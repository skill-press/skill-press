import { realpathSync, symlinkSync } from "node:fs";
import { lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Lexer } from "yaml";

import {
  CONFIG_FILE_NAME,
  LEGACY_CONFIG_FILE_NAME,
  loadProjectConfig,
  loadStrictYamlDocument,
  MAX_CONFIG_BYTES,
  readConfigText,
  sameFileIdentity,
} from "../src/config/load.js";
import { ProjectConfigError } from "../src/config/errors.js";

const fixturePath = fileURLToPath(new URL("fixtures/config/valid.yaml", import.meta.url));
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
let validConfig = "";

function legacyRegExpState(): readonly string[] {
  const aliases = RegExp as unknown as Readonly<Record<string, string>>;
  return "input $_ lastMatch $& lastParen $+ leftContext $` rightContext $' $1 $2 $3 $4 $5 $6 $7 $8 $9"
    .split(" ")
    .map((alias) => aliases[alias]);
}

function seedLegacyRegExpState(): void {
  /(a)(b)(c)(d)(e)(f)(g)(h)(i)/u.exec("known-benign-leftabcdefghi known-benign-tail");
}

function legacyIndentationExceedsBudget(text: string): boolean {
  return text.split(/\r?\n/u).some((line) => {
    const contentOffset = line.search(/[^ ]/u);
    return (contentOffset === -1 ? line.length : contentOffset) > 64;
  });
}

beforeAll(async () => {
  validConfig = await readFile(fixturePath, "utf8");
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryConfig(
  content: string | Uint8Array,
): Promise<{ readonly directory: string; readonly path: string }> {
  const directory = await mkdtemp(join(temporaryRoot, "skillpress-config-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, CONFIG_FILE_NAME);
  await writeFile(path, content, { mode: 0o600 });
  return { directory, path };
}

async function strictDocumentIssueCodes(path: string): Promise<readonly string[]> {
  try {
    await loadStrictYamlDocument(path);
    return [];
  } catch (error) {
    if (!(error instanceof ProjectConfigError)) throw error;
    return error.issues.map((entry) => entry.code);
  }
}

async function expectIssue(path: string, code: string): Promise<ProjectConfigError> {
  try {
    await loadProjectConfig(path);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectConfigError);
    const configError = error as ProjectConfigError;
    expect(configError.issues.map((entry) => entry.code)).toContain(code);
    return configError;
  }
  throw new Error(`Expected ${code} while loading ${path}`);
}

describe("project configuration", () => {
  it("loads a valid configuration file", async () => {
    const config = await loadProjectConfig(fixturePath);

    expect(config.schemaVersion).toBe(2);
    expect(config.skill).toEqual({
      name: "example-skill",
      path: "skills/example-skill",
      risk: "moderate",
    });
    expect(config.quality.tesslImpactMinimum).toBe(90);
  });

  it("finds skill-press.yaml when given a directory", async () => {
    const fixture = await temporaryConfig(validConfig);

    await expect(loadProjectConfig(fixture.directory)).resolves.toEqual(
      await loadProjectConfig(fixture.path),
    );
  });

  it("rejects the legacy filename with an explicit migration diagnostic", async () => {
    const directory = await mkdtemp(join(temporaryRoot, "skill-press-legacy-config-test-"));
    temporaryDirectories.push(directory);
    const legacyPath = join(directory, LEGACY_CONFIG_FILE_NAME);
    await writeFile(legacyPath, validConfig, { mode: 0o600 });

    await expectIssue(directory, "config.legacy_filename");
    await expectIssue(legacyPath, "config.legacy_filename");
  });

  it("reports every schema violation with stable codes", async () => {
    const invalid = `${validConfig}\nunknownTopLevel: true\n`.replace(
      "tesslImpactMinimum: 90",
      "tesslImpactMinimum: 89",
    );
    const fixture = await temporaryConfig(invalid);
    const error = await expectIssue(fixture.path, "config.schema.additionalProperties");

    expect(error.issues.map((entry) => entry.code)).toContain("config.schema.minimum");
  });

  it("rejects an unsafe parent-relative skill path", async () => {
    const fixture = await temporaryConfig(
      validConfig.replace("path: skills/example-skill", "path: ../outside"),
    );

    await expectIssue(fixture.path, "config.schema.pattern");
  });

  it("enforces SemVer numeric prerelease identifiers without leading zeroes", async () => {
    const invalid = await temporaryConfig(
      validConfig.replace("version: 1.2.3", "version: 1.2.3-01"),
    );
    const valid = await temporaryConfig(
      validConfig.replace("version: 1.2.3", "version: 1.2.3-alpha.1+build.01"),
    );

    await expectIssue(invalid.path, "config.schema.pattern");
    await expect(loadProjectConfig(valid.path)).resolves.toMatchObject({
      project: { version: "1.2.3-alpha.1+build.01" },
    });
  });

  it("requires one canonical lowercase registry namespace", async () => {
    const missing = await temporaryConfig(
      validConfig.replace("registry:\n  namespace: example\n", ""),
    );
    const noncanonical = await temporaryConfig(
      validConfig.replace("namespace: example", "namespace: Example_Org"),
    );

    await expectIssue(missing.path, "config.schema.required");
    await expectIssue(noncanonical.path, "config.schema.pattern");
  });

  it("rejects duplicate YAML keys", async () => {
    const fixture = await temporaryConfig(`${validConfig}\nschemaVersion: 2\n`);

    await expectIssue(fixture.path, "config.yaml");
  });

  it("rejects multiple YAML documents", async () => {
    const fixture = await temporaryConfig(`${validConfig}\n---\nschemaVersion: 2\n`);

    await expectIssue(fixture.path, "config.yaml_documents");
  });

  it("rejects YAML aliases", async () => {
    const fixture = await temporaryConfig(
      validConfig.replace("schemaVersion: 2", "schemaVersion: &version 2\nalias: *version"),
    );

    await expectIssue(fixture.path, "config.yaml_alias");
  });

  it("rejects invalid UTF-8", async () => {
    const fixture = await temporaryConfig(Uint8Array.from([0xc3, 0x28]));

    await expectIssue(fixture.path, "config.encoding");
  });

  it("rejects files above the byte limit without parsing them", async () => {
    const fixture = await temporaryConfig(new Uint8Array(MAX_CONFIG_BYTES + 1).fill(0x61));

    await expectIssue(fixture.path, "config.too_large");
  });

  it("rejects deeply nested flow collections before YAML parsing", async () => {
    const fixture = await temporaryConfig(`${"[".repeat(33)}0${"]".repeat(33)}`);

    await expectIssue(fixture.path, "config.complexity");
  });

  it("rejects excessive block indentation before YAML parsing", async () => {
    const fixture = await temporaryConfig(`root:\n${" ".repeat(65)}value: true\n`);

    await expectIssue(fixture.path, "config.complexity");
  });

  it("matches the former LF-delimited indentation language at every boundary", async () => {
    const fixture = await temporaryConfig("");
    const trailingSpaces = " ".repeat(65);
    const tails = ["", "x", "\t", "\u00a0", "\u2028", "😀", "\ufffd"];
    const leaders = [
      "",
      "head: value\n",
      "head: value\r",
      "head: value\r\n",
      "head: value\r\r\n",
      "head: value\n\r",
    ];
    for (const leader of leaders) {
      for (const indentation of [0, 64, 65]) {
        for (const tail of tails) {
          const text = `${leader}${" ".repeat(indentation)}${tail}${
            tail === "" ? "" : trailingSpaces
          }\n`;
          await writeFile(fixture.path, text);
          const codes = await strictDocumentIssueCodes(fixture.path);
          expect(codes.includes("config.complexity")).toBe(legacyIndentationExceedsBudget(text));
        }
      }
    }
  });

  it("keeps byte and encoding failures ahead of indentation complexity", async () => {
    const exactText = new Uint8Array(MAX_CONFIG_BYTES).fill(0x78);
    exactText.fill(0x20, 0, 65);
    const invalidUtf8 = exactText.slice();
    invalidUtf8[MAX_CONFIG_BYTES - 1] = 0xc3;
    const over = new Uint8Array(MAX_CONFIG_BYTES + 1).fill(0x78);
    over.fill(0x20, 0, 65);
    over[MAX_CONFIG_BYTES] = 0xc3;
    const cases = [
      {
        fixture: await temporaryConfig(exactText),
        code: "config.complexity",
        message: "YAML indentation exceeds 64 spaces",
      },
      {
        fixture: await temporaryConfig(invalidUtf8),
        code: "config.encoding",
        message: "configuration is not valid UTF-8",
      },
      {
        fixture: await temporaryConfig(over),
        code: "config.too_large",
        message: `configuration exceeds ${MAX_CONFIG_BYTES} bytes`,
      },
    ] as const;

    for (const { fixture, code, message } of cases) {
      for (const operation of [loadProjectConfig, loadStrictYamlDocument]) {
        const error = await expectIssueFrom(operation(fixture.path), code);
        expect(error.issues).toEqual([{ code, path: "/", message }]);
      }
    }
  });

  it("does not retain over-indented input in legacy RegExp aliases", async () => {
    const secret = "retention-sentinel-config";
    const fixture = await temporaryConfig(`root:\n${" ".repeat(65)}${secret}: true\n`);
    const operations = [
      () => loadProjectConfig(fixture.path),
      () => loadStrictYamlDocument(fixture.path),
    ] as const;

    for (const operation of operations) {
      seedLegacyRegExpState();
      const before = legacyRegExpState();
      let failure: unknown;
      try {
        await operation();
      } catch (error) {
        failure = error;
      }
      const after = legacyRegExpState();

      expect(before).toHaveLength(19);
      expect(before[0]).toBe("known-benign-leftabcdefghi known-benign-tail");
      expect(after).toEqual(before);
      expect(failure).toBeInstanceOf(ProjectConfigError);
      const configError = failure as ProjectConfigError;
      expect(configError.message).toBe(
        "Skill Press configuration exceeds the YAML complexity budget.",
      );
      expect(configError.issues).toEqual([
        {
          code: "config.complexity",
          path: "/",
          message: "YAML indentation exceeds 64 spaces",
        },
      ]);
      expect(JSON.stringify(configError)).not.toContain(secret);
    }
  });

  it("uses captured indentation intrinsics and returns before the Lexer", async () => {
    const fixture = await temporaryConfig(`root:\n${" ".repeat(65)}private: true\n`);
    const nativeApply = Reflect.apply;
    const nativeSplit = String.prototype.split;
    const targets = [
      [Reflect, "apply"],
      [String.prototype, "charCodeAt"],
      [String.prototype, "search"],
      [RegExp.prototype, "exec"],
      [RegExp.prototype, "test"],
      [RegExp.prototype, Symbol.split],
      [RegExp.prototype, Symbol.search],
    ] as const;
    const descriptors = targets.map(([target, key]) =>
      Object.getOwnPropertyDescriptor(target, key),
    );
    const splitDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "split");
    const lexerDescriptor = Object.getOwnPropertyDescriptor(Lexer.prototype, "lex");
    const failures: unknown[] = [];
    let poisonCalls = 0;
    let plainSplitCalls = 0;
    let regexpSplitCalls = 0;
    let lexerCalls = 0;
    const poison = () => {
      poisonCalls += 1;
      throw new Error("live indentation intrinsic used");
    };
    const guardedSplit = function (
      this: string,
      separator?: string | RegExp,
      limit?: number,
    ): string[] {
      if (separator !== undefined && typeof separator !== "string") {
        regexpSplitCalls += 1;
        throw new Error("RegExp separator used by indentation scanner");
      }
      plainSplitCalls += 1;
      return nativeApply(nativeSplit, this, [separator, limit]) as string[];
    };
    try {
      Object.defineProperty(String.prototype, "split", {
        configurable: true,
        value: guardedSplit,
        writable: true,
      });
      for (const [target, key] of targets) {
        Object.defineProperty(target, key, { configurable: true, value: poison, writable: true });
      }
      Object.defineProperty(Lexer.prototype, "lex", {
        configurable: true,
        value: () => {
          lexerCalls += 1;
          throw new Error("Lexer used on over-indented configuration");
        },
        writable: true,
      });
      for (const operation of [loadProjectConfig, loadStrictYamlDocument]) {
        try {
          await operation(fixture.path);
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      Object.defineProperty(Lexer.prototype, "lex", lexerDescriptor as PropertyDescriptor);
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        Object.defineProperty(targets[index][0], targets[index][1], descriptors[index]);
      }
      Object.defineProperty(String.prototype, "split", splitDescriptor as PropertyDescriptor);
    }

    expect([poisonCalls, regexpSplitCalls, lexerCalls]).toEqual([0, 0, 0]);
    expect(plainSplitCalls).toBeGreaterThan(0);
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ProjectConfigError);
      expect((failure as ProjectConfigError).issues).toEqual([
        {
          code: "config.complexity",
          path: "/",
          message: "YAML indentation exceeds 64 spaces",
        },
      ]);
    }
  });

  it("captures indentation intrinsics before the top-level schema read yields", async () => {
    const text = `root:\n${" ".repeat(65)}private: true\n`;
    const fixture = await temporaryConfig(text);
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const schemaHref = new URL("../schemas/skill-press.schema.json", import.meta.url).href;
    const nativeApply = Reflect.apply;
    const nativeCharCodeAt = String.prototype.charCodeAt;
    const applyDescriptor = Object.getOwnPropertyDescriptor(Reflect, "apply");
    const charCodeAtDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "charCodeAt");
    let markSchemaReadStarted: () => void = () => undefined;
    const schemaReadStarted = new Promise<void>((resolve) => {
      markSchemaReadStarted = resolve;
    });
    let releaseSchemaRead: () => void = () => undefined;
    const schemaReadRelease = new Promise<void>((resolve) => {
      releaseSchemaRead = resolve;
    });
    let gated = false;
    let poisonCalls = 0;
    let intrinsicsReplaced = false;
    const guardedApply: typeof Reflect.apply = (target, thisArgument, argumentsList) => {
      if (thisArgument === text) {
        poisonCalls += 1;
        throw new Error("post-await Reflect.apply snapshot used");
      }
      return nativeApply(target, thisArgument, argumentsList);
    };
    const guardedCharCodeAt: typeof String.prototype.charCodeAt = function (
      this: string,
      index: number,
    ): number {
      if (this === text) {
        poisonCalls += 1;
        throw new Error("post-await charCodeAt snapshot used");
      }
      return nativeApply(nativeCharCodeAt, this, [index]) as number;
    };
    const restoreIntrinsics = () => {
      if (!intrinsicsReplaced) return;
      Object.defineProperty(Reflect, "apply", applyDescriptor as PropertyDescriptor);
      Object.defineProperty(
        String.prototype,
        "charCodeAt",
        charCodeAtDescriptor as PropertyDescriptor,
      );
      intrinsicsReplaced = false;
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
    try {
      const importing = import("../src/config/load.js");
      await schemaReadStarted;
      Object.defineProperty(Reflect, "apply", {
        configurable: true,
        value: guardedApply,
        writable: true,
      });
      Object.defineProperty(String.prototype, "charCodeAt", {
        configurable: true,
        value: guardedCharCodeAt,
        writable: true,
      });
      intrinsicsReplaced = true;
      releaseSchemaRead();
      const isolated = await importing;
      restoreIntrinsics();

      let failure: unknown;
      try {
        await isolated.loadStrictYamlDocument(fixture.path);
      } catch (error) {
        failure = error;
      }
      expect(poisonCalls).toBe(0);
      expect(failure).toMatchObject({
        name: "ProjectConfigError",
        message: "Skill Press configuration exceeds the YAML complexity budget.",
        issues: [
          {
            code: "config.complexity",
            path: "/",
            message: "YAML indentation exceeds 64 spaces",
          },
        ],
      });
    } finally {
      releaseSchemaRead();
      restoreIntrinsics();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("keeps config indentation free of per-input RegExp entry points", async () => {
    const source = await readFile(new URL("../src/config/load.ts", import.meta.url), "utf8");
    const firstAwait = source.indexOf("await readFile(schemaUrl");
    const applyCapture = source.indexOf("const applySnapshot");
    const charCodeAtCapture = source.indexOf("const charCodeAtSnapshot");
    expect(firstAwait).toBeGreaterThan(-1);
    expect(applyCapture).toBeGreaterThan(-1);
    expect(charCodeAtCapture).toBeGreaterThan(-1);
    expect(applyCapture).toBeLessThan(firstAwait);
    expect(charCodeAtCapture).toBeLessThan(firstAwait);
    expect(source).toContain(".split(sep)");
    expect(source.split(".split(")).toHaveLength(2);
    for (const fragment of [
      "RegExp",
      ".exec(",
      ".test(",
      ".match(",
      ".matchAll(",
      ".search(",
      ".replace(",
      ".replaceAll(",
      ".split(/",
      "Symbol.split",
      "Symbol.search",
    ]) {
      expect(source).not.toContain(fragment);
    }
  });

  it("rejects excessive lexical tokens before YAML parsing", async () => {
    const fixture = await temporaryConfig(`values:\n${"- 0\n".repeat(3000)}`);

    await expectIssue(fixture.path, "config.complexity");
  });

  it("rejects a missing configuration file", async () => {
    const directory = await mkdtemp(join(temporaryRoot, "skillpress-config-test-"));
    temporaryDirectories.push(directory);

    await expectIssue(directory, "config.read");
  });

  it.runIf(process.platform !== "win32")("rejects a symbolic-link configuration", async () => {
    const target = await temporaryConfig(validConfig);
    const linkDirectory = await mkdtemp(join(temporaryRoot, "skillpress-config-test-"));
    temporaryDirectories.push(linkDirectory);
    const link = join(linkDirectory, CONFIG_FILE_NAME);
    symlinkSync(target.path, link);

    await expectIssue(link, "config.symlink");
  });

  it.runIf(process.platform !== "win32")(
    "rejects symbolic links in an intermediate path component",
    async () => {
      const target = await temporaryConfig(validConfig);
      const parent = await mkdtemp(join(temporaryRoot, "skillpress-config-test-"));
      temporaryDirectories.push(parent);
      const link = join(parent, "linked-directory");
      symlinkSync(target.directory, link);

      await expectIssue(join(link, CONFIG_FILE_NAME), "config.symlink");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a default configuration that is a symbolic link",
    async () => {
      const target = await temporaryConfig(validConfig);
      const linkDirectory = await mkdtemp(join(temporaryRoot, "skillpress-config-test-"));
      temporaryDirectories.push(linkDirectory);
      symlinkSync(target.path, join(linkDirectory, CONFIG_FILE_NAME));

      await expectIssue(linkDirectory, "config.symlink");
    },
  );

  it.runIf(process.platform !== "win32")("rejects a non-file configuration path", async () => {
    const directory = await mkdtemp(join(temporaryRoot, "skillpress-config-test-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "config.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      await expectIssue(socketPath, "config.file_type");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it("compares both device and inode when checking an opened file", () => {
    expect(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 2 })).toBe(true);
    expect(sameFileIdentity({ dev: 9, ino: 2 }, { dev: 1, ino: 2 })).toBe(false);
    expect(sameFileIdentity({ dev: 1, ino: 9 }, { dev: 1, ino: 2 })).toBe(false);
  });

  it("rejects a file swapped between inspection and opening", async () => {
    const expected = await temporaryConfig(validConfig);
    const replacement = await temporaryConfig(validConfig);
    const inspected = { path: expected.path, metadata: await lstat(expected.path) };

    await expectIssueFrom(
      readConfigText(inspected, async () => open(replacement.path, "r")),
      "config.changed",
    );
  });

  it("fails closed when an inspected config cannot be opened", async () => {
    const fixture = await temporaryConfig(validConfig);
    const inspected = { path: fixture.path, metadata: await lstat(fixture.path) };

    await expectIssueFrom(
      readConfigText(inspected, async () => {
        throw new Error("simulated open failure");
      }),
      "config.read",
    );
  });

  it("rejects a non-file or oversized object after opening and still closes it", async () => {
    const fixture = await temporaryConfig(validConfig);
    const metadata = await lstat(fixture.path);
    const inspected = { path: fixture.path, metadata };

    for (const [openedMetadata, expectedCode] of [
      [Object.assign(Object.create(metadata), { isFile: () => false }), "config.file_type"],
      [Object.assign(Object.create(metadata), { size: MAX_CONFIG_BYTES + 1 }), "config.too_large"],
    ] as const) {
      let closed = false;
      await expectIssueFrom(
        readConfigText(inspected, async () => ({
          stat: async () => openedMetadata,
          read: async () => ({ bytesRead: 0 }),
          close: async () => {
            closed = true;
          },
        })),
        expectedCode,
      );
      expect(closed).toBe(true);
    }
  });

  it("rejects a configuration that grows past the byte limit while being read", async () => {
    const fixture = await temporaryConfig(validConfig);
    const metadata = await lstat(fixture.path);
    const inspected = { path: fixture.path, metadata };
    let closed = false;

    await expectIssueFrom(
      readConfigText(inspected, async () => ({
        stat: async () => metadata,
        read: async (buffer, offset, length) => {
          buffer.fill(0x61, offset, offset + length);
          return { bytesRead: length };
        },
        close: async () => {
          closed = true;
        },
      })),
      "config.too_large",
    );
    expect(closed).toBe(true);
  });
});

async function expectIssueFrom(
  operation: Promise<unknown>,
  code: string,
): Promise<ProjectConfigError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectConfigError);
    const configError = error as ProjectConfigError;
    expect(configError.issues.map((entry) => entry.code)).toContain(code);
    return configError;
  }
  throw new Error(`Expected ${code}`);
}
