import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";

import { ProjectCreationError } from "./errors.js";
import { type ExpectedRenderedFile, INCOMPLETE_MARKER } from "./manifest.js";

const READ_BUFFER_BYTES = 64 * 1024;

export type FileMetadata = BigIntStats;

export interface OwnedEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly dev: bigint;
  readonly ino: bigint;
  readonly bytes?: number;
  readonly sha256?: string;
}

/** @internal Platform capability override used by the cross-platform filesystem tests. */
export interface DirectoryOpenCapabilities {
  readonly noFollow: number | undefined;
  readonly directory: number | undefined;
}

/** @internal Platform capability override used by the cross-platform filesystem tests. */
export interface FileOpenCapabilities {
  readonly noFollow: number | undefined;
}

function changedTypeError(kind: OwnedEntry["kind"]): ProjectCreationError {
  return new ProjectCreationError(
    "Created output changed type while it was being recorded.",
    "unsafe-output",
    [
      {
        code: "create.output_changed",
        path: "/",
        message: `created ${kind} changed type while it was being recorded`,
      },
    ],
  );
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function sameIdentity(
  expected: Pick<FileMetadata, "dev" | "ino">,
  actual: FileMetadata,
): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

async function closeQuietly(handle: Awaited<ReturnType<typeof open>> | undefined): Promise<void> {
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      // Verification has already completed or failed; a close error cannot make the handle safe.
    }
  }
}

async function digestExactBytes(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: number,
): Promise<string | undefined> {
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(READ_BUFFER_BYTES);
  let remaining = bytes;
  while (remaining > 0) {
    const requested = Math.min(buffer.length, remaining);
    const { bytesRead } = await handle.read(buffer, 0, requested, null);
    if (bytesRead === 0) {
      return undefined;
    }
    digest.update(buffer.subarray(0, bytesRead));
    remaining -= bytesRead;
  }
  const extra = Buffer.alloc(1);
  if ((await handle.read(extra, 0, 1, null)).bytesRead !== 0) {
    return undefined;
  }
  return digest.digest("hex");
}

/** @internal Not exported from the package root. */
export async function finalizeOwnedDirectory(
  entry: OwnedEntry,
  mode?: number,
  capabilities: DirectoryOpenCapabilities = {
    noFollow: (constants as Partial<typeof constants>).O_NOFOLLOW,
    directory: (constants as Partial<typeof constants>).O_DIRECTORY,
  },
): Promise<boolean> {
  const { noFollow, directory } = capabilities;
  if (typeof noFollow !== "number" || typeof directory !== "number") {
    // Windows does not expose either flag and does not implement POSIX directory modes.
    // A path-based chmod after lstat would add a symlink race, so verify only.
    try {
      const metadata = await lstat(entry.path, { bigint: true });
      return sameIdentity(entry, metadata) && metadata.isDirectory() && !metadata.isSymbolicLink();
    } catch {
      return false;
    }
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(entry.path, constants.O_RDONLY | noFollow | directory);
    const before = await handle.stat({ bigint: true });
    if (!sameIdentity(entry, before) || !before.isDirectory()) {
      return false;
    }
    if (mode === undefined) {
      return true;
    }
    await handle.chmod(mode);
    const after = await handle.stat({ bigint: true });
    return sameIdentity(entry, after) && after.isDirectory();
  } catch {
    return false;
  } finally {
    await closeQuietly(handle);
  }
}

/** @internal Not exported from the package root. */
export async function finalizeOwnedFile(
  entry: OwnedEntry,
  expected: ExpectedRenderedFile | undefined,
  mode?: number,
  capabilities: FileOpenCapabilities = {
    noFollow: (constants as Partial<typeof constants>).O_NOFOLLOW,
  },
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const { noFollow } = capabilities;
    if (typeof noFollow !== "number") {
      const pathBeforeOpen = await lstat(entry.path, { bigint: true });
      if (
        !sameIdentity(entry, pathBeforeOpen) ||
        !pathBeforeOpen.isFile() ||
        pathBeforeOpen.isSymbolicLink()
      ) {
        return false;
      }
    }
    handle = await open(
      entry.path,
      constants.O_RDONLY | (typeof noFollow === "number" ? noFollow : 0),
    );
    const before = await handle.stat({ bigint: true });
    if (!sameIdentity(entry, before) || !before.isFile()) {
      return false;
    }
    if (expected !== undefined) {
      if (before.size !== BigInt(expected.bytes)) {
        return false;
      }
      const digest = await digestExactBytes(handle, expected.bytes);

      const afterRead = await handle.stat({ bigint: true });
      if (
        !sameIdentity(entry, afterRead) ||
        !afterRead.isFile() ||
        afterRead.size !== BigInt(expected.bytes) ||
        digest !== expected.sha256
      ) {
        return false;
      }
    }
    if (mode !== undefined && typeof noFollow === "number") {
      await handle.chmod(mode);
      const afterChmod = await handle.stat({ bigint: true });
      if (!sameIdentity(entry, afterChmod) || !afterChmod.isFile()) {
        return false;
      }
    }
    const finalPath = await lstat(entry.path, { bigint: true });
    return sameIdentity(entry, finalPath) && finalPath.isFile() && !finalPath.isSymbolicLink();
  } catch {
    return false;
  } finally {
    await closeQuietly(handle);
  }
}

/** @internal Not exported from the package root. */
export async function matchesOwnedFile(entry: OwnedEntry): Promise<boolean> {
  if (
    entry.kind !== "file" ||
    !Number.isSafeInteger(entry.bytes) ||
    (entry.bytes as number) < 0 ||
    typeof entry.sha256 !== "string"
  ) {
    return false;
  }
  return finalizeOwnedFile(entry, {
    bytes: entry.bytes as number,
    sha256: entry.sha256,
  });
}

function compareAscii(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function hasExactInventory(root: string, entries: readonly OwnedEntry[]): Promise<boolean> {
  const children = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.kind === "directory") {
      children.set(entry.path, []);
    }
  }
  for (const entry of entries) {
    if (entry.path !== root) {
      children.get(dirname(entry.path))?.push(basename(entry.path));
    }
  }

  try {
    for (const [directory, expected] of children) {
      const owned = entries.find((entry) => entry.path === directory) as OwnedEntry;
      const metadata = await lstat(directory, { bigint: true });
      if (!sameIdentity(owned, metadata) || !metadata.isDirectory() || metadata.isSymbolicLink()) {
        return false;
      }
      const actual = (await readdir(directory)).sort(compareAscii);
      const sortedExpected = expected.sort(compareAscii);
      if (
        actual.length !== expected.length ||
        actual.some((name, index) => name !== sortedExpected[index])
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function verifyOwnedTree(
  root: string,
  entries: readonly OwnedEntry[],
  expectedFiles: ReadonlyMap<string, ExpectedRenderedFile>,
  finalizeModes: boolean,
): Promise<boolean> {
  const rootEntry = entries[0];
  if (rootEntry === undefined || rootEntry.path !== root || rootEntry.kind !== "directory") {
    return false;
  }
  const journal = new Map<string, OwnedEntry>();
  for (const entry of entries) {
    const pathFromRoot = relative(root, entry.path);
    if (
      journal.has(entry.path) ||
      (entry.path !== root &&
        (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)))
    ) {
      return false;
    }
    journal.set(entry.path, entry);
  }
  for (const entry of entries.slice(1)) {
    if (journal.get(dirname(entry.path))?.kind !== "directory") {
      return false;
    }
  }
  if (!(await hasExactInventory(root, entries))) {
    return false;
  }

  const matchedExpectedFiles = new Set<string>();
  for (const entry of entries) {
    const relativePath = relative(root, entry.path).split(sep).join("/");
    const expected = expectedFiles.get(relativePath);
    if (expected !== undefined && entry.kind !== "file") {
      return false;
    }
    if (entry.kind === "file" && expected === undefined && relativePath !== INCOMPLETE_MARKER) {
      return false;
    }
    if (expected !== undefined) {
      matchedExpectedFiles.add(relativePath);
    }
    const verified =
      entry.kind === "directory"
        ? await finalizeOwnedDirectory(entry, finalizeModes ? 0o755 : undefined)
        : await finalizeOwnedFile(
            entry,
            expected ??
              (entry.bytes !== undefined && entry.sha256 !== undefined
                ? { bytes: entry.bytes, sha256: entry.sha256 }
                : undefined),
            finalizeModes && expected !== undefined ? 0o644 : undefined,
          );
    if (!verified) {
      return false;
    }
    try {
      const metadata = await lstat(entry.path, { bigint: true });
      const matchesType = entry.kind === "directory" ? metadata.isDirectory() : metadata.isFile();
      if (!sameIdentity(entry, metadata) || !matchesType || metadata.isSymbolicLink()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return (
    matchedExpectedFiles.size === expectedFiles.size &&
    [...expectedFiles.keys()].every((path) => matchedExpectedFiles.has(path))
  );
}

export async function recordOwned(path: string, kind: OwnedEntry["kind"]): Promise<OwnedEntry> {
  const metadata = await lstat(path, { bigint: true });
  const matches = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (!matches || metadata.isSymbolicLink()) {
    throw changedTypeError(kind);
  }
  const entry = { path, kind, dev: metadata.dev, ino: metadata.ino };
  if (kind === "directory") {
    return entry;
  }
  if (metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw changedTypeError(kind);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow = (constants as Partial<typeof constants>).O_NOFOLLOW;
    handle = await open(path, constants.O_RDONLY | (typeof noFollow === "number" ? noFollow : 0));
    const before = await handle.stat({ bigint: true });
    if (!sameIdentity(entry, before) || !before.isFile() || before.size !== metadata.size) {
      throw changedTypeError(kind);
    }
    const bytes = Number(before.size);
    const sha256 = await digestExactBytes(handle, bytes);
    const afterRead = await handle.stat({ bigint: true });
    const finalPath = await lstat(path, { bigint: true });
    if (
      sha256 === undefined ||
      !sameIdentity(entry, afterRead) ||
      !afterRead.isFile() ||
      afterRead.size !== before.size ||
      !sameIdentity(entry, finalPath) ||
      !finalPath.isFile() ||
      finalPath.isSymbolicLink()
    ) {
      throw changedTypeError(kind);
    }
    return { ...entry, bytes, sha256 };
  } catch (error) {
    if (error instanceof ProjectCreationError) {
      throw error;
    }
    throw changedTypeError(kind);
  } finally {
    await closeQuietly(handle);
  }
}
