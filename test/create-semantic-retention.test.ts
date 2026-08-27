import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

const semanticPath = "../src/validate/semantic-text-placeholder.js";
const comparablePath = "../src/create/comparable-text.js";
const repositoryRoot = new URL("../", import.meta.url);
const fixturePath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];

type SemanticModule = typeof import("../src/validate/semantic-text-placeholder.js");
type ComparableModule = typeof import("../src/create/comparable-text.js");
type CreateLoader = typeof import("../src/create/load.js");

interface IsolatedLoader {
  readonly comparable: ComparableModule;
  readonly loader: CreateLoader;
  readonly semantic: SemanticModule;
  setNormalizer(normalizer: (value: string) => string): void;
  setProducer(producer: (value: unknown) => unknown): void;
  setPredicate(predicate: (value: unknown) => unknown): void;
}

afterEach(async () => {
  vi.doUnmock(semanticPath);
  vi.doUnmock(comparablePath);
  vi.resetModules();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryBrief(contents?: string): Promise<string> {
  const directory = await mkdtemp(join(temporaryRoot, "skillpress-create-semantic-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "brief.yaml");
  await writeFile(path, contents ?? (await readFile(fixturePath)), { mode: 0o600 });
  return path;
}

async function importIsolatedLoader(): Promise<IsolatedLoader> {
  let semantic: SemanticModule | undefined;
  let producer: (value: unknown) => unknown = () => {
    throw new Error("semantic producer used before initialization");
  };
  let predicate: (value: unknown) => unknown = () => false;
  let comparable: ComparableModule | undefined;
  let normalizer: (value: string) => string = () => {
    throw new Error("comparable-text normalizer used before initialization");
  };
  vi.resetModules();
  vi.doMock(semanticPath, async (importOriginal) => {
    semantic = await importOriginal<SemanticModule>();
    producer = semantic.classifySemanticTextPlaceholder;
    predicate = semantic.isGenuineSemanticTextPlaceholderClassification;
    return {
      ...semantic,
      classifySemanticTextPlaceholder: (value: unknown) => producer(value),
      isGenuineSemanticTextPlaceholderClassification: (value: unknown) => predicate(value),
    };
  });
  vi.doMock(comparablePath, async (importOriginal) => {
    comparable = await importOriginal<ComparableModule>();
    normalizer = comparable.normalizeComparableText;
    return {
      ...comparable,
      normalizeComparableText: (value: string) => normalizer(value),
    };
  });
  const loader = await import("../src/create/load.js");
  if (semantic === undefined) throw new Error("expected isolated semantic module");
  if (comparable === undefined) throw new Error("expected isolated comparable-text module");
  return {
    comparable,
    loader,
    semantic,
    setNormalizer(value) {
      normalizer = value;
    },
    setProducer(value) {
      producer = value;
    },
    setPredicate(value) {
      predicate = value;
    },
  };
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

async function captureIssues(
  operation: Promise<unknown>,
): Promise<readonly Record<string, unknown>[]> {
  try {
    await operation;
  } catch (error) {
    if (typeof error !== "object" || error === null || !("issues" in error)) throw error;
    return (error as { readonly issues: readonly Record<string, unknown>[] }).issues;
  }
  throw new Error("expected capability brief failure");
}

describe("create semantic-stage retention boundary", () => {
  it("preserves a post-schema RegExp checkpoint across all semantic scans", async () => {
    const isolated = await importIsolatedLoader();
    const path = await temporaryBrief();
    const forbiddenSources = new Set([
      "\\r\\n?|\\n",
      "^(?:todo|tbd|fixme|changeme|placeholder|replace me|fill me)$",
      "^(?:todo|tbd|fixme|changeme|placeholder|replace me|fill me)\\s*[:—-].*$",
      "^(?:TODO|TBD|FIXME|CHANGEME)\\s+.+$",
      "^\\[(?:todo|tbd|fixme|changeme|placeholder|fill|replace|insert|describe|enter|your)\\b[^\\]]*\\](?:\\s.*)?$",
      "\\p{Default_Ignorable_Code_Point}+",
      "[\\p{P}\\p{S}]+",
      "\\s+",
    ]);
    const targets = [
      [RegExp.prototype, "exec"],
      [RegExp.prototype, "test"],
      [RegExp.prototype, Symbol.replace],
      [RegExp.prototype, Symbol.split],
    ] as const;
    const descriptors = targets.map(([target, key]) =>
      Object.getOwnPropertyDescriptor(target, key),
    );
    const originals = descriptors.map(
      (descriptor) => descriptor?.value as (...args: never[]) => unknown,
    );
    let guardedCalls = 0;
    let prohibitedCalls = 0;
    let classifierCalls = 0;
    let normalizerCalls = 0;
    let checkpoint: readonly string[] | undefined;
    let guardsInstalled = false;

    const installGuards = () => {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index] as (typeof targets)[number];
        const original = originals[index] as (...args: never[]) => unknown;
        Object.defineProperty(target[0], target[1], {
          configurable: true,
          value: function (this: RegExp, ...args: unknown[]) {
            guardedCalls += 1;
            if (forbiddenSources.has(this.source)) {
              prohibitedCalls += 1;
              throw new Error("former create semantic RegExp path used");
            }
            return Reflect.apply(original, this, args);
          },
          writable: true,
        });
      }
      guardsInstalled = true;
    };
    const restoreGuards = () => {
      if (!guardsInstalled) return;
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        Object.defineProperty(targets[index][0], targets[index][1], descriptors[index]);
      }
      guardsInstalled = false;
    };

    const actualNormalizer = isolated.comparable.normalizeComparableText;
    isolated.setNormalizer((value) => {
      normalizerCalls += 1;
      if (normalizerCalls === 1) {
        seedLegacyRegExpState();
        checkpoint = legacyRegExpState();
        installGuards();
      }
      return actualNormalizer(value);
    });
    isolated.setProducer((value) => {
      classifierCalls += 1;
      return isolated.semantic.classifySemanticTextPlaceholder(value);
    });
    let result: Awaited<ReturnType<CreateLoader["loadCapabilityBrief"]>> | undefined;
    try {
      result = await isolated.loader.loadCapabilityBrief(path);
    } finally {
      restoreGuards();
    }
    const after = legacyRegExpState();

    expect(result?.name).toBe("incident-summary");
    expect(normalizerCalls).toBe(21);
    expect(classifierCalls).toBe(48);
    expect(guardedCalls).toBe(0);
    expect(prohibitedCalls).toBe(0);
    expect(checkpoint?.[0]).toBe("known-benign-leftabcdefghi known-benign-tail");
    expect(after).toEqual(checkpoint);
  });

  it("fails closed on foreign, forged, hostile, and exceptional classifier results", async () => {
    const foreign = await import(semanticPath);
    const foreignSafe = foreign.classifySemanticTextPlaceholder("ordinary");
    const isolated = await importIsolatedLoader();
    const path = await temporaryBrief();
    const safe = isolated.semantic.classifySemanticTextPlaceholder("ordinary");
    const invalid = isolated.semantic.classifySemanticTextPlaceholder(Symbol("private"));
    const tooLarge = isolated.semantic.classifySemanticTextPlaceholder("x".repeat(512 * 1024 + 1));
    let traps = 0;
    const trap = () => {
      traps += 1;
      throw new Error("private proxy trap");
    };
    const activeProxy = new Proxy(safe, { get: trap, getOwnPropertyDescriptor: trap });
    const revoked = Proxy.revocable(safe, { get: trap, getOwnPropertyDescriptor: trap });
    revoked.revoke();
    let accessorReads = 0;
    const accessor = Object.defineProperties(
      {},
      {
        ok: { get: () => (accessorReads += 1) },
        reason: { get: () => (accessorReads += 1) },
      },
    );
    const genuine = isolated.semantic.isGenuineSemanticTextPlaceholderClassification;
    const failures: readonly (readonly [() => unknown, () => unknown])[] = [
      [() => foreignSafe, genuine],
      [() => structuredClone(safe), genuine],
      [() => activeProxy, () => true],
      [() => revoked.proxy, () => true],
      [() => accessor, () => true],
      [() => invalid, genuine],
      [() => tooLarge, genuine],
      [() => ({ ok: true, reason: "placeholder" }), () => true],
      [() => safe, () => ({ truthy: true })],
      [
        () => safe,
        () => {
          throw new Error("private predicate failure");
        },
      ],
      [
        () => {
          throw new Error("private producer failure");
        },
        genuine,
      ],
    ];

    for (const [producer, predicate] of failures) {
      isolated.setProducer(producer);
      isolated.setPredicate(predicate);
      const issues = await captureIssues(isolated.loader.loadCapabilityBrief(path));
      expect(issues).toEqual([
        {
          code: "brief.placeholder_analysis",
          path: "/title",
          message: "value could not be analyzed safely for placeholders",
        },
      ]);
      expect(JSON.stringify(issues)).not.toContain("private");
    }
    expect(traps).toBe(0);
    expect(accessorReads).toBe(0);
  });

  it("keeps every declared non-prose path outside placeholder classification", async () => {
    const isolated = await importIsolatedLoader();
    const source = (await readFile(fixturePath, "utf8")).replace(
      "      timeoutSeconds: 300",
      "      cwd: TODO\n      timeoutSeconds: 300",
    );
    const path = await temporaryBrief(source);
    const exemptValues = new Set([
      "incident-summary",
      "0.1.0",
      "https://github.com/example/incident-summary",
      "example",
      "MIT",
      "moderate",
      "docker",
      "none",
      "incident-records",
      "audience",
      "handoff",
      "node",
      "--test",
      "TODO",
      "github",
      "tessl",
      "positive-shift-handoff",
      "positive-review-summary",
      "near-miss-fiction",
      "near-miss-generic-summary",
      "failure-no-records",
      "adversarial-record-injection",
      "holdout-positive-escalation",
      "holdout-near-miss-status",
    ]);
    const actualClassifier = isolated.semantic.classifySemanticTextPlaceholder;
    let calls = 0;
    isolated.setProducer((value) => {
      calls += 1;
      if (typeof value === "string" && exemptValues.has(value)) {
        throw new Error(`non-prose value reached classifier: ${value}`);
      }
      return actualClassifier(value);
    });

    await expect(isolated.loader.loadCapabilityBrief(path)).resolves.toMatchObject({
      name: "incident-summary",
      version: "0.1.0",
    });
    expect(calls).toBe(48);
  });

  it("discards staged placeholder findings when a later classification fails", async () => {
    const isolated = await importIsolatedLoader();
    const path = await temporaryBrief();
    const placeholder = isolated.semantic.classifySemanticTextPlaceholder("TODO");
    const genuine = isolated.semantic.isGenuineSemanticTextPlaceholderClassification;
    let calls = 0;
    isolated.setProducer((value) => {
      calls += 1;
      if (calls === 1) return placeholder;
      if (calls === 2) throw new Error("private late failure");
      return isolated.semantic.classifySemanticTextPlaceholder(value);
    });
    isolated.setPredicate(genuine);

    const issues = await captureIssues(isolated.loader.loadCapabilityBrief(path));

    expect(calls).toBe(2);
    expect(issues).toEqual([
      {
        code: "brief.placeholder_analysis",
        path: "/summary",
        message: "value could not be analyzed safely for placeholders",
      },
    ]);
  });

  it("returns a prebuilt result after a classifier poisons live traversal entries", async () => {
    const isolated = await importIsolatedLoader();
    const path = await temporaryBrief();
    const safe = isolated.semantic.classifySemanticTextPlaceholder("ordinary");
    const nativeDefineProperty = Object.defineProperty;
    const nativeDeleteProperty = Reflect.deleteProperty;
    const targets = [
      [Reflect, "apply"],
      [Array, "isArray"],
      [Object, "defineProperty"],
      [Object, "entries"],
      [Object, "getOwnPropertyDescriptor"],
      [Set.prototype, "has"],
      [String.prototype, "endsWith"],
      [String.prototype, "includes"],
      [String.prototype, "replaceAll"],
      [String.prototype, "startsWith"],
      [types, "isProxy"],
    ] as const;
    const descriptors = targets.map(([target, key]) =>
      Object.getOwnPropertyDescriptor(target, key),
    );
    const versionDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "version");
    const thenDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "then");
    let classifierCalls = 0;
    let poisonCalls = 0;
    let installed = false;
    const poison = () => {
      poisonCalls += 1;
      throw new Error("live semantic traversal entry used after classifier callback");
    };
    const install = () => {
      for (let index = 0; index < targets.length; index += 1) {
        nativeDefineProperty(targets[index][0], targets[index][1], {
          configurable: true,
          value: poison,
          writable: true,
        });
      }
      for (const key of ["version", "then"] as const) {
        nativeDefineProperty(Object.prototype, key, {
          configurable: true,
          get: poison,
          set: poison,
        });
      }
      installed = true;
    };
    const restore = () => {
      if (!installed) return;
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        nativeDefineProperty(targets[index][0], targets[index][1], descriptors[index]);
      }
      for (const [key, descriptor] of [
        ["version", versionDescriptor],
        ["then", thenDescriptor],
      ] as const) {
        if (descriptor === undefined) nativeDeleteProperty(Object.prototype, key);
        else nativeDefineProperty(Object.prototype, key, descriptor);
      }
      installed = false;
    };

    isolated.setProducer(() => {
      classifierCalls += 1;
      if (classifierCalls === 1) install();
      return safe;
    });
    let result: Awaited<ReturnType<CreateLoader["loadCapabilityBrief"]>> | undefined;
    try {
      result = await isolated.loader.loadCapabilityBrief(path);
    } finally {
      restore();
    }

    expect(result?.name).toBe("incident-summary");
    expect(result?.version).toBe("0.1.0");
    expect(Object.getOwnPropertyDescriptor(result, "then")).toEqual({
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false,
    });
    expect(Object.keys(result ?? {})).not.toContain("then");
    expect(JSON.stringify(result)).not.toContain('"then"');
    expect(classifierCalls).toBe(48);
    expect(poisonCalls).toBe(0);
  });

  it("assembles a prebuilt error through own slots after inherited setters are poisoned", async () => {
    const isolated = await importIsolatedLoader();
    const path = await temporaryBrief();
    const placeholder = isolated.semantic.classifySemanticTextPlaceholder("TODO");
    const safe = isolated.semantic.classifySemanticTextPlaceholder("ordinary");
    const nativeDefineProperty = Object.defineProperty;
    const nativeDeleteProperty = Reflect.deleteProperty;
    const arrayZeroDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    const errorNameDescriptor = Object.getOwnPropertyDescriptor(Error.prototype, "name");
    const objectIssuesDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "issues");
    const objectGetDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "get");
    const objectSetDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "set");
    const definePropertyDescriptor = Object.getOwnPropertyDescriptor(Object, "defineProperty");
    let classifierCalls = 0;
    let poisonCalls = 0;
    let installed = false;
    const poison = () => {
      poisonCalls += 1;
      throw new Error("inherited semantic assembly entry used after classifier callback");
    };
    const install = () => {
      nativeDefineProperty(Array.prototype, "0", {
        configurable: true,
        get: poison,
        set: poison,
      });
      nativeDefineProperty(Error.prototype, "name", {
        configurable: true,
        get: poison,
        set: poison,
      });
      nativeDefineProperty(Object.prototype, "issues", {
        configurable: true,
        get: poison,
        set: poison,
      });
      nativeDefineProperty(Object, "defineProperty", {
        configurable: true,
        value: poison,
        writable: true,
      });
      for (const key of ["get", "set"] as const) {
        nativeDefineProperty(Object.prototype, key, {
          configurable: true,
          get: poison,
          set: poison,
        });
      }
      installed = true;
    };
    const restoreProperty = (
      target: object,
      key: PropertyKey,
      descriptor: PropertyDescriptor | undefined,
    ) => {
      if (descriptor === undefined) nativeDeleteProperty(target, key);
      else nativeDefineProperty(target, key, descriptor);
    };
    const restore = () => {
      if (!installed) return;
      restoreProperty(Object.prototype, "set", objectSetDescriptor);
      restoreProperty(Object.prototype, "get", objectGetDescriptor);
      restoreProperty(Object, "defineProperty", definePropertyDescriptor);
      restoreProperty(Object.prototype, "issues", objectIssuesDescriptor);
      restoreProperty(Error.prototype, "name", errorNameDescriptor);
      restoreProperty(Array.prototype, "0", arrayZeroDescriptor);
      installed = false;
    };

    isolated.setProducer(() => {
      classifierCalls += 1;
      if (classifierCalls === 1) install();
      return classifierCalls === 1 ? placeholder : safe;
    });
    let observed: unknown;
    try {
      await isolated.loader.loadCapabilityBrief(path);
    } catch (error) {
      observed = error;
    } finally {
      restore();
    }

    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).name).toBe("CapabilityBriefError");
    expect((observed as { readonly issues: readonly unknown[] }).issues).toEqual([
      {
        code: "brief.placeholder",
        path: "/title",
        message: "value is a placeholder",
      },
    ]);
    expect(classifierCalls).toBe(48);
    expect(poisonCalls).toBe(0);
  });

  it("captures semantic dependencies before the capability schema read yields", async () => {
    const path = await temporaryBrief();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const nativeApply = Reflect.apply;
    const nativeDescriptor = Object.getOwnPropertyDescriptor;
    const nativeIsProxy = types.isProxy;
    const schemaHref = new URL("../schemas/capability-brief.schema.json", import.meta.url).href;
    let markSchemaReadStarted: () => void = () => undefined;
    const schemaReadStarted = new Promise<void>((resolve) => {
      markSchemaReadStarted = resolve;
    });
    let releaseSchemaRead: () => void = () => undefined;
    const schemaReadRelease = new Promise<void>((resolve) => {
      releaseSchemaRead = resolve;
    });
    let gated = false;
    let semantic: SemanticModule | undefined;
    let safeSingleton: unknown;
    let classifyWrapper: ((value: unknown) => unknown) | undefined;
    let predicateWrapper: ((value: unknown) => unknown) | undefined;
    let mockedSemantic: Record<string, unknown> | undefined;
    let comparable: ComparableModule | undefined;
    let normalizeWrapper: ((value: string) => string) | undefined;
    let mockedComparable: Record<string, unknown> | undefined;
    let poisonCalls = 0;
    const poison = () => {
      poisonCalls += 1;
      throw new Error("post-await semantic dependency used");
    };

    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      async readFile(...args: unknown[]) {
        const reading = nativeApply(actualFs.readFile, undefined, args) as Promise<unknown>;
        const requested = args[0];
        if (!gated && requested instanceof URL && requested.href === schemaHref) {
          gated = true;
          markSchemaReadStarted();
          await schemaReadRelease;
        }
        return reading;
      },
    }));
    vi.doMock(semanticPath, async (importOriginal) => {
      semantic = await importOriginal<SemanticModule>();
      safeSingleton = semantic.classifySemanticTextPlaceholder("ordinary");
      classifyWrapper = (value: unknown) => semantic?.classifySemanticTextPlaceholder(value);
      predicateWrapper = (value: unknown) =>
        semantic?.isGenuineSemanticTextPlaceholderClassification(value);
      mockedSemantic = {
        ...semantic,
        classifySemanticTextPlaceholder: classifyWrapper,
        isGenuineSemanticTextPlaceholderClassification: predicateWrapper,
      };
      return mockedSemantic;
    });
    vi.doMock(comparablePath, async (importOriginal) => {
      comparable = await importOriginal<ComparableModule>();
      normalizeWrapper = (value: string) => comparable?.normalizeComparableText(value) as string;
      mockedComparable = {
        ...comparable,
        normalizeComparableText: normalizeWrapper,
      };
      return mockedComparable;
    });

    const applyDescriptor = nativeDescriptor(Reflect, "apply");
    const objectDescriptor = nativeDescriptor(Object, "getOwnPropertyDescriptor");
    const proxyDescriptor = nativeDescriptor(types, "isProxy");
    let replacementsInstalled = false;
    const restore = () => {
      if (!replacementsInstalled) return;
      Object.defineProperty(Reflect, "apply", applyDescriptor as PropertyDescriptor);
      Object.defineProperty(
        Object,
        "getOwnPropertyDescriptor",
        objectDescriptor as PropertyDescriptor,
      );
      Object.defineProperty(types, "isProxy", proxyDescriptor as PropertyDescriptor);
      if (mockedSemantic !== undefined) {
        mockedSemantic.classifySemanticTextPlaceholder = classifyWrapper;
        mockedSemantic.isGenuineSemanticTextPlaceholderClassification = predicateWrapper;
      }
      if (mockedComparable !== undefined) {
        mockedComparable.normalizeComparableText = normalizeWrapper;
      }
      replacementsInstalled = false;
    };

    let loader: CreateLoader | undefined;
    let result: Awaited<ReturnType<CreateLoader["loadCapabilityBrief"]>> | undefined;
    try {
      const importing = import("../src/create/load.js");
      await schemaReadStarted;
      Object.defineProperty(Reflect, "apply", {
        configurable: true,
        value(target: unknown, receiver: unknown, args: ArrayLike<unknown>) {
          if (
            target === classifyWrapper ||
            target === predicateWrapper ||
            target === normalizeWrapper ||
            target === nativeDescriptor ||
            target === nativeIsProxy
          ) {
            return poison();
          }
          return nativeApply(target as (...args: never[]) => unknown, receiver, args);
        },
        writable: true,
      });
      Object.defineProperty(Object, "getOwnPropertyDescriptor", {
        configurable: true,
        value(target: object, key: PropertyKey) {
          if (target === safeSingleton && (key === "ok" || key === "reason")) return poison();
          return nativeDescriptor(target, key);
        },
        writable: true,
      });
      Object.defineProperty(types, "isProxy", {
        configurable: true,
        value(value: unknown) {
          if (value === safeSingleton) return poison();
          return nativeIsProxy(value);
        },
        writable: true,
      });
      if (mockedSemantic === undefined) throw new Error("expected mocked semantic exports");
      if (mockedComparable === undefined) throw new Error("expected mocked comparable exports");
      mockedSemantic.classifySemanticTextPlaceholder = poison;
      mockedSemantic.isGenuineSemanticTextPlaceholderClassification = poison;
      mockedComparable.normalizeComparableText = poison;
      replacementsInstalled = true;
      releaseSchemaRead();
      loader = await importing;
      result = await loader.loadCapabilityBrief(path);
    } finally {
      releaseSchemaRead();
      restore();
      vi.doUnmock("node:fs/promises");
    }

    expect(result).toMatchObject({
      name: "incident-summary",
    });
    expect(poisonCalls).toBe(0);
  });

  it("contains no former raw-input RegExp path and captures dependencies before schema await", async () => {
    const source = await readFile(new URL("src/create/load.ts", repositoryRoot), "utf8");
    for (const fragment of [
      "isPlaceholderLine",
      ".split(/\\r\\n?|\\n/u)",
      "\\p{Default_Ignorable_Code_Point}",
      "[\\p{P}\\p{S}]",
      ".replaceAll(/\\s+",
    ]) {
      expect(source).not.toContain(fragment);
    }
    expect(source.split("RegExp")).toHaveLength(1);
    const schemaAwait = source.indexOf("await readFile(schemaUrl");
    expect(schemaAwait).toBeGreaterThan(0);
    for (const fragment of [
      "const applySnapshot = Reflect.apply;",
      "const classifyPlaceholderSnapshot = classifySemanticTextPlaceholder;",
      "const genuinePlaceholderSnapshot = isGenuineSemanticTextPlaceholderClassification;",
      "const normalizeComparableTextSnapshot = normalizeComparableText;",
      "const arrayIsArraySnapshot = Array.isArray;",
      "const definePropertySnapshot = Object.defineProperty;",
      "const getOwnPropertyDescriptorSnapshot = Object.getOwnPropertyDescriptor;",
      "const objectEntriesSnapshot = Object.entries;",
      "const setHasSnapshot = Set.prototype.has;",
      "const stringEndsWithSnapshot = String.prototype.endsWith;",
      "const stringIncludesSnapshot = String.prototype.includes;",
      "const stringReplaceAllSnapshot = String.prototype.replaceAll;",
      "const stringStartsWithSnapshot = String.prototype.startsWith;",
      "const isProxySnapshot = types.isProxy;",
    ]) {
      const capture = source.indexOf(fragment);
      expect(capture).toBeGreaterThan(0);
      expect(capture).toBeLessThan(schemaAwait);
    }
  });
});
