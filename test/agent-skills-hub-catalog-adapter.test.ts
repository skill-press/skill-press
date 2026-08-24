import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { digestBoundedTree } from "../src/evidence/tree-digest.js";
import type { CapturedCommand, CapturedCommandResult } from "../src/process/capture.js";
import { createAgentSkillsHubCatalogAdapter } from "../src/publish/adapters/agent-skills-hub-catalog.js";
import type { PublicationContext } from "../src/publish/saga.js";

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const skill = Buffer.from(
  "---\nname: skillpress\ndescription: Reliable skill delivery.\n---\n# SkillPress\n",
);
const license = Buffer.from("MIT\n");
const upstreamCommit = "a".repeat(40);
const upstreamTree = "b".repeat(40);
const branchCommit = "c".repeat(40);
const branch = `skillpress/skillpress-v0.1.0-${"d".repeat(12)}`;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function blob(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

const source = [
  { path: "LICENSE", bytes: license, sha: blob(license) },
  { path: "SKILL.md", bytes: skill, sha: blob(skill) },
] as const;

async function fixture(): Promise<PublicationContext> {
  const root = await mkdtemp(join(temporaryRoot, "skillpress-catalog-"));
  temporaryDirectories.push(root);
  const stage = join(root, ".skillpress/staging/x");
  const canonical = join(stage, "canonical/skillpress");
  const artifacts = join(stage, "artifacts");
  await mkdir(canonical, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(canonical, "SKILL.md"), skill);
  await writeFile(join(canonical, "LICENSE"), license);
  const provenance = Buffer.from(
    `${JSON.stringify({
      provenanceType: "skillpress.package",
      sourceCommit: "d".repeat(40),
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
    sourceCommit: "d".repeat(40),
    artifactSha256: "e".repeat(64),
    artifactsPath: ".skillpress/staging/x/artifacts",
    artifacts: Object.freeze({
      skillArchive: Object.freeze({ name: "x.skill", sha256: "e".repeat(64), bytes: 1 }),
      zipArchive: Object.freeze({ name: "x.zip", sha256: "e".repeat(64), bytes: 1 }),
      checksums: Object.freeze({ name: "SHA256SUMS", sha256: "f".repeat(64), bytes: 2 }),
      provenance: Object.freeze({
        name: "provenance.json",
        sha256: sha256(provenance),
        bytes: provenance.byteLength,
      }),
    }),
    idempotencyKey: "1".repeat(64),
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

function sourceTree(): CapturedCommandResult {
  return result(
    `${source
      .map(
        (file) =>
          `100644 blob ${file.sha} ${file.bytes.byteLength}\tskills/skillpress/${file.path}`,
      )
      .join("\0")}\0`,
  );
}

function upstreamBranch(): CapturedCommandResult {
  return result(
    JSON.stringify({
      commit: { sha: upstreamCommit, commit: { tree: { sha: upstreamTree } } },
    }),
  );
}

function tree(exact: boolean): CapturedCommandResult {
  return result(
    JSON.stringify({
      truncated: false,
      tree: exact
        ? source.map((file) => ({
            path: `skills/skillpress/${file.path}`,
            mode: "100644",
            type: "blob",
            sha: file.sha,
          }))
        : [],
    }),
  );
}

function fork(): CapturedCommandResult {
  return result(
    JSON.stringify({
      isFork: true,
      nameWithOwner: "mushanyoung/agent-skills-hub",
      url: "https://github.com/mushanyoung/agent-skills-hub",
      parent: { nameWithOwner: "agent-skills-hub/agent-skills-hub" },
    }),
  );
}

function pr(): CapturedCommandResult {
  return result(
    JSON.stringify([
      {
        number: 123,
        url: "https://github.com/agent-skills-hub/agent-skills-hub/pull/123",
        state: "OPEN",
        isDraft: false,
        mergedAt: null,
        headRefName: branch,
        headRefOid: branchCommit,
        headRepository: { nameWithOwner: "mushanyoung/agent-skills-hub" },
        headRepositoryOwner: { login: "mushanyoung" },
        baseRefName: "main",
      },
    ]),
  );
}

function comparison(): CapturedCommandResult {
  return result(
    JSON.stringify({
      status: "ahead",
      ahead_by: 1,
      behind_by: 0,
      total_commits: 1,
      commits: [{ sha: branchCommit }],
      files: source.map((file) => ({
        filename: `skills/skillpress/${file.path}`,
        status: "added",
        sha: file.sha,
      })),
    }),
  );
}

function contributionExecutor(options?: {
  readonly comparisonResult?: CapturedCommandResult;
  readonly pullRequestResult?: CapturedCommandResult;
  readonly branchResult?: CapturedCommandResult;
  readonly forkTreeResult?: CapturedCommandResult;
}): (command: CapturedCommand) => Promise<CapturedCommandResult> {
  return async (command) => {
    const shared = common(command);
    if (shared !== undefined) return shared;
    if (command.argv[1] === "repo" && command.argv[2] === "view") return fork();
    if (command.argv.some((value) => value.includes("/git/ref/heads/"))) {
      return options?.branchResult ?? result(JSON.stringify({ object: { sha: branchCommit } }));
    }
    if (
      command.argv.some((value) =>
        value.startsWith(`repos/mushanyoung/agent-skills-hub/git/trees/${branchCommit}`),
      )
    ) {
      return options?.forkTreeResult ?? tree(true);
    }
    if (command.argv.some((value) => value.includes("/compare/"))) {
      return options?.comparisonResult ?? comparison();
    }
    if (command.argv[1] === "pr" && command.argv[2] === "list") {
      return options?.pullRequestResult ?? pr();
    }
    return result("", false);
  };
}

function branchCreationExecutor(failure: "blob" | "tree" | "commit" | "reference") {
  return async (command: CapturedCommand): Promise<CapturedCommandResult> => {
    const shared = common(command);
    if (shared !== undefined) return shared;
    if (command.argv[1] === "repo" && command.argv[2] === "view") return fork();
    if (command.argv.some((value) => value.includes("/git/ref/heads/"))) {
      return result("", false);
    }
    if (command.argv[1] === "api" && command.argv.includes("--method")) {
      const endpoint = command.argv[4] as string;
      const input = JSON.parse(await readFile(command.argv[6] as string, "utf8")) as Readonly<
        Record<string, unknown>
      >;
      if (endpoint.endsWith("/git/blobs")) {
        const bytes = Buffer.from(input.content as string, "base64");
        return result(JSON.stringify({ sha: failure === "blob" ? "f".repeat(40) : blob(bytes) }));
      }
      if (endpoint.endsWith("/git/trees")) {
        return result(JSON.stringify({ sha: failure === "tree" ? "invalid" : "2".repeat(40) }));
      }
      if (endpoint.endsWith("/git/commits")) {
        return result(JSON.stringify({ sha: failure === "commit" ? "invalid" : branchCommit }));
      }
      return result(
        JSON.stringify({
          object: { sha: failure === "reference" ? "f".repeat(40) : branchCommit },
        }),
      );
    }
    return result("", false);
  };
}

function common(
  command: CapturedCommand,
  exactUpstream = false,
): CapturedCommandResult | undefined {
  if (command.argv[0] === "git") return sourceTree();
  if (command.argv[1] === "api" && command.argv[2] === "user") {
    return result(JSON.stringify({ login: "mushanyoung" }));
  }
  if (command.argv.includes("repos/agent-skills-hub/agent-skills-hub/branches/main")) {
    return upstreamBranch();
  }
  if (
    command.argv.some((value) =>
      value.startsWith(`repos/agent-skills-hub/agent-skills-hub/git/trees/${upstreamCommit}`),
    )
  ) {
    return tree(exactUpstream);
  }
  return undefined;
}

describe("Agent Skills Hub catalog adapter", () => {
  it("preflights auth, upstream path absence, and a creatable fork without mutation", async () => {
    const context = await fixture();
    const calls: CapturedCommand[] = [];
    const adapter = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) => {
        calls.push(command);
        return (
          common(command) ??
          (command.argv[2] === "view"
            ? result("gh: Not Found (HTTP 404)", false)
            : result("", false))
        );
      },
    });
    await expect(adapter.preflight(context)).resolves.toEqual({
      ok: true,
      code: "ready",
      message: "catalog contribution is ready; merge will require maintainer review",
    });
    expect(adapter.capability).toBe("submit");
    expect(calls.some((call) => call.argv.includes("fork"))).toBe(false);
    expect(calls.every((call) => call.env?.NPM_TOKEN === undefined)).toBe(true);
  });

  it("recognizes an exact upstream merge without requiring a fork or PR", async () => {
    const context = await fixture();
    const adapter = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) => common(command, true) ?? result("", false),
    });
    await expect(adapter.preflight(context)).resolves.toMatchObject({
      ok: true,
      message: "Agent Skills Hub catalog already contains the exact skill",
    });
    await expect(adapter.execute?.(context, "prepare-fork")).resolves.toEqual({
      ok: true,
      remoteId: "agent-skills-hub/agent-skills-hub:skills/skillpress",
      url: "https://github.com/agent-skills-hub/agent-skills-hub/tree/main/skills/skillpress",
    });
    await expect(adapter.verify(context)).resolves.toMatchObject({ ok: true });
  });

  it("creates a fork, atomic content branch, and reviewable pull request idempotently", async () => {
    const context = await fixture();
    let forkReady = false;
    let remoteCommit: string | null = null;
    let pullRequestReady = false;
    const calls: CapturedCommand[] = [];
    const adapter = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) => {
        calls.push(command);
        const shared = common(command);
        if (shared !== undefined) return shared;
        if (command.argv[1] === "repo" && command.argv[2] === "view") {
          return forkReady ? fork() : result("gh: Not Found (HTTP 404)", false);
        }
        if (command.argv[1] === "repo" && command.argv[2] === "fork") {
          forkReady = true;
          return result("forked");
        }
        if (command.argv.some((value) => value.includes("/git/ref/heads/"))) {
          return remoteCommit === null
            ? result("", false)
            : result(JSON.stringify({ object: { sha: remoteCommit } }));
        }
        if (
          command.argv.some((value) =>
            value.startsWith(`repos/mushanyoung/agent-skills-hub/git/trees/${branchCommit}`),
          )
        ) {
          return tree(true);
        }
        if (command.argv.some((value) => value.includes("/compare/"))) return comparison();
        if (command.argv[1] === "api" && command.argv.includes("--method")) {
          const endpoint = command.argv[4] as string;
          const input = JSON.parse(await readFile(command.argv[6] as string, "utf8")) as Readonly<
            Record<string, unknown>
          >;
          if (endpoint.endsWith("/git/blobs")) {
            const bytes = Buffer.from(input.content as string, "base64");
            return result(JSON.stringify({ sha: blob(bytes) }));
          }
          if (endpoint.endsWith("/git/trees"))
            return result(JSON.stringify({ sha: "2".repeat(40) }));
          if (endpoint.endsWith("/git/commits")) {
            return result(JSON.stringify({ sha: branchCommit }));
          }
          remoteCommit = branchCommit;
          return result(JSON.stringify({ object: { sha: branchCommit } }));
        }
        if (command.argv[1] === "pr" && command.argv[2] === "list") {
          return pullRequestReady ? pr() : result("[]");
        }
        if (command.argv[1] === "pr" && command.argv[2] === "create") {
          pullRequestReady = true;
          return result("https://github.com/agent-skills-hub/agent-skills-hub/pull/123\n");
        }
        return result("", false);
      },
    });
    await expect(adapter.execute?.(context, "prepare-fork")).resolves.toMatchObject({
      remoteId: "mushanyoung/agent-skills-hub",
    });
    await expect(adapter.execute?.(context, "publish-branch")).resolves.toMatchObject({
      remoteId: expect.stringContaining(branch),
    });
    await expect(adapter.execute?.(context, "open-pull-request")).resolves.toEqual({
      url: "https://github.com/agent-skills-hub/agent-skills-hub/pull/123",
    });
    await expect(adapter.verify(context)).resolves.toEqual({
      ok: true,
      remoteId: "agent-skills-hub/agent-skills-hub#123",
      url: "https://github.com/agent-skills-hub/agent-skills-hub/pull/123",
    });
    await expect(adapter.execute?.(context, "publish-branch")).resolves.toMatchObject({
      remoteId: expect.stringContaining(branch),
    });
    await expect(adapter.execute?.(context, "open-pull-request")).resolves.toMatchObject({
      remoteId: "agent-skills-hub/agent-skills-hub#123",
    });
    expect(calls.filter((call) => call.argv[2] === "create")).toHaveLength(1);
    expect(calls.filter((call) => call.argv[2] === "fork")).toHaveLength(1);
  });

  it("blocks wrong auth, upstream collisions, conflicting forks, and invalid sources", async () => {
    const context = await fixture();
    const wrongAuth = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) =>
        command.argv[0] === "git" ? sourceTree() : result(JSON.stringify({ login: "attacker" })),
    });
    await expect(wrongAuth.preflight(context)).resolves.toMatchObject({ code: "auth_missing" });

    const collision = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) => {
        const shared = common(command);
        if (shared !== undefined) {
          if (command.argv.some((value) => value.includes("/git/trees/"))) {
            return result(
              JSON.stringify({
                truncated: false,
                tree: [
                  {
                    path: "skills/skillpress/SKILL.md",
                    mode: "100644",
                    type: "blob",
                    sha: "f".repeat(40),
                  },
                ],
              }),
            );
          }
          return shared;
        }
        return result("", false);
      },
    });
    await expect(collision.preflight(context)).resolves.toMatchObject({ code: "catalog_conflict" });
    await expect(collision.execute?.(context, "prepare-fork")).rejects.toThrow(/upstream path/u);

    const badFork = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) => {
        const shared = common(command);
        if (shared !== undefined) return shared;
        return command.argv[2] === "view"
          ? result(JSON.stringify({ isFork: false }))
          : result("", false);
      },
    });
    await expect(badFork.preflight(context)).resolves.toMatchObject({ code: "fork_conflict" });

    await writeFile(join(context.root, context.artifactsPath, "provenance.json"), "{}\n");
    const invalid = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async () => result(""),
    });
    await expect(invalid.preflight(context)).resolves.toMatchObject({ code: "source_invalid" });
    await expect(invalid.verify(context)).resolves.toEqual({ ok: false });
  });

  it("rejects invalid configuration, unknown steps, and missing publication prerequisites", async () => {
    expect(() => createAgentSkillsHubCatalogAdapter({ contributor: "bad/name" })).toThrow(/login/u);
    const context = await fixture();
    const adapter = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) => common(command) ?? result("", false),
    });
    await expect(adapter.execute?.(context, "wrong")).rejects.toThrow(/Unknown/u);
    await expect(adapter.execute?.(context, "publish-branch")).rejects.toThrow(/fork/u);
    await expect(adapter.execute?.(context, "open-pull-request")).rejects.toThrow(/branch/u);
    await expect(adapter.verify(context)).resolves.toEqual({ ok: false });
  });

  it.each([
    ["failed git command", result("", false)],
    ["unterminated git output", result("not-nul-terminated")],
    ["malformed tree entry", result("invalid\0")],
    [
      "tree entry outside the skill",
      result(`100644 blob ${source[0].sha} ${source[0].bytes.byteLength}\tother/LICENSE\0`),
    ],
    [
      "absolute relative path",
      result(
        `100644 blob ${source[0].sha} ${source[0].bytes.byteLength}\tskills/skillpress//LICENSE\0`,
      ),
    ],
    [
      "parent traversal",
      result(
        `100644 blob ${source[0].sha} ${source[0].bytes.byteLength}\tskills/skillpress/../LICENSE\0`,
      ),
    ],
    [
      "duplicate path",
      result(
        `100644 blob ${source[0].sha} ${source[0].bytes.byteLength}\tskills/skillpress/LICENSE\0${`100644 blob ${source[0].sha} ${source[0].bytes.byteLength}\tskills/skillpress/LICENSE\0`}`,
      ),
    ],
    ["size mismatch", result(`100644 blob ${source[0].sha} 999\tskills/skillpress/LICENSE\0`)],
    ["empty tree", result("\0")],
  ])("rejects a %s source listing", async (_name, listing) => {
    const context = await fixture();
    const adapter = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) => (command.argv[0] === "git" ? listing : result("", false)),
    });
    await expect(adapter.preflight(context)).resolves.toMatchObject({ code: "source_invalid" });
  });

  it("fails closed on unavailable upstream metadata and tree responses", async () => {
    const context = await fixture();
    const unavailableBranch = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) => {
        if (command.argv[0] === "git") return sourceTree();
        if (command.argv[2] === "user") return result(JSON.stringify({ login: "mushanyoung" }));
        return result("not-json");
      },
    });
    await expect(unavailableBranch.preflight(context)).resolves.toMatchObject({
      code: "provider_unavailable",
    });

    const unavailableTree = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) => {
        const shared = common(command);
        if (shared !== undefined && !command.argv.some((value) => value.includes("/git/trees/"))) {
          return shared;
        }
        return result("", false);
      },
    });
    await expect(unavailableTree.preflight(context)).resolves.toMatchObject({
      code: "provider_unavailable",
    });

    const malformedTree = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) => {
        const shared = common(command);
        return shared !== undefined && !command.argv.some((value) => value.includes("/git/trees/"))
          ? shared
          : result("{}");
      },
    });
    await expect(malformedTree.preflight(context)).resolves.toMatchObject({
      code: "provider_unavailable",
    });
  });

  it.each([
    ["null comparison", result("not-json")],
    [
      "diverged comparison",
      result(JSON.stringify({ ...JSON.parse(comparison().stdout.toString()), status: "diverged" })),
    ],
    [
      "multiple commits",
      result(JSON.stringify({ ...JSON.parse(comparison().stdout.toString()), ahead_by: 2 })),
    ],
    [
      "behind upstream",
      result(JSON.stringify({ ...JSON.parse(comparison().stdout.toString()), behind_by: 1 })),
    ],
    [
      "wrong total",
      result(JSON.stringify({ ...JSON.parse(comparison().stdout.toString()), total_commits: 2 })),
    ],
    [
      "missing commits",
      result(JSON.stringify({ ...JSON.parse(comparison().stdout.toString()), commits: null })),
    ],
    [
      "extra commit",
      result(
        JSON.stringify({
          ...JSON.parse(comparison().stdout.toString()),
          commits: [{ sha: branchCommit }, { sha: "f".repeat(40) }],
        }),
      ),
    ],
    [
      "wrong commit",
      result(
        JSON.stringify({
          ...JSON.parse(comparison().stdout.toString()),
          commits: [{ sha: "f".repeat(40) }],
        }),
      ),
    ],
    [
      "missing files",
      result(JSON.stringify({ ...JSON.parse(comparison().stdout.toString()), files: null })),
    ],
    [
      "extra file",
      result(
        JSON.stringify({
          ...JSON.parse(comparison().stdout.toString()),
          files: [
            ...source.map((file) => ({
              filename: `skills/skillpress/${file.path}`,
              status: "added",
              sha: file.sha,
            })),
            { filename: "README.md", status: "modified", sha: "f".repeat(40) },
          ],
        }),
      ),
    ],
    [
      "wrong file status",
      result(
        JSON.stringify({
          ...JSON.parse(comparison().stdout.toString()),
          files: source.map((file) => ({
            filename: `skills/skillpress/${file.path}`,
            status: "modified",
            sha: file.sha,
          })),
        }),
      ),
    ],
    [
      "wrong file digest",
      result(
        JSON.stringify({
          ...JSON.parse(comparison().stdout.toString()),
          files: source.map((file) => ({
            filename: `skills/skillpress/${file.path}`,
            status: "added",
            sha: "f".repeat(40),
          })),
        }),
      ),
    ],
  ])("rejects a contribution with %s", async (_name, comparisonResult) => {
    const context = await fixture();
    const adapter = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: contributionExecutor({ comparisonResult }),
    });
    await expect(adapter.verify(context)).resolves.toEqual({ ok: false });
  });

  it("accepts one exact contribution commit when upstream has advanced", async () => {
    const context = await fixture();
    const lagging = JSON.parse(comparison().stdout.toString()) as Record<string, unknown>;
    lagging.status = "diverged";
    lagging.behind_by = 3;
    const adapter = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: contributionExecutor({ comparisonResult: result(JSON.stringify(lagging)) }),
    });
    await expect(adapter.verify(context)).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["failed listing", result("", false)],
    ["invalid JSON", result("not-json")],
    ["non-array JSON", result("{}")],
    ["duplicate PRs", result(JSON.stringify([{}, {}]))],
    ["non-object PR", result("[null]")],
    [
      "invalid number",
      result(
        JSON.stringify([
          {
            ...JSON.parse(pr().stdout.toString())[0],
            number: 0,
            url: "https://github.com/agent-skills-hub/agent-skills-hub/pull/0",
          },
        ]),
      ),
    ],
    [
      "wrong URL",
      result(
        JSON.stringify([
          { ...JSON.parse(pr().stdout.toString())[0], url: "https://example.test/pull/123" },
        ]),
      ),
    ],
    [
      "draft PR",
      result(JSON.stringify([{ ...JSON.parse(pr().stdout.toString())[0], isDraft: true }])),
    ],
    [
      "wrong branch",
      result(
        JSON.stringify([{ ...JSON.parse(pr().stdout.toString())[0], headRefName: "attacker" }]),
      ),
    ],
    [
      "wrong commit",
      result(
        JSON.stringify([{ ...JSON.parse(pr().stdout.toString())[0], headRefOid: "f".repeat(40) }]),
      ),
    ],
    [
      "wrong owner",
      result(
        JSON.stringify([
          { ...JSON.parse(pr().stdout.toString())[0], headRepositoryOwner: { login: "attacker" } },
        ]),
      ),
    ],
    [
      "wrong repository",
      result(
        JSON.stringify([
          {
            ...JSON.parse(pr().stdout.toString())[0],
            headRepository: { nameWithOwner: "attacker/agent-skills-hub" },
          },
        ]),
      ),
    ],
    [
      "wrong base",
      result(JSON.stringify([{ ...JSON.parse(pr().stdout.toString())[0], baseRefName: "dev" }])),
    ],
    [
      "closed state",
      result(JSON.stringify([{ ...JSON.parse(pr().stdout.toString())[0], state: "CLOSED" }])),
    ],
  ])("rejects a pull request with %s", async (_name, pullRequestResult) => {
    const context = await fixture();
    const adapter = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: contributionExecutor({ pullRequestResult }),
    });
    await expect(adapter.verify(context)).resolves.toEqual({ ok: false });
  });

  it("rejects malformed fork metadata and non-404 lookup failures", async () => {
    const context = await fixture();
    for (const forkResult of [
      result("network unavailable", false),
      result("null"),
      result(
        JSON.stringify({
          ...JSON.parse(fork().stdout.toString()),
          nameWithOwner: "attacker/agent-skills-hub",
        }),
      ),
      result(
        JSON.stringify({ ...JSON.parse(fork().stdout.toString()), url: "https://example.test" }),
      ),
      result(JSON.stringify({ ...JSON.parse(fork().stdout.toString()), parent: null })),
    ]) {
      const adapter = createAgentSkillsHubCatalogAdapter({
        contributor: "mushanyoung",
        executor: async (command) => common(command) ?? forkResult,
      });
      await expect(adapter.preflight(context)).resolves.toMatchObject({ ok: false });
    }
  });

  it("fails each remote branch-creation stage closed and revalidates stored requests", async () => {
    for (const failure of ["blob", "tree", "commit", "reference"] as const) {
      const context = await fixture();
      const adapter = createAgentSkillsHubCatalogAdapter({
        contributor: "mushanyoung",
        executor: branchCreationExecutor(failure),
      });
      await expect(adapter.execute?.(context, "publish-branch")).rejects.toThrow(
        new RegExp(failure === "reference" ? "branch creation" : failure, "u"),
      );
      if (failure === "blob") {
        await expect(adapter.execute?.(context, "publish-branch")).rejects.toThrow(/blob/u);
      }
    }
  });

  it("fails fork preparation and review submission errors closed", async () => {
    const context = await fixture();
    const failedFork = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) => {
        const shared = common(command);
        if (shared !== undefined) return shared;
        if (command.argv[2] === "view") return result("gh: Not Found (HTTP 404)", false);
        return result("", false);
      },
    });
    await expect(failedFork.execute?.(context, "prepare-fork")).rejects.toThrow(/creation/u);

    let forkCreated = false;
    const unverifiableFork = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) => {
        const shared = common(command);
        if (shared !== undefined) return shared;
        if (command.argv[2] === "view") {
          return forkCreated
            ? result(JSON.stringify({ isFork: false }))
            : result("gh: Not Found (HTTP 404)", false);
        }
        if (command.argv[2] === "fork") {
          forkCreated = true;
          return result("forked");
        }
        return result("", false);
      },
    });
    await expect(unverifiableFork.execute?.(context, "prepare-fork")).rejects.toThrow(/verified/u);

    const conflictingContribution = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: contributionExecutor({ comparisonResult: result("{}") }),
    });
    await expect(conflictingContribution.execute?.(context, "publish-branch")).rejects.toThrow(
      /branch conflicts/u,
    );
    await expect(conflictingContribution.execute?.(context, "open-pull-request")).rejects.toThrow(
      /branch conflicts/u,
    );

    const conflictingPr = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: contributionExecutor({ pullRequestResult: result("[{},{}]") }),
    });
    await expect(conflictingPr.execute?.(context, "open-pull-request")).rejects.toThrow(
      /pull request conflicts/u,
    );

    const failedPr = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: contributionExecutor({ pullRequestResult: result("[]") }),
    });
    await expect(failedPr.execute?.(context, "open-pull-request")).rejects.toThrow(/creation/u);

    const merged = JSON.parse(pr().stdout.toString()) as Array<Record<string, unknown>>;
    merged[0] = { ...merged[0], state: "MERGED", mergedAt: "2026-08-24T00:00:00Z" };
    const staleMergedPr = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: contributionExecutor({ pullRequestResult: result(JSON.stringify(merged)) }),
    });
    await expect(staleMergedPr.verify(context)).resolves.toEqual({ ok: false });
    await expect(staleMergedPr.execute?.(context, "open-pull-request")).rejects.toThrow(
      /merged state/u,
    );
  });

  it("rejects changed sources and missing upstream state during execution", async () => {
    const context = await fixture();
    await writeFile(join(context.root, context.artifactsPath, "provenance.json"), "{}\n");
    const changed = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async () => result(""),
    });
    await expect(changed.execute?.(context, "prepare-fork")).rejects.toThrow(/source changed/u);

    const second = await fixture();
    const missingUpstream = createAgentSkillsHubCatalogAdapter({
      contributor: "mushanyoung",
      executor: async (command) => (command.argv[0] === "git" ? sourceTree() : result("null")),
    });
    await expect(missingUpstream.execute?.(second, "prepare-fork")).rejects.toThrow(/upstream/u);
  });
});
