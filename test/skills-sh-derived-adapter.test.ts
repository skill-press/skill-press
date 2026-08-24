import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { digestBoundedTree } from "../src/evidence/tree-digest.js";
import type { CapturedCommandResult } from "../src/process/capture.js";
import type {
  PublicationHttpRequest,
  PublicationHttpResult,
} from "../src/publish/adapters/command.js";
import { createSkillsShDerivedAdapter } from "../src/publish/adapters/skills-sh.js";
import type { PublicationContext } from "../src/publish/saga.js";

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const commit = "d".repeat(40);
const skill = Buffer.from(
  "---\nname: skillpress\ndescription: Reliable skill delivery.\n---\n# SkillPress\n",
);
const license = Buffer.from("MIT\n");
const guide = Buffer.from("# Guide\n");
const sourceFiles = [
  { path: "LICENSE", bytes: license, mode: "100644" },
  { path: "SKILL.md", bytes: skill, mode: "100644" },
  { path: "references/guide.md", bytes: guide, mode: "100644" },
] as const;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function blob(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function commandResult(stdout: string, ok = true): CapturedCommandResult {
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
    stdoutSha256: digest(bytes),
    stderrSha256: digest(Buffer.alloc(0)),
  };
}

function sourceTree(): CapturedCommandResult {
  return commandResult(
    `${sourceFiles
      .map(
        (file) =>
          `${file.mode} blob ${blob(file.bytes)} ${file.bytes.byteLength}\tskills/skillpress/${file.path}`,
      )
      .join("\0")}\0`,
  );
}

async function fixture(): Promise<PublicationContext> {
  const root = await mkdtemp(join(temporaryRoot, "skillpress-skills-sh-"));
  temporaryDirectories.push(root);
  const canonical = join(root, ".skillpress/staging/x/canonical/skillpress");
  const artifacts = join(root, ".skillpress/staging/x/artifacts");
  await mkdir(join(canonical, "references"), { recursive: true });
  await mkdir(artifacts, { recursive: true });
  for (const file of sourceFiles) {
    await writeFile(join(canonical, ...file.path.split("/")), file.bytes);
  }
  const provenance = Buffer.from(
    `${JSON.stringify({
      provenanceType: "skillpress.package",
      sourceCommit: commit,
      skillSha256: await digestBoundedTree(canonical),
      project: { skillName: "skillpress" },
    })}\n`,
  );
  await writeFile(join(artifacts, "provenance.json"), provenance);
  return Object.freeze({
    root,
    project: Object.freeze({
      name: "skillpress",
      version: "0.1.0",
      repository: "https://github.com/mushanyoung/skillpress",
    }),
    skill: Object.freeze({ name: "skillpress", path: "skills/skillpress" }),
    sourceCommit: commit,
    artifactSha256: "e".repeat(64),
    artifactsPath: ".skillpress/staging/x/artifacts",
    artifacts: Object.freeze({
      skillArchive: Object.freeze({ name: "x.skill", sha256: "e".repeat(64), bytes: 1 }),
      zipArchive: Object.freeze({ name: "x.zip", sha256: "e".repeat(64), bytes: 1 }),
      checksums: Object.freeze({ name: "SHA256SUMS", sha256: "f".repeat(64), bytes: 2 }),
      provenance: Object.freeze({
        name: "provenance.json",
        sha256: digest(provenance),
        bytes: provenance.byteLength,
      }),
    }),
    idempotencyKey: "1".repeat(64),
  });
}

function repository(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    full_name: "mushanyoung/skillpress",
    html_url: "https://github.com/mushanyoung/skillpress",
    private: false,
    archived: false,
    disabled: false,
    default_branch: "main",
    ...overrides,
  };
}

function remoteTree(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    truncated: false,
    tree: [
      { path: "skills", mode: "040000", type: "tree", sha: "1".repeat(40) },
      { path: "skills/skillpress", mode: "040000", type: "tree", sha: "2".repeat(40) },
      {
        path: "skills/skillpress/references",
        mode: "040000",
        type: "tree",
        sha: "3".repeat(40),
      },
      ...sourceFiles.map((file) => ({
        path: `skills/skillpress/${file.path}`,
        mode: file.mode,
        type: "blob",
        sha: blob(file.bytes),
      })),
      { path: "README.md", mode: "100644", type: "blob", sha: "4".repeat(40) },
    ],
    ...overrides,
  };
}

function listing(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "mushanyoung/skillpress/skillpress",
    source: "mushanyoung/skillpress",
    slug: "skillpress",
    installs: 7,
    hash: "a".repeat(64),
    files: sourceFiles.map((file) => ({ path: file.path, contents: file.bytes.toString("utf8") })),
    ...overrides,
  };
}

function httpFixture(options?: {
  readonly repository?: Record<string, unknown>;
  readonly branch?: Record<string, unknown>;
  readonly tree?: Record<string, unknown>;
  readonly listing?: Record<string, unknown>;
  readonly listingStatus?: number;
}) {
  const requests: PublicationHttpRequest[] = [];
  const client = async (request: PublicationHttpRequest): Promise<PublicationHttpResult> => {
    requests.push(request);
    if (request.url === "https://api.github.com/repos/mushanyoung/skillpress") {
      return { status: 200, body: JSON.stringify(options?.repository ?? repository()) };
    }
    if (request.url.endsWith("/repos/mushanyoung/skillpress/branches/main")) {
      return {
        status: 200,
        body: JSON.stringify(options?.branch ?? { commit: { sha: commit } }),
      };
    }
    if (request.url.includes("/git/trees/")) {
      return { status: 200, body: JSON.stringify(options?.tree ?? remoteTree()) };
    }
    if (request.url.startsWith("https://skills.sh/api/v1/skills/")) {
      return {
        status: options?.listingStatus ?? 200,
        body: JSON.stringify(options?.listing ?? listing()),
      };
    }
    return { status: 404, body: "not found" };
  };
  return { client, requests };
}

function adapter(
  httpClient: (request: PublicationHttpRequest) => Promise<PublicationHttpResult>,
  oidcToken: string | null = "oidc-secret",
  executor: () => Promise<CapturedCommandResult> = async () => sourceTree(),
) {
  return createSkillsShDerivedAdapter({
    source: "mushanyoung/skillpress",
    githubToken: "github-secret",
    ...(oidcToken === null ? {} : { oidcToken }),
    executor,
    httpClient,
  });
}

describe("skills.sh derived adapter", () => {
  it("verifies an exact public source and authenticated organic listing without mutation", async () => {
    const context = await fixture();
    const remote = httpFixture();
    const derived = adapter(remote.client);
    await expect(derived.preflight(context)).resolves.toEqual({
      ok: true,
      code: "ready",
      message: "public GitHub source is exact and skills.sh listing verification is available",
    });
    await expect(derived.verify(context)).resolves.toEqual({
      ok: true,
      remoteId: "mushanyoung/skillpress/skillpress",
      url: "https://skills.sh/mushanyoung/skillpress/skillpress",
    });
    expect(derived.capability).toBe("derived");
    expect(derived.steps).toEqual([]);
    expect(
      remote.requests.filter((request) => request.url.startsWith("https://skills.sh")),
    ).toHaveLength(1);
    const github = remote.requests.find(
      (request) => request.url === "https://api.github.com/repos/mushanyoung/skillpress",
    );
    const skillsSh = remote.requests.find((request) => request.url.startsWith("https://skills.sh"));
    expect(github?.headers?.Authorization).toBe("Bearer github-secret");
    expect(skillsSh?.headers?.Authorization).toBe("Bearer oidc-secret");
    expect(skillsSh?.headers?.Authorization).not.toContain("github-secret");
  });

  it("reports source readiness without claiming a listing when OIDC is unavailable", async () => {
    const previous = process.env.VERCEL_OIDC_TOKEN;
    delete process.env.VERCEL_OIDC_TOKEN;
    try {
      const context = await fixture();
      const remote = httpFixture();
      const derived = adapter(remote.client, null);
      await expect(derived.preflight(context)).resolves.toMatchObject({
        ok: true,
        message: expect.stringContaining("requires Vercel OIDC"),
      });
      await expect(derived.verify(context)).resolves.toEqual({
        ok: false,
        url: "https://skills.sh/mushanyoung/skillpress/skillpress",
      });
      expect(remote.requests.some((request) => request.url.startsWith("https://skills.sh"))).toBe(
        false,
      );
    } finally {
      if (previous === undefined) delete process.env.VERCEL_OIDC_TOKEN;
      else process.env.VERCEL_OIDC_TOKEN = previous;
    }
  });

  it.each([
    ["wrong repository", { full_name: "attacker/skillpress" }],
    ["wrong URL", { html_url: "https://example.test/repo" }],
    ["private repository", { private: true }],
    ["archived repository", { archived: true }],
    ["disabled repository", { disabled: true }],
    ["missing default branch", { default_branch: "" }],
  ])("blocks a %s public source", async (_name, override) => {
    const context = await fixture();
    const remote = httpFixture({ repository: repository(override) });
    await expect(adapter(remote.client).preflight(context)).resolves.toMatchObject({
      ok: false,
      code: "source_unavailable",
    });
  });

  it("blocks a default branch that moved and a changed remote skill tree", async () => {
    const context = await fixture();
    const moved = httpFixture({ branch: { commit: { sha: "f".repeat(40) } } });
    await expect(adapter(moved.client).preflight(context)).resolves.toMatchObject({ ok: false });

    const changedTree = remoteTree();
    const entries = changedTree.tree as Array<Record<string, unknown>>;
    const skillEntry = entries.find((entry) => entry.path === "skills/skillpress/SKILL.md");
    if (skillEntry === undefined) throw new Error("fixture tree is incomplete");
    skillEntry.sha = "f".repeat(40);
    const changed = httpFixture({ tree: changedTree });
    await expect(adapter(changed.client).preflight(context)).resolves.toMatchObject({ ok: false });

    const truncated = httpFixture({ tree: remoteTree({ truncated: true }) });
    await expect(adapter(truncated.client).preflight(context)).resolves.toMatchObject({
      ok: false,
    });

    const unsafeTree = remoteTree();
    (unsafeTree.tree as Array<Record<string, unknown>>).push({
      path: "skills/skillpress/submodule",
      mode: "160000",
      type: "commit",
      sha: "a".repeat(40),
    });
    const unsafe = httpFixture({ tree: unsafeTree });
    await expect(adapter(unsafe.client).preflight(context)).resolves.toMatchObject({ ok: false });
  });

  it.each([
    ["wrong id", { id: "attacker/repo/skillpress" }],
    ["wrong source", { source: "attacker/repo" }],
    ["wrong slug", { slug: "other" }],
    ["invalid installs", { installs: -1 }],
    ["invalid hash", { hash: "invalid" }],
    ["missing files", { files: null }],
    [
      "extra file",
      { files: [...(listing().files as unknown[]), { path: "extra", contents: "x" }] },
    ],
    [
      "changed contents",
      { files: sourceFiles.map((file) => ({ path: file.path, contents: "changed" })) },
    ],
  ])("does not verify a listing with %s", async (_name, override) => {
    const context = await fixture();
    const remote = httpFixture({ listing: listing(override) });
    await expect(adapter(remote.client).verify(context)).resolves.toEqual({
      ok: false,
      url: "https://skills.sh/mushanyoung/skillpress/skillpress",
    });
  });

  it("does not convert API failures or invalid staged sources into organic success", async () => {
    const context = await fixture();
    const unavailable = httpFixture({ listingStatus: 503 });
    await expect(adapter(unavailable.client).verify(context)).resolves.toMatchObject({ ok: false });

    await writeFile(join(context.root, context.artifactsPath, "provenance.json"), "{}\n");
    const remote = httpFixture();
    const invalid = adapter(remote.client);
    await expect(invalid.preflight(context)).resolves.toMatchObject({ code: "source_unavailable" });
    await expect(invalid.verify(context)).resolves.toMatchObject({ ok: false });

    const valid = await fixture();
    const failedGit = adapter(remote.client, "oidc-secret", async () => commandResult("", false));
    await expect(failedGit.preflight(valid)).resolves.toMatchObject({ code: "source_unavailable" });

    const malformedGithub = createSkillsShDerivedAdapter({
      source: "mushanyoung/skillpress",
      githubToken: "github-secret",
      oidcToken: "oidc-secret",
      executor: async () => sourceTree(),
      httpClient: async (request) =>
        request.url === "https://api.github.com/repos/mushanyoung/skillpress"
          ? { status: 200, body: "not-json" }
          : { status: 404, body: "not found" },
    });
    await expect(malformedGithub.preflight(valid)).resolves.toMatchObject({
      code: "source_unavailable",
    });
  });

  it("rejects unsafe sources and empty credentials", () => {
    expect(() => createSkillsShDerivedAdapter({ source: "bad" })).toThrow(/owner\/repository/u);
    expect(() => createSkillsShDerivedAdapter({ source: "owner/../repo" })).toThrow(
      /owner\/repository/u,
    );
    expect(() =>
      createSkillsShDerivedAdapter({ source: "mushanyoung/skillpress", githubToken: "" }),
    ).toThrow(/GitHub token/u);
    expect(() =>
      createSkillsShDerivedAdapter({ source: "mushanyoung/skillpress", oidcToken: "" }),
    ).toThrow(/OIDC token/u);
    expect(() =>
      createSkillsShDerivedAdapter({ source: "mushanyoung/skillpress", githubToken: " token " }),
    ).toThrow(/GitHub token/u);
    expect(() =>
      createSkillsShDerivedAdapter({ source: "mushanyoung/skillpress", oidcToken: " token " }),
    ).toThrow(/OIDC token/u);
  });

  it("binds the configured source to the project repository", async () => {
    const context = await fixture();
    const mismatched = {
      ...context,
      project: { ...context.project, repository: "https://github.com/attacker/repo" },
    };
    const remote = httpFixture();
    await expect(adapter(remote.client).preflight(mismatched)).resolves.toMatchObject({
      ok: false,
    });
    expect(remote.requests).toEqual([]);
  });

  it("can verify the public GitHub source without forwarding a GitHub credential", async () => {
    const previousGithub = process.env.GITHUB_TOKEN;
    const previousGh = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    try {
      const context = await fixture();
      const remote = httpFixture();
      const derived = createSkillsShDerivedAdapter({
        source: "mushanyoung/skillpress",
        oidcToken: "oidc-secret",
        executor: async () => sourceTree(),
        httpClient: remote.client,
      });
      await expect(derived.preflight(context)).resolves.toMatchObject({ ok: true });
      const github = remote.requests.find((request) =>
        request.url.startsWith("https://api.github.com"),
      );
      expect(github?.headers?.Authorization).toBeUndefined();
    } finally {
      if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGithub;
      if (previousGh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGh;
    }
  });
});
