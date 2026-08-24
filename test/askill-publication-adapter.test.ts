import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { digestBoundedTree } from "../src/evidence/tree-digest.js";
import type { CapturedCommand, CapturedCommandResult } from "../src/process/capture.js";
import { createAskillPublicationAdapter } from "../src/publish/adapters/askill.js";
import { projectSkillFrontmatter, readBoundCanonicalSkill } from "../src/publish/projection.js";
import type { PublicationContext } from "../src/publish/saga.js";

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const canonicalMarkdown =
  "---\nname: skillpress\ndescription: Reliable skill delivery.\n---\n# SkillPress\n";
const projectedMarkdown =
  "---\nname: skillpress\ndescription: Reliable skill delivery.\nslug: skillpress\nversion: 0.1.0\n---\n# SkillPress\n";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(
  markdown = canonicalMarkdown,
): Promise<{ context: PublicationContext; canonicalPath: string }> {
  const root = await mkdtemp(join(temporaryRoot, "skillpress-askill-"));
  temporaryDirectories.push(root);
  const stage = join(root, ".skillpress/staging/x");
  const canonical = join(stage, "canonical/skillpress");
  const artifacts = join(stage, "artifacts");
  await mkdir(canonical, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const canonicalPath = join(canonical, "SKILL.md");
  await writeFile(canonicalPath, markdown);
  const provenance = Buffer.from(
    `${JSON.stringify({
      provenanceType: "skillpress.package",
      sourceCommit: "c".repeat(40),
      skillSha256: await digestBoundedTree(canonical),
      project: { skillName: "skillpress" },
    })}\n`,
  );
  await writeFile(join(artifacts, "provenance.json"), provenance);
  return {
    canonicalPath,
    context: Object.freeze({
      root,
      project: Object.freeze({
        name: "skillpress",
        version: "0.1.0",
        repository: "https://github.com/mushanyoung/skillpress",
      }),
      skill: Object.freeze({ name: "skillpress", path: "skills/skillpress" }),
      sourceCommit: "c".repeat(40),
      artifactSha256: "a".repeat(64),
      artifactsPath: ".skillpress/staging/x/artifacts",
      artifacts: Object.freeze({
        skillArchive: Object.freeze({ name: "x.skill", sha256: "a".repeat(64), bytes: 1 }),
        zipArchive: Object.freeze({ name: "x.zip", sha256: "a".repeat(64), bytes: 1 }),
        checksums: Object.freeze({ name: "SHA256SUMS", sha256: "d".repeat(64), bytes: 2 }),
        provenance: Object.freeze({
          name: "provenance.json",
          sha256: digest(provenance),
          bytes: provenance.byteLength,
        }),
      }),
      idempotencyKey: "b".repeat(64),
    }),
  };
}

async function replaceProvenance(
  context: PublicationContext,
  value: unknown,
): Promise<PublicationContext> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  await writeFile(join(context.root, context.artifactsPath, "provenance.json"), bytes);
  return Object.freeze({
    ...context,
    artifacts: Object.freeze({
      ...context.artifacts,
      provenance: Object.freeze({
        ...context.artifacts.provenance,
        sha256: digest(bytes),
        bytes: bytes.byteLength,
      }),
    }),
  });
}

function result(stdout: string, ok = true): CapturedCommandResult {
  const bytes = Buffer.from(stdout);
  return {
    status: ok ? "passed" : "failed",
    exitCode: ok ? 0 : 1,
    signal: null,
    durationMs: 1,
    stdout: bytes,
    stderr: Buffer.alloc(0),
    stdoutBytes: bytes.byteLength,
    stderrBytes: 0,
    stdoutSha256: "unused",
    stderrSha256: "unused",
  };
}

function notFound(): CapturedCommandResult {
  return result(
    JSON.stringify({
      ok: false,
      error: { code: "SKILL_NOT_FOUND", message: "not found" },
    }),
    false,
  );
}

function info(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    ok: true,
    skill: {
      id: 42,
      name: "skillpress",
      owner: "mushanyoung",
      version: "0.1.0",
      url: "https://askill.sh/skills/42",
      frontmatter: { name: "skillpress", slug: "skillpress", version: "0.1.0" },
      ...overrides,
    },
    installed: {},
  });
}

describe("askill publication adapter", () => {
  it("preflights the official non-updating CLI path and writes only a private projection", async () => {
    const { context, canonicalPath } = await fixture();
    const calls: CapturedCommand[] = [];
    const adapter = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async (command) => {
        calls.push(command);
        if (command.argv[1] === "info") return notFound();
        if (command.argv[1] === "--version") return result("0.1.15\n");
        if (command.argv[1] === "whoami") return result("@mushanyoung (token: ask_...1234)\n");
        return result("valid\n");
      },
    });
    await expect(adapter.preflight(context)).resolves.toEqual({
      ok: true,
      code: "ready",
      message: "askill publication is ready",
    });
    expect(calls.map((call) => call.argv.slice(0, 3))).toEqual([
      ["askill", "info", "@mushanyoung/skillpress"],
      ["askill", "--version"],
      ["askill", "whoami", "--json"],
      ["askill", "validate", expect.stringContaining("/SKILL.md")],
    ]);
    expect(
      calls.every((call) => call.argv.includes("--json") || call.argv[1] === "--version"),
    ).toBe(true);
    expect(calls.every((call) => call.env?.NO_COLOR === "1")).toBe(true);
    expect(calls.every((call) => call.env?.HOME !== undefined)).toBe(true);
    expect(calls.every((call) => call.env?.AWS_SECRET_ACCESS_KEY === undefined)).toBe(true);
    expect(await readFile(canonicalPath, "utf8")).toBe(canonicalMarkdown);
    const projection = join(
      context.root,
      `.skillpress/projections/${context.idempotencyKey}/askill-sh/skillpress/SKILL.md`,
    );
    expect(await readFile(projection, "utf8")).toBe(projectedMarkdown);
    expect((await stat(projection)).mode & 0o777).toBe(0o600);
  });

  it("forwards only the configured platform login directories", async () => {
    const names = [
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "APPDATA",
      "LOCALAPPDATA",
      "USERPROFILE",
    ] as const;
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = `/private/${name.toLowerCase()}`;
      vi.resetModules();
      const reloaded = await import("../src/publish/adapters/askill.js");
      const { context } = await fixture();
      let environment: Readonly<Record<string, string>> | undefined;
      const adapter = reloaded.createAskillPublicationAdapter({
        author: "mushanyoung",
        executor: async (command) => {
          environment = command.env;
          return result("", false);
        },
      });
      await adapter.preflight(context);
      for (const name of names) {
        expect(environment?.[name]).toBe(`/private/${name.toLowerCase()}`);
      }
      expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      vi.resetModules();
    }
  });

  it("reuses only an exact remote raw projection and skips authentication and mutation", async () => {
    const { context } = await fixture();
    const calls: CapturedCommand[] = [];
    const adapter = createAskillPublicationAdapter({
      author: "MushanYoung",
      executor: async (command) => {
        calls.push(command);
        return result(info());
      },
      httpClient: async () => ({ status: 200, body: projectedMarkdown }),
    });
    await expect(adapter.preflight(context)).resolves.toMatchObject({
      ok: true,
      message: "askill version already verified",
    });
    await expect(adapter.execute?.(context, "publish-skill")).resolves.toEqual({
      remoteId: "@mushanyoung/skillpress@0.1.0",
      url: "https://askill.sh/skills/42",
    });
    expect(calls.every((call) => call.argv[1] === "info")).toBe(true);
  });

  it("publishes once with exact identity and verifies the listing and raw content", async () => {
    const { context } = await fixture();
    let published = false;
    const calls: CapturedCommand[] = [];
    const adapter = createAskillPublicationAdapter({
      author: "mushanyoung",
      executable: "askill-official",
      executor: async (command) => {
        calls.push(command);
        if (command.argv[1] === "info") return published ? result(info()) : notFound();
        if (command.argv[1] === "publish") {
          published = true;
          return result("Published @mushanyoung/skillpress@0.1.0\n");
        }
        return result("");
      },
      httpClient: async (request) => {
        expect(request.url).toBe("https://askill.sh/api/v1/skills/%40mushanyoung%2Fskillpress/raw");
        return { status: 200, body: projectedMarkdown };
      },
    });
    await expect(adapter.execute?.(context, "publish-skill")).resolves.toMatchObject({
      remoteId: "@mushanyoung/skillpress@0.1.0",
    });
    await expect(adapter.verify(context)).resolves.toMatchObject({ ok: true });
    const publish = calls.find((call) => call.argv[1] === "publish");
    expect(publish?.argv).toEqual([
      "askill-official",
      "publish",
      expect.stringContaining("/askill-sh/skillpress"),
      "--json",
    ]);
  });

  it("fails closed on provenance, CLI, identity, validation, and remote mismatches", async () => {
    const { context } = await fixture();
    await writeFile(join(context.root, context.artifactsPath, "provenance.json"), "{}\n");
    const invalidProjection = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async () => result(""),
    });
    await expect(invalidProjection.preflight(context)).resolves.toMatchObject({
      code: "projection_invalid",
    });

    const unsupportedFixture = await fixture();
    const unsupported = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async (command) => (command.argv[1] === "info" ? notFound() : result("0.1.14")),
    });
    await expect(unsupported.preflight(unsupportedFixture.context)).resolves.toMatchObject({
      code: "cli_unsupported",
    });

    const authFixture = await fixture();
    const wrongAuth = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async (command) => {
        if (command.argv[1] === "info") return notFound();
        if (command.argv[1] === "--version") return result("0.2.0");
        return result("@attacker (token: hidden)");
      },
    });
    await expect(wrongAuth.preflight(authFixture.context)).resolves.toMatchObject({
      code: "auth_missing",
    });

    const validationFixture = await fixture();
    const rejected = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async (command) => {
        if (command.argv[1] === "info") return notFound();
        if (command.argv[1] === "--version") return result("1.0.0");
        if (command.argv[1] === "whoami") return result("@mushanyoung (token: hidden)");
        return result("", false);
      },
    });
    await expect(rejected.preflight(validationFixture.context)).resolves.toMatchObject({
      code: "projection_rejected",
    });

    const remoteFixture = await fixture();
    const mismatched = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async () => result(info({ version: "9.0.0" })),
      httpClient: async () => ({ status: 200, body: projectedMarkdown }),
    });
    await expect(mismatched.verify(remoteFixture.context)).resolves.toEqual({ ok: false });
  });

  it("distinguishes provider failure, immutable conflicts, and publishable older versions", async () => {
    const unavailableFixture = await fixture();
    const unavailable = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async () => result("gateway failed", false),
    });
    await expect(unavailable.preflight(unavailableFixture.context)).resolves.toMatchObject({
      code: "provider_unavailable",
    });

    const conflictFixture = await fixture();
    const conflict = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async () => result(info({ version: "9.0.0" })),
    });
    await expect(conflict.preflight(conflictFixture.context)).resolves.toMatchObject({
      code: "version_conflict",
    });

    const olderFixture = await fixture();
    let published = false;
    const older = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async (command) => {
        if (command.argv[1] === "info") {
          return published
            ? result(info())
            : result(
                info({
                  version: "0.0.9",
                  frontmatter: { name: "skillpress", slug: "skillpress", version: "0.0.9" },
                }),
              );
        }
        if (command.argv[1] === "publish") {
          published = true;
          return result("Published @mushanyoung/skillpress@0.1.0");
        }
        if (command.argv[1] === "--version") return result("1.0.0");
        if (command.argv[1] === "whoami") return result("@mushanyoung (token: hidden)");
        return result("valid");
      },
      httpClient: async () => ({ status: 200, body: projectedMarkdown }),
    });
    await expect(older.preflight(olderFixture.context)).resolves.toMatchObject({ ok: true });
    await expect(older.execute?.(olderFixture.context, "publish-skill")).resolves.toMatchObject({
      remoteId: "@mushanyoung/skillpress@0.1.0",
    });
  });

  it("fails closed on malformed JSON, listing URLs, raw transport, and projection conflicts", async () => {
    const malformedFixture = await fixture();
    const malformed = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async () => result("[]"),
    });
    await expect(malformed.preflight(malformedFixture.context)).resolves.toMatchObject({
      code: "version_conflict",
    });

    const urlFixture = await fixture();
    const badUrl = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async () => result(info({ url: "https://evil.invalid/skills/42" })),
      httpClient: async () => ({ status: 200, body: projectedMarkdown }),
    });
    await expect(badUrl.verify(urlFixture.context)).resolves.toEqual({ ok: false });

    const rawFixture = await fixture();
    const rawFailure = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async () => result(info()),
      httpClient: async () => ({ status: 503, body: "" }),
    });
    await expect(rawFailure.verify(rawFixture.context)).resolves.toEqual({ ok: false });

    const projectionFixture = await fixture();
    await projectSkillFrontmatter(projectionFixture.context, "askill-sh", {
      slug: "skillpress",
      version: "0.1.0",
    });
    const path = join(
      projectionFixture.context.root,
      `.skillpress/projections/${projectionFixture.context.idempotencyKey}/askill-sh/skillpress/SKILL.md`,
    );
    await writeFile(path, "conflict");
    await expect(
      projectSkillFrontmatter(projectionFixture.context, "askill-sh", {
        slug: "skillpress",
        version: "0.1.0",
      }),
    ).rejects.toThrow(/conflicts/u);
    await expect(projectSkillFrontmatter(projectionFixture.context, "BAD", {})).rejects.toThrow(
      /target/u,
    );
  });

  it.each([
    ["0.1.0-alpha", "0.1.0", true],
    ["0.1.0-alpha.1", "0.1.0-alpha.2", true],
    ["0.1.0-alpha.1", "0.1.0-alpha.beta", true],
    ["0.1.0-alpha", "0.1.0-alpha.1", true],
    ["0.1.0-beta", "0.1.0-alpha", false],
    ["0.1.invalid", "0.2.0", false],
  ])("orders remote semver %s against release %s", async (remoteVersion, releaseVersion, ready) => {
    const { context: base } = await fixture();
    const context: PublicationContext = Object.freeze({
      ...base,
      project: Object.freeze({ ...base.project, version: releaseVersion }),
    });
    const adapter = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async (command) => {
        if (command.argv[1] === "info") {
          return result(
            info({
              version: remoteVersion,
              frontmatter: { name: "skillpress", slug: "skillpress", version: remoteVersion },
            }),
          );
        }
        if (command.argv[1] === "--version") return result("1.0.0");
        if (command.argv[1] === "whoami") return result("@mushanyoung (token: hidden)");
        return result("valid");
      },
    });
    await expect(adapter.preflight(context)).resolves.toMatchObject(
      ready ? { ok: true } : { ok: false, code: "version_conflict" },
    );
  });

  it("rejects malformed projection inputs and unsafe projection storage", async () => {
    for (const value of [null, [], { project: null }, { project: [] }]) {
      const { context } = await fixture();
      await expect(
        readBoundCanonicalSkill(await replaceProvenance(context, value)),
      ).rejects.toThrow(/provenance/u);
    }

    const changedFixture = await fixture();
    const changed = await replaceProvenance(changedFixture.context, {
      provenanceType: "skillpress.package",
      sourceCommit: "c".repeat(40),
      skillSha256: "f".repeat(64),
      project: { skillName: "skillpress" },
    });
    await expect(readBoundCanonicalSkill(changed)).rejects.toThrow(/changed/u);

    for (const markdown of [
      "no frontmatter\n",
      "---\nname: [\n---\nbody\n",
      "---\n- skillpress\n---\nbody\n",
    ]) {
      const { context } = await fixture(markdown);
      await expect(
        projectSkillFrontmatter(context, "askill-sh", {
          slug: "skillpress",
          version: "0.1.0",
        }),
      ).rejects.toThrow(/frontmatter/u);
    }

    const unsafeFixture = await fixture();
    await writeFile(join(unsafeFixture.context.root, ".skillpress/projections"), "not a directory");
    await expect(
      projectSkillFrontmatter(unsafeFixture.context, "askill-sh", {
        slug: "skillpress",
        version: "0.1.0",
      }),
    ).rejects.toThrow(/unsafe/u);
  });

  it("rejects invalid configuration, unknown steps, and unexpected publish responses", async () => {
    expect(() => createAskillPublicationAdapter({ author: "bad/name" })).toThrow(/author/u);
    expect(() => createAskillPublicationAdapter({ author: "valid", executable: "" })).toThrow(
      /executable/u,
    );
    const { context } = await fixture();
    const adapter = createAskillPublicationAdapter({
      author: "mushanyoung",
      executor: async (command) =>
        command.argv[1] === "info" ? notFound() : result("wrong publication"),
    });
    await expect(adapter.execute?.(context, "unknown")).rejects.toThrow(/Unknown/u);
    await expect(adapter.execute?.(context, "publish-skill")).rejects.toThrow(/unexpected/u);
  });
});
