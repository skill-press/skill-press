import {
  isDefaultIgnorableCodePointUnicode15_1,
  isPunctuationOrSymbolCodePointUnicode17_0,
} from "../validate/generated-unicode.js";

// Module initialization is the trust boundary for caller-controlled text and intrinsics below.
const applySnapshot = Reflect.apply;
const charCodeAtSnapshot = String.prototype.charCodeAt;
const normalizeSnapshot = String.prototype.normalize;
const sliceSnapshot = String.prototype.slice;
const toLocaleLowerCaseSnapshot = String.prototype.toLocaleLowerCase;
const defaultIgnorableSnapshot = isDefaultIgnorableCodePointUnicode15_1;
const punctuationOrSymbolSnapshot = isPunctuationOrSymbolCodePointUnicode17_0;

function codeUnitAt(value: string, index: number): number {
  return applySnapshot(charCodeAtSnapshot, value, [index]) as number;
}

function codePointAt(value: string, index: number): number {
  const first = codeUnitAt(value, index);
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
    const second = codeUnitAt(value, index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return (first - 0xd800) * 0x400 + second - 0xdc00 + 0x10000;
    }
  }
  return first;
}

function isEcmaScriptWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    codePoint === 0x20 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000 ||
    codePoint === 0xfeff
  );
}

/**
 * Preserve the create-time lexical comparison projection without matching input expressions.
 * Unicode normalization and en-US lowercase mapping intentionally retain their host semantics;
 * default-ignorable membership is pinned to 15.1 and punctuation/symbol membership to 17.0.
 */
export function normalizeComparableText(value: string): string {
  const normalized = applySnapshot(normalizeSnapshot, value, ["NFKC"]) as string;
  const folded = applySnapshot(toLocaleLowerCaseSnapshot, normalized, ["en-US"]) as string;
  let result = "";
  let pendingSpace = false;
  let index = 0;

  while (index < folded.length) {
    const codePoint = codePointAt(folded, index);
    const width = codePoint > 0xffff ? 2 : 1;
    if (applySnapshot(defaultIgnorableSnapshot, undefined, [codePoint]) as boolean) {
      index += width;
      continue;
    }
    if (
      isEcmaScriptWhitespace(codePoint) ||
      (applySnapshot(punctuationOrSymbolSnapshot, undefined, [codePoint]) as boolean)
    ) {
      if (result.length > 0) pendingSpace = true;
      index += width;
      continue;
    }
    if (pendingSpace) {
      result += " ";
      pendingSpace = false;
    }
    result += applySnapshot(sliceSnapshot, folded, [index, index + width]) as string;
    index += width;
  }

  return result;
}
