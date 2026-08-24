import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile, chmod } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { loadProjectConfig } from "../config/load.js";
import { digestBoundedTree } from "../evidence/tree-digest.js";
import { runCapturedCommand } from "../process/capture.js";
import { validateAgentSkill } from "../validate/agent-skill.js";

export interface StagedSkillFile {
  readonly path: string;
  readonly bytes: number;
  readonly executable: boolean;
  readonly sha256: string;
}

export interface StagedCanonicalSkill {
  readonly schemaVersion: 1;
  readonly sourceCommit: string;
  readonly projectConfigSha256: string;
  readonly skillSha256: string;
  readonly stagingPath: string;
  readonly skillPath: string;
  readonly files: readonly StagedSkillFile[];
}

export interface SkillStagingIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class SkillStagingError extends Error {
  readonly issues: readonly SkillStagingIssue[];

  constructor(message: string, issues: readonly SkillStagingIssue[]) {
    super(message);
    this.name = "SkillStagingError";
    this.issues = Object.freeze([...issues]);
  }
}

const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

function issue(code: string, path: string, message: string): SkillStagingIssue {
  return Object.freeze({ code, path, message });
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function projectRelative(root: string, target: string): string {
  const path = relative(root, target);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new SkillStagingError("The canonical skill path is unsafe.", [
      issue("stage.path.unsafe", "/skill", "skill must resolve inside the project"),
    ]);
  }
  return path.split(sep).join("/");
}

async function git(root: string, args: readonly string[]): Promise<Buffer> {
  const result = await runCapturedCommand({
    argv: ["git", ...args],
    cwd: root,
    timeoutSeconds: 30,
    maxOutputBytes: MAX_GIT_OUTPUT,
  });
  if (result.status !== "passed") {
    throw new SkillStagingError("Git could not prove staging inputs.", [
      issue("stage.git.failed", "/project", "required Git query failed"),
    ]);
  }
  return result.stdout;
}

function nulPaths(bytes: Buffer): string[] {
  if (bytes.byteLength === 0) return [];
  return bytes.subarray(0, -1).toString("utf8").split("\0");
}

async function trackedFiles(root: string, skillPath: string): Promise<string[]> {
  const status = await git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    "skillpress.yaml",
    skillPath,
  ]);
  if (status.byteLength !== 0) {
    throw new SkillStagingError("Canonical skill inputs are dirty.", [
      issue("stage.git.dirty", "/skill", "tracked and untracked skill inputs must be clean"),
    ]);
  }
  const ignored = nulPaths(
    await git(root, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--",
      skillPath,
    ]),
  );
  if (ignored.length !== 0) {
    throw new SkillStagingError("Canonical skill contains ignored files.", [
      issue("stage.git.ignored", "/skill", "ignored skill files cannot enter a release snapshot"),
    ]);
  }
  const files = nulPaths(await git(root, ["ls-files", "-z", "--", skillPath])).sort();
  if (!files.includes(`${skillPath}/SKILL.md`)) {
    throw new SkillStagingError("Canonical skill is not tracked.", [
      issue("stage.git.untracked", "/skill", "SKILL.md and release files must be tracked"),
    ]);
  }
  return files;
}

/** Create a private, immutable-by-contract snapshot from clean tracked canonical skill files. */
export async function stageCanonicalSkill(projectDirectory: string): Promise<StagedCanonicalSkill> {
  const root = await realpath(resolve(projectDirectory));
  const config = await loadProjectConfig(root);
  const skillRoot = await realpath(join(root, config.skill.path));
  const skillPath = projectRelative(root, skillRoot);
  const validation = await validateAgentSkill(skillRoot, { expectedName: config.skill.name });
  if (!validation.ok) {
    throw new SkillStagingError("Canonical skill validation failed.", [
      issue("stage.skill.invalid", "/skill", "canonical skill must pass deterministic validation"),
    ]);
  }
  const sourceCommit = (await git(root, ["rev-parse", "--verify", "HEAD"])).toString("utf8").trim();
  const files = await trackedFiles(root, skillPath);
  const configBytes = await readFile(join(root, "skillpress.yaml"));
  const beforeSha256 = await digestBoundedTree(skillRoot);
  const privateRoot = join(root, ".skillpress");
  const stagingRoot = join(privateRoot, "staging");
  await mkdir(privateRoot, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  for (const path of [privateRoot, stagingRoot]) {
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    });
    const metadata = await lstat(path);
    if (!metadata.isDirectory()) {
      throw new SkillStagingError("Private staging storage is unsafe.", [
        issue("stage.storage.unsafe", "/staging", "staging path must use real directories"),
      ]);
    }
    await chmod(path, 0o700);
  }
  const id = randomBytes(32).toString("hex");
  const runRoot = join(stagingRoot, id);
  const stagedSkillRoot = join(runRoot, "canonical", config.skill.name);
  await mkdir(stagedSkillRoot, { recursive: true, mode: 0o700 });
  const stagedFiles: StagedSkillFile[] = [];
  for (const trackedPath of files) {
    const relativePath = trackedPath.slice(skillPath.length + 1);
    const source = join(root, trackedPath);
    const metadata = await lstat(source);
    const bytes = await readFile(source);
    const destination = join(stagedSkillRoot, relativePath);
    await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
    const executable = (metadata.mode & 0o111) !== 0;
    await writeFile(destination, bytes, { flag: "wx", mode: executable ? 0o700 : 0o600 });
    await chmod(destination, executable ? 0o700 : 0o600);
    stagedFiles.push({
      path: relativePath,
      bytes: bytes.byteLength,
      executable,
      sha256: digest(bytes),
    });
  }
  const afterSourceSha256 = await digestBoundedTree(skillRoot);
  const stagedSha256 = await digestBoundedTree(stagedSkillRoot);
  if (
    beforeSha256 !== afterSourceSha256 ||
    beforeSha256 !== stagedSha256 ||
    !(await readFile(join(root, "skillpress.yaml"))).equals(configBytes)
  ) {
    throw new SkillStagingError("Canonical skill changed during staging.", [
      issue("stage.source.changed", "/skill", "source and staged tree digests must remain equal"),
    ]);
  }
  if ((await trackedFiles(root, skillPath)).join("\0") !== files.join("\0")) {
    throw new SkillStagingError("Canonical Git inputs changed during staging.", [
      issue("stage.git.changed", "/skill", "tracked file set must remain stable"),
    ]);
  }
  return freeze({
    schemaVersion: 1,
    sourceCommit,
    projectConfigSha256: digest(configBytes),
    skillSha256: beforeSha256,
    stagingPath: `.skillpress/staging/${id}`,
    skillPath: `canonical/${config.skill.name}`,
    files: stagedFiles,
  });
}
