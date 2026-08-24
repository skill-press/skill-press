import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { digestBoundedTree } from "../src/evidence/tree-digest.js";
import type { CapturedCommand, CapturedCommandResult } from "../src/process/capture.js";
import { createAgentSkillHubPublicationAdapter } from "../src/publish/adapters/agentskillhub.js";
import type {
  PublicationHttpRequest,
  PublicationHttpResult,
} from "../src/publish/adapters/command.js";
import type { PublicationContext } from "../src/publish/saga.js";

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const markdown =
  "---\nname: skillpress\ndescription: Reliable skill delivery.\n---\n# SkillPress\n";
const blob = createHash("sha1")
  .update(`blob ${Buffer.byteLength(markdown)}\0${markdown}`)
  .digest("hex");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(): Promise<PublicationContext> {
  const root = await mkdtemp(join(temporaryRoot, "skillpress-agentskillhub-"));
  temporaryDirectories.push(root);
  const stage = join(root, ".skillpress/staging/x");
  const canonical = join(stage, "canonical/skillpress");
  const artifacts = join(stage, "artifacts");
  await mkdir(canonical, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(canonical, "SKILL.md"), markdown);
  const provenance = Buffer.from(
    `${JSON.stringify({
      provenanceType: "skillpress.package",
      sourceCommit: "c".repeat(40),
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
  });
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
    stdoutSha256: "unused",
    stderrSha256: "unused",
  };
}

function treeResult(overrides = ""): CapturedCommandResult {
  return commandResult(
    overrides || `100644 blob ${blob} ${Buffer.byteLength(markdown)}\tskills/skillpress/SKILL.md\0`,
  );
}

function analysis(overrides: Readonly<Record<string, unknown>> = {}): PublicationHttpResult {
  return {
    status: 200,
    body: JSON.stringify({
      repoFullName: "mushanyoung/skillpress",
      defaultBranch: "main",
      skills: [
        {
          path: "skills/skillpress",
          slug: "skillpress",
          name: "skillpress",
          description: "Reliable skill delivery.",
          alreadyImported: false,
        },
      ],
      ...overrides,
    }),
  };
}

function detail(overrides: Readonly<Record<string, unknown>> = {}): PublicationHttpResult {
  return {
    status: 200,
    body: JSON.stringify({
      skill: {
        ownerUsername: "mushanyoung",
        slug: "skillpress",
        displaySlug: "mushanyoung/skillpress",
        name: "skillpress",
        sourceType: "github",
        sourceIdentifier: "mushanyoung/skillpress",
        skillPath: "skills/skillpress",
        defaultBranch: "main",
      },
      latestVersion: {
        version: "2026.08.24",
        commitSha: "c".repeat(40),
        skillMdRaw: markdown,
        fileManifest: [{ path: "SKILL.md", gitBlobSha: blob, size: Buffer.byteLength(markdown) }],
      },
      ...overrides,
    }),
  };
}

function route(
  handlers: (request: PublicationHttpRequest) => PublicationHttpResult,
): (request: PublicationHttpRequest) => Promise<PublicationHttpResult> {
  return async (request) => handlers(request);
}

describe("Agent Skill Hub publication adapter", () => {
  it("uses public analyze as a non-mutating preflight for the exact configured skill", async () => {
    const context = await fixture();
    const requests: PublicationHttpRequest[] = [];
    const adapter = createAgentSkillHubPublicationAdapter({
      httpClient: route((request) => {
        requests.push(request);
        return request.method === "GET" ? { status: 404, body: "" } : analysis();
      }),
    });
    await expect(adapter.preflight(context)).resolves.toEqual({
      ok: true,
      code: "ready",
      message: "Agent Skill Hub import is ready; execute explicitly to mutate the registry",
    });
    expect(requests).toEqual([
      {
        method: "GET",
        url: "https://agentskillhub.dev/api/v1/u/mushanyoung/skills/skillpress",
      },
      {
        method: "POST",
        url: "https://agentskillhub.dev/api/v1/repos/analyze",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/mushanyoung/skillpress" }),
      },
    ]);
  });

  it("verifies exact source identity, canonical bytes, and the complete git blob manifest", async () => {
    const context = await fixture();
    const commands: CapturedCommand[] = [];
    const adapter = createAgentSkillHubPublicationAdapter({
      pollAttempts: 1,
      executor: async (command) => {
        commands.push(command);
        return treeResult();
      },
      httpClient: async () => detail(),
    });
    await expect(adapter.verify(context)).resolves.toEqual({
      ok: true,
      remoteId: "mushanyoung/skillpress@2026.08.24",
      url: "https://agentskillhub.dev/api/v1/u/mushanyoung/skills/skillpress",
    });
    expect(commands[0]?.argv).toEqual([
      "git",
      "ls-tree",
      "-r",
      "-z",
      "--long",
      "c".repeat(40),
      "--",
      "skills/skillpress",
    ]);
    await expect(adapter.preflight(context)).resolves.toMatchObject({
      ok: true,
      message: "Agent Skill Hub snapshot already verified",
    });
  });

  it("imports once, accepts grouped success only, and reuses an exact snapshot", async () => {
    const context = await fixture();
    let imported = false;
    const requests: PublicationHttpRequest[] = [];
    const adapter = createAgentSkillHubPublicationAdapter({
      executor: async () => treeResult(),
      httpClient: route((request) => {
        requests.push(request);
        if (request.method === "GET") return imported ? detail() : { status: 404, body: "" };
        if (request.url.endsWith("/analyze")) return analysis();
        imported = true;
        return {
          status: 200,
          body: JSON.stringify({ imported: [{}], updated: [], reused: [], failed: [] }),
        };
      }),
    });
    await expect(adapter.execute?.(context, "import-skill")).resolves.toEqual({
      remoteId: "mushanyoung/skillpress",
    });
    const mutation = requests.find((request) => request.url.endsWith("/repos/import"));
    expect(mutation?.body).toBe(
      JSON.stringify({
        repoFullName: "mushanyoung/skillpress",
        selectedPaths: ["skills/skillpress"],
      }),
    );
    await expect(adapter.execute?.(context, "import-skill")).resolves.toEqual({
      remoteId: "mushanyoung/skillpress@2026.08.24",
      url: "https://agentskillhub.dev/api/v1/u/mushanyoung/skills/skillpress",
    });
    expect(requests.filter((request) => request.url.endsWith("/repos/import"))).toHaveLength(1);
  });

  it("polls boundedly for an eventually visible imported snapshot", async () => {
    const context = await fixture();
    let calls = 0;
    const adapter = createAgentSkillHubPublicationAdapter({
      pollAttempts: 3,
      pollIntervalMs: 1,
      executor: async () => treeResult(),
      httpClient: async () => {
        calls += 1;
        return calls < 3 ? { status: 404, body: "" } : detail();
      },
    });
    await expect(adapter.verify(context)).resolves.toMatchObject({ ok: true });
    expect(calls).toBe(3);
  });

  it("fails closed on invalid repositories, provider errors, and analysis collisions", async () => {
    const context = await fixture();
    const invalidContext = {
      ...context,
      project: { ...context.project, repository: "https://example.com/not-github" },
    };
    const unused = createAgentSkillHubPublicationAdapter();
    await expect(unused.preflight(invalidContext)).resolves.toMatchObject({
      code: "repository_invalid",
    });
    await expect(unused.verify(invalidContext)).resolves.toEqual({ ok: false });

    const unavailable = createAgentSkillHubPublicationAdapter({
      httpClient: async () => ({ status: 503, body: "" }),
    });
    await expect(unavailable.preflight(context)).resolves.toMatchObject({
      code: "provider_unavailable",
    });

    const analysisUnavailable = createAgentSkillHubPublicationAdapter({
      httpClient: route((request) =>
        request.method === "GET" ? { status: 404, body: "" } : { status: 503, body: "" },
      ),
    });
    await expect(analysisUnavailable.preflight(context)).resolves.toMatchObject({
      code: "provider_unavailable",
    });

    const collision = createAgentSkillHubPublicationAdapter({
      httpClient: route((request) =>
        request.method === "GET"
          ? { status: 404, body: "" }
          : analysis({
              skills: [
                {
                  path: "skills/skillpress",
                  slug: "skillpress-2",
                  name: "skillpress",
                  description: "collision",
                  alreadyImported: true,
                },
              ],
            }),
      ),
    });
    await expect(collision.preflight(context)).resolves.toMatchObject({
      code: "analysis_conflict",
    });
  });

  it("rejects conflicting listings, malformed manifests, failed imports, and unknown steps", async () => {
    const context = await fixture();
    const conflict = createAgentSkillHubPublicationAdapter({
      pollAttempts: 1,
      executor: async () => treeResult(),
      httpClient: async () => detail({ skill: { ownerUsername: "attacker" } }),
    });
    await expect(conflict.preflight(context)).resolves.toMatchObject({ code: "listing_conflict" });
    await expect(conflict.verify(context)).resolves.toEqual({ ok: false });
    await expect(conflict.execute?.(context, "import-skill")).rejects.toThrow(/conflicts/u);

    const malformedJson = createAgentSkillHubPublicationAdapter({
      httpClient: async () => ({ status: 200, body: "not json" }),
    });
    await expect(malformedJson.preflight(context)).resolves.toMatchObject({
      code: "listing_conflict",
    });

    const badManifest = createAgentSkillHubPublicationAdapter({
      pollAttempts: 1,
      executor: async () => treeResult(),
      httpClient: async () =>
        detail({
          latestVersion: {
            version: "2026.08.24",
            commitSha: "c".repeat(40),
            skillMdRaw: markdown,
            fileManifest: [],
          },
        }),
    });
    await expect(badManifest.verify(context)).resolves.toEqual({ ok: false });

    const outdated = createAgentSkillHubPublicationAdapter({
      executor: async () => treeResult(),
      httpClient: route((request) =>
        request.method === "GET"
          ? detail({
              latestVersion: {
                version: "2026.08.23",
                commitSha: "d".repeat(40),
                skillMdRaw: "older",
                fileManifest: [
                  { path: "SKILL.md", gitBlobSha: blob, size: Buffer.byteLength(markdown) },
                ],
              },
            })
          : analysis(),
      ),
    });
    await expect(outdated.preflight(context)).resolves.toMatchObject({ ok: true });

    const malformed = createAgentSkillHubPublicationAdapter({
      pollAttempts: 1,
      executor: async () => treeResult("bad tree\0"),
      httpClient: async () => detail(),
    });
    await expect(malformed.verify(context)).resolves.toEqual({ ok: false });

    const failed = createAgentSkillHubPublicationAdapter({
      httpClient: route((request) => {
        if (request.method === "GET") return { status: 404, body: "" };
        if (request.url.endsWith("/analyze")) return analysis();
        return {
          status: 200,
          body: JSON.stringify({ imported: [], updated: [], reused: [], failed: [{}] }),
        };
      }),
    });
    await expect(failed.execute?.(context, "import-skill")).rejects.toThrow(/import failed/u);

    const changedAnalysis = createAgentSkillHubPublicationAdapter({
      httpClient: route((request) =>
        request.method === "GET"
          ? { status: 404, body: "" }
          : analysis({ repoFullName: "attacker/repository" }),
      ),
    });
    await expect(changedAnalysis.execute?.(context, "import-skill")).rejects.toThrow(
      /analysis changed/u,
    );
    await expect(failed.execute?.(context, "wrong")).rejects.toThrow(/Unknown/u);
  });

  it("validates bounded polling options", () => {
    expect(() => createAgentSkillHubPublicationAdapter({ pollAttempts: 0 })).toThrow(/polling/u);
    expect(() => createAgentSkillHubPublicationAdapter({ pollAttempts: 21 })).toThrow(/polling/u);
    expect(() => createAgentSkillHubPublicationAdapter({ pollIntervalMs: -1 })).toThrow(/polling/u);
    expect(() => createAgentSkillHubPublicationAdapter({ pollIntervalMs: 5_001 })).toThrow(
      /polling/u,
    );
  });
});
