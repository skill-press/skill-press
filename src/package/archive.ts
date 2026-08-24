import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { Ajv, type ValidateFunction } from "ajv";

import { loadProjectConfig } from "../config/load.js";
import { digestBoundedTree } from "../evidence/tree-digest.js";
import { VERSION } from "../version.js";
import type { SkillPressPackageProvenance } from "./generated-provenance.js";
import type { StagedCanonicalSkill } from "./stage.js";

export interface SkillPackageArtifacts {
  readonly schemaVersion: 1;
  readonly artifactsPath: string;
  readonly skillArchive: string;
  readonly zipArchive: string;
  readonly checksums: string;
  readonly provenance: string;
  readonly provenanceSha256: string;
  readonly provenanceBytes: number;
  readonly checksumsSha256: string;
  readonly checksumsBytes: number;
  readonly artifactSha256: string;
  readonly artifactBytes: number;
}

export interface LoadedSkillPackageArtifacts extends SkillPackageArtifacts {
  readonly sourceCommit: string;
}

export interface SkillPackageIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class SkillPackageError extends Error {
  readonly issues: readonly SkillPackageIssue[];

  constructor(message: string, issues: readonly SkillPackageIssue[]) {
    super(message);
    this.name = "SkillPackageError";
    this.issues = Object.freeze([...issues]);
  }
}

interface ZipEntry {
  readonly name: Buffer;
  readonly contents: Buffer;
  readonly crc32: number;
  readonly executable: boolean;
  readonly offset: number;
}

const provenanceSchema = JSON.parse(
  await readFile(new URL("../../schemas/package-provenance.schema.json", import.meta.url), "utf8"),
) as object;
const validateProvenance = new Ajv({ allErrors: true, strict: true }).compile(
  provenanceSchema,
) as ValidateFunction<SkillPressPackageProvenance>;
const CRC_TABLE = new Uint32Array(256);
const ARTIFACTS_PATH = /^\.skillpress\/staging\/[a-f0-9]{64}\/artifacts$/u;
const MAX_LOADED_ARTIFACT_BYTES = 64 * 1024 * 1024;
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  CRC_TABLE[index] = value >>> 0;
}

function issue(code: string, path: string, message: string): SkillPackageIssue {
  return Object.freeze({ code, path, message });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameMetadata(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function readPrivateArtifact(path: string, label: string): Promise<Buffer> {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.size < 1 ||
    before.size > MAX_LOADED_ARTIFACT_BYTES ||
    (process.platform !== "win32" && (before.mode & 0o077) !== 0)
  ) {
    throw new SkillPackageError("Packaged artifacts are unsafe.", [
      issue(
        "package.load.unsafe",
        `/artifacts/${label}`,
        "artifact must be a bounded private regular file",
      ),
    ]);
  }
  const value = await readFile(path);
  const after = await lstat(path);
  if (value.byteLength !== before.size || !sameMetadata(before, after)) {
    throw new SkillPackageError("A packaged artifact changed while it was read.", [
      issue(
        "package.load.changed",
        `/artifacts/${label}`,
        "artifact identity and content must remain stable",
      ),
    ]);
  }
  return value;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(entry: Omit<ZipEntry, "offset">): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12);
  header.writeUInt32LE(entry.crc32, 14);
  header.writeUInt32LE(entry.contents.byteLength, 18);
  header.writeUInt32LE(entry.contents.byteLength, 22);
  header.writeUInt16LE(entry.name.byteLength, 26);
  return header;
}

function centralHeader(entry: ZipEntry): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | 20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.contents.byteLength, 20);
  header.writeUInt32LE(entry.contents.byteLength, 24);
  header.writeUInt16LE(entry.name.byteLength, 28);
  const mode = entry.executable ? 0o100755 : 0o100644;
  header.writeUInt32LE((mode << 16) >>> 0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

function createZip(
  files: readonly { path: string; contents: Buffer; executable: boolean }[],
): Buffer {
  const body: Buffer[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (const file of files) {
    const base = {
      name: Buffer.from(file.path, "utf8"),
      contents: file.contents,
      crc32: crc32(file.contents),
      executable: file.executable,
    };
    const header = localHeader(base);
    entries.push({ ...base, offset });
    body.push(header, base.name, base.contents);
    offset += header.byteLength + base.name.byteLength + base.contents.byteLength;
  }
  const central = entries.flatMap((entry) => [centralHeader(entry), entry.name]);
  const centralBytes = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, ...central, end]);
}

async function archiveFromCanonicalTree(
  root: string,
  skillName: string,
): Promise<{ readonly bytes: Buffer; readonly sha256: string }> {
  const files: Array<{ path: string; contents: Buffer; executable: boolean }> = [];
  let entries = 0;
  let totalBytes = 0;
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const names = await readdir(directory);
    names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
      entries += 1;
      if (entries > 2048) {
        throw new SkillPackageError("Staged canonical inventory is too large.", [
          issue("package.load.canonical", "/artifacts", "canonical entry limit exceeded"),
        ]);
      }
      const absolute = join(directory, name);
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const before = await lstat(absolute);
      if (before.isSymbolicLink()) {
        throw new SkillPackageError("Staged canonical tree is unsafe.", [
          issue("package.load.canonical", "/artifacts", "canonical tree cannot contain links"),
        ]);
      }
      if (before.isDirectory()) {
        await visit(absolute, relativePath);
        continue;
      }
      if (!before.isFile() || before.size > 32 * 1024 * 1024) {
        throw new SkillPackageError("Staged canonical tree is unsafe.", [
          issue(
            "package.load.canonical",
            "/artifacts",
            "canonical tree must contain bounded regular files",
          ),
        ]);
      }
      const contents = await readFile(absolute);
      const after = await lstat(absolute);
      totalBytes += contents.byteLength;
      if (
        totalBytes > 128 * 1024 * 1024 ||
        contents.byteLength !== before.size ||
        !sameMetadata(before, after)
      ) {
        throw new SkillPackageError("Staged canonical tree changed while it was read.", [
          issue(
            "package.load.canonical",
            "/artifacts",
            "canonical content and metadata must remain stable",
          ),
        ]);
      }
      files.push({
        path: posix.join(skillName, relativePath),
        contents,
        executable: (before.mode & 0o111) !== 0,
      });
    }
  };
  const beforeSha256 = await digestBoundedTree(root);
  await visit(root, "");
  const afterSha256 = await digestBoundedTree(root);
  if (beforeSha256 !== afterSha256) {
    throw new SkillPackageError("Staged canonical tree changed while it was archived.", [
      issue("package.load.canonical", "/artifacts", "canonical tree digest must remain stable"),
    ]);
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return Object.freeze({ bytes: createZip(files), sha256: afterSha256 });
}

async function readStagedFiles(
  root: string,
  staged: StagedCanonicalSkill,
  skillName: string,
): Promise<Array<{ path: string; contents: Buffer; executable: boolean }>> {
  if (staged.skillPath !== `canonical/${skillName}`) {
    throw new SkillPackageError("Staged skill identity is invalid.", [
      issue("package.stage.identity", "/staging", "staged canonical name must match configuration"),
    ]);
  }
  const skillRoot = join(root, staged.stagingPath, staged.skillPath);
  if ((await digestBoundedTree(skillRoot)) !== staged.skillSha256) {
    throw new SkillPackageError("Staged skill digest changed.", [
      issue("package.stage.changed", "/staging", "staged tree must match its staging report"),
    ]);
  }
  const files = [...staged.files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  const result: Array<{ path: string; contents: Buffer; executable: boolean }> = [];
  for (const file of files) {
    const path = join(skillRoot, file.path);
    const metadata = await lstat(path);
    const contents = await readFile(path);
    if (
      !metadata.isFile() ||
      contents.byteLength !== file.bytes ||
      sha256(contents) !== file.sha256 ||
      ((metadata.mode & 0o111) !== 0) !== file.executable
    ) {
      throw new SkillPackageError("A staged file changed.", [
        issue("package.stage.file", "/staging", "staged file metadata and content must match"),
      ]);
    }
    result.push({
      path: posix.join(skillName, file.path),
      contents,
      executable: file.executable,
    });
  }
  return result;
}

/** Produce reproducible .skill/.zip bytes, checksums, and schema-validated provenance. */
export async function packageStagedSkill(
  projectDirectory: string,
  staged: StagedCanonicalSkill,
): Promise<SkillPackageArtifacts> {
  const root = await realpath(projectDirectory);
  const config = await loadProjectConfig(root);
  const configBytes = await readFile(join(root, "skillpress.yaml"));
  if (sha256(configBytes) !== staged.projectConfigSha256) {
    throw new SkillPackageError("Project configuration changed after staging.", [
      issue("package.config.changed", "/project", "configuration must match staging provenance"),
    ]);
  }
  const files = await readStagedFiles(root, staged, config.skill.name);
  const archive = createZip(files);
  const archiveSha256 = sha256(archive);
  const baseName = `${config.project.name}-${config.project.version}`;
  const skillArchive = `${baseName}.skill`;
  const zipArchive = `${baseName}.zip`;
  const artifactsPath = `${staged.stagingPath}/artifacts`;
  const output = join(root, artifactsPath);
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, skillArchive), archive, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(output, zipArchive), archive, {
    flag: "wx",
    mode: 0o600,
  });
  const artifact = (name: string) => ({
    name,
    bytes: archive.byteLength,
    sha256: archiveSha256,
    mediaType: "application/zip" as const,
  });
  const artifacts: SkillPressPackageProvenance["artifacts"] = [
    artifact(skillArchive),
    artifact(zipArchive),
  ];
  const provenance: SkillPressPackageProvenance = {
    schemaVersion: 1,
    provenanceType: "skillpress.package",
    project: {
      name: config.project.name,
      version: config.project.version,
      skillName: config.skill.name,
    },
    sourceCommit: staged.sourceCommit,
    projectConfigSha256: staged.projectConfigSha256,
    skillSha256: staged.skillSha256,
    tool: { name: "@mushanyoung/skillpress", version: VERSION },
    archive: {
      format: "zip",
      compression: "store",
      timestamp: "1980-01-01T00:00:00.000Z",
      ordering: "utf8-bytewise",
      regularMode: "0644",
      executableMode: "0755",
    },
    artifacts,
  };
  if (!validateProvenance(provenance)) {
    throw new SkillPackageError("Package provenance violated its schema.", [
      issue("package.provenance.schema", "/provenance", "internal provenance is invalid"),
    ]);
  }
  const checksumName = "SHA256SUMS";
  const provenanceName = "provenance.json";
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance)}\n`);
  const provenanceSha256 = sha256(provenanceBytes);
  await writeFile(join(output, provenanceName), provenanceBytes, {
    flag: "wx",
    mode: 0o600,
  });
  const checksumBytes = Buffer.from(
    `${[
      ...artifacts.map((entry) => `${entry.sha256}  ${entry.name}`),
      `${provenanceSha256}  ${provenanceName}`,
    ].join("\n")}\n`,
  );
  const checksumsSha256 = sha256(checksumBytes);
  await writeFile(join(output, checksumName), checksumBytes, {
    flag: "wx",
    mode: 0o600,
  });
  for (const name of [skillArchive, zipArchive, checksumName, provenanceName]) {
    await chmod(join(output, name), 0o600);
  }
  return Object.freeze({
    schemaVersion: 1,
    artifactsPath,
    skillArchive,
    zipArchive,
    checksums: checksumName,
    provenance: provenanceName,
    provenanceSha256,
    provenanceBytes: provenanceBytes.byteLength,
    checksumsSha256,
    checksumsBytes: checksumBytes.byteLength,
    artifactSha256: archiveSha256,
    artifactBytes: archive.byteLength,
  });
}

/** Reload a private package only after proving its path, provenance, checksums, and bytes. */
export async function loadPackagedSkill(
  projectDirectory: string,
  artifactsPath: string,
): Promise<LoadedSkillPackageArtifacts> {
  if (!ARTIFACTS_PATH.test(artifactsPath)) {
    throw new SkillPackageError("Packaged artifact path is invalid.", [
      issue(
        "package.load.path",
        "/artifactsPath",
        "artifact path must identify private SkillPress staging storage",
      ),
    ]);
  }
  const root = await realpath(projectDirectory);
  const output = join(root, artifactsPath);
  const pathParts = artifactsPath.split("/");
  const directories = [
    join(root, pathParts[0] as string),
    join(root, pathParts[0] as string, pathParts[1] as string),
    join(root, pathParts[0] as string, pathParts[1] as string, pathParts[2] as string),
    output,
  ];
  for (const path of directories) {
    const metadata = await lstat(path);
    if (
      !metadata.isDirectory() ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      throw new SkillPackageError("Packaged artifact storage is unsafe.", [
        issue(
          "package.load.unsafe",
          "/artifactsPath",
          "artifact parents must be private real directories",
        ),
      ]);
    }
  }
  if ((await realpath(output)) !== output) {
    throw new SkillPackageError("Packaged artifact storage is unsafe.", [
      issue(
        "package.load.unsafe",
        "/artifactsPath",
        "artifact storage cannot traverse symbolic links",
      ),
    ]);
  }

  const config = await loadProjectConfig(root);
  const baseName = `${config.project.name}-${config.project.version}`;
  const skillArchive = `${baseName}.skill`;
  const zipArchive = `${baseName}.zip`;
  const checksums = "SHA256SUMS";
  const provenance = "provenance.json";
  const expectedNames = [checksums, provenance, skillArchive, zipArchive].sort();
  const names = (await readdir(output)).sort();
  if (names.join("\0") !== expectedNames.join("\0")) {
    throw new SkillPackageError("Packaged artifact inventory is invalid.", [
      issue(
        "package.load.inventory",
        "/artifacts",
        "artifact storage must contain the exact package inventory",
      ),
    ]);
  }

  const skillBytes = await readPrivateArtifact(join(output, skillArchive), skillArchive);
  const zipBytes = await readPrivateArtifact(join(output, zipArchive), zipArchive);
  const provenanceBytes = await readPrivateArtifact(join(output, provenance), provenance);
  const checksumBytes = await readPrivateArtifact(join(output, checksums), checksums);
  if (!skillBytes.equals(zipBytes)) {
    throw new SkillPackageError("Packaged archives do not match.", [
      issue(
        "package.load.archive",
        "/artifacts",
        ".skill and .zip archives must be byte-identical",
      ),
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(provenanceBytes.toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (!validateProvenance(parsed)) {
    throw new SkillPackageError("Package provenance is invalid.", [
      issue(
        "package.load.provenance",
        "/artifacts/provenance.json",
        "provenance must satisfy its versioned schema",
      ),
    ]);
  }
  const loadedProvenance = parsed;
  const configBytes = await readFile(join(root, "skillpress.yaml"));
  const artifactSha256 = sha256(skillBytes);
  const provenanceSha256 = sha256(provenanceBytes);
  const stagedCanonicalPath = join(
    root,
    ...artifactsPath.split("/").slice(0, -1),
    "canonical",
    config.skill.name,
  );
  const stagedCanonicalRoot = await realpath(stagedCanonicalPath);
  const currentCanonicalPath = join(root, config.skill.path);
  const currentCanonicalRoot = await realpath(currentCanonicalPath);
  if (stagedCanonicalRoot !== stagedCanonicalPath) {
    throw new SkillPackageError("Staged canonical storage is unsafe.", [
      issue(
        "package.load.canonical",
        "/artifacts",
        "staged canonical storage cannot traverse symbolic links",
      ),
    ]);
  }
  if (currentCanonicalRoot !== currentCanonicalPath) {
    throw new SkillPackageError("Current canonical storage is unsafe.", [
      issue(
        "package.load.canonical",
        "/artifacts",
        "current canonical storage cannot traverse symbolic links",
      ),
    ]);
  }
  const [stagedCanonical, currentCanonicalSha256] = await Promise.all([
    archiveFromCanonicalTree(stagedCanonicalRoot, config.skill.name),
    digestBoundedTree(currentCanonicalRoot),
  ]);
  if (
    loadedProvenance.project.name !== config.project.name ||
    loadedProvenance.project.version !== config.project.version ||
    loadedProvenance.project.skillName !== config.skill.name ||
    loadedProvenance.projectConfigSha256 !== sha256(configBytes) ||
    loadedProvenance.skillSha256 !== stagedCanonical.sha256 ||
    loadedProvenance.skillSha256 !== currentCanonicalSha256 ||
    !skillBytes.equals(stagedCanonical.bytes) ||
    loadedProvenance.artifacts.length !== 2 ||
    loadedProvenance.artifacts[0]?.name !== skillArchive ||
    loadedProvenance.artifacts[1]?.name !== zipArchive ||
    loadedProvenance.artifacts.some(
      (artifact) => artifact.sha256 !== artifactSha256 || artifact.bytes !== skillBytes.byteLength,
    )
  ) {
    throw new SkillPackageError("Package provenance does not bind current artifacts.", [
      issue(
        "package.load.binding",
        "/artifacts",
        "project, configuration, names, sizes, and digests must match provenance",
      ),
    ]);
  }
  const expectedChecksums = Buffer.from(
    `${artifactSha256}  ${skillArchive}\n${artifactSha256}  ${zipArchive}\n${provenanceSha256}  ${provenance}\n`,
  );
  if (!checksumBytes.equals(expectedChecksums)) {
    throw new SkillPackageError("Package checksums are invalid.", [
      issue(
        "package.load.checksums",
        "/artifacts/SHA256SUMS",
        "checksums must exactly bind all packaged files",
      ),
    ]);
  }
  return Object.freeze({
    schemaVersion: 1,
    artifactsPath,
    skillArchive,
    zipArchive,
    checksums,
    provenance,
    provenanceSha256,
    provenanceBytes: provenanceBytes.byteLength,
    checksumsSha256: sha256(checksumBytes),
    checksumsBytes: checksumBytes.byteLength,
    artifactSha256,
    artifactBytes: skillBytes.byteLength,
    sourceCommit: loadedProvenance.sourceCommit,
  });
}
