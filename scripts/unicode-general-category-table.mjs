import { createHash } from "node:crypto";

import {
  assertGeneration,
  expectCount,
  isAscii,
  isCodePoint,
  MAX_CODE_POINT,
  SURROGATE_END,
  SURROGATE_START,
} from "./unicode-source-parse.mjs";

const EXPECTED_SECTIONS = [
  ["Unassigned", "Cn", 735, 814_730],
  ["Uppercase_Letter", "Lu", 655, 1_886],
  ["Lowercase_Letter", "Ll", 664, 2_283],
  ["Titlecase_Letter", "Lt", 10, 31],
  ["Modifier_Letter", "Lm", 79, 410],
  ["Other_Letter", "Lo", 537, 141_062],
  ["Nonspacing_Mark", "Mn", 365, 2_059],
  ["Enclosing_Mark", "Me", 5, 13],
  ["Spacing_Mark", "Mc", 193, 471],
  ["Decimal_Number", "Nd", 72, 770],
  ["Letter_Number", "Nl", 13, 239],
  ["Other_Number", "No", 72, 915],
  ["Space_Separator", "Zs", 7, 17],
  ["Line_Separator", "Zl", 1, 1],
  ["Paragraph_Separator", "Zp", 1, 1],
  ["Control", "Cc", 2, 65],
  ["Format", "Cf", 21, 170],
  ["Private_Use", "Co", 3, 137_468],
  ["Surrogate", "Cs", 1, 2_048],
  ["Dash_Punctuation", "Pd", 20, 27],
  ["Open_Punctuation", "Ps", 79, 79],
  ["Close_Punctuation", "Pe", 76, 77],
  ["Connector_Punctuation", "Pc", 6, 10],
  ["Other_Punctuation", "Po", 194, 641],
  ["Math_Symbol", "Sm", 67, 960],
  ["Currency_Symbol", "Sc", 21, 64],
  ["Modifier_Symbol", "Sk", 31, 125],
  ["Other_Symbol", "So", 193, 7_468],
  ["Initial_Punctuation", "Pi", 11, 12],
  ["Final_Punctuation", "Pf", 10, 10],
];

const GENERAL_CATEGORY_HEADING = "# General_Category=";
const TOTAL_PREFIX = "# Total code points: ";
const TARGET_RECORD_COUNT = 708;
const TARGET_CODE_POINT_COUNT = 9_473;
const TARGET_RANGE_COUNT = 355;
const TARGET_BITSET_SHA256 = "c06972e22f0b283c265dd69e0ee3a44b525f1f06a45e57f6f2ed64091b8f666a";
const generalCategoryRecordPattern =
  /^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*;\s*([A-Za-z]{2})\s+# .+$/;

function rangeCodePointCount(ranges) {
  return ranges.reduce((count, [start, end]) => count + end - start + 1, 0);
}

function mergeAdjacentRanges(ranges) {
  const merged = [];
  for (const [start, end] of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && start === previous[1] + 1) {
      previous[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

function rangeBitsetSha256(ranges) {
  const bitset = Buffer.alloc((MAX_CODE_POINT + 1) / 8);
  for (const [start, end] of ranges) {
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      const byteIndex = codePoint >> 3;
      bitset[byteIndex] = (bitset[byteIndex] ?? 0) | (1 << (codePoint & 7));
    }
  }
  return createHash("sha256").update(bitset).digest("hex");
}

export function parsePunctuationAndSymbol(lines) {
  const allRecords = [];
  const targetRecords = [];
  let sectionIndex = 0;
  let active;

  for (const [lineIndex, line] of lines.entries()) {
    if (line.startsWith(GENERAL_CATEGORY_HEADING)) {
      assertGeneration(
        active === undefined,
        `DerivedGeneralCategory.txt line ${lineIndex + 1} starts a nested section`,
      );
      const expected = EXPECTED_SECTIONS[sectionIndex];
      assertGeneration(
        expected !== undefined && line === `${GENERAL_CATEGORY_HEADING}${expected[0]}`,
        `DerivedGeneralCategory.txt section ${sectionIndex + 1} is unexpected`,
      );
      active = { expected, records: 0, codePoints: 0, previousEnd: -1 };
      continue;
    }

    if (line.startsWith(TOTAL_PREFIX)) {
      assertGeneration(
        active !== undefined,
        `DerivedGeneralCategory.txt line ${lineIndex + 1} has a total outside a section`,
      );
      const expectedTotal = active.expected[3];
      const observedTotal = Number.parseInt(line.slice(TOTAL_PREFIX.length), 10);
      expectCount(active.records, active.expected[2], `${active.expected[0]} record count`);
      expectCount(active.codePoints, expectedTotal, `${active.expected[0]} code-point count`);
      expectCount(observedTotal, expectedTotal, `${active.expected[0]} declared total`);
      active = undefined;
      sectionIndex += 1;
      continue;
    }

    if (line === "" || line.startsWith("#")) continue;
    assertGeneration(
      active !== undefined,
      `DerivedGeneralCategory.txt line ${lineIndex + 1} has data outside a section`,
    );
    assertGeneration(
      isAscii(line),
      `DerivedGeneralCategory.txt line ${lineIndex + 1} is not ASCII`,
    );
    const match = generalCategoryRecordPattern.exec(line);
    assertGeneration(
      match !== null,
      `DerivedGeneralCategory.txt line ${lineIndex + 1} has invalid grammar`,
    );
    const startText = match[1];
    const endText = match[2] ?? startText;
    const category = match[3];
    assertGeneration(
      startText !== undefined && endText !== undefined && category !== undefined,
      `DerivedGeneralCategory.txt line ${lineIndex + 1} is incomplete`,
    );
    const start = Number.parseInt(startText, 16);
    const end = Number.parseInt(endText, 16);
    assertGeneration(
      isCodePoint(start) && isCodePoint(end),
      `DerivedGeneralCategory.txt line ${lineIndex + 1} has an invalid endpoint`,
    );
    assertGeneration(
      start <= end && start > active.previousEnd,
      `DerivedGeneralCategory.txt line ${lineIndex + 1} is not strictly ordered`,
    );
    assertGeneration(
      category === active.expected[1],
      `DerivedGeneralCategory.txt line ${lineIndex + 1} has an unexpected category`,
    );
    active.records += 1;
    active.codePoints += end - start + 1;
    active.previousEnd = end;
    allRecords.push([start, end]);
    if (category.startsWith("P") || category.startsWith("S")) {
      assertGeneration(
        end < SURROGATE_START || start > SURROGATE_END,
        `DerivedGeneralCategory.txt line ${lineIndex + 1} intersects the surrogate range`,
      );
      targetRecords.push([start, end]);
    }
  }

  assertGeneration(active === undefined, "DerivedGeneralCategory.txt final section is incomplete");
  expectCount(sectionIndex, EXPECTED_SECTIONS.length, "DerivedGeneralCategory.txt section count");
  expectCount(allRecords.length, 4_144, "DerivedGeneralCategory.txt record count");
  allRecords.sort((left, right) => left[0] - right[0]);
  let coveredThrough = -1;
  for (const [start, end] of allRecords) {
    assertGeneration(
      start === coveredThrough + 1,
      "DerivedGeneralCategory.txt does not partition the code-point space",
    );
    coveredThrough = end;
  }
  expectCount(coveredThrough, MAX_CODE_POINT, "DerivedGeneralCategory.txt final code point");

  expectCount(targetRecords.length, TARGET_RECORD_COUNT, "punctuation/symbol record count");
  expectCount(
    rangeCodePointCount(targetRecords),
    TARGET_CODE_POINT_COUNT,
    "punctuation/symbol code-point count",
  );
  targetRecords.sort((left, right) => left[0] - right[0]);
  const merged = mergeAdjacentRanges(targetRecords);
  expectCount(merged.length, TARGET_RANGE_COUNT, "punctuation/symbol merged range count");
  expectCount(
    rangeCodePointCount(merged),
    TARGET_CODE_POINT_COUNT,
    "punctuation/symbol merged code-point count",
  );
  assertGeneration(
    rangeBitsetSha256(merged) === TARGET_BITSET_SHA256,
    "punctuation/symbol semantic SHA-256 does not match",
  );
  return merged;
}
