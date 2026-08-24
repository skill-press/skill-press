import { randomUUID } from "node:crypto";
import { lstat, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  type FileMetadata,
  matchesOwnedFile,
  type OwnedEntry,
  sameIdentity,
} from "./owned-tree.js";

export async function cleanupOwned(entries: readonly OwnedEntry[]): Promise<boolean> {
  let complete = true;
  for (const entry of [...entries].reverse()) {
    let metadata: FileMetadata;
    try {
      metadata = await lstat(entry.path, { bigint: true });
    } catch {
      complete = false;
      continue;
    }

    if (
      !sameIdentity(entry, metadata) ||
      metadata.isSymbolicLink() ||
      (entry.kind === "file" && !(await matchesOwnedFile(entry)))
    ) {
      complete = false;
      continue;
    }
    try {
      if (entry.kind === "file") {
        await unlink(entry.path);
      } else {
        await rmdir(entry.path);
      }
    } catch {
      complete = false;
    }
  }
  return complete;
}

async function restoreIncompleteMarker(root: OwnedEntry, markerPath: string): Promise<void> {
  try {
    const rootMetadata = await lstat(root.path, { bigint: true });
    if (sameIdentity(root, rootMetadata) && rootMetadata.isDirectory()) {
      await writeFile(markerPath, `${randomUUID()}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
  } catch {
    // Cleanup remains failed; never overwrite a path that raced with marker restoration.
  }
}

export async function cleanupClaimedTarget(
  entries: readonly OwnedEntry[],
  markerPath: string,
  afterMarkerRemoved?: () => void | Promise<void>,
): Promise<boolean> {
  if (entries.length === 0) {
    return true;
  }
  const root = entries[0] as OwnedEntry;
  const marker = entries.find((entry) => entry.path === markerPath);
  const body = entries.filter((entry) => entry !== root && entry !== marker);
  if (!(await cleanupOwned(body))) {
    return false;
  }

  try {
    const rootMetadata = await lstat(root.path, { bigint: true });
    if (!sameIdentity(root, rootMetadata) || !rootMetadata.isDirectory()) {
      return false;
    }
    const remaining = await readdir(root.path);
    if (marker === undefined) {
      if (remaining.length !== 0) {
        return false;
      }
    } else {
      const markerMetadata = await lstat(marker.path, { bigint: true });
      if (
        !sameIdentity(marker, markerMetadata) ||
        !markerMetadata.isFile() ||
        !(await matchesOwnedFile(marker)) ||
        remaining.length !== 1 ||
        remaining[0] !== basename(marker.path)
      ) {
        return false;
      }
      await unlink(marker.path);
      await afterMarkerRemoved?.();
    }
    await rmdir(root.path);
    return true;
  } catch {
    if (marker !== undefined) {
      await restoreIncompleteMarker(root, marker.path);
    }
    return false;
  }
}
