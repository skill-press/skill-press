import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { CapturedCommand, CapturedCommandResult } from "../src/process/capture.js";
import { createGitHubPublicationAdapter } from "../src/publish/adapters/github.js";
import type { PublicationContext } from "../src/publish/saga.js";

const root = realpathSync(tmpdir());
const commit = "c".repeat(40);
const context: PublicationContext = Object.freeze({
  root,
  project: Object.freeze({
    name: "skillpress",
    version: "0.1.0",
    repository: "https://github.com/mushanyoung/skillpress",
  }),
  skill: Object.freeze({ name: "skillpress", path: "skills/skillpress" }),
  sourceCommit: commit,
  artifactSha256: "a".repeat(64),
  artifactsPath: ".skillpress/staging/x/artifacts",
  artifacts: Object.freeze({
    skillArchive: Object.freeze({
      name: "skillpress-0.1.0.skill",
      sha256: "a".repeat(64),
      bytes: 10,
    }),
    zipArchive: Object.freeze({ name: "skillpress-0.1.0.zip", sha256: "a".repeat(64), bytes: 10 }),
    checksums: Object.freeze({ name: "SHA256SUMS", sha256: "d".repeat(64), bytes: 20 }),
    provenance: Object.freeze({ name: "provenance.json", sha256: "e".repeat(64), bytes: 30 }),
  }),
  idempotencyKey: "b".repeat(64),
});

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

function releaseJson(): string {
  const asset = (name: string, digest: string, size: number) => ({
    name,
    digest: `sha256:${digest}`,
    size,
  });
  return JSON.stringify({
    assets: [
      asset("skillpress-0.1.0.skill", "a".repeat(64), 10),
      asset("skillpress-0.1.0.zip", "a".repeat(64), 10),
      asset("SHA256SUMS", "d".repeat(64), 20),
      asset("provenance.json", "e".repeat(64), 30),
    ],
    isDraft: false,
    isPrerelease: false,
    tagName: "v0.1.0",
    url: "https://github.com/mushanyoung/skillpress/releases/tag/v0.1.0",
  });
}

describe("GitHub publication adapter", () => {
  it("preflights auth, public repository identity, and native skill validation", async () => {
    const calls: CapturedCommand[] = [];
    const outputs = [
      result("{}"),
      result(JSON.stringify({ isPrivate: false, nameWithOwner: "mushanyoung/skillpress" })),
      result(""),
      result("valid"),
    ];
    const adapter = createGitHubPublicationAdapter({
      executor: async (command) => {
        calls.push(command);
        return outputs.shift() as CapturedCommandResult;
      },
    });
    await expect(adapter.preflight(context)).resolves.toEqual({
      ok: true,
      code: "ready",
      message: "GitHub publication is ready",
    });
    expect(calls.map((call) => call.argv)).toEqual([
      ["gh", "api", "user"],
      ["gh", "repo", "view", "mushanyoung/skillpress", "--json", "isPrivate,nameWithOwner,url"],
      [
        "git",
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        "--dry-run",
        "https://github.com/mushanyoung/skillpress.git",
        `${commit}:refs/heads/main`,
      ],
      ["gh", "skill", "publish", "--dry-run", root],
    ]);
  });

  it("projects GitHub tokens without unrelated credentials", async () => {
    const oldGhToken = process.env.GH_TOKEN;
    const oldGithubToken = process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "gh-secret";
    process.env.GITHUB_TOKEN = "github-secret";
    try {
      let environment: Readonly<Record<string, string>> | undefined;
      const adapter = createGitHubPublicationAdapter({
        executor: async (command) => {
          environment = command.env;
          return result("", false);
        },
      });
      await adapter.preflight(context);
      expect(environment).toEqual({
        GH_TOKEN: "gh-secret",
        GITHUB_TOKEN: "github-secret",
        GH_CONFIG_DIR: expect.any(String),
        HOME: expect.any(String),
        GIT_TERMINAL_PROMPT: "0",
        NO_COLOR: "1",
      });
    } finally {
      if (oldGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = oldGhToken;
      if (oldGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = oldGithubToken;
    }
  });

  it("publishes exact source and creates an asset-bound release without a shell", async () => {
    const calls: CapturedCommand[] = [];
    const adapter = createGitHubPublicationAdapter({
      executor: async (command) => {
        calls.push(command);
        const argv = command.argv;
        if (argv[0] === "git" && argv[1] === "ls-remote") return result("", false);
        if (argv[0] === "gh" && argv[1] === "release" && argv[2] === "view") {
          return calls.filter((call) => call.argv[2] === "view").length === 1
            ? result("", false)
            : result(releaseJson());
        }
        return result("");
      },
    });
    await adapter.execute?.(context, "publish-source");
    await adapter.execute?.(context, "configure-discovery");
    await adapter.execute?.(context, "publish-release");
    expect(calls.some((call) => call.argv.includes(`${commit}:refs/heads/main`))).toBe(true);
    const create = calls.find((call) => call.argv[2] === "create");
    expect(create?.argv).toContain("--target");
    expect(create?.argv).toContain(commit);
    expect(create?.argv.some((value) => value.endsWith("/provenance.json"))).toBe(true);
    expect(create?.env).not.toHaveProperty("NPM_TOKEN");
  });

  it("verifies commit, tag, assets, topic, and release URL", async () => {
    const adapter = createGitHubPublicationAdapter({
      executor: async (command) => {
        if (command.argv[0] === "git") {
          const reference = command.argv.at(-1) as string;
          return result(`${commit}\t${reference}\n`);
        }
        if (command.argv[1] === "release") return result(releaseJson());
        return result(
          JSON.stringify({ repositoryTopics: ["agent-skills"], url: context.project.repository }),
        );
      },
    });
    await expect(adapter.verify(context)).resolves.toEqual({
      ok: true,
      remoteId: "mushanyoung/skillpress@v0.1.0",
      url: "https://github.com/mushanyoung/skillpress/releases/tag/v0.1.0",
    });
  });

  it("fails closed on missing auth, private repository, invalid skill, and release conflict", async () => {
    const missing = createGitHubPublicationAdapter({ executor: async () => result("", false) });
    await expect(missing.preflight(context)).resolves.toMatchObject({ code: "auth_missing" });

    const privateRepo = createGitHubPublicationAdapter({
      executor: async (command) =>
        command.argv[1] === "api"
          ? result("{}")
          : result(JSON.stringify({ isPrivate: true, nameWithOwner: "mushanyoung/skillpress" })),
    });
    await expect(privateRepo.preflight(context)).resolves.toMatchObject({
      code: "repository_unavailable",
    });

    let pushCalls = 0;
    const unavailablePush = createGitHubPublicationAdapter({
      executor: async () => {
        pushCalls += 1;
        if (pushCalls === 1) return result("{}");
        if (pushCalls === 2) {
          return result(
            JSON.stringify({ isPrivate: false, nameWithOwner: "mushanyoung/skillpress" }),
          );
        }
        return result("", false);
      },
    });
    await expect(unavailablePush.preflight(context)).resolves.toMatchObject({
      code: "push_unavailable",
    });

    let calls = 0;
    const invalid = createGitHubPublicationAdapter({
      executor: async () => {
        calls += 1;
        return calls === 4
          ? result("", false)
          : result(
              calls === 2
                ? JSON.stringify({ isPrivate: false, nameWithOwner: "mushanyoung/skillpress" })
                : "{}",
            );
      },
    });
    await expect(invalid.preflight(context)).resolves.toMatchObject({ code: "skill_invalid" });

    const conflict = createGitHubPublicationAdapter({
      executor: async () =>
        result(
          JSON.stringify({
            assets: [],
            isDraft: false,
            isPrerelease: false,
            tagName: "v0.1.0",
          }),
        ),
    });
    await expect(conflict.execute?.(context, "publish-release")).rejects.toThrow(/conflicts/u);
  });

  it("rejects malformed identities, provider output, failed mutations, and unknown steps", async () => {
    const malformedContext = {
      ...context,
      project: { ...context.project, repository: "https://example.com/not/github" },
    };
    const unused = createGitHubPublicationAdapter({ executor: async () => result("") });
    await expect(unused.preflight(malformedContext)).rejects.toThrow(/canonical/u);

    const failed = createGitHubPublicationAdapter({
      executor: async (command) =>
        command.argv[0] === "git" && command.argv[1] === "ls-remote"
          ? result("not-a-remote-line")
          : result("", false),
    });
    await expect(failed.execute?.(context, "publish-source")).rejects.toThrow(/push failed/u);
    await expect(failed.execute?.(context, "configure-discovery")).rejects.toThrow(
      /configuration failed/u,
    );
    await expect(failed.execute?.(context, "unknown")).rejects.toThrow(/Unknown/u);
    await expect(failed.execute?.(context, "publish-release")).rejects.toThrow(/creation failed/u);
  });

  it("does not verify malformed asset metadata, topic data, refs, or absent URLs", async () => {
    const malformed = createGitHubPublicationAdapter({
      executor: async (command) => {
        if (command.argv[0] === "git") return result(`bad\t${command.argv.at(-1)}\n`);
        if (command.argv[1] === "release") {
          return result(
            JSON.stringify({
              assets: [null, [], { name: 1 }, { name: "SHA256SUMS", digest: 2, size: "x" }],
              isDraft: false,
              isPrerelease: false,
              tagName: "v0.1.0",
            }),
          );
        }
        return result(JSON.stringify({ repositoryTopics: [{ name: "agent-skills" }] }));
      },
    });
    await expect(malformed.verify(context)).resolves.toEqual({ ok: false });
  });

  it("reuses a fully matching release and rejects a failed release lookup as absent", async () => {
    const calls: CapturedCommand[] = [];
    const existing = createGitHubPublicationAdapter({
      executor: async (command) => {
        calls.push(command);
        return command.argv[1] === "release" ? result(releaseJson()) : result("");
      },
    });
    await expect(existing.execute?.(context, "publish-release")).resolves.toMatchObject({
      remoteId: "mushanyoung/skillpress@v0.1.0",
    });
    expect(calls.some((call) => call.argv[2] === "create")).toBe(false);
  });
});
