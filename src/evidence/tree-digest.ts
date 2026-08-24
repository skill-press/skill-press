import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface TreeDigestLimits {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_TREE_DIGEST_LIMITS: TreeDigestLimits = Object.freeze({
  maxEntries: 2048,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
});

function validLimits(limits: TreeDigestLimits): boolean {
  return (
    Number.isSafeInteger(limits.maxEntries) &&
    limits.maxEntries > 0 &&
    Number.isSafeInteger(limits.maxFileBytes) &&
    limits.maxFileBytes > 0 &&
    Number.isSafeInteger(limits.maxTotalBytes) &&
    limits.maxTotalBytes >= limits.maxFileBytes
  );
}

/** Digest a real, bounded directory tree including relative paths and executable bits. */
export async function digestBoundedTree(
  root: string,
  limits: TreeDigestLimits = DEFAULT_TREE_DIGEST_LIMITS,
): Promise<string> {
  if (!validLimits(limits)) throw new TypeError("Tree digest limits are invalid.");
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new TypeError("Tree digest root must be a real directory.");
  }
  const hash = createHash("sha256");
  let entries = 0;
  let totalBytes = 0;

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const names = await readdir(directory);
    names.sort();
    for (const name of names) {
      entries += 1;
      if (entries > limits.maxEntries) throw new TypeError("Tree digest entry limit exceeded.");
      const path = join(directory, name);
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new TypeError("Tree digest rejects symbolic links.");
      if (metadata.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        await visit(path, relativePath);
      } else if (metadata.isFile()) {
        if (metadata.size > limits.maxFileBytes) {
          throw new TypeError("Tree digest file limit exceeded.");
        }
        totalBytes += metadata.size;
        if (totalBytes > limits.maxTotalBytes) {
          throw new TypeError("Tree digest byte limit exceeded.");
        }
        const content = await readFile(path);
        const executable = (metadata.mode & 0o111) === 0 ? "0" : "1";
        hash.update(`F\0${relativePath}\0${executable}\0${content.byteLength}\0`);
        hash.update(content);
      } else {
        throw new TypeError("Tree digest rejects special files.");
      }
    }
  }

  await visit(root, "");
  return hash.digest("hex");
}
