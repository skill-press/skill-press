import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseDocument, stringify } from "yaml";

import { digestBoundedTree } from "../evidence/tree-digest.js";
import type { PublicationContext } from "./saga.js";

const TARGET = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MIT0_LICENSE = `MIT No Attribution

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`;

interface PackageProvenance {
  readonly provenanceType: "skillpress.package";
  readonly sourceCommit: string;
  readonly skillSha256: string;
  readonly project: { readonly skillName: string };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function provenance(value: unknown): PackageProvenance | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const project = record.project;
  if (project === null || typeof project !== "object" || Array.isArray(project)) return null;
  const projectRecord = project as Readonly<Record<string, unknown>>;
  return record.provenanceType === "skillpress.package" &&
    typeof record.sourceCommit === "string" &&
    /^[a-f0-9]{40}$/u.test(record.sourceCommit) &&
    typeof record.skillSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(record.skillSha256) &&
    typeof projectRecord.skillName === "string"
    ? (record as unknown as PackageProvenance)
    : null;
}

function projectFrontmatter(source: string, additions: Readonly<Record<string, string>>): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  if (match === null) throw new Error("Canonical SKILL.md frontmatter is unavailable");
  const document = parseDocument(match[1] as string, {
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) throw new Error("Canonical SKILL.md frontmatter is invalid");
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Canonical SKILL.md frontmatter must be a mapping");
  }
  const projected = { ...(value as Readonly<Record<string, unknown>>), ...additions };
  return `---\n${stringify(projected, { lineWidth: 0 })}---\n${source.slice(match[0].length)}`;
}

function canonicalLicense(source: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  if (match === null) return null;
  const document = parseDocument(match[1] as string, {
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) return null;
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const license = (value as Readonly<Record<string, unknown>>).license;
  return typeof license === "string" ? license : null;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) throw new Error("Publication projection storage is unsafe");
  await chmod(path, 0o700);
}

/** Read the immutable staged canonical skill only after rebinding it to package provenance. */
export async function readBoundCanonicalSkill(
  context: PublicationContext,
): Promise<{ readonly root: string; readonly skillMarkdown: string }> {
  const provenancePath = join(
    context.root,
    context.artifactsPath,
    context.artifacts.provenance.name,
  );
  const provenanceBytes = await readFile(provenancePath);
  const parsed =
    sha256(provenanceBytes) === context.artifacts.provenance.sha256
      ? provenance(JSON.parse(provenanceBytes.toString("utf8")))
      : null;
  if (
    parsed === null ||
    parsed.sourceCommit !== context.sourceCommit ||
    parsed.project.skillName !== context.skill.name
  ) {
    throw new Error("Package provenance does not bind the staged canonical skill");
  }
  const root = join(context.root, dirname(context.artifactsPath), "canonical", context.skill.name);
  if ((await digestBoundedTree(root)) !== parsed.skillSha256) {
    throw new Error("Staged canonical skill changed after packaging");
  }
  return Object.freeze({ root, skillMarkdown: await readFile(join(root, "SKILL.md"), "utf8") });
}

/** Create an idempotent private target projection without modifying the canonical source. */
export async function projectSkillFrontmatter(
  context: PublicationContext,
  target: string,
  additions: Readonly<Record<string, string>>,
): Promise<{ readonly root: string; readonly skillMarkdown: string }> {
  if (!TARGET.test(target)) throw new TypeError("Publication projection target is invalid");
  const canonical = await readBoundCanonicalSkill(context);
  const skillMarkdown = projectFrontmatter(canonical.skillMarkdown, additions);
  const privateRoot = join(context.root, ".skillpress");
  const projections = join(privateRoot, "projections");
  const run = join(projections, context.idempotencyKey);
  const targetRoot = join(run, target);
  const root = join(targetRoot, context.skill.name);
  for (const path of [privateRoot, projections, run, targetRoot, root]) {
    await ensureDirectory(path);
  }
  const path = join(root, "SKILL.md");
  try {
    await writeFile(path, skillMarkdown, { flag: "wx", mode: 0o600 });
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const metadata = await lstat(path);
    const existing = await readFile(path, "utf8");
    if (!metadata.isFile() || existing !== skillMarkdown) {
      throw new Error("Publication projection conflicts with its idempotency binding");
    }
  }
  await chmod(path, 0o600);
  return Object.freeze({ root, skillMarkdown });
}

interface ProjectedTreeFile {
  readonly bytes: Buffer;
  readonly executable: boolean;
}

async function collectProjectedFiles(
  root: string,
  relativeDirectory: string,
  files: Map<string, ProjectedTreeFile>,
): Promise<void> {
  for (const entry of await readdir(join(root, relativeDirectory), { withFileTypes: true })) {
    const path = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    const absolute = join(root, ...path.split("/"));
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error("Publication projection rejects symbolic links");
    if (metadata.isDirectory()) {
      await collectProjectedFiles(root, path, files);
      continue;
    }
    if (!metadata.isFile()) throw new Error("Publication projection rejects special files");
    files.set(path, {
      bytes: await readFile(absolute),
      executable: (metadata.mode & 0o111) !== 0,
    });
  }
}

async function ensureProjectedFile(
  root: string,
  path: string,
  expected: ProjectedTreeFile,
): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  let parent = root;
  for (const segment of path.split("/").slice(0, -1)) {
    parent = join(parent, segment);
    await ensureDirectory(parent);
  }
  const mode = expected.executable ? 0o700 : 0o600;
  try {
    await writeFile(absolute, expected.bytes, { flag: "wx", mode });
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || !(await readFile(absolute)).equals(expected.bytes)) {
      throw new Error("Publication projection conflicts with its idempotency binding");
    }
  }
  await chmod(absolute, mode);
}

async function actualProjectedFiles(
  root: string,
  relativeDirectory: string,
  files: Map<string, ProjectedTreeFile>,
): Promise<void> {
  for (const entry of await readdir(join(root, relativeDirectory), { withFileTypes: true })) {
    const path = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    const absolute = join(root, ...path.split("/"));
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error("Publication projection storage is unsafe");
    if (metadata.isDirectory()) {
      await actualProjectedFiles(root, path, files);
      continue;
    }
    if (!metadata.isFile()) throw new Error("Publication projection storage is unsafe");
    files.set(path, {
      bytes: await readFile(absolute),
      executable: (metadata.mode & 0o111) !== 0,
    });
  }
}

/** Project a complete canonical tree under the explicit ClawHub MIT-0 distribution contract. */
export async function projectClawHubSkill(
  context: PublicationContext,
): Promise<{ readonly root: string; readonly skillMarkdown: string }> {
  const canonical = await readBoundCanonicalSkill(context);
  const license = canonicalLicense(canonical.skillMarkdown);
  if (license !== "MIT" && license !== "MIT-0") {
    throw new Error("Canonical skill license is not compatible with explicit MIT-0 projection");
  }
  const projected = await projectSkillFrontmatter(context, "clawhub", {
    license: "MIT-0",
    version: context.project.version,
  });
  const expected = new Map<string, ProjectedTreeFile>();
  await collectProjectedFiles(canonical.root, "", expected);
  for (const path of expected.keys()) {
    if (!path.includes("/") && path.toLowerCase() === "license") expected.delete(path);
  }
  expected.set("SKILL.md", {
    bytes: Buffer.from(projected.skillMarkdown),
    executable: false,
  });
  expected.set("LICENSE", { bytes: Buffer.from(MIT0_LICENSE), executable: false });
  for (const [path, file] of expected) await ensureProjectedFile(projected.root, path, file);

  const actual = new Map<string, ProjectedTreeFile>();
  await actualProjectedFiles(projected.root, "", actual);
  if (
    actual.size !== expected.size ||
    [...expected].some(([path, file]) => {
      const candidate = actual.get(path);
      return (
        candidate === undefined ||
        candidate.executable !== file.executable ||
        !candidate.bytes.equals(file.bytes)
      );
    })
  ) {
    throw new Error("ClawHub projection contains unexpected or changed files");
  }
  return projected;
}

function projectedDescription(source: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  if (match === null) throw new Error("Canonical SKILL.md frontmatter is unavailable");
  const document = parseDocument(match[1] as string, {
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) throw new Error("Canonical SKILL.md frontmatter is invalid");
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Canonical SKILL.md frontmatter must be a mapping");
  }
  const description = (value as Readonly<Record<string, unknown>>).description;
  if (typeof description !== "string" || description.length === 0) {
    throw new Error("Canonical skill description is unavailable");
  }
  return description;
}

/** Project the complete canonical skill into Tessl's current public plugin package shape. */
export async function projectTesslPlugin(
  context: PublicationContext,
  workspace: string,
): Promise<{
  readonly root: string;
  readonly manifest: string;
  readonly skillMarkdown: string;
}> {
  const canonical = await readBoundCanonicalSkill(context);
  const privateRoot = join(context.root, ".skillpress");
  const projections = join(privateRoot, "projections");
  const run = join(projections, context.idempotencyKey);
  const root = join(run, "tessl");
  const manifest = `${JSON.stringify(
    {
      name: `${workspace}/${context.skill.name}`,
      version: context.project.version,
      description: projectedDescription(canonical.skillMarkdown),
      private: false,
      skills: [`skills/${context.skill.name}`],
    },
    null,
    2,
  )}\n`;
  for (const path of [privateRoot, projections, run, root]) await ensureDirectory(path);

  const expected = new Map<string, ProjectedTreeFile>();
  const canonicalFiles = new Map<string, ProjectedTreeFile>();
  await collectProjectedFiles(canonical.root, "", canonicalFiles);
  for (const [path, file] of canonicalFiles) {
    expected.set(`skills/${context.skill.name}/${path}`, file);
  }
  expected.set(".tessl-plugin/plugin.json", {
    bytes: Buffer.from(manifest),
    executable: false,
  });
  for (const [path, file] of expected) await ensureProjectedFile(root, path, file);

  const actual = new Map<string, ProjectedTreeFile>();
  await actualProjectedFiles(root, "", actual);
  if (
    actual.size !== expected.size ||
    [...expected].some(([path, file]) => {
      const candidate = actual.get(path);
      return (
        candidate === undefined ||
        candidate.executable !== file.executable ||
        !candidate.bytes.equals(file.bytes)
      );
    })
  ) {
    throw new Error("Tessl projection contains unexpected or changed files");
  }
  return Object.freeze({ root, manifest, skillMarkdown: canonical.skillMarkdown });
}
