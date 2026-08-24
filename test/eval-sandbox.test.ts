import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createSandboxInvocation,
  DEFAULT_SANDBOX_RESOURCE_POLICY,
  type SandboxRunRequest,
  SandboxPolicyError,
} from "../src/eval/sandbox.js";

const temporaryRoot = realpathSync(tmpdir());
const digest = "a".repeat(64);

function request(backend: "docker" | "podman" = "docker"): SandboxRunRequest {
  return {
    backend,
    runId: "0123456789abcdef",
    image: `registry.example/agent@sha256:${digest}`,
    command: ["agent", "--input", "/input/scenario.json"],
    mounts: [
      { source: join(temporaryRoot, "skill"), target: "/skill", mode: "read-only" },
      { source: join(temporaryRoot, "input"), target: "/input", mode: "read-only" },
      { source: join(temporaryRoot, "output"), target: "/output", mode: "read-write" },
    ],
    network: "none",
  };
}

async function codes(run: () => unknown): Promise<readonly string[]> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxPolicyError);
    return (error as SandboxPolicyError).issues.map((entry) => entry.code);
  }
  throw new Error("expected sandbox policy rejection");
}

describe("sandbox invocation policy", () => {
  it.each(["docker", "podman"] as const)(
    "constructs a shell-free, release-eligible %s invocation",
    (backend) => {
      const invocation = createSandboxInvocation(request(backend));

      expect(invocation).toMatchObject({
        executable: backend,
        containerName: "skillpress-0123456789abcdef",
        releaseEligible: true,
        ineligibilityReasons: [],
        policy: DEFAULT_SANDBOX_RESOURCE_POLICY,
      });
      expect(invocation.argv.slice(0, 4)).toEqual([
        "run",
        "--rm",
        "--pull=never",
        "--name=skillpress-0123456789abcdef",
      ]);
      expect(invocation.argv).toEqual(
        expect.arrayContaining([
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--user=65532:65532",
          "--cpus=1",
          "--memory=512m",
          "--memory-swap=512m",
          "--pids-limit=64",
          "--shm-size=16m",
          "--ulimit=nofile=256:256",
          "--log-driver=none",
          "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
          "--workdir=/output",
          `registry.example/agent@sha256:${digest}`,
        ]),
      );
      expect(invocation.argv.filter((entry) => entry === "--mount")).toHaveLength(3);
      expect(invocation.argv.some((entry) => entry.includes("dst=/skill,readonly"))).toBe(true);
      expect(invocation.argv.some((entry) => entry.endsWith("dst=/output"))).toBe(true);
      expect(invocation.argv).not.toContain("--privileged");
      expect(invocation.argv).not.toContain("--network=host");
      expect(Object.isFrozen(invocation)).toBe(true);
      expect(Object.isFrozen(invocation.argv)).toBe(true);
      expect(Object.isFrozen(invocation.policy)).toBe(true);
      if (backend === "podman") expect(invocation.argv).toContain("--read-only-tmpfs=false");
      else expect(invocation.argv).not.toContain("--read-only-tmpfs=false");
    },
  );

  it("allows an explicit unpinned local image but makes the result ineligible", () => {
    const invocation = createSandboxInvocation({
      ...request(),
      image: "local-agent:test",
      allowUnpinnedImage: true,
    });

    expect(invocation.releaseEligible).toBe(false);
    expect(invocation.ineligibilityReasons).toEqual(["sandbox_image_unpinned"]);
  });

  it("accepts a digest-pinned official-library image name", () => {
    const invocation = createSandboxInvocation({
      ...request(),
      image: `python@sha256:${digest}`,
    });

    expect(invocation.releaseEligible).toBe(true);
  });

  it.each([
    [
      "unpinned image",
      (value: SandboxRunRequest) => ({ ...value, image: "latest" }),
      "sandbox.image.unpinned",
    ],
    [
      "restricted network",
      (value: SandboxRunRequest) => ({ ...value, network: "restricted" as const }),
      "sandbox.network.unsupported",
    ],
    [
      "invalid run id",
      (value: SandboxRunRequest) => ({ ...value, runId: "../container" }),
      "sandbox.run_id",
    ],
    [
      "empty command argument",
      (value: SandboxRunRequest) => ({ ...value, command: ["agent", ""] as [string, string] }),
      "sandbox.command.argument",
    ],
    [
      "too many command arguments",
      (value: SandboxRunRequest) => ({
        ...value,
        command: Array.from({ length: 257 }, () => "x") as [string, ...string[]],
      }),
      "sandbox.command.count",
    ],
    [
      "relative source",
      (value: SandboxRunRequest) => ({
        ...value,
        mounts: [{ ...value.mounts[0], source: "relative" }, ...value.mounts.slice(1)],
      }),
      "sandbox.mount.source",
    ],
    [
      "unsafe target",
      (value: SandboxRunRequest) => ({
        ...value,
        mounts: [{ ...value.mounts[0], target: "/skill/../host" }, ...value.mounts.slice(1)],
      }),
      "sandbox.mount.target",
    ],
    [
      "overlapping target",
      (value: SandboxRunRequest) => ({
        ...value,
        mounts: [value.mounts[0], { ...value.mounts[1], target: "/skill/input" }, value.mounts[2]],
      }),
      "sandbox.mount.overlap",
    ],
    [
      "multiple writable mounts",
      (value: SandboxRunRequest) => ({
        ...value,
        mounts: value.mounts.map((mount) => ({ ...mount, mode: "read-write" as const })),
      }),
      "sandbox.mount.writable",
    ],
    ["no mounts", (value: SandboxRunRequest) => ({ ...value, mounts: [] }), "sandbox.mount.count"],
    [
      "unexpected mount topology",
      (value: SandboxRunRequest) => ({
        ...value,
        mounts: [{ ...value.mounts[0], target: "/repository" }, ...value.mounts.slice(1)],
      }),
      "sandbox.mount.topology",
    ],
    [
      "unknown backend",
      (value: SandboxRunRequest) => ({
        ...value,
        backend: "host" as SandboxRunRequest["backend"],
      }),
      "sandbox.backend",
    ],
  ] as const)("rejects %s", async (_name, mutate, code) => {
    expect(await codes(() => createSandboxInvocation(mutate(request())))).toContain(code);
  });

  it.each([
    ["timeoutSeconds", 0],
    ["memoryMib", 63],
    ["pids", 7],
    ["tmpfsMib", 7],
    ["shmMib", 0],
    ["maxOutputBytes", 1000],
    ["maxArtifactBytes", 1000],
    ["maxArtifactFiles", 0],
    ["cpus", Number.NaN],
  ] as const)("rejects an invalid %s resource limit", async (field, invalid) => {
    const policy = { ...DEFAULT_SANDBOX_RESOURCE_POLICY, [field]: invalid };

    expect(await codes(() => createSandboxInvocation({ ...request(), policy }))).toContain(
      "sandbox.policy.bound",
    );
  });

  it("rejects oversized mount and command collections", async () => {
    const tooManyMounts = Array.from({ length: 9 }, (_, index) => ({
      source: join(temporaryRoot, `source-${index}`),
      target: `/target-${index}`,
      mode: index === 0 ? ("read-write" as const) : ("read-only" as const),
    }));
    const oversizedArgument = "x".repeat(16 * 1024 + 1);

    expect(
      await codes(() => createSandboxInvocation({ ...request(), mounts: tooManyMounts })),
    ).toContain("sandbox.mount.count");
    expect(
      await codes(() => createSandboxInvocation({ ...request(), command: [oversizedArgument] })),
    ).toContain("sandbox.command.argument");
  });
});
