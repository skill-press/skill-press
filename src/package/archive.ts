import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
  readonly artifactSha256: string;
  readonly artifactBytes: number;
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
    result.push({ path: posix.join(skillName, file.path), contents, executable: file.executable });
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
  await writeFile(join(output, skillArchive), archive, { flag: "wx", mode: 0o600 });
  await writeFile(join(output, zipArchive), archive, { flag: "wx", mode: 0o600 });
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
  await writeFile(
    join(output, checksumName),
    `${[
      ...artifacts.map((entry) => `${entry.sha256}  ${entry.name}`),
      `${provenanceSha256}  ${provenanceName}`,
    ].join("\n")}\n`,
    { flag: "wx", mode: 0o600 },
  );
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
    artifactSha256: archiveSha256,
    artifactBytes: archive.byteLength,
  });
}
