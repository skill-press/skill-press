import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const observations = vi.hoisted(() => [] as boolean[]);

vi.mock("../src/install/git-policy.js", async () => {
  const { lstat: inspect } = await import("node:fs/promises");
  const { join: pathJoin } = await import("node:path");
  return {
    createGitPolicyBudget: () => ({ remainingMs: 30_000 }),
    assertGitLocalInstallPolicy: async (projectRoot: string) => {
      let mutationLockExisted = true;
      try {
        await inspect(pathJoin(projectRoot, ".skill-lock.json.lock"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") mutationLockExisted = false;
        else throw error;
      }
      observations.push(mutationLockExisted);
      throw Object.assign(new Error("Git policy rejected the target."), {
        code: "install_path_unsafe",
      });
    },
  };
});

const { addTrustedSkill, installTrustedSkills } = await import("../src/install/index.js");

const temporaryPaths: string[] = [];

afterEach(async () => {
  observations.splice(0);
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryProject(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "skillpress-preflight-order-test-"));
  temporaryPaths.push(path);
  return path;
}

async function expectNoMutationLock(projectRoot: string): Promise<void> {
  await expect(lstat(join(projectRoot, ".skill-lock.json.lock"))).rejects.toMatchObject({
    code: "ENOENT",
  });
}

describe("trusted install preflight ordering", () => {
  it("runs add Git policy before creating its project mutation lock", async () => {
    const projectRoot = await temporaryProject();
    await expect(
      addTrustedSkill({ locator: "example/example-skill@1.2.3", projectRoot }),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
    expect(observations).toEqual([false]);
    await expectNoMutationLock(projectRoot);
  });

  it("reads install targets and runs Git policy before creating its project mutation lock", async () => {
    const projectRoot = await temporaryProject();
    await writeFile(
      join(projectRoot, "skill-lock.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        lockfileType: "skillpress.lock",
        registry: { origin: "https://skill-press.com", protocolVersion: 1 },
        skills: [
          {
            locator: "example/example-skill@1.2.3",
            namespace: "example",
            skill: "example-skill",
            version: "1.2.3",
            artifact: { sha256: "a".repeat(64), bytes: 100 },
            attestation: { sha256: "b".repeat(64), keyId: "attestation-key" },
            trust: {
              sequence: 1,
              status: "trusted",
              keyId: "trust-key",
              sha256: "c".repeat(64),
              updatedAt: "2026-08-27T00:00:00.000Z",
            },
            installedPath: ".agents/skills/example-skill",
          },
        ],
      })}\n`,
    );
    await expect(installTrustedSkills({ projectRoot })).rejects.toMatchObject({
      code: "install_path_unsafe",
    });
    expect(observations).toEqual([false]);
    await expectNoMutationLock(projectRoot);
  });
});
