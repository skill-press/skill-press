import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parsePunctuationAndSymbol } from "../scripts/unicode-general-category-table.mjs";

const repositoryRoot = new URL("../", import.meta.url);

async function generalCategoryLines() {
  const source = await readFile(
    new URL("vendor/unicode/17.0.0/DerivedGeneralCategory.txt", repositoryRoot),
    "utf8",
  );
  return source.slice(0, -1).split("\n");
}

describe("punctuation and symbol Unicode table generation", () => {
  it("extracts the pinned complete category union", async () => {
    const ranges = parsePunctuationAndSymbol(await generalCategoryLines());

    expect(ranges).toHaveLength(355);
    expect(ranges[0]).toEqual([0x21, 0x2f]);
    expect(ranges.at(-1)).toEqual([0x1fbfa, 0x1fbfa]);
    expect(ranges.reduce((count, [start, end]) => count + end - start + 1, 0)).toBe(9_473);
  });

  it("rejects category, partition, and surrogate mutations", async () => {
    const original = await generalCategoryLines();
    const changedHeading = [...original];
    const punctuationHeading = changedHeading.indexOf("# General_Category=Dash_Punctuation");
    expect(punctuationHeading).toBeGreaterThanOrEqual(0);
    changedHeading[punctuationHeading] = "# General_Category=Other_Punctuation";
    expect(() => parsePunctuationAndSymbol(changedHeading)).toThrow(/section 20 is unexpected/u);

    const changedPartition = [...original];
    const hyphen = changedPartition.findIndex((line) => line.startsWith("002D          ; Pd"));
    expect(hyphen).toBeGreaterThanOrEqual(0);
    changedPartition[hyphen] = changedPartition[hyphen].replace(/^002D/u, "0030");
    expect(() => parsePunctuationAndSymbol(changedPartition)).toThrow(
      /does not partition the code-point space/u,
    );

    const surrogate = [...original];
    surrogate[hyphen] = surrogate[hyphen].replace(/^002D/u, "D800");
    expect(() => parsePunctuationAndSymbol(surrogate)).toThrow(
      /intersects the surrogate range|not strictly ordered/u,
    );
  });
});
