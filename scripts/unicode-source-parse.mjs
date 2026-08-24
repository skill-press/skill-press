import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

export const UNICODE_VERSION = "15.1.0";
export const COMPARABLE_TEXT_GENERAL_CATEGORY_VERSION = "17.0.0";
export const MAX_CODE_POINT = 0x10ffff;
export const SURROGATE_START = 0xd800;
export const SURROGATE_END = 0xdfff;

const inputs = {
  caseFolding: {
    path: "vendor/unicode/15.1.0/CaseFolding.txt",
    bytes: 84_870,
    sha256: "4e55acfdc32825a22e87670e9056a3bf94ad7c5400065778e9e10f8314372bcf",
    header: "# CaseFolding-15.1.0.txt",
  },
  derivedAge: {
    path: "vendor/unicode/15.1.0/DerivedAge.txt",
    bytes: 131_154,
    sha256: "04e16379344bdb9973cdb6f6bf0a5dd66f7cd41b014cd9f79d848768ae757256",
    header: "# DerivedAge-15.1.0.txt",
  },
  derivedCoreProperties: {
    path: "vendor/unicode/15.1.0/DerivedCoreProperties.txt",
    bytes: 1_072_686,
    sha256: "f55d0db69123431a7317868725b1fcbf1eab6b265d756d1bd7f0f6d9f9ee108b",
    header: "# DerivedCoreProperties-15.1.0.txt",
  },
  derivedGeneralCategory: {
    path: "vendor/unicode/17.0.0/DerivedGeneralCategory.txt",
    bytes: 277_514,
    sha256: "d62e5bab70ca74f099343f71224fa051cb1fdd61a1ab45c0488c44cfc0b6102e",
    header: "# DerivedGeneralCategory-17.0.0.txt",
  },
};

const caseFoldingRecordPattern =
  /^([0-9A-F]{4,6}); ([CFST]); ([0-9A-F]{4,6}(?: [0-9A-F]{4,6})*); # .+$/;
const statusRanks = new Map([
  ["C", 0],
  ["F", 1],
  ["S", 2],
  ["T", 3],
]);

export function assertGeneration(condition, message) {
  if (!condition) {
    throw new Error(`Unicode table generation failed: ${message}`);
  }
}

export function expectCount(actual, expected, label) {
  assertGeneration(actual === expected, `${label}: expected ${expected}, received ${actual}`);
}

export function isCodePoint(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CODE_POINT;
}

export function isAscii(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}

function isScalar(value) {
  return isCodePoint(value) && (value < SURROGATE_START || value > SURROGATE_END);
}

export function compareUnicodeVersions(left, right) {
  return left[0] - right[0] || left[1] - right[1];
}

async function readPinnedInput(input) {
  const filePath = fileURLToPath(new URL(`../${input.path}`, import.meta.url));
  const bytes = await readFile(filePath);

  expectCount(bytes.byteLength, input.bytes, `${input.path} byte length`);
  assertGeneration(
    createHash("sha256").update(bytes).digest("hex") === input.sha256,
    `${input.path} SHA-256 does not match the pinned digest`,
  );

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Unicode table generation failed: ${input.path} is not valid UTF-8`);
  }

  assertGeneration(!text.includes("\r"), `${input.path} must use LF line endings`);
  assertGeneration(text.endsWith("\n"), `${input.path} must end with a newline`);

  const lines = text.slice(0, -1).split("\n");
  assertGeneration(lines[0] === input.header, `${input.path} has an unexpected version header`);
  expectCount(lines.filter((line) => line === "# EOF").length, 1, `${input.path} EOF marker count`);
  assertGeneration(lines.at(-1) === "# EOF", `${input.path} EOF marker must be the final line`);
  return lines;
}

export async function readPinnedUnicodeInputs() {
  const [
    caseFoldingLines,
    derivedAgeLines,
    derivedCorePropertiesLines,
    derivedGeneralCategoryLines,
  ] = await Promise.all([
    readPinnedInput(inputs.caseFolding),
    readPinnedInput(inputs.derivedAge),
    readPinnedInput(inputs.derivedCoreProperties),
    readPinnedInput(inputs.derivedGeneralCategory),
  ]);
  return {
    caseFoldingLines,
    derivedAgeLines,
    derivedCorePropertiesLines,
    derivedGeneralCategoryLines,
  };
}

export function parseCaseFolding(lines) {
  const records = [];
  const counts = new Map([
    ["C", 0],
    ["F", 0],
    ["S", 0],
    ["T", 0],
  ]);
  const fullMappingLengths = new Map([
    [2, 0],
    [3, 0],
  ]);
  const statusesBySource = new Map();
  let previous;

  for (const [index, line] of lines.entries()) {
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    assertGeneration(isAscii(line), `CaseFolding.txt line ${index + 1} is not ASCII data`);
    const match = caseFoldingRecordPattern.exec(line);
    assertGeneration(match !== null, `CaseFolding.txt line ${index + 1} has invalid grammar`);
    const sourceText = match[1];
    const status = match[2];
    const mappingText = match[3];
    assertGeneration(
      sourceText !== undefined && status !== undefined && mappingText !== undefined,
      `CaseFolding.txt line ${index + 1} is incomplete`,
    );

    const source = Number.parseInt(sourceText, 16);
    const mapping = mappingText.split(" ").map((value) => Number.parseInt(value, 16));
    assertGeneration(isScalar(source), `CaseFolding.txt line ${index + 1} has a non-scalar source`);
    assertGeneration(
      mapping.every((value) => isScalar(value)),
      `CaseFolding.txt line ${index + 1} has a non-scalar mapping`,
    );

    const rank = statusRanks.get(status);
    assertGeneration(rank !== undefined, `CaseFolding.txt line ${index + 1} has an unknown status`);
    if (previous !== undefined) {
      assertGeneration(
        source > previous.source || (source === previous.source && rank > previous.rank),
        `CaseFolding.txt line ${index + 1} is not strictly ordered`,
      );
    }
    previous = { source, rank };

    if (status === "F") {
      assertGeneration(
        mapping.length === 2 || mapping.length === 3,
        `CaseFolding.txt line ${index + 1} has an invalid full mapping length`,
      );
      fullMappingLengths.set(mapping.length, (fullMappingLengths.get(mapping.length) ?? 0) + 1);
    } else {
      expectCount(mapping.length, 1, `CaseFolding.txt line ${index + 1} mapping length`);
    }

    counts.set(status, (counts.get(status) ?? 0) + 1);
    const statuses = statusesBySource.get(source) ?? [];
    assertGeneration(
      !statuses.includes(status),
      `CaseFolding.txt line ${index + 1} is a duplicate record`,
    );
    statuses.push(status);
    statusesBySource.set(source, statuses);
    records.push({ source, status, mapping });
  }

  expectCount(records.length, 1_563, "CaseFolding.txt record count");
  for (const [status, expected] of [
    ["C", 1_426],
    ["F", 104],
    ["S", 31],
    ["T", 2],
  ]) {
    expectCount(counts.get(status), expected, `CaseFolding.txt ${status} status count`);
  }
  expectCount(fullMappingLengths.get(2), 88, "CaseFolding.txt two-scalar full mappings");
  expectCount(fullMappingLengths.get(3), 16, "CaseFolding.txt three-scalar full mappings");

  const combinationCounts = new Map();
  for (const statuses of statusesBySource.values()) {
    if (statuses.length > 1) {
      const combination = statuses.join("");
      combinationCounts.set(combination, (combinationCounts.get(combination) ?? 0) + 1);
    }
  }
  assertGeneration(
    combinationCounts.size === 3 &&
      combinationCounts.get("CT") === 1 &&
      combinationCounts.get("FT") === 1 &&
      combinationCounts.get("FS") === 31,
    "CaseFolding.txt has unexpected status combinations",
  );

  const selected = records.filter((record) => record.status === "C" || record.status === "F");
  expectCount(selected.length, 1_530, "default full case-fold record count");
  expectCount(
    new Set(selected.map((record) => record.source)).size,
    1_530,
    "default full case-fold unique source count",
  );
  return selected;
}
