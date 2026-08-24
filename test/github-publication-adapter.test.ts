import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

function failedResult(stdout: string, exitCode: number, stderr = ""): CapturedCommandResult {
  const base = result(stdout, false);
  const stderrBytes = Buffer.from(stderr);
  return {
    ...base,
    exitCode,
    stderr: stderrBytes,
    stderrBytes: stderrBytes.byteLength,
  };
}

function missingReference(): CapturedCommandResult {
  return failedResult("", 2);
}

function releaseRecord(): Readonly<Record<string, unknown>> {
  const asset = (name: string, digest: string, size: number) => ({
    name,
    digest: `sha256:${digest}`,
    size,
  });
  return {
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
  };
}

function releaseResponse(overrides: Readonly<Record<string, unknown>> = {}): CapturedCommandResult {
  const value = { ...releaseRecord(), ...overrides };
  return result(
    `HTTP/2.0 200 OK\ncontent-type: application/json\n\n${JSON.stringify({
      assets: value.assets,
      draft: value.isDraft,
      prerelease: value.isPrerelease,
      tag_name: value.tagName,
      html_url: value.url,
    })}\n`,
  );
}

function missingRelease(): CapturedCommandResult {
  return failedResult(
    'HTTP/2.0 404 Not Found\ncontent-type: application/json\n\n{"message":"Not Found","status":"404"}\n',
    1,
    "gh: Not Found (HTTP 404)\n",
  );
}

describe("GitHub publication adapter", () => {
  it("preflights auth, public repository identity, and native skill validation", async () => {
    const calls: CapturedCommand[] = [];
    const outputs = [
      result("{}"),
      result(
        JSON.stringify({
          isPrivate: false,
          nameWithOwner: "mushanyoung/skillpress",
          url: context.project.repository,
        }),
      ),
      result(""),
      missingReference(),
      result(""),
      missingRelease(),
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
      [
        "git",
        "ls-remote",
        "--exit-code",
        "https://github.com/mushanyoung/skillpress.git",
        "refs/tags/v0.1.0",
      ],
      [
        "git",
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        "--dry-run",
        "https://github.com/mushanyoung/skillpress.git",
        `${commit}:refs/tags/v0.1.0`,
      ],
      ["gh", "api", "--include", "repos/mushanyoung/skillpress/releases/tags/v0.1.0"],
      ["gh", "skill", "publish", "--dry-run", root],
    ]);

    const exactTagCalls: CapturedCommand[] = [];
    const exactTag = createGitHubPublicationAdapter({
      executor: async (command) => {
        exactTagCalls.push(command);
        if (command.argv[1] === "repo") {
          return result(
            JSON.stringify({
              isPrivate: false,
              nameWithOwner: "mushanyoung/skillpress",
              url: context.project.repository,
            }),
          );
        }
        if (command.argv[0] === "git" && command.argv[1] === "ls-remote") {
          return result(`${commit}\trefs/tags/v0.1.0\n`);
        }
        if (command.argv[1] === "api" && command.argv[2] === "--include") {
          return missingRelease();
        }
        return result("{}");
      },
    });
    await expect(exactTag.preflight(context)).resolves.toMatchObject({ ok: true });
    expect(exactTagCalls.filter((call) => call.argv.includes("--dry-run"))).toHaveLength(2);
  });

  it("projects GitHub tokens without unrelated credentials", async () => {
    const oldGhToken = process.env.GH_TOKEN;
    const oldGithubToken = process.env.GITHUB_TOKEN;
    const oldGhConfig = process.env.GH_CONFIG_DIR;
    const oldXdgConfig = process.env.XDG_CONFIG_HOME;
    const oldHome = process.env.HOME;
    process.env.GH_TOKEN = "gh-secret";
    process.env.GITHUB_TOKEN = "github-secret";
    delete process.env.GH_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.HOME;
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
        GH_CONFIG_DIR: join(homedir(), ".config", "gh"),
        HOME: homedir(),
        GIT_TERMINAL_PROMPT: "0",
        NO_COLOR: "1",
      });
    } finally {
      if (oldGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = oldGhToken;
      if (oldGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = oldGithubToken;
      if (oldGhConfig === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = oldGhConfig;
      if (oldXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdgConfig;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it("publishes exact source and creates an asset-bound release without a shell", async () => {
    const calls: CapturedCommand[] = [];
    const adapter = createGitHubPublicationAdapter({
      executor: async (command) => {
        calls.push(command);
        const argv = command.argv;
        if (argv[0] === "git" && argv[1] === "ls-remote") return missingReference();
        if (argv[0] === "gh" && argv[1] === "api" && argv[2] === "--include") {
          return calls.filter((call) => call.argv[2] === "--include").length === 1
            ? missingRelease()
            : releaseResponse();
        }
        return result("");
      },
    });
    await adapter.execute?.(context, "publish-source");
    await adapter.execute?.(context, "configure-discovery");
    await adapter.execute?.(context, "publish-release");
    expect(calls.some((call) => call.argv.includes(`${commit}:refs/heads/main`))).toBe(true);
    const create = calls.find((call) => call.argv[2] === "create");
    expect(create?.argv).toContain("--verify-tag");
    expect(create?.argv).not.toContain("--target");
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
        if (command.argv[1] === "api" && command.argv[2] === "--include") {
          return releaseResponse();
        }
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
        command.argv[1] === "api" && command.argv[2] === "user"
          ? result("{}")
          : result(
              JSON.stringify({
                isPrivate: true,
                nameWithOwner: "mushanyoung/skillpress",
                url: context.project.repository,
              }),
            ),
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
            JSON.stringify({
              isPrivate: false,
              nameWithOwner: "mushanyoung/skillpress",
              url: context.project.repository,
            }),
          );
        }
        return result("", false);
      },
    });
    await expect(unavailablePush.preflight(context)).resolves.toMatchObject({
      code: "push_unavailable",
    });

    const invalid = createGitHubPublicationAdapter({
      executor: async (command) => {
        if (command.argv[1] === "repo") {
          return result(
            JSON.stringify({
              isPrivate: false,
              nameWithOwner: "mushanyoung/skillpress",
              url: context.project.repository,
            }),
          );
        }
        if (command.argv[0] === "git" && command.argv[1] === "ls-remote") {
          return missingReference();
        }
        if (command.argv[1] === "api" && command.argv[2] === "--include") {
          return missingRelease();
        }
        if (command.argv[1] === "skill") return result("", false);
        return result("{}");
      },
    });
    await expect(invalid.preflight(context)).resolves.toMatchObject({ code: "skill_invalid" });

    const conflict = createGitHubPublicationAdapter({
      executor: async (command) =>
        command.argv[0] === "git"
          ? result(`${commit}\trefs/tags/v0.1.0\n`)
          : releaseResponse({ assets: [] }),
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
    await expect(failed.execute?.(context, "publish-source")).rejects.toThrow(/unavailable/u);
    await expect(failed.execute?.(context, "configure-discovery")).rejects.toThrow(
      /configuration failed/u,
    );
    await expect(failed.execute?.(context, "unknown")).rejects.toThrow(/Unknown/u);
    await expect(failed.execute?.(context, "publish-release")).rejects.toThrow(/unavailable/u);
  });

  it("does not verify malformed asset metadata, topic data, refs, or absent URLs", async () => {
    const malformed = createGitHubPublicationAdapter({
      executor: async (command) => {
        if (command.argv[0] === "git") return result(`bad\t${command.argv.at(-1)}\n`);
        if (command.argv[1] === "api" && command.argv[2] === "--include") {
          return releaseResponse({
            assets: [null, [], { name: 1 }, { name: "SHA256SUMS", digest: 2, size: "x" }],
            url: undefined,
          });
        }
        return result(JSON.stringify({ repositoryTopics: [{ name: "agent-skills" }] }));
      },
    });
    await expect(malformed.verify(context)).resolves.toEqual({ ok: false });

    const ambiguousReference = createGitHubPublicationAdapter({
      executor: async (command) => {
        if (command.argv[0] === "git") {
          const reference = command.argv.at(-1) as string;
          return result(`${commit}\t${reference}\n${commit}\t${reference}\n`);
        }
        if (command.argv[1] === "api" && command.argv[2] === "--include") {
          return releaseResponse();
        }
        return result(
          JSON.stringify({ repositoryTopics: ["agent-skills"], url: context.project.repository }),
        );
      },
    });
    await expect(ambiguousReference.verify(context)).resolves.toEqual({ ok: false });
  });

  it("rejects releases with extra or duplicate assets even when expected assets are present", async () => {
    const exact = releaseRecord() as { assets: Array<Record<string, unknown>> };
    const inventories = [
      [...exact.assets, { name: "unexpected.txt", digest: `sha256:${"f".repeat(64)}`, size: 1 }],
      [...exact.assets, exact.assets[0] as Record<string, unknown>],
    ];
    for (const releaseAssets of inventories) {
      const adapter = createGitHubPublicationAdapter({
        executor: async (command) => {
          if (command.argv[0] === "git") {
            const reference = command.argv.at(-1) as string;
            return result(`${commit}\t${reference}\n`);
          }
          if (command.argv[1] === "api" && command.argv[2] === "--include") {
            return releaseResponse({ assets: releaseAssets });
          }
          return result(JSON.stringify({ repositoryTopics: ["agent-skills"] }));
        },
      });
      await expect(adapter.verify(context)).resolves.toMatchObject({ ok: false });
      await expect(adapter.execute?.(context, "publish-release")).rejects.toThrow(/conflicts/u);
    }
  });

  it("reuses a fully matching release", async () => {
    const calls: CapturedCommand[] = [];
    const existing = createGitHubPublicationAdapter({
      executor: async (command) => {
        calls.push(command);
        if (command.argv[0] === "git") return result(`${commit}\trefs/tags/v0.1.0\n`);
        return releaseResponse();
      },
    });
    await expect(existing.execute?.(context, "publish-release")).resolves.toMatchObject({
      remoteId: "mushanyoung/skillpress@v0.1.0",
    });
    expect(calls.some((call) => call.argv[2] === "create")).toBe(false);
  });

  it("fails closed on unavailable release state and a conflicting existing tag", async () => {
    const unavailable = createGitHubPublicationAdapter({
      executor: async (command) =>
        command.argv[0] === "git" ? result(`${commit}\trefs/tags/v0.1.0\n`) : result("", false),
    });
    await expect(unavailable.execute?.(context, "publish-release")).rejects.toThrow(
      /release state is unavailable/u,
    );

    const conflict = createGitHubPublicationAdapter({
      executor: async () => result(`${"f".repeat(40)}\trefs/tags/v0.1.0\n`),
    });
    await expect(conflict.execute?.(context, "publish-release")).rejects.toThrow(/tag conflicts/u);
  });

  it("blocks preflight on unavailable or conflicting immutable release state", async () => {
    const executeUntilReleaseState = async (
      command: CapturedCommand,
      tagResult: CapturedCommandResult,
      releaseResult: CapturedCommandResult,
    ) => {
      if (command.argv[1] === "repo") {
        return result(
          JSON.stringify({
            isPrivate: false,
            nameWithOwner: "mushanyoung/skillpress",
            url: context.project.repository,
          }),
        );
      }
      if (command.argv[0] === "git" && command.argv[1] === "ls-remote") return tagResult;
      if (command.argv[1] === "api" && command.argv[2] === "--include") return releaseResult;
      return result("{}");
    };

    const unavailableTag = createGitHubPublicationAdapter({
      executor: async (command) =>
        executeUntilReleaseState(command, result("", false), missingRelease()),
    });
    await expect(unavailableTag.preflight(context)).resolves.toMatchObject({
      code: "tag_unavailable",
    });

    const conflictingTag = createGitHubPublicationAdapter({
      executor: async (command) =>
        executeUntilReleaseState(
          command,
          result(`${"f".repeat(40)}\trefs/tags/v0.1.0\n`),
          missingRelease(),
        ),
    });
    await expect(conflictingTag.preflight(context)).resolves.toMatchObject({
      code: "tag_conflict",
    });

    const unavailableRelease = createGitHubPublicationAdapter({
      executor: async (command) =>
        executeUntilReleaseState(command, missingReference(), result("", false)),
    });
    await expect(unavailableRelease.preflight(context)).resolves.toMatchObject({
      code: "release_unavailable",
    });

    const conflictingRelease = createGitHubPublicationAdapter({
      executor: async (command) =>
        executeUntilReleaseState(command, missingReference(), releaseResponse({ assets: [] })),
    });
    await expect(conflictingRelease.preflight(context)).resolves.toMatchObject({
      code: "release_conflict",
    });

    let dryPushes = 0;
    const deniedTagPush = createGitHubPublicationAdapter({
      executor: async (command) => {
        if (command.argv[1] === "repo") {
          return result(
            JSON.stringify({
              isPrivate: false,
              nameWithOwner: "mushanyoung/skillpress",
              url: context.project.repository,
            }),
          );
        }
        if (command.argv[0] === "git" && command.argv[1] === "ls-remote") {
          return missingReference();
        }
        if (command.argv[0] === "git" && command.argv.includes("--dry-run")) {
          dryPushes += 1;
          return result("", dryPushes === 1);
        }
        return result("{}");
      },
    });
    await expect(deniedTagPush.preflight(context)).resolves.toMatchObject({
      code: "tag_push_unavailable",
    });
  });

  it("requires exact repository and release URLs during verification", async () => {
    for (const wrongReleaseUrl of ["https://example.com/release", undefined]) {
      const adapter = createGitHubPublicationAdapter({
        executor: async (command) => {
          if (command.argv[0] === "git") {
            const reference = command.argv.at(-1) as string;
            return result(`${commit}\t${reference}\n`);
          }
          if (command.argv[1] === "api" && command.argv[2] === "--include") {
            return releaseResponse({ url: wrongReleaseUrl });
          }
          return result(
            JSON.stringify({ repositoryTopics: ["agent-skills"], url: context.project.repository }),
          );
        },
      });
      await expect(adapter.verify(context)).resolves.toMatchObject({ ok: false });
    }

    const wrongRepository = createGitHubPublicationAdapter({
      executor: async (command) => {
        if (command.argv[0] === "git") {
          const reference = command.argv.at(-1) as string;
          return result(`${commit}\t${reference}\n`);
        }
        if (command.argv[1] === "api" && command.argv[2] === "--include") {
          return releaseResponse();
        }
        return result(
          JSON.stringify({ repositoryTopics: ["agent-skills"], url: "https://example.com/repo" }),
        );
      },
    });
    await expect(wrongRepository.verify(context)).resolves.toMatchObject({ ok: false });
  });
});
