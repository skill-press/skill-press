import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CapturedCommand, CapturedCommandResult } from "../src/process/capture.js";
import { createNpmPublicationAdapter } from "../src/publish/adapters/npm.js";
import type { PublicationContext } from "../src/publish/saga.js";

const root = realpathSync(new URL("..", import.meta.url).pathname);
const temporaryRoot = realpathSync(tmpdir());
const sourceCommit = "c".repeat(40);
const context: PublicationContext = Object.freeze({
  root,
  project: Object.freeze({
    name: "skillpress",
    version: "0.1.0",
    repository: "https://github.com/mushanyoung/skillpress",
  }),
  skill: Object.freeze({ name: "skillpress", path: "skills/skillpress" }),
  sourceCommit,
  artifactSha256: "a".repeat(64),
  artifactsPath: ".skillpress/staging/x/artifacts",
  artifacts: Object.freeze({
    skillArchive: Object.freeze({ name: "x.skill", sha256: "a".repeat(64), bytes: 1 }),
    zipArchive: Object.freeze({ name: "x.zip", sha256: "a".repeat(64), bytes: 1 }),
    checksums: Object.freeze({ name: "SHA256SUMS", sha256: "d".repeat(64), bytes: 2 }),
    provenance: Object.freeze({ name: "provenance.json", sha256: "e".repeat(64), bytes: 3 }),
  }),
  idempotencyKey: "b".repeat(64),
});
const temporaryDirectories: string[] = [];
const environmentNames = [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "GITHUB_ACTIONS",
  "GITHUB_REPOSITORY",
  "GITHUB_SHA",
] as const;
const originalEnvironment = Object.fromEntries(
  environmentNames.map((name) => [name, process.env[name]]),
);

afterEach(async () => {
  for (const name of environmentNames) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function trustedEnvironment(): void {
  process.env.GITHUB_ACTIONS = "true";
  process.env.GITHUB_REPOSITORY = "mushanyoung/skillpress";
  process.env.GITHUB_SHA = sourceCommit;
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://actions.invalid/oidc";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "oidc-secret";
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

function publishedPackage(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    name: "@mushanyoung/skillpress",
    version: "0.1.0",
    dist: {
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      shasum: "1".repeat(40),
      tarball: "https://registry.npmjs.org/package.tgz",
      signatures: [{ keyid: "key", sig: "signature" }],
      attestations: {
        url: "https://registry.npmjs.org/-/npm/v1/attestations/%40mushanyoung%2fskillpress@0.1.0",
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
    ...overrides,
  });
}

function attestationBody(commit = sourceCommit): string {
  const payload = {
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: "pkg:npm/%40mushanyoung/skillpress@0.1.0",
        digest: { sha512: Buffer.alloc(64, 1).toString("hex") },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: { repository: "https://github.com/mushanyoung/skillpress" },
        },
        resolvedDependencies: [{ digest: { gitCommit: commit } }],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
  return JSON.stringify({
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          verificationMaterial: { tlogEntries: [{}] },
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
            signatures: [{}],
          },
        },
      },
    ],
  });
}

describe("npm publication adapter", () => {
  it("blocks local token publication and requires the bound trusted-publisher workflow", async () => {
    const calls: CapturedCommand[] = [];
    const adapter = createNpmPublicationAdapter({
      executor: async (command) => {
        calls.push(command);
        return result("", false);
      },
    });
    await expect(adapter.preflight(context)).resolves.toEqual({
      ok: false,
      code: "trusted_publishing_required",
      message: "run from the bound GitHub Actions trusted-publisher workflow",
    });
    expect(calls.map((call) => call.argv)).toEqual([
      ["npm", "view", "@mushanyoung/skillpress@0.1.0", "name", "version", "dist", "--json"],
    ]);
  });

  it("preflights supported npm, registry reachability, and package dry-run under OIDC", async () => {
    trustedEnvironment();
    const calls: CapturedCommand[] = [];
    const outputs = [
      result("", false),
      result(`${sourceCommit}\n`),
      result(""),
      result("11.5.1\n"),
      result("{}"),
      result("[]"),
    ];
    const adapter = createNpmPublicationAdapter({
      executor: async (command) => {
        calls.push(command);
        return outputs.shift() as CapturedCommandResult;
      },
    });
    await expect(adapter.preflight(context)).resolves.toMatchObject({ ok: true, code: "ready" });
    expect(calls.map((call) => call.argv)).toEqual([
      ["npm", "view", "@mushanyoung/skillpress@0.1.0", "name", "version", "dist", "--json"],
      ["git", "rev-parse", "--verify", "HEAD"],
      ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      ["npm", "--version"],
      ["npm", "ping", "--json"],
      ["npm", "pack", "--dry-run", "--json"],
    ]);
    expect(calls[3]?.env).toMatchObject({
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
      NPM_CONFIG_PROVENANCE: "true",
    });
    expect(calls[3]?.env).not.toHaveProperty("NPM_TOKEN");
  });

  it("verifies registry signatures and SLSA provenance and reuses an existing version", async () => {
    const calls: CapturedCommand[] = [];
    const adapter = createNpmPublicationAdapter({
      executor: async (command) => {
        calls.push(command);
        return result(publishedPackage());
      },
      httpClient: async () => ({ status: 200, body: attestationBody() }),
    });
    await expect(adapter.verify(context)).resolves.toEqual({
      ok: true,
      remoteId: "@mushanyoung/skillpress@0.1.0",
      url: "https://www.npmjs.com/package/@mushanyoung/skillpress/v/0.1.0",
    });
    await expect(adapter.execute?.(context, "publish-package")).resolves.toMatchObject({
      remoteId: "@mushanyoung/skillpress@0.1.0",
    });
    expect(calls.some((call) => call.argv[1] === "publish")).toBe(false);
    await expect(adapter.preflight(context)).resolves.toMatchObject({
      message: "npm version already verified",
    });
  });

  it("treats an existing version with different provenance as an immutable conflict", async () => {
    trustedEnvironment();
    const adapter = createNpmPublicationAdapter({
      executor: async () => result(publishedPackage()),
      httpClient: async () => ({
        status: 200,
        body: attestationBody("f".repeat(40)),
      }),
    });

    await expect(adapter.preflight(context)).resolves.toEqual({
      ok: false,
      code: "version_conflict",
      message: "npm version exists but does not match trusted source provenance",
    });
    await expect(adapter.execute?.(context, "publish-package")).rejects.toThrow(/conflicts/u);
  });

  it("publishes once when the version is absent and fails closed on publication failure", async () => {
    trustedEnvironment();
    let calls = 0;
    const publishing = createNpmPublicationAdapter({
      executor: async (command) => {
        calls += 1;
        if (command.argv[0] === "git" && command.argv[1] === "rev-parse") {
          return result(`${sourceCommit}\n`);
        }
        if (command.argv[0] === "git") return result("");
        return command.argv[1] === "publish" ? result("published") : result("", false);
      },
    });
    await expect(publishing.execute?.(context, "publish-package")).resolves.toMatchObject({
      remoteId: "@mushanyoung/skillpress@0.1.0",
    });
    expect(calls).toBe(4);

    const failing = createNpmPublicationAdapter({
      executor: async (command) => {
        if (command.argv[0] === "git" && command.argv[1] === "rev-parse") {
          return result(`${sourceCommit}\n`);
        }
        if (command.argv[0] === "git") return result("");
        return result("", false);
      },
    });
    await expect(failing.execute?.(context, "publish-package")).rejects.toThrow(/publication/u);
    await expect(failing.execute?.(context, "wrong")).rejects.toThrow(/Unknown/u);
  });

  it("rejects unsupported npm and failed registry or pack checks", async () => {
    trustedEnvironment();
    for (const version of ["bad", "10.9.0", "11.5.0"]) {
      const adapter = createNpmPublicationAdapter({
        executor: async (command) => {
          if (command.argv[0] === "git" && command.argv[1] === "rev-parse") {
            return result(`${sourceCommit}\n`);
          }
          if (command.argv[0] === "git") return result("");
          return command.argv[1] === "--version" ? result(version) : result("", false);
        },
      });
      await expect(adapter.preflight(context)).resolves.toMatchObject({
        code: "npm_version_unsupported",
      });
    }
    for (const failAt of [3, 4]) {
      let npmChecks = 0;
      const adapter = createNpmPublicationAdapter({
        executor: async (command) => {
          if (command.argv[0] === "git" && command.argv[1] === "rev-parse") {
            return result(`${sourceCommit}\n`);
          }
          if (command.argv[0] === "git") return result("");
          npmChecks += 1;
          if (npmChecks === 1) return result("", false);
          if (npmChecks === 2) return result("12.0.0");
          return result("{}", npmChecks !== failAt);
        },
      });
      await expect(adapter.preflight(context)).resolves.toMatchObject({
        code: "npm_preflight_failed",
      });
    }
  });

  it("rejects malformed package metadata and incomplete registry attestations", async () => {
    const invalidRoot = await mkdtemp(join(temporaryRoot, "skillpress-npm-adapter-"));
    temporaryDirectories.push(invalidRoot);
    await writeFile(join(invalidRoot, "package.json"), "{}\n");
    const invalidContext = { ...context, root: invalidRoot };
    const adapter = createNpmPublicationAdapter({ executor: async () => result("") });
    await expect(adapter.preflight(invalidContext)).resolves.toMatchObject({
      code: "package_invalid",
    });
    await expect(adapter.verify(invalidContext)).resolves.toEqual({ ok: false });
    await expect(adapter.execute?.(invalidContext, "publish-package")).rejects.toThrow(
      /disappeared/u,
    );

    for (const value of [
      {},
      { dist: null },
      { dist: { integrity: "x", shasum: "x", tarball: "x", signatures: [] } },
      {
        dist: {
          integrity: "x",
          shasum: "x",
          tarball: "x",
          signatures: [{}],
          attestations: { url: "x", provenance: [] },
        },
      },
    ]) {
      const malformed = createNpmPublicationAdapter({
        executor: async () => result(JSON.stringify(value)),
      });
      await expect(malformed.verify(context)).resolves.toEqual({ ok: false });
    }

    const wrongSource = createNpmPublicationAdapter({
      executor: async () => result(publishedPackage()),
      httpClient: async () => ({ status: 200, body: attestationBody("f".repeat(40)) }),
    });
    await expect(wrongSource.verify(context)).resolves.toEqual({ ok: false });

    const invalidAttestation = createNpmPublicationAdapter({
      executor: async () => result(publishedPackage()),
      httpClient: async () => ({ status: 200, body: "not-json" }),
    });
    await expect(invalidAttestation.verify(context)).resolves.toEqual({ ok: false });
  });
});
