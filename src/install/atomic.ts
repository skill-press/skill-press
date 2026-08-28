import { createHash } from "node:crypto";
import { linkSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { validateAgentSkill } from "../validate/agent-skill.js";
import { TrustedInstallError } from "./errors.js";
import type { StoredArchiveFile, StoredSkillArchive } from "./zip.js";

export const PENDING_SKILL_DOCUMENT = ".skill-press-installing-SKILL.md" as const;
export const INSTALL_STATE_MARKER = ".skill-press-installing.json" as const;

export interface CommittedInstallation {
  readonly targetPath: string;
  readonly installedPath: string;
  readonly changed: boolean;
  readonly rollback: () => Promise<void>;
}

export interface PreparedInstallation {
  readonly targetPath: string;
  readonly installedPath: string;
  readonly changed: boolean;
  readonly commit: (
    beforePublish?: BeforeSkillPublish,
    atPublish?: AtSkillPublish,
  ) => Promise<CommittedInstallation>;
  readonly abort: () => Promise<void>;
}

export type BeforeSkillPublish = () => void | Promise<void>;
export type AtSkillPublish = () => void;

type Metadata = Awaited<ReturnType<typeof lstat>>;
type ExistingState = "complete" | "partial" | "pending" | "published-pending";
type OwnedEntry = Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  mode: number | bigint;
  size: number | bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
  kind: "directory" | "file";
  sha256?: string;
}>;
type OwnedSnapshot = Readonly<{
  root: OwnedEntry;
  entries: ReadonlyMap<string, OwnedEntry>;
}>;

function unsafe(message: string): never {
  throw new TrustedInstallError("install_path_unsafe", message);
}

function conflict(message: string): never {
  throw new TrustedInstallError("install_conflict", message);
}

function metadataEqual(left: Metadata, right: Metadata): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameIdentity(left: Metadata, right: Metadata): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function expectedDirectoryPaths(archive: StoredSkillArchive): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const file of archive.files) {
    let directory = dirname(file.relativePath);
    while (directory !== ".") {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  return directories;
}

function installationMarker(skill: string, archive: StoredSkillArchive): StoredArchiveFile {
  const digest = createHash("sha256");
  for (const file of archive.files) {
    digest.update(file.relativePath, "utf8");
    digest.update("\0", "utf8");
    digest.update(file.executable ? "1\0" : "0\0", "utf8");
    digest.update(String(file.contents.byteLength), "utf8");
    digest.update("\0", "utf8");
    digest.update(file.contents);
  }
  return Object.freeze({
    relativePath: INSTALL_STATE_MARKER,
    contents: Buffer.from(
      `${JSON.stringify({
        schemaVersion: 1,
        stateType: "skillpress.installing",
        skill,
        archiveSha256: digest.digest("hex"),
      })}\n`,
      "utf8",
    ),
    executable: false,
  });
}

export async function canonicalProjectRoot(input: string | undefined): Promise<string> {
  const candidate = resolve(input ?? process.cwd());
  try {
    const resolved = await realpath(candidate);
    const metadata = await lstat(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      return unsafe("Project root is unsafe.");
    return resolved;
  } catch (error) {
    if (error instanceof TrustedInstallError) throw error;
    return unsafe("Project root must be an existing directory.");
  }
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(path)) !== path) {
    unsafe("The project installation root cannot contain symbolic links.");
  }
}

async function installationRoots(
  projectRoot: string,
): Promise<{ readonly targetRoot: string; readonly stagingRoot: string }> {
  const agents = join(projectRoot, ".agents");
  const targetRoot = join(agents, "skills");
  const state = join(projectRoot, ".skill-press");
  const stagingRoot = join(state, "staging");
  try {
    await ensureDirectory(agents);
    await ensureDirectory(targetRoot);
    await ensureDirectory(state);
    await ensureDirectory(stagingRoot);
  } catch (error) {
    if (error instanceof TrustedInstallError) throw error;
    throw new TrustedInstallError(
      "install_failed",
      "The project installation roots could not be created.",
    );
  }
  if ((await lstat(targetRoot)).dev !== (await lstat(stagingRoot)).dev) {
    throw new TrustedInstallError(
      "install_path_unsafe",
      "Skill staging and installation must share a filesystem.",
    );
  }
  return Object.freeze({ targetRoot, stagingRoot });
}

function safeChild(root: string, child: string): boolean {
  const path = relative(root, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

async function stableFileMatches(
  path: string,
  expected: StoredArchiveFile,
): Promise<
  Readonly<{ readonly ok: false }> | Readonly<{ readonly ok: true; readonly metadata: Metadata }>
> {
  try {
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size !== expected.contents.byteLength
    ) {
      return { ok: false };
    }
    const contents = await readFile(path);
    const after = await lstat(path);
    if (!metadataEqual(before, after) || !contents.equals(expected.contents)) return { ok: false };
    return { ok: true, metadata: after };
  } catch {
    return { ok: false };
  }
}

async function inspectExisting(
  target: string,
  archive: StoredSkillArchive,
): Promise<ExistingState | undefined> {
  const expected = new Map(archive.files.map((file) => [file.relativePath, file]));
  const marker = installationMarker(basename(target), archive);
  const expectedDirectories = expectedDirectoryPaths(archive);
  const observed = new Set<string>();
  const observedDirectories = new Set<string>();
  const observedMetadata = new Map<string, Metadata>();
  const observedDirectoryMetadata = new Map<string, Metadata>();
  let skillMetadata: Metadata | undefined;
  let pendingMetadata: Metadata | undefined;
  let hasMarker = false;
  let valid = true;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      valid = false;
      return;
    }
    for (const name of names) {
      const path = join(directory, name);
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      let metadata: Metadata;
      try {
        metadata = await lstat(path);
      } catch {
        valid = false;
        return;
      }
      if (metadata.isSymbolicLink()) {
        valid = false;
        return;
      }
      if (metadata.isDirectory()) {
        if (!expectedDirectories.has(relativePath) || observedDirectories.has(relativePath)) {
          valid = false;
          return;
        }
        observedDirectories.add(relativePath);
        observedDirectoryMetadata.set(relativePath, metadata);
        await visit(path, relativePath);
        continue;
      }
      if (relativePath === INSTALL_STATE_MARKER) {
        const match = await stableFileMatches(path, marker);
        if (!match.ok || hasMarker) {
          valid = false;
          return;
        }
        hasMarker = true;
        continue;
      }
      const expectedPath = relativePath === PENDING_SKILL_DOCUMENT ? "SKILL.md" : relativePath;
      const expectedFile = expected.get(expectedPath);
      const match =
        expectedFile === undefined
          ? ({ ok: false } as const)
          : await stableFileMatches(path, expectedFile);
      if (!match.ok || observed.has(relativePath)) {
        valid = false;
        return;
      }
      observed.add(relativePath);
      observedMetadata.set(expectedPath, match.metadata);
      if (relativePath === "SKILL.md") skillMetadata = match.metadata;
      if (relativePath === PENDING_SKILL_DOCUMENT) pendingMetadata = match.metadata;
    }
  };
  await visit(target, "");
  if (!valid || observedDirectories.size > expectedDirectories.size) {
    return undefined;
  }
  const modesMatch =
    process.platform === "win32" ||
    (archive.files.every((file) => {
      const metadata = observedMetadata.get(file.relativePath);
      const expectedMode = file.executable ? 0o755 : 0o644;
      return metadata !== undefined && (Number(metadata.mode) & 0o777) === expectedMode;
    }) &&
      [...observedDirectoryMetadata.values()].every(
        (metadata) => (Number(metadata.mode) & 0o777) === 0o755,
      ));
  if (
    skillMetadata !== undefined &&
    pendingMetadata === undefined &&
    observed.size === expected.size &&
    observedDirectories.size === expectedDirectories.size &&
    !hasMarker
  ) {
    return modesMatch ? "complete" : undefined;
  }
  if (
    skillMetadata === undefined &&
    pendingMetadata !== undefined &&
    observed.size === expected.size &&
    observedDirectories.size === expectedDirectories.size &&
    !hasMarker
  ) {
    return "pending";
  }
  if (
    skillMetadata !== undefined &&
    pendingMetadata !== undefined &&
    sameIdentity(skillMetadata, pendingMetadata) &&
    observed.size === expected.size + 1 &&
    observedDirectories.size === expectedDirectories.size &&
    !hasMarker &&
    modesMatch
  ) {
    return "published-pending";
  }
  if (
    skillMetadata === undefined &&
    (hasMarker || (observed.size === 0 && observedDirectories.size === 0))
  ) {
    return "partial";
  }
  return undefined;
}

async function removePath(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // Cleanup is best effort; ownership checks guard destructive cleanup below.
  }
}

async function validateStagedSkill(path: string, skill: string): Promise<void> {
  let report: Awaited<ReturnType<typeof validateAgentSkill>>;
  try {
    report = await validateAgentSkill(path, { expectedName: skill });
  } catch {
    throw new TrustedInstallError(
      "artifact_invalid",
      "The installed skill could not be independently validated.",
    );
  }
  if (!report.ok) {
    throw new TrustedInstallError(
      "artifact_invalid",
      "The signed artifact does not pass this CLI's Agent Skill validation.",
    );
  }
}

async function writeArchive(staging: string, archive: StoredSkillArchive): Promise<void> {
  for (const file of archive.files) {
    const destination = join(staging, ...file.relativePath.split("/"));
    if (!safeChild(staging, destination)) unsafe("The archive escaped its staging directory.");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.contents, { flag: "wx", mode: 0o600 });
  }
}

function owned(
  metadata: Metadata,
  kind: OwnedEntry["kind"],
  expectedContents?: Buffer,
): OwnedEntry {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
    kind,
    ...(expectedContents === undefined
      ? {}
      : { sha256: createHash("sha256").update(expectedContents).digest("hex") }),
  });
}

function metadataMatchesOwnership(metadata: Metadata, expected: OwnedEntry): boolean {
  return (
    metadata.dev === expected.dev &&
    metadata.ino === expected.ino &&
    metadata.mode === expected.mode &&
    metadata.size === expected.size &&
    metadata.mtimeMs === expected.mtimeMs &&
    metadata.ctimeMs === expected.ctimeMs
  );
}

async function ownedTreeUnchanged(
  target: string,
  targetOwnership: OwnedEntry,
  entries: ReadonlyMap<string, OwnedEntry>,
): Promise<boolean> {
  try {
    const root = await lstat(target);
    if (
      !root.isDirectory() ||
      targetOwnership.kind !== "directory" ||
      !metadataMatchesOwnership(root, targetOwnership)
    ) {
      return false;
    }
    const observed = new Set<string>();
    const visit = async (directory: string, prefix: string): Promise<boolean> => {
      const names = await readdir(directory);
      for (const name of names) {
        const path = join(directory, name);
        const relativePath = prefix === "" ? name : `${prefix}/${name}`;
        const metadata = await lstat(path);
        const expected = entries.get(relativePath);
        const kind = metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : undefined;
        if (
          expected === undefined ||
          kind !== expected.kind ||
          !metadataMatchesOwnership(metadata, expected)
        ) {
          return false;
        }
        observed.add(relativePath);
        if (kind === "directory") {
          if (!(await visit(path, relativePath))) return false;
        } else if (expected.sha256 !== undefined) {
          const contents = await readFile(path);
          const after = await lstat(path);
          if (
            !metadataMatchesOwnership(after, expected) ||
            createHash("sha256").update(contents).digest("hex") !== expected.sha256
          ) {
            return false;
          }
        }
      }
      return true;
    };
    return (await visit(target, "")) && observed.size === entries.size;
  } catch {
    return false;
  }
}

async function cleanupOwnedTarget(
  target: string,
  targetOwnership: OwnedEntry,
  entries: ReadonlyMap<string, OwnedEntry>,
): Promise<boolean> {
  if (!(await ownedTreeUnchanged(target, targetOwnership, entries))) return false;
  const quarantine = await mkdtemp(join(dirname(target), ".skill-press-removing-"));
  const movedTarget = join(quarantine, "owned-target");
  let moved = false;
  let removed = false;
  try {
    await rename(target, movedTarget);
    moved = true;
    const relocated = await lstat(movedTarget);
    if (
      relocated.dev !== targetOwnership.dev ||
      relocated.ino !== targetOwnership.ino ||
      relocated.mode !== targetOwnership.mode ||
      relocated.size !== targetOwnership.size ||
      relocated.mtimeMs !== targetOwnership.mtimeMs
    ) {
      return false;
    }
    const relocatedOwnership = Object.freeze({
      ...targetOwnership,
      ctimeMs: relocated.ctimeMs,
    });
    if (!(await ownedTreeUnchanged(movedTarget, relocatedOwnership, entries))) return false;
    await removePath(quarantine);
    removed = true;
    return true;
  } catch {
    return false;
  } finally {
    if (!moved) await removePath(quarantine);
    else if (!removed) {
      try {
        await lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          try {
            await rename(movedTarget, target);
            await removePath(quarantine);
          } catch {
            // Preserve the target in quarantine if its canonical path cannot be restored safely.
          }
        }
      }
    }
  }
}

async function refreshDirectoryOwnership(
  target: string,
  relativeDirectory: string,
  ownedEntries: Map<string, OwnedEntry>,
  setTargetOwnership: (value: OwnedEntry) => void,
): Promise<void> {
  const path = relativeDirectory === "." ? target : join(target, ...relativeDirectory.split("/"));
  const entry = owned(await lstat(path), "directory");
  if (relativeDirectory === ".") setTargetOwnership(entry);
  else ownedEntries.set(relativeDirectory, entry);
}

async function ensureTargetDirectory(
  target: string,
  relativeDirectory: string,
  ownedEntries: Map<string, OwnedEntry>,
  setTargetOwnership: (value: OwnedEntry) => void,
): Promise<void> {
  if (relativeDirectory === ".") return;
  let current = "";
  for (const component of relativeDirectory.split("/")) {
    current = current === "" ? component : `${current}/${component}`;
    if (ownedEntries.has(current)) continue;
    const path = join(target, ...current.split("/"));
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        return conflict("The installation directory appeared with an unsafe identity.");
      }
      continue;
    }
    ownedEntries.set(current, owned(await lstat(path), "directory"));
    await refreshDirectoryOwnership(target, dirname(current), ownedEntries, setTargetOwnership);
  }
}

async function materializeFile(
  source: string,
  target: string,
  relativePath: string,
  expectedContents: Buffer,
  ownedEntries: Map<string, OwnedEntry>,
  setTargetOwnership: (value: OwnedEntry) => void,
): Promise<void> {
  await ensureTargetDirectory(target, dirname(relativePath), ownedEntries, setTargetOwnership);
  const destination = join(target, ...relativePath.split("/"));
  await link(source, destination);
  await refreshDirectoryOwnership(target, dirname(relativePath), ownedEntries, setTargetOwnership);
  ownedEntries.set(relativePath, owned(await lstat(destination), "file", expectedContents));
  await unlink(source);
  ownedEntries.set(relativePath, owned(await lstat(destination), "file", expectedContents));
}

async function materializeOrMatch(
  source: string,
  target: string,
  relativePath: string,
  expected: StoredArchiveFile,
  ownedEntries: Map<string, OwnedEntry>,
  setTargetOwnership: (value: OwnedEntry) => void,
): Promise<void> {
  const destination = join(target, ...relativePath.split("/"));
  const match = await stableFileMatches(destination, expected);
  if (match.ok) {
    await unlink(source);
    return;
  }
  try {
    await lstat(destination);
    return conflict("The interrupted installation contains a conflicting file.");
  } catch (error) {
    if (error instanceof TrustedInstallError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new TrustedInstallError(
        "install_conflict",
        "The interrupted installation target could not be inspected.",
      );
    }
  }
  await materializeFile(
    source,
    target,
    relativePath,
    expected.contents,
    ownedEntries,
    setTargetOwnership,
  );
}

async function ensureInstallationMarker(
  target: string,
  marker: StoredArchiveFile,
  ownedEntries: Map<string, OwnedEntry>,
  setTargetOwnership: (value: OwnedEntry) => void,
): Promise<void> {
  const path = join(target, INSTALL_STATE_MARKER);
  const match = await stableFileMatches(path, marker);
  if (match.ok) return;
  try {
    await lstat(path);
    return conflict("The installation state marker has a conflicting identity.");
  } catch (error) {
    if (error instanceof TrustedInstallError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, marker.contents, { flag: "wx", mode: 0o600 });
  await refreshDirectoryOwnership(target, ".", ownedEntries, setTargetOwnership);
  ownedEntries.set(INSTALL_STATE_MARKER, owned(await lstat(path), "file", marker.contents));
}

async function applyModes(
  target: string,
  archive: StoredSkillArchive,
  ownedEntries: Map<string, OwnedEntry>,
  setTargetOwnership: (value: OwnedEntry) => void,
  stagedDocumentName: typeof PENDING_SKILL_DOCUMENT | "SKILL.md",
): Promise<void> {
  if (process.platform === "win32") return;
  const directories = new Set<string>();
  for (const file of archive.files) {
    const ownedPath = file.relativePath === "SKILL.md" ? stagedDocumentName : file.relativePath;
    const path = join(target, ...ownedPath.split("/"));
    await chmod(path, file.executable ? 0o755 : 0o644);
    ownedEntries.set(ownedPath, owned(await lstat(path), "file", file.contents));
    let directory = dirname(file.relativePath);
    while (directory !== ".") {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    const path = join(target, ...directory.split("/"));
    await chmod(path, 0o755);
    ownedEntries.set(directory, owned(await lstat(path), "directory"));
  }
  await chmod(target, 0o755);
  setTargetOwnership(owned(await lstat(target), "directory"));
}

async function captureCommittedOwnership(
  target: string,
  archive: StoredSkillArchive,
): Promise<OwnedSnapshot> {
  const entries = new Map<string, OwnedEntry>();
  for (const directory of expectedDirectoryPaths(archive)) {
    const metadata = await lstat(join(target, ...directory.split("/")));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new TrustedInstallError("install_conflict", "The installed directory tree changed.");
    }
    entries.set(directory, owned(metadata, "directory"));
  }
  for (const file of archive.files) {
    const path = join(target, ...file.relativePath.split("/"));
    const match = await stableFileMatches(path, file);
    if (!match.ok) {
      throw new TrustedInstallError("install_conflict", "The installed file tree changed.");
    }
    entries.set(file.relativePath, owned(match.metadata, "file", file.contents));
  }
  const rootMetadata = await lstat(target);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new TrustedInstallError("install_conflict", "The installed target identity changed.");
  }
  const snapshot: OwnedSnapshot = Object.freeze({
    root: owned(rootMetadata, "directory"),
    entries,
  });
  if (!(await ownedTreeUnchanged(target, snapshot.root, snapshot.entries))) {
    throw new TrustedInstallError("install_conflict", "The installed tree changed during commit.");
  }
  return snapshot;
}

function inertPrepared(
  targetPath: string,
  installedPath: string,
  archive: StoredSkillArchive,
): PreparedInstallation {
  return Object.freeze({
    targetPath,
    installedPath,
    changed: false,
    commit: async (beforePublish?: BeforeSkillPublish, atPublish?: AtSkillPublish) => {
      await beforePublish?.();
      if ((await inspectExisting(targetPath, archive)) !== "complete") {
        return conflict("The existing installation changed before commit.");
      }
      atPublish?.();
      return Object.freeze({
        targetPath,
        installedPath,
        changed: false,
        rollback: async () => undefined,
      });
    },
    abort: async () => undefined,
  });
}

/** Stage and validate a skill, then publish SKILL.md last into a no-clobber directory. */
export async function prepareAtomicInstallation(
  projectRoot: string,
  skill: string,
  archive: StoredSkillArchive,
): Promise<PreparedInstallation> {
  const skillDocument = archive.files.find((file) => file.relativePath === "SKILL.md");
  if (skillDocument === undefined) {
    throw new TrustedInstallError(
      "artifact_invalid",
      "The verified archive does not contain its required SKILL.md.",
    );
  }
  const { targetRoot, stagingRoot } = await installationRoots(projectRoot);
  const targetPath = join(targetRoot, skill);
  const installedPath = `.agents/skills/${skill}`;
  if (!safeChild(targetRoot, targetPath)) unsafe("The requested installation target is unsafe.");

  let stagingContainer: string | undefined;
  try {
    stagingContainer = await mkdtemp(join(stagingRoot, ".release-"));
    const skillRoot = join(stagingContainer, skill);
    await mkdir(skillRoot, { mode: 0o700 });
    await writeArchive(skillRoot, archive);
    await validateStagedSkill(skillRoot, skill);
  } catch (error) {
    if (stagingContainer !== undefined) await removePath(stagingContainer);
    if (error instanceof TrustedInstallError) throw error;
    throw new TrustedInstallError("install_failed", "The verified skill could not be staged.", {
      cause: error,
    });
  }
  const containerPath = stagingContainer;
  const stagedPath = join(containerPath, skill);

  let existingState: ExistingState | undefined;
  try {
    const metadata = await lstat(targetPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      await removePath(containerPath);
      return conflict("The requested skill target already exists and is not a safe directory.");
    }
    existingState = await inspectExisting(targetPath, archive);
    if (existingState === undefined) {
      await removePath(containerPath);
      return conflict("The requested skill target already contains different content.");
    }
    if (existingState === "complete") {
      await removePath(containerPath);
      return inertPrepared(targetPath, installedPath, archive);
    }
  } catch (error) {
    if (error instanceof TrustedInstallError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await removePath(containerPath);
      throw new TrustedInstallError(
        "install_failed",
        "The installation target could not be inspected.",
      );
    }
  }

  let active = true;
  return Object.freeze({
    targetPath,
    installedPath,
    changed: true,
    abort: async () => {
      if (!active) return;
      active = false;
      await removePath(containerPath);
    },
    commit: async (beforePublish?: BeforeSkillPublish, atPublish?: AtSkillPublish) => {
      if (!active) {
        throw new TrustedInstallError(
          "install_failed",
          "The staged installation is no longer active.",
        );
      }
      const ownedEntries = new Map<string, OwnedEntry>();
      let targetOwnership: OwnedEntry | undefined;
      let createdTarget = false;
      const setTargetOwnership = (value: OwnedEntry): void => {
        targetOwnership = value;
      };
      let committedOwnership: OwnedSnapshot | undefined;
      const marker = installationMarker(skill, archive);
      try {
        if (existingState === undefined) {
          await mkdir(targetPath, { mode: 0o700 });
          createdTarget = true;
          targetOwnership = owned(await lstat(targetPath), "directory");
        } else {
          const state = await inspectExisting(targetPath, archive);
          if (state !== existingState) return conflict("The interrupted installation changed.");
        }
        if (existingState === undefined || existingState === "partial") {
          await ensureInstallationMarker(targetPath, marker, ownedEntries, setTargetOwnership);
          const nonDocumentFiles = archive.files.filter((file) => file.relativePath !== "SKILL.md");
          for (const file of nonDocumentFiles) {
            await materializeOrMatch(
              join(stagedPath, ...file.relativePath.split("/")),
              targetPath,
              file.relativePath,
              file,
              ownedEntries,
              setTargetOwnership,
            );
          }
          await materializeOrMatch(
            join(stagedPath, "SKILL.md"),
            targetPath,
            PENDING_SKILL_DOCUMENT,
            skillDocument,
            ownedEntries,
            setTargetOwnership,
          );
          await unlink(join(targetPath, INSTALL_STATE_MARKER));
          if (createdTarget) {
            ownedEntries.delete(INSTALL_STATE_MARKER);
            await refreshDirectoryOwnership(targetPath, ".", ownedEntries, setTargetOwnership);
          }
        }

        const pendingPath = join(targetPath, PENDING_SKILL_DOCUMENT);
        const skillPath = join(targetPath, "SKILL.md");
        await applyModes(
          targetPath,
          archive,
          ownedEntries,
          setTargetOwnership,
          PENDING_SKILL_DOCUMENT,
        );
        const readyState = await inspectExisting(targetPath, archive);
        const expectedReadyState =
          existingState === "published-pending" ? "published-pending" : "pending";
        if (readyState !== expectedReadyState) {
          return conflict("The materialized installation was not ready for publication.");
        }
        await beforePublish?.();
        if ((await inspectExisting(targetPath, archive)) !== expectedReadyState) {
          return conflict("The installation changed during its final publication guard.");
        }
        // Keep the freshness decision and no-clobber publication syscall in one synchronous turn;
        // fs/promises.link could otherwise wait behind unrelated libuv thread-pool work.
        atPublish?.();
        if (existingState !== "published-pending") {
          linkSync(pendingPath, skillPath);
          if (createdTarget) {
            await refreshDirectoryOwnership(targetPath, ".", ownedEntries, setTargetOwnership);
            ownedEntries.set(
              PENDING_SKILL_DOCUMENT,
              owned(await lstat(pendingPath), "file", skillDocument.contents),
            );
          }
        }
        const pendingIdentity = await lstat(pendingPath);
        const skillIdentity = await lstat(skillPath);
        if (!sameIdentity(pendingIdentity, skillIdentity)) {
          return conflict("The published SKILL.md did not retain its staged identity.");
        }
        if ((await inspectExisting(targetPath, archive)) !== "published-pending") {
          return conflict("The published installation failed identity verification.");
        }
        await unlink(pendingPath);
        if (createdTarget) {
          await refreshDirectoryOwnership(targetPath, ".", ownedEntries, setTargetOwnership);
          ownedEntries.delete(PENDING_SKILL_DOCUMENT);
          ownedEntries.set(
            "SKILL.md",
            owned(await lstat(skillPath), "file", skillDocument.contents),
          );
        }
        if ((await inspectExisting(targetPath, archive)) !== "complete") {
          return conflict("The materialized installation failed final verification.");
        }
        committedOwnership = await captureCommittedOwnership(targetPath, archive);
        await removePath(containerPath);
      } catch (error) {
        active = false;
        await removePath(containerPath);
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return conflict("The requested skill target appeared during installation.");
        }
        if (
          createdTarget &&
          targetOwnership !== undefined &&
          !(await cleanupOwnedTarget(targetPath, targetOwnership, ownedEntries))
        ) {
          return conflict(
            "The failed installation target was externally modified and was preserved.",
          );
        }
        if (error instanceof TrustedInstallError) throw error;
        throw new TrustedInstallError(
          "install_failed",
          "The skill installation could not be committed.",
          {
            cause: error,
          },
        );
      }
      active = false;
      const rollbackOwnership = createdTarget ? committedOwnership : undefined;
      return Object.freeze({
        targetPath,
        installedPath,
        changed: true,
        rollback: async () => {
          if (rollbackOwnership === undefined) return;
          await cleanupOwnedTarget(targetPath, rollbackOwnership.root, rollbackOwnership.entries);
        },
      });
    },
  });
}
