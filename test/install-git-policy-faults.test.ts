import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

interface MockGitResponse {
  readonly code: number | string | null;
  readonly stdout?: string;
  readonly killed?: boolean;
  readonly signal?: NodeJS.Signals | null;
}

const git = vi.hoisted(() => ({
  responses: [] as MockGitResponse[],
  environments: [] as NodeJS.ProcessEnv[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...arguments_: unknown[]) => {
      const callback = arguments_.at(-1) as (
        error: NodeJS.ErrnoException | null,
        stdout: Buffer,
        stderr: Buffer,
      ) => void;
      const options = arguments_.at(-2) as { readonly env?: NodeJS.ProcessEnv };
      git.environments.push({ ...options.env });
      const response = git.responses.shift();
      if (response === undefined) throw new Error("Missing mocked Git response.");
      queueMicrotask(() => {
        const stdout = Buffer.from(response.stdout ?? "");
        if (response.code === null) callback(null, stdout, Buffer.alloc(0));
        else {
          callback(
            Object.assign(new Error("mock git failure"), {
              code: response.code,
              killed: response.killed ?? false,
              signal: response.signal ?? null,
            }),
            stdout,
            Buffer.alloc(0),
          );
        }
      });
      return Object.create(null);
    },
  };
});

const { assertGitLocalInstallPolicy, createGitPolicyBudget } = await import(
  "../src/install/git-policy.js"
);

const temporaryPaths: string[] = [];

afterEach(async () => {
  git.responses.splice(0);
  git.environments.splice(0);
  delete process.env.GIT_CONFIG_KEY_SKPRESS_TEST;
  delete process.env.GIT_CONFIG_VALUE_SKPRESS_TEST;
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryProject(gitMarker = false): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "skillpress-git-policy-fault-test-"));
  temporaryPaths.push(path);
  if (gitMarker) await mkdir(join(path, ".git"));
  return path;
}

function success(stdout = ""): MockGitResponse {
  return { code: null, stdout };
}

function failure(code: number | string, overrides: Partial<MockGitResponse> = {}): MockGitResponse {
  return { code, ...overrides };
}

describe("trusted install Git policy faults", () => {
  it("does nothing for an empty target set", async () => {
    await expect(
      assertGitLocalInstallPolicy(await temporaryProject(), []),
    ).resolves.toBeUndefined();
    expect(git.environments).toEqual([]);
  });

  it("allows a non-Git directory when Git is absent or reports no repository", async () => {
    const root = await temporaryProject();
    git.responses.push(failure("ENOENT"), failure(128));
    await expect(assertGitLocalInstallPolicy(root, ["example-skill"])).resolves.toBeUndefined();
    await expect(assertGitLocalInstallPolicy(root, ["example-skill"])).resolves.toBeUndefined();
  });

  it("fails closed when Git is absent or malformed beside a repository marker", async () => {
    const root = await temporaryProject(true);
    git.responses.push(failure("ENOENT"), failure(128));
    await expect(assertGitLocalInstallPolicy(root, ["example-skill"])).rejects.toMatchObject({
      code: "install_path_unsafe",
    });
    await expect(assertGitLocalInstallPolicy(root, ["example-skill"])).rejects.toMatchObject({
      code: "install_path_unsafe",
    });
  });

  it.each([
    failure(1, { killed: true }),
    failure(1, { signal: "SIGTERM" }),
    failure("ERR_CHILD_PROCESS_STDIO_MAXBUFFER"),
    failure("not-an-exit-code"),
  ])("fails closed for an abnormal Git process result", async (response) => {
    git.responses.push(response);
    await expect(
      assertGitLocalInstallPolicy(await temporaryProject(), ["example-skill"]),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
  });

  it("rejects any tracked target output", async () => {
    git.responses.push(success(".agents/skills/example-skill/SKILL.md\0"));
    await expect(
      assertGitLocalInstallPolicy(await temporaryProject(), ["example-skill"]),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
  });

  it("rejects target-query failures and sanitizes inherited Git config injection", async () => {
    process.env.GIT_CONFIG_KEY_SKPRESS_TEST = "core.fsmonitor";
    process.env.GIT_CONFIG_VALUE_SKPRESS_TEST = "malicious";
    git.responses.push(failure(2));
    await expect(
      assertGitLocalInstallPolicy(await temporaryProject(), ["example-skill"]),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
    expect(git.environments[0]).toMatchObject({
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    });
    expect(git.environments[0]).not.toHaveProperty("GIT_CONFIG_KEY_SKPRESS_TEST");
    expect(git.environments[0]).not.toHaveProperty("GIT_CONFIG_VALUE_SKPRESS_TEST");
  });

  it("rejects nonzero tracked-state and exceptional ignore-state results", async () => {
    const root = await temporaryProject();
    git.responses.push(failure(2));
    await expect(assertGitLocalInstallPolicy(root, ["example-skill"])).rejects.toMatchObject({
      code: "install_path_unsafe",
    });
    git.responses.push(success(), failure(2));
    await expect(assertGitLocalInstallPolicy(root, ["example-skill"])).rejects.toMatchObject({
      code: "install_path_unsafe",
    });
  });

  it("deduplicates targets while accepting an ignored untracked tree", async () => {
    git.responses.push(success(), success(".agents/skills/example-skill/\n"));
    await expect(
      assertGitLocalInstallPolicy(await temporaryProject(), ["example-skill", "example-skill"]),
    ).resolves.toBeUndefined();
    expect(git.environments).toHaveLength(2);
  });

  it("batches targets and fails when even one directory is not ignored", async () => {
    git.responses.push(success(), success(".agents/skills/first-skill/\n"));
    await expect(
      assertGitLocalInstallPolicy(await temporaryProject(), ["first-skill", "second-skill"]),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
    expect(git.environments).toHaveLength(2);
  });

  it("rejects invalid targets and an exhausted cumulative Git budget", async () => {
    const root = await temporaryProject();
    await expect(assertGitLocalInstallPolicy(root, ["../unsafe"])).rejects.toMatchObject({
      code: "install_path_unsafe",
    });
    await expect(
      assertGitLocalInstallPolicy(root, ["example-skill"], { remainingMs: 0 }),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
    expect(createGitPolicyBudget().remainingMs).toBe(30_000);
  });
});
