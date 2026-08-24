import { realpathSync, symlinkSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { INCOMPLETE_MARKER } from "../src/create/manifest.js";
import { cleanupClaimedTarget, cleanupOwned } from "../src/create/owned-cleanup.js";
import { type OwnedEntry, recordOwned } from "../src/create/owned-tree.js";

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(temporaryRoot, "skillpress-owned-cleanup-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface CleanupFixture {
  readonly root: string;
  readonly marker: string;
  readonly file: string;
  readonly entries: OwnedEntry[];
}

async function createCleanupFixture(): Promise<CleanupFixture> {
  const parent = await temporaryDirectory();
  const root = join(parent, "tree");
  const nested = join(root, "nested");
  const marker = join(root, INCOMPLETE_MARKER);
  const file = join(nested, "file.txt");
  await mkdir(root);
  const entries = [await recordOwned(root, "directory")];
  await writeFile(marker, "transaction\n", { flag: "wx", mode: 0o600 });
  entries.push(await recordOwned(marker, "file"));
  await mkdir(nested);
  entries.push(await recordOwned(nested, "directory"));
  await writeFile(file, "owned\n", { flag: "wx", mode: 0o600 });
  entries.push(await recordOwned(file, "file"));
  return { root, marker, file, entries };
}

describe("owned tree cleanup", () => {
  it("cleans a known tree in reverse order", async () => {
    const fixture = await createCleanupFixture();

    await expect(cleanupOwned(fixture.entries)).resolves.toBe(true);
    await expect(lstat(fixture.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves paths whose identity or contents are no longer owned", async () => {
    const missing = await createCleanupFixture();
    await unlink(missing.file);
    await expect(cleanupOwned(missing.entries)).resolves.toBe(false);

    const replaced = await createCleanupFixture();
    await unlink(replaced.file);
    await writeFile(replaced.file, "foreign", { flag: "wx" });
    await expect(cleanupOwned(replaced.entries)).resolves.toBe(false);
    await expect(readFile(replaced.file, "utf8")).resolves.toBe("foreign");

    const sameSize = await createCleanupFixture();
    await unlink(sameSize.file);
    await writeFile(sameSize.file, "alien\n", { flag: "wx" });
    await expect(cleanupOwned(sameSize.entries)).resolves.toBe(false);
    await expect(readFile(sameSize.file, "utf8")).resolves.toBe("alien\n");

    const nonempty = await createCleanupFixture();
    await writeFile(join(nonempty.root, "foreign"), "keep", { flag: "wx" });
    await expect(cleanupOwned(nonempty.entries)).resolves.toBe(false);
    await expect(readFile(join(nonempty.root, "foreign"), "utf8")).resolves.toBe("keep");
  });

  it.runIf(process.platform !== "win32")(
    "preserves a replacement symlink and its external target",
    async () => {
      const fixture = await createCleanupFixture();
      const external = join(await temporaryDirectory(), "external");
      await writeFile(external, "preserve", { flag: "wx" });
      await unlink(fixture.file);
      symlinkSync(external, fixture.file);

      await expect(cleanupOwned(fixture.entries)).resolves.toBe(false);
      expect((await lstat(fixture.file)).isSymbolicLink()).toBe(true);
      await expect(readFile(external, "utf8")).resolves.toBe("preserve");
    },
  );

  it("removes an exact claimed target and invokes the marker boundary callback", async () => {
    const fixture = await createCleanupFixture();
    const callback = vi.fn();

    await expect(cleanupClaimedTarget(fixture.entries, fixture.marker, callback)).resolves.toBe(
      true,
    );
    expect(callback).toHaveBeenCalledOnce();
    await expect(lstat(fixture.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("handles an empty journal and an unmarked empty root", async () => {
    await expect(cleanupClaimedTarget([], "unused")).resolves.toBe(true);

    const parent = await temporaryDirectory();
    const root = join(parent, "root");
    await mkdir(root);
    const entry = await recordOwned(root, "directory");
    await expect(cleanupClaimedTarget([entry], join(root, INCOMPLETE_MARKER))).resolves.toBe(true);
  });

  it("rejects changed root and marker journal identities", async () => {
    const changedRoot = await createCleanupFixture();
    const wrongRoot = { ...(changedRoot.entries[0] as OwnedEntry), ino: -1n };
    await expect(
      cleanupClaimedTarget([wrongRoot, ...changedRoot.entries.slice(1)], changedRoot.marker),
    ).resolves.toBe(false);

    const changedMarker = await createCleanupFixture();
    const wrongMarker = { ...(changedMarker.entries[1] as OwnedEntry), ino: -1n };
    await expect(
      cleanupClaimedTarget(
        [changedMarker.entries[0] as OwnedEntry, wrongMarker, ...changedMarker.entries.slice(2)],
        changedMarker.marker,
      ),
    ).resolves.toBe(false);
  });

  it("does not remove an unmarked root that contains unknown data", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "root");
    await mkdir(root);
    const entry = await recordOwned(root, "directory");
    await writeFile(join(root, "foreign"), "preserve", { flag: "wx" });

    await expect(cleanupClaimedTarget([entry], join(root, INCOMPLETE_MARKER))).resolves.toBe(false);
    await expect(readFile(join(root, "foreign"), "utf8")).resolves.toBe("preserve");
  });

  it("keeps the marker when unknown data makes target cleanup unsafe", async () => {
    const fixture = await createCleanupFixture();
    await writeFile(join(fixture.root, "foreign"), "preserve", { flag: "wx" });

    await expect(cleanupClaimedTarget(fixture.entries, fixture.marker)).resolves.toBe(false);
    expect(await readdir(fixture.root)).toEqual(
      expect.arrayContaining([INCOMPLETE_MARKER, "foreign"]),
    );
  });

  it("restores the marker if the final directory removal loses a race", async () => {
    const fixture = await createCleanupFixture();

    await expect(
      cleanupClaimedTarget(fixture.entries, fixture.marker, async () => {
        await writeFile(join(fixture.root, "foreign"), "preserve", { flag: "wx" });
        throw new Error("injected cleanup race");
      }),
    ).resolves.toBe(false);

    await expect(readFile(join(fixture.root, "foreign"), "utf8")).resolves.toBe("preserve");
    await expect(readFile(fixture.marker, "utf8")).resolves.toMatch(/^[0-9a-f-]+\n$/u);
  });

  it("never overwrites a foreign marker during restoration", async () => {
    const fixture = await createCleanupFixture();

    await expect(
      cleanupClaimedTarget(fixture.entries, fixture.marker, async () => {
        await writeFile(fixture.marker, "foreign marker\n", { flag: "wx" });
        throw new Error("injected marker race");
      }),
    ).resolves.toBe(false);

    await expect(readFile(fixture.marker, "utf8")).resolves.toBe("foreign marker\n");
  });
});
