import {
  assertGeneration,
  isAscii,
  MAX_CODE_POINT,
  SURROGATE_END,
  SURROGATE_START,
  COMPARABLE_TEXT_GENERAL_CATEGORY_VERSION,
  UNICODE_VERSION,
} from "./unicode-source-parse.mjs";

function hex(value) {
  return `0x${value.toString(16)}`;
}

function escapedMapping(mapping) {
  return mapping.map((codePoint) => `\\u{${codePoint.toString(16)}}`).join("");
}

export function renderGeneratedSource(
  assignedRanges,
  defaultIgnorableRanges,
  punctuationAndSymbolRanges,
  compressed,
) {
  const assignedRows = assignedRanges
    .map(([start, end]) => `  [${hex(start)}, ${hex(end)}],`)
    .join("\n");
  const defaultIgnorableRows = defaultIgnorableRanges
    .map(([start, end]) => `  [${hex(start)}, ${hex(end)}],`)
    .join("\n");
  const punctuationAndSymbolRows = punctuationAndSymbolRanges
    .map(([start, end]) => `  [${hex(start)}, ${hex(end)}],`)
    .join("\n");
  const foldRangeRows = compressed.ranges
    .map(({ start, end, stride, delta }) => `  [${hex(start)}, ${hex(end)}, ${stride}, ${delta}],`)
    .join("\n");
  const exceptionRows = compressed.exceptions
    .map(({ source, mapping }) => `  [${hex(source)}, "${escapedMapping(mapping)}"],`)
    .join("\n");

  const generated = `/* Generated from Unicode Character Database ${UNICODE_VERSION} and
 * ${COMPARABLE_TEXT_GENERAL_CATEGORY_VERSION} by
 * scripts/generate-unicode-tables.mjs. Do not edit by hand. */

type CodePointRange = readonly [start: number, end: number];
type FoldRange = readonly [start: number, end: number, stride: number, delta: number];
type FoldException = readonly [codePoint: number, mapping: string];

// Module initialization is the trust boundary for the intrinsics below.
const applySnapshot = Reflect.apply;
const charCodeAtSnapshot = String.prototype.charCodeAt;
const fromCodePointSnapshot = String.fromCodePoint;
const numberIsIntegerSnapshot = Number.isInteger;
const stringConstructorSnapshot = String;

const ASSIGNED_SCALAR_RANGES: readonly CodePointRange[] = [
${assignedRows}
];

const DEFAULT_IGNORABLE_CODE_POINT_RANGES: readonly CodePointRange[] = [
${defaultIgnorableRows}
];

const PUNCTUATION_AND_SYMBOL_CODE_POINT_RANGES: readonly CodePointRange[] = [
${punctuationAndSymbolRows}
];

const CASE_FOLD_RANGES: readonly FoldRange[] = [
${foldRangeRows}
];

const CASE_FOLD_EXCEPTIONS: readonly FoldException[] = [
${exceptionRows}
];

export const UNICODE_PORTABILITY_VERSION: string = "${UNICODE_VERSION}";
export const COMPARABLE_TEXT_GENERAL_CATEGORY_VERSION: string = "${COMPARABLE_TEXT_GENERAL_CATEGORY_VERSION}";

function codeUnitAt(value: string, index: number): number {
  return applySnapshot(charCodeAtSnapshot, value, [index]) as number;
}

function stringFromCodePoint(codePoint: number): string {
  return applySnapshot(fromCodePointSnapshot, stringConstructorSnapshot, [codePoint]) as string;
}

function isScalarCodePoint(codePoint: number): boolean {
  return (
    numberIsIntegerSnapshot(codePoint) &&
    codePoint >= 0 &&
    codePoint <= ${hex(MAX_CODE_POINT)} &&
    (codePoint < ${hex(SURROGATE_START)} || codePoint > ${hex(SURROGATE_END)})
  );
}

function rangeTableContains(ranges: readonly CodePointRange[], codePoint: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle] as CodePointRange;
    const start = range[0];
    const end = range[1];
    if (codePoint < start) {
      high = middle - 1;
    } else if (codePoint > end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function foldCodePoint(codePoint: number): string {
  let low = 0;
  let high = CASE_FOLD_EXCEPTIONS.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const exception = CASE_FOLD_EXCEPTIONS[middle] as FoldException;
    const source = exception[0];
    const mapping = exception[1];
    if (codePoint < source) {
      high = middle - 1;
    } else if (codePoint > source) {
      low = middle + 1;
    } else {
      return mapping;
    }
  }

  low = 0;
  high = CASE_FOLD_RANGES.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = CASE_FOLD_RANGES[middle] as FoldRange;
    const start = range[0];
    const end = range[1];
    const stride = range[2];
    const delta = range[3];
    if (codePoint < start) {
      high = middle - 1;
    } else if (codePoint > end) {
      low = middle + 1;
    } else if ((codePoint - start) % stride === 0) {
      return stringFromCodePoint(codePoint + delta);
    } else {
      return stringFromCodePoint(codePoint);
    }
  }
  return stringFromCodePoint(codePoint);
}

export function fullCaseFoldUnicode15_1(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const first = codeUnitAt(value, index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = codeUnitAt(value, index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        codePoint = (first - 0xd800) * 0x400 + second - 0xdc00 + 0x10000;
        index += 1;
      }
    }
    result += foldCodePoint(codePoint);
  }
  return result;
}

export function isAssignedScalarUnicode15_1(codePoint: number): boolean {
  return isScalarCodePoint(codePoint) && rangeTableContains(ASSIGNED_SCALAR_RANGES, codePoint);
}

export function isDefaultIgnorableCodePointUnicode15_1(codePoint: number): boolean {
  return (
    isScalarCodePoint(codePoint) &&
    rangeTableContains(DEFAULT_IGNORABLE_CODE_POINT_RANGES, codePoint)
  );
}

export function isPunctuationOrSymbolCodePointUnicode17_0(codePoint: number): boolean {
  return (
    isScalarCodePoint(codePoint) &&
    rangeTableContains(PUNCTUATION_AND_SYMBOL_CODE_POINT_RANGES, codePoint)
  );
}
`;

  assertGeneration(isAscii(generated), "generated module must contain ASCII only");
  return generated;
}
