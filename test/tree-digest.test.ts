import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { digestBoundedTree } from "../src/evidence/tree-digest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skillpress-tree-digest-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "SKILL.md"), "fixed\n");
  await writeFile(join(root, "nested/tool"), "tool\n");
  return root;
}

describe("bounded tree digest", () => {
  it("is stable, order independent, and binds content and executable bits", async () => {
    const root = await fixture();
    const first = await digestBoundedTree(root);
    expect(await digestBoundedTree(root)).toBe(first);
    await chmod(join(root, "nested/tool"), 0o755);
    expect(await digestBoundedTree(root)).not.toBe(first);
    await chmod(join(root, "nested/tool"), 0o644);
    await writeFile(join(root, "SKILL.md"), "changed\n");
    expect(await digestBoundedTree(root)).not.toBe(first);
  });

  it("rejects non-directories, symlinks, special limits, and invalid limits", async () => {
    const root = await fixture();
    await expect(digestBoundedTree(join(root, "SKILL.md"))).rejects.toThrow("real directory");
    await symlink(join(root, "SKILL.md"), join(root, "linked"));
    await expect(digestBoundedTree(root)).rejects.toThrow("symbolic links");
    await rm(join(root, "linked"));
    await expect(
      digestBoundedTree(root, { maxEntries: 1, maxFileBytes: 10, maxTotalBytes: 20 }),
    ).rejects.toThrow("entry limit");
    await expect(
      digestBoundedTree(root, { maxEntries: 5, maxFileBytes: 2, maxTotalBytes: 20 }),
    ).rejects.toThrow("file limit");
    await expect(
      digestBoundedTree(root, { maxEntries: 5, maxFileBytes: 10, maxTotalBytes: 5 }),
    ).rejects.toThrow(TypeError);
  });
});
