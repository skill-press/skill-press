import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseDocument, stringify } from "yaml";

import { digestBoundedTree } from "../evidence/tree-digest.js";
import type { PublicationContext } from "./saga.js";

const TARGET = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

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
