import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  COMPARABLE_TEXT_GENERAL_CATEGORY_VERSION,
  fullCaseFoldUnicode15_1,
  isAssignedScalarUnicode15_1,
  isDefaultIgnorableCodePointUnicode15_1,
  isPunctuationOrSymbolCodePointUnicode17_0,
  UNICODE_PORTABILITY_VERSION,
} from "../src/validate/generated-unicode.js";

const repositoryRoot = new URL("../", import.meta.url);
const MAX_CODE_POINT = 0x10ffff;
const CODE_POINT_COUNT = MAX_CODE_POINT + 1;
const SURROGATE_START = 0xd800;
const SURROGATE_END = 0xdfff;

function withPropertyReplacement<T>(
  target: object,
  property: PropertyKey,
  value: unknown,
  run: () => T,
): T {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  Object.defineProperty(target, property, {
    configurable: true,
    value,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (descriptor === undefined) {
      Reflect.deleteProperty(target, property);
    } else {
      Object.defineProperty(target, property, descriptor);
    }
  }
}

async function readUnicodeSource(file: string): Promise<string> {
  return readFile(new URL(`vendor/unicode/15.1.0/${file}`, repositoryRoot), "utf8");
}

async function readGeneralCategorySource(): Promise<string> {
  return readFile(
    new URL("vendor/unicode/17.0.0/DerivedGeneralCategory.txt", repositoryRoot),
    "utf8",
  );
}

function parseCaseFoldOracle(source: string): Map<number, readonly number[]> {
  const mappings = new Map<number, readonly number[]>();
  for (const line of source.split("\n")) {
    const data = line.split("#")[0]?.trim();
    if (!data) {
      continue;
    }

    const fields = data.split(";").map((field) => field.trim());
    const sourceText = fields[0];
    const status = fields[1];
    const mappingText = fields[2];
    if (
      sourceText === undefined ||
      mappingText === undefined ||
      (status !== "C" && status !== "F")
    ) {
      continue;
    }

    mappings.set(
      Number.parseInt(sourceText, 16),
      mappingText.split(" ").map((value) => Number.parseInt(value, 16)),
    );
  }
  return mappings;
}

function versionAtMost15_1(version: string): boolean {
  const parts = version.split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  return major < 15 || (major === 15 && minor <= 1);
}

function parseAssignedScalarOracle(source: string): Uint8Array {
  const assigned = new Uint8Array(CODE_POINT_COUNT);
  for (const line of source.split("\n")) {
    const data = line.split("#")[0]?.trim();
    if (!data) {
      continue;
    }

    const fields = data.split(";").map((field) => field.trim());
    const rangeText = fields[0];
    const version = fields[1];
    if (rangeText === undefined || version === undefined || !versionAtMost15_1(version)) {
      continue;
    }

    const endpoints = rangeText.split("..");
    const startText = endpoints[0];
    const endText = endpoints[1] ?? startText;
    if (startText === undefined || endText === undefined) {
      continue;
    }
    const start = Number.parseInt(startText, 16);
    const end = Number.parseInt(endText, 16);
    assigned.fill(1, start, end + 1);
  }

  assigned.fill(0, SURROGATE_START, SURROGATE_END + 1);
  return assigned;
}

function parseDefaultIgnorableOracle(source: string): {
  readonly bitmap: Uint8Array;
  readonly recordCount: number;
} {
  const bitmap = new Uint8Array(CODE_POINT_COUNT);
  let recordCount = 0;
  for (const line of source.split("\n")) {
    const data = line.split("#")[0]?.trim();
    if (!data) {
      continue;
    }

    const fields = data.split(";").map((field) => field.trim());
    if (fields.length !== 2 || fields[1] !== "Default_Ignorable_Code_Point") {
      continue;
    }
    const rangeText = fields[0];
    if (rangeText === undefined) {
      continue;
    }
    const endpoints = rangeText.split("..");
    const startText = endpoints[0];
    const endText = endpoints[1] ?? startText;
    if (startText === undefined || endText === undefined) {
      continue;
    }
    const start = Number.parseInt(startText, 16);
    const end = Number.parseInt(endText, 16);
    bitmap.fill(1, start, end + 1);
    recordCount += 1;
  }
  return { bitmap, recordCount };
}

function parsePunctuationAndSymbolOracle(source: string): {
  readonly bitmap: Uint8Array;
  readonly recordCount: number;
} {
  const bitmap = new Uint8Array(CODE_POINT_COUNT);
  let recordCount = 0;
  for (const line of source.split("\n")) {
    const match = /^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*;\s*([PS][a-z])\s+#/u.exec(line);
    if (match === null) continue;
    const startText = match[1];
    const endText = match[2] ?? startText;
    if (startText === undefined || endText === undefined) continue;
    bitmap.fill(1, Number.parseInt(startText, 16), Number.parseInt(endText, 16) + 1);
    recordCount += 1;
  }
  return { bitmap, recordCount };
}

function countSetRanges(bitmap: Uint8Array): number {
  let count = 0;
  let inside = false;
  for (let codePoint = 0; codePoint < bitmap.length; codePoint += 1) {
    if (bitmap[codePoint] === 1) {
      if (!inside) {
        count += 1;
        inside = true;
      }
    } else {
      inside = false;
    }
  }
  return count;
}

function packBitset(bitmap: Uint8Array): Uint8Array {
  const packed = new Uint8Array(Math.ceil(bitmap.length / 8));
  for (let codePoint = 0; codePoint < bitmap.length; codePoint += 1) {
    if (bitmap[codePoint] === 1) {
      const byteIndex = codePoint >> 3;
      packed[byteIndex] = (packed[byteIndex] ?? 0) | (1 << (codePoint & 7));
    }
  }
  return packed;
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function scalarValues(value: string): number[] {
  return Array.from(value, (character) => character.codePointAt(0) as number);
}

describe("generated Unicode 15.1 portability tables", () => {
  it("exposes the pinned Unicode version and readable full-fold goldens", () => {
    expect(UNICODE_PORTABILITY_VERSION).toBe("15.1.0");
    expect(COMPARABLE_TEXT_GENERAL_CATEGORY_VERSION).toBe("17.0.0");
    expect(fullCaseFoldUnicode15_1("AZ")).toBe("az");
    expect(fullCaseFoldUnicode15_1("ß")).toBe("ss");
    expect(fullCaseFoldUnicode15_1("İ")).toBe("i\u0307");
    expect(fullCaseFoldUnicode15_1("ﬃ")).toBe("ffi");
    expect(fullCaseFoldUnicode15_1("Āā")).toBe("āā");
    expect(fullCaseFoldUnicode15_1("🙂")).toBe("🙂");
    expect(fullCaseFoldUnicode15_1("\ud800")).toBe("\ud800");
    expect(fullCaseFoldUnicode15_1("\ud800A")).toBe("\ud800a");
    expect(fullCaseFoldUnicode15_1("")).toBe("");
  });

  it("recognizes only assigned Unicode 15.1 scalar values", () => {
    expect(isAssignedScalarUnicode15_1(0)).toBe(true);
    expect(isAssignedScalarUnicode15_1(0x41)).toBe(true);
    expect(isAssignedScalarUnicode15_1(0x2fff)).toBe(true);
    expect(isAssignedScalarUnicode15_1(0x10ffff)).toBe(true);
    expect(isAssignedScalarUnicode15_1(0x378)).toBe(false);

    for (const invalid of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
      SURROGATE_START,
      SURROGATE_END,
      MAX_CODE_POINT + 1,
    ]) {
      expect(isAssignedScalarUnicode15_1(invalid)).toBe(false);
    }
  });

  it("recognizes the complete Unicode 15.1 default-ignorable property", () => {
    for (const codePoint of [0x00ad, 0x034f, 0x2064, 0x2065, 0xfff0, 0xe0000, 0xe0fff]) {
      expect(isDefaultIgnorableCodePointUnicode15_1(codePoint)).toBe(true);
    }
    for (const codePoint of [0x0041, 0x205f, 0x2070, 0xe1000]) {
      expect(isDefaultIgnorableCodePointUnicode15_1(codePoint)).toBe(false);
    }
    for (const invalid of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
      SURROGATE_START,
      SURROGATE_END,
      MAX_CODE_POINT + 1,
    ]) {
      expect(isDefaultIgnorableCodePointUnicode15_1(invalid)).toBe(false);
    }

    expect(isAssignedScalarUnicode15_1(0x2065)).toBe(false);
    expect(isAssignedScalarUnicode15_1(0xe0000)).toBe(false);
  });

  it("uses intrinsic snapshots after module initialization", () => {
    const input = "Ā🙂\ud800";
    const expected = "ā🙂\ud800";

    const throwingArrayIteratorResult = withPropertyReplacement(
      Array.prototype,
      Symbol.iterator,
      () => {
        throw new Error("array iterator was used");
      },
      () => ({
        assigned: isAssignedScalarUnicode15_1(0x41),
        defaultIgnorable: isDefaultIgnorableCodePointUnicode15_1(0x00ad),
        punctuationOrSymbol: isPunctuationOrSymbolCodePointUnicode17_0(0x21),
        folded: fullCaseFoldUnicode15_1(input),
      }),
    );
    expect(throwingArrayIteratorResult).toEqual({
      assigned: true,
      defaultIgnorable: true,
      punctuationOrSymbol: true,
      folded: expected,
    });

    const emptyArrayIteratorResult = withPropertyReplacement(
      Array.prototype,
      Symbol.iterator,
      () => ({ next: () => ({ done: true, value: undefined }) }),
      () => ({
        assigned: isAssignedScalarUnicode15_1(0x41),
        defaultIgnorable: isDefaultIgnorableCodePointUnicode15_1(0x00ad),
        punctuationOrSymbol: isPunctuationOrSymbolCodePointUnicode17_0(0x21),
        folded: fullCaseFoldUnicode15_1(input),
      }),
    );
    expect(emptyArrayIteratorResult).toEqual({
      assigned: true,
      defaultIgnorable: true,
      punctuationOrSymbol: true,
      folded: expected,
    });

    const iteratorResult = withPropertyReplacement(
      String.prototype,
      Symbol.iterator,
      () => {
        throw new Error("iterator was used");
      },
      () => fullCaseFoldUnicode15_1(input),
    );
    expect(iteratorResult).toBe(expected);

    const codePointAtResult = withPropertyReplacement(
      String.prototype,
      "codePointAt",
      () => 0x41,
      () => fullCaseFoldUnicode15_1(input),
    );
    expect(codePointAtResult).toBe(expected);

    const fromCodePointResult = withPropertyReplacement(
      String,
      "fromCodePoint",
      () => "polluted",
      () => fullCaseFoldUnicode15_1(input),
    );
    expect(fromCodePointResult).toBe(expected);

    const applyResult = withPropertyReplacement(
      Reflect,
      "apply",
      () => {
        throw new Error("live Reflect.apply was used");
      },
      () => fullCaseFoldUnicode15_1(input),
    );
    expect(applyResult).toBe(expected);

    const integerResult = withPropertyReplacement(
      Number,
      "isInteger",
      () => false,
      () => ({
        assigned: isAssignedScalarUnicode15_1(0x41),
        defaultIgnorable: isDefaultIgnorableCodePointUnicode15_1(0x00ad),
        punctuationOrSymbol: isPunctuationOrSymbolCodePointUnicode17_0(0x21),
      }),
    );
    expect(integerResult).toEqual({
      assigned: true,
      defaultIgnorable: true,
      punctuationOrSymbol: true,
    });
  });

  it("matches independent UCD oracles for every code point and locks semantic digests", async () => {
    const [caseFoldingSource, derivedAgeSource] = await Promise.all([
      readUnicodeSource("CaseFolding.txt"),
      readUnicodeSource("DerivedAge.txt"),
    ]);
    const foldOracle = parseCaseFoldOracle(caseFoldingSource);
    const assignedOracle = parseAssignedScalarOracle(derivedAgeSource);

    expect(foldOracle.size).toBe(1_530);

    const combinedFraming = Buffer.allocUnsafe(CODE_POINT_COUNT * 14);
    const foldFraming = Buffer.allocUnsafe(CODE_POINT_COUNT * 13);
    const assignedBitset = Buffer.alloc(Math.ceil(CODE_POINT_COUNT / 8));
    let combinedOffset = 0;
    let foldOffset = 0;
    let assignedCount = 0;
    let foldMismatchCount = 0;
    let assignedMismatchCount = 0;
    let firstFoldMismatch:
      | { readonly codePoint: number; readonly expected: number[]; readonly actual: number[] }
      | undefined;
    let firstAssignedMismatch:
      | { readonly codePoint: number; readonly expected: boolean; readonly actual: boolean }
      | undefined;

    for (let codePoint = 0; codePoint <= MAX_CODE_POINT; codePoint += 1) {
      const expectedMapping = foldOracle.get(codePoint) ?? [codePoint];
      const expectedFold = String.fromCodePoint(...expectedMapping);
      const actualFold = fullCaseFoldUnicode15_1(String.fromCodePoint(codePoint));
      if (actualFold !== expectedFold) {
        foldMismatchCount += 1;
        firstFoldMismatch ??= {
          codePoint,
          expected: [...expectedMapping],
          actual: scalarValues(actualFold),
        };
      }

      const expectedAssigned = assignedOracle[codePoint] === 1;
      const actualAssigned = isAssignedScalarUnicode15_1(codePoint);
      if (actualAssigned !== expectedAssigned) {
        assignedMismatchCount += 1;
        firstAssignedMismatch ??= { codePoint, expected: expectedAssigned, actual: actualAssigned };
      }
      if (actualAssigned) {
        assignedCount += 1;
        const byteIndex = codePoint >> 3;
        assignedBitset[byteIndex] = (assignedBitset[byteIndex] ?? 0) | (1 << (codePoint & 7));
      }

      combinedFraming[combinedOffset] = actualAssigned ? 1 : 0;
      combinedOffset += 1;
      combinedFraming[combinedOffset] = expectedMapping.length;
      combinedOffset += 1;
      foldFraming[foldOffset] = expectedMapping.length;
      foldOffset += 1;
      for (const mappedCodePoint of expectedMapping) {
        combinedFraming.writeUInt32LE(mappedCodePoint, combinedOffset);
        combinedOffset += 4;
        foldFraming.writeUInt32LE(mappedCodePoint, foldOffset);
        foldOffset += 4;
      }
    }

    expect({ count: foldMismatchCount, first: firstFoldMismatch }).toEqual({
      count: 0,
      first: undefined,
    });
    expect({ count: assignedMismatchCount, first: firstAssignedMismatch }).toEqual({
      count: 0,
      first: undefined,
    });
    expect(assignedCount).toBe(287_412);
    expect(digest(combinedFraming.subarray(0, combinedOffset))).toBe(
      "eb91735feb94303a8d611b1a85aa55ca3fe6367d23d84d7b2d4c4dc4ee03a11e",
    );
    expect(digest(foldFraming.subarray(0, foldOffset))).toBe(
      "b6448e86dddf50efa9baf605f293630923aaa3daa56b58124d6ec05f3bdcf0a5",
    );
    expect(digest(assignedBitset)).toBe(
      "0952fdec921e0439d955516710b6aa42cf30df450611e6159d1a2f2de4137b37",
    );
  }, 30_000);

  it("matches the independent default-ignorable oracle for every code point", async () => {
    const [derivedCorePropertiesSource, derivedAgeSource] = await Promise.all([
      readUnicodeSource("DerivedCoreProperties.txt"),
      readUnicodeSource("DerivedAge.txt"),
    ]);
    const defaultIgnorableOracle = parseDefaultIgnorableOracle(derivedCorePropertiesSource);
    const assignedOracle = parseAssignedScalarOracle(derivedAgeSource);
    const actualDefaultIgnorable = new Uint8Array(CODE_POINT_COUNT);
    const actualAssignedDefaultIgnorable = new Uint8Array(CODE_POINT_COUNT);
    let defaultIgnorableMismatchCount = 0;
    let assignedDefaultIgnorableMismatchCount = 0;
    let firstDefaultIgnorableMismatch:
      | { readonly codePoint: number; readonly expected: boolean; readonly actual: boolean }
      | undefined;
    let firstAssignedDefaultIgnorableMismatch:
      | { readonly codePoint: number; readonly expected: boolean; readonly actual: boolean }
      | undefined;

    for (let codePoint = 0; codePoint <= MAX_CODE_POINT; codePoint += 1) {
      const expectedDefaultIgnorable = defaultIgnorableOracle.bitmap[codePoint] === 1;
      const actualIsDefaultIgnorable = isDefaultIgnorableCodePointUnicode15_1(codePoint);
      if (actualIsDefaultIgnorable !== expectedDefaultIgnorable) {
        defaultIgnorableMismatchCount += 1;
        firstDefaultIgnorableMismatch ??= {
          codePoint,
          expected: expectedDefaultIgnorable,
          actual: actualIsDefaultIgnorable,
        };
      }
      if (actualIsDefaultIgnorable) {
        actualDefaultIgnorable[codePoint] = 1;
      }

      const expectedAssignedDefaultIgnorable =
        expectedDefaultIgnorable && assignedOracle[codePoint] === 1;
      const actualIsAssignedDefaultIgnorable =
        actualIsDefaultIgnorable && isAssignedScalarUnicode15_1(codePoint);
      if (actualIsAssignedDefaultIgnorable !== expectedAssignedDefaultIgnorable) {
        assignedDefaultIgnorableMismatchCount += 1;
        firstAssignedDefaultIgnorableMismatch ??= {
          codePoint,
          expected: expectedAssignedDefaultIgnorable,
          actual: actualIsAssignedDefaultIgnorable,
        };
      }
      if (actualIsAssignedDefaultIgnorable) {
        actualAssignedDefaultIgnorable[codePoint] = 1;
      }
    }

    expect(defaultIgnorableOracle.recordCount).toBe(27);
    expect({ count: defaultIgnorableMismatchCount, first: firstDefaultIgnorableMismatch }).toEqual({
      count: 0,
      first: undefined,
    });
    expect(actualDefaultIgnorable.reduce((count, value) => count + value, 0)).toBe(4_174);
    expect(countSetRanges(actualDefaultIgnorable)).toBe(17);
    expect(digest(packBitset(actualDefaultIgnorable))).toBe(
      "c8984091f29193139ea640ff7fc181d77f209fe34867cb0368af1f07f260a3bd",
    );

    expect({
      count: assignedDefaultIgnorableMismatchCount,
      first: firstAssignedDefaultIgnorableMismatch,
    }).toEqual({ count: 0, first: undefined });
    expect(actualAssignedDefaultIgnorable.reduce((count, value) => count + value, 0)).toBe(405);
    expect(countSetRanges(actualAssignedDefaultIgnorable)).toBe(19);
    expect(digest(packBitset(actualAssignedDefaultIgnorable))).toBe(
      "47369767624770346e80491eece207fde8e876a257bdf676c0f92fc073773615",
    );
  }, 30_000);

  it("matches the independent Unicode 17 punctuation/symbol oracle for every code point", async () => {
    const oracle = parsePunctuationAndSymbolOracle(await readGeneralCategorySource());
    const actual = new Uint8Array(CODE_POINT_COUNT);
    let mismatchCount = 0;
    let firstMismatch:
      | { readonly codePoint: number; readonly expected: boolean; readonly observed: boolean }
      | undefined;

    for (let codePoint = 0; codePoint <= MAX_CODE_POINT; codePoint += 1) {
      const expected = oracle.bitmap[codePoint] === 1;
      const observed = isPunctuationOrSymbolCodePointUnicode17_0(codePoint);
      if (expected !== observed) {
        mismatchCount += 1;
        firstMismatch ??= { codePoint, expected, observed };
      }
      if (observed) actual[codePoint] = 1;
    }

    expect(oracle.recordCount).toBe(708);
    expect({ count: mismatchCount, first: firstMismatch }).toEqual({
      count: 0,
      first: undefined,
    });
    expect(actual.reduce((count, value) => count + value, 0)).toBe(9_473);
    expect(countSetRanges(actual)).toBe(355);
    expect(digest(packBitset(actual))).toBe(
      "c06972e22f0b283c265dd69e0ee3a44b525f1f06a45e57f6f2ed64091b8f666a",
    );
    for (const invalid of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
      SURROGATE_START,
      SURROGATE_END,
      MAX_CODE_POINT + 1,
    ]) {
      expect(isPunctuationOrSymbolCodePointUnicode17_0(invalid)).toBe(false);
    }
  }, 30_000);

  it("keeps generated declarations narrow and host Unicode operations out of generation", async () => {
    const declaration = await readFile(
      new URL("dist/validate/generated-unicode.d.ts", repositoryRoot),
      "utf8",
    );
    expect(declaration).toContain(
      "export declare const UNICODE_PORTABILITY_VERSION: string;\nexport declare const COMPARABLE_TEXT_GENERAL_CATEGORY_VERSION: string;\nexport declare function fullCaseFoldUnicode15_1(value: string): string;\nexport declare function isAssignedScalarUnicode15_1(codePoint: number): boolean;\nexport declare function isDefaultIgnorableCodePointUnicode15_1(codePoint: number): boolean;\nexport declare function isPunctuationOrSymbolCodePointUnicode17_0(codePoint: number): boolean;",
    );
    expect(declaration).not.toMatch(
      /(?:ASSIGNED_SCALAR|CASE_FOLD_|DEFAULT_IGNORABLE_|PUNCTUATION_AND_SYMBOL_)/u,
    );
    expect(declaration.split("\n").length).toBeLessThanOrEqual(9);

    const scriptDirectory = new URL("scripts/", repositoryRoot);
    const unicodeScripts = (await readdir(scriptDirectory)).filter((file) =>
      file.includes("unicode"),
    );
    const generatedSource = await readFile(
      new URL("src/validate/generated-unicode.ts", repositoryRoot),
      "utf8",
    );
    const sources = await Promise.all(
      unicodeScripts.map((file) => readFile(new URL(file, scriptDirectory), "utf8")),
    );
    const forbiddenFragments = [
      `to${"Lower"}Case`,
      `to${"Upper"}Case`,
      `locale${"Compare"}`,
      `toLocale${"Lower"}Case`,
      `toLocale${"Upper"}Case`,
      `norma${"lize"}`,
      `${"Int"}l`,
    ];
    for (const source of [generatedSource, ...sources]) {
      for (const fragment of forbiddenFragments) {
        expect(source).not.toContain(fragment);
      }
    }
    expect(generatedSource).not.toContain(".codePointAt(");
    expect(generatedSource).not.toContain("for (const character of value)");
    expect(generatedSource).not.toContain("Math.floor");
    expect(generatedSource).not.toContain("[Symbol.iterator]");
    expect(generatedSource).not.toMatch(/\bfor\s*\([^)]*\bof\b/gu);
    expect(generatedSource).not.toContain("const [source, mapping]");
    expect(generatedSource).not.toContain("const [start, end");
  });
});
