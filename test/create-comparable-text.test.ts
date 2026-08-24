import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { normalizeComparableText } from "../src/create/comparable-text.js";

const repositoryRoot = new URL("../", import.meta.url);
const ecmaScriptWhitespace = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
] as const;

type CodePointRange = readonly [number, number];

function pinnedRanges(
  source: string,
  includesProperty: (property: string) => boolean,
): readonly CodePointRange[] {
  const ranges: CodePointRange[] = [];
  for (const line of source.split("\n")) {
    const match = /^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*;\s*([A-Za-z_]{2,})\s+#/u.exec(line);
    if (match === null || !includesProperty(match[3] as string)) continue;
    ranges.push([
      Number.parseInt(match[1] as string, 16),
      Number.parseInt((match[2] ?? match[1]) as string, 16),
    ]);
  }
  return ranges;
}

function explicitClass(ranges: readonly CodePointRange[]): RegExp {
  const source = ranges
    .map(([start, end]) => {
      const first = `\\u{${start.toString(16)}}`;
      return start === end ? first : `${first}-\\u{${end.toString(16)}}`;
    })
    .join("");
  return new RegExp(`[${source}]+`, "gu");
}

const [generalCategorySource, derivedCorePropertiesSource] = await Promise.all([
  readFile(new URL("vendor/unicode/17.0.0/DerivedGeneralCategory.txt", repositoryRoot), "utf8"),
  readFile(new URL("vendor/unicode/15.1.0/DerivedCoreProperties.txt", repositoryRoot), "utf8"),
]);
const pinnedPunctuationOrSymbol = explicitClass(
  pinnedRanges(
    generalCategorySource,
    (property) => property.startsWith("P") || property.startsWith("S"),
  ),
);
const pinnedDefaultIgnorable = explicitClass(
  pinnedRanges(
    derivedCorePropertiesSource,
    (property) => property === "Default_Ignorable_Code_Point",
  ),
);

function referenceComparableText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll(pinnedDefaultIgnorable, "")
    .replaceAll(pinnedPunctuationOrSymbol, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function legacyRegExpState(): readonly string[] {
  const aliases = RegExp as unknown as Readonly<Record<string, string>>;
  return [
    RegExp.input,
    RegExp.$_,
    RegExp.lastMatch,
    aliases["$&"],
    RegExp.lastParen,
    aliases["$+"],
    RegExp.leftContext,
    aliases["$`"],
    RegExp.rightContext,
    aliases["$'"],
    RegExp.$1,
    RegExp.$2,
    RegExp.$3,
    RegExp.$4,
    RegExp.$5,
    RegExp.$6,
    RegExp.$7,
    RegExp.$8,
    RegExp.$9,
  ];
}

function seedLegacyRegExpState(): void {
  /(a)(b)(c)(d)(e)(f)(g)(h)(i)/u.exec("known-benign-leftabcdefghi known-benign-tail");
}

function deterministicCorpus(count: number): readonly string[] {
  const alphabet = [
    "a",
    "Z",
    "İ",
    "Σ",
    "ß",
    "\u0301",
    "\u00ad",
    "\u034f",
    "\u200b",
    "\ufe0f",
    " ",
    "\t",
    "\n",
    "\u2028",
    "!",
    "—",
    "€",
    "😀",
    "\u{1fae8}",
    "\ud800",
    "\udc00",
    "Ａ",
    "ﬁ",
  ] as const;
  let state = 0x010f17a5;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const values: string[] = [];
  for (let caseIndex = 0; caseIndex < count; caseIndex += 1) {
    let value = "";
    const length = next() % 24;
    for (let index = 0; index < length; index += 1) {
      value += alphabet[next() % alphabet.length] as string;
    }
    values.push(value);
  }
  return values;
}

describe("create comparable-text normalization", () => {
  it("matches the pinned projection over normalization and separator boundaries", () => {
    const corpus = [
      "",
      "plain prose",
      "  MIXED\t whitespace\n",
      "ＡＢＣ",
      "Straße",
      "İstanbul",
      "ΟΣ",
      "ﬁnal",
      "a\u00adb",
      "a\u200bb",
      "a\ufe0fb",
      "a!—€💥 b",
      "!—€💥",
      "\ud800A\udc00",
      ...ecmaScriptWhitespace.map((codePoint) => `a${String.fromCodePoint(codePoint)}b`),
      ...deterministicCorpus(20_000),
    ];

    for (const value of corpus) {
      expect(normalizeComparableText(value)).toBe(referenceComparableText(value));
    }
  });

  it("matches the pinned projection at every Unicode 17 P/S range boundary", () => {
    const boundaryCodePoints = new Set<number>();
    for (const line of generalCategorySource.split("\n")) {
      const match = /^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*;\s*([PS][a-z])\s+#/u.exec(line);
      if (match === null) continue;
      const start = Number.parseInt(match[1] as string, 16);
      const end = Number.parseInt((match[2] ?? match[1]) as string, 16);
      for (const codePoint of [start - 1, start, end, end + 1]) {
        if (codePoint >= 0 && codePoint <= 0x10ffff) boundaryCodePoints.add(codePoint);
      }
    }

    expect(boundaryCodePoints.size).toBeGreaterThan(1_000);
    for (const codePoint of boundaryCodePoints) {
      const value = `left${String.fromCodePoint(codePoint)}right`;
      expect(normalizeComparableText(value)).toBe(referenceComparableText(value));
    }
  });

  it("pins post-15.1 punctuation/symbol separators and the ECMAScript whitespace boundary", () => {
    expect(normalizeComparableText("left\u{10d6e}right")).toBe("left right");
    expect(normalizeComparableText("left\u20c1right")).toBe("left right");
    expect(normalizeComparableText("left\u0085right")).toBe("left\u0085right");
  });

  it("leaves all legacy RegExp aliases unchanged", () => {
    const secret = "retention-sentinel-create-comparable";
    seedLegacyRegExpState();
    const before = legacyRegExpState();
    const result = normalizeComparableText(`  Ａ${secret}\u200b—💥\tB!  `);
    const after = legacyRegExpState();

    expect(before).toHaveLength(19);
    expect(before[0]).toBe("known-benign-leftabcdefghi known-benign-tail");
    expect(after).toEqual(before);
    expect(result).toBe("aretention sentinel create comparable b");
  });

  it("uses captured intrinsics after live RegExp and String entries are poisoned", () => {
    const value = "  Ａ\u200b—💥\tB!  ";
    const expected = referenceComparableText(value);
    const targets = [
      [Reflect, "apply"],
      [Number, "isInteger"],
      [String.prototype, "charCodeAt"],
      [String.prototype, "normalize"],
      [String.prototype, "slice"],
      [String.prototype, "toLocaleLowerCase"],
      [String.prototype, "replace"],
      [String.prototype, "replaceAll"],
      [String.prototype, "trim"],
      [RegExp.prototype, "exec"],
      [RegExp.prototype, "test"],
      [RegExp.prototype, Symbol.replace],
      [Array.prototype, Symbol.iterator],
    ] as const;
    const descriptors = targets.map(([target, key]) =>
      Object.getOwnPropertyDescriptor(target, key),
    );
    let calls = 0;
    const poison = () => {
      calls += 1;
      throw new Error("live comparable-text intrinsic used");
    };
    let observed: string | undefined;
    try {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index] as (typeof targets)[number];
        Object.defineProperty(target[0], target[1], {
          configurable: true,
          value: poison,
          writable: true,
        });
      }
      observed = normalizeComparableText(value);
    } finally {
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        Object.defineProperty(targets[index][0], targets[index][1], descriptors[index]);
      }
    }

    expect(calls).toBe(0);
    expect(observed).toBe(expected);
  });

  it("contains no RegExp or String rewrite entry path", async () => {
    const source = await readFile(new URL("src/create/comparable-text.ts", repositoryRoot), "utf8");
    for (const fragment of [
      "RegExp",
      ".exec(",
      ".test(",
      ".match(",
      ".search(",
      ".replace(",
      ".replaceAll(",
      ".split(",
      ".trim(",
      "Symbol.replace",
    ]) {
      expect(source).not.toContain(fragment);
    }
  });
});
