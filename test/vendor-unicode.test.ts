import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const repositoryRoot = new URL("../", import.meta.url);
const repositoryPath = fileURLToPath(repositoryRoot);
const execFileAsync = promisify(execFile);

const unicodeFiles = [
  {
    file: "CaseFolding.txt",
    bytes: 84_870,
    displayBytes: "84,870",
    sha256: "4e55acfdc32825a22e87670e9056a3bf94ad7c5400065778e9e10f8314372bcf",
    header: "# CaseFolding-15.1.0.txt\n",
    upstream: "https://www.unicode.org/Public/15.1.0/ucd/CaseFolding.txt",
  },
  {
    file: "DerivedAge.txt",
    bytes: 131_154,
    displayBytes: "131,154",
    sha256: "04e16379344bdb9973cdb6f6bf0a5dd66f7cd41b014cd9f79d848768ae757256",
    header: "# DerivedAge-15.1.0.txt\n",
    upstream: "https://www.unicode.org/Public/15.1.0/ucd/DerivedAge.txt",
  },
  {
    file: "DerivedCoreProperties.txt",
    bytes: 1_072_686,
    displayBytes: "1,072,686",
    sha256: "f55d0db69123431a7317868725b1fcbf1eab6b265d756d1bd7f0f6d9f9ee108b",
    header: "# DerivedCoreProperties-15.1.0.txt\n",
    upstream: "https://www.unicode.org/Public/15.1.0/ucd/DerivedCoreProperties.txt",
  },
] as const;

const comparableTextUnicodeFile = {
  file: "DerivedGeneralCategory.txt",
  bytes: 277_514,
  displayBytes: "277,514",
  sha256: "d62e5bab70ca74f099343f71224fa051cb1fdd61a1ab45c0488c44cfc0b6102e",
  header: "# DerivedGeneralCategory-17.0.0.txt\n",
  upstream: "https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedGeneralCategory.txt",
} as const;

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function provenanceTable(document: string): readonly string[] {
  const lines = document.split("\n");
  const start = lines.indexOf("| File | Upstream | Bytes | SHA-256 |");
  if (start < 0) {
    return [];
  }

  const rows: string[] = [];
  for (let index = start; index < lines.length && lines[index]?.startsWith("|"); index += 1) {
    rows.push(lines[index] ?? "");
  }
  return rows;
}

describe("vendored Unicode portability data", () => {
  it.each(unicodeFiles)(
    "pins $file byte-for-byte",
    async ({ file, bytes, sha256: digest, header }) => {
      const content = await readFile(new URL(`vendor/unicode/15.1.0/${file}`, repositoryRoot));

      expect(content.byteLength).toBe(bytes);
      expect(sha256(content)).toBe(digest);
      expect(content.toString("utf8").startsWith(header)).toBe(true);
    },
  );

  it("pins the Unicode 17 general-category source byte-for-byte", async () => {
    const content = await readFile(
      new URL(`vendor/unicode/17.0.0/${comparableTextUnicodeFile.file}`, repositoryRoot),
    );

    expect(content.byteLength).toBe(comparableTextUnicodeFile.bytes);
    expect(sha256(content)).toBe(comparableTextUnicodeFile.sha256);
    expect(content.toString("utf8").startsWith(comparableTextUnicodeFile.header)).toBe(true);
  });

  it("carries the exact official Unicode License V3 text", async () => {
    const license = await readFile(new URL("LICENSES/Unicode-3.0.txt", repositoryRoot));

    expect(license.byteLength).toBe(1_995);
    expect(sha256(license)).toBe(
      "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96",
    );
    expect(license.toString("utf8")).toMatch(/^UNICODE LICENSE V3\n/u);
  });

  it("records sources, integrity values, and the complete license", async () => {
    const notice = await readFile(new URL("THIRD_PARTY_NOTICES.md", repositoryRoot), "utf8");
    const readme = await readFile(
      new URL("vendor/unicode/15.1.0/README.md", repositoryRoot),
      "utf8",
    );
    const comparableTextReadme = await readFile(
      new URL("vendor/unicode/17.0.0/README.md", repositoryRoot),
      "utf8",
    );

    const expectedTable = [
      "| File | Upstream | Bytes | SHA-256 |",
      "| --- | --- | ---: | --- |",
      ...unicodeFiles.map(
        (entry) =>
          `| \`${entry.file}\` | <${entry.upstream}> | ${entry.displayBytes} | ` +
          `\`${entry.sha256}\` |`,
      ),
    ];
    expect(provenanceTable(notice)).toEqual(expectedTable);
    expect(provenanceTable(readme)).toEqual(expectedTable);
    for (const entry of unicodeFiles) {
      expect(notice.split(entry.file)).toHaveLength(3);
      expect(readme.split(entry.file)).toHaveLength(3);
    }
    expect(notice).toContain("[`LICENSES/Unicode-3.0.txt`](LICENSES/Unicode-3.0.txt)");
    expect(readme).toContain("[`LICENSES/Unicode-3.0.txt`](../../../LICENSES/Unicode-3.0.txt)");
    expect(notice).toContain("SPDX license identifier: `Unicode-3.0`");
    expect(readme).toContain("Source retrieval date: 2026-08-19");

    const expectedComparableTextTable = [
      "| File | Upstream | Bytes | SHA-256 |",
      "| --- | --- | ---: | --- |",
      `| \`${comparableTextUnicodeFile.file}\` | <${comparableTextUnicodeFile.upstream}> | ` +
        `${comparableTextUnicodeFile.displayBytes} | \`${comparableTextUnicodeFile.sha256}\` |`,
    ];
    const comparableTextNotice = notice.slice(
      notice.indexOf("## Unicode Character Database 17.0.0"),
    );
    expect(provenanceTable(comparableTextNotice)).toEqual(expectedComparableTextTable);
    expect(provenanceTable(comparableTextReadme)).toEqual(expectedComparableTextTable);
    expect(notice.split(comparableTextUnicodeFile.file)).toHaveLength(3);
    expect(comparableTextReadme.split(comparableTextUnicodeFile.file)).toHaveLength(3);
    expect(comparableTextReadme).toContain(
      "[`LICENSES/Unicode-3.0.txt`](../../../LICENSES/Unicode-3.0.txt)",
    );
    expect(comparableTextReadme).toContain("Source retrieval date: 2026-08-24");
  });

  it("ships notices and licenses while excluding generation inputs", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("package.json", repositoryRoot), "utf8"),
    ) as { readonly files: readonly string[] };

    expect(manifest.files).toEqual([
      "dist/",
      "schemas/",
      "LICENSES/",
      "LICENSE",
      "README.md",
      "THIRD_PARTY_NOTICES.md",
    ]);
    expect(manifest.files.some((path) => path === "vendor" || path.startsWith("vendor/"))).toBe(
      false,
    );

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const { stdout } = await execFileAsync(
      npm,
      ["pack", "--dry-run", "--ignore-scripts", "--json"],
      {
        cwd: repositoryPath,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    type PackManifest = {
      readonly files: ReadonlyArray<{ readonly path: string }>;
    };
    const parsed = JSON.parse(stdout) as readonly PackManifest[] | Record<string, PackManifest>;
    const packs = Array.isArray(parsed) ? parsed : Object.values(parsed);
    expect(packs).toHaveLength(1);
    const packedPaths = packs[0]?.files.map((entry) => entry.path) ?? [];
    expect(packedPaths).toContain("LICENSES/Unicode-3.0.txt");
    expect(packedPaths).toContain("THIRD_PARTY_NOTICES.md");
    expect(packedPaths.some((path) => path === "vendor" || path.startsWith("vendor/"))).toBe(false);

    const rawDigests = new Set([
      ...unicodeFiles.map((entry) => entry.sha256),
      comparableTextUnicodeFile.sha256,
    ]);
    const packedDigests = await Promise.all(
      packedPaths.map(async (path) => sha256(await readFile(resolve(repositoryPath, path)))),
    );
    expect(packedDigests.some((digest) => rawDigests.has(digest))).toBe(false);
  });
});
