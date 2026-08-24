import { realpathSync } from "node:fs";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSandboxInvocation, type SandboxResourcePolicy } from "../src/eval/sandbox.js";

const temporaryRoot = realpathSync(tmpdir());
const originalPath = process.env.PATH;
let fakeRoot = "";
let fakeDocker = "";
let cleanupLog = "";
let executeSandboxInvocation: typeof import("../src/eval/sandbox-execute.js").executeSandboxInvocation;

function invocation(command: string, policy?: SandboxResourcePolicy) {
  return createSandboxInvocation({
    backend: "docker",
    runId: "0123456789abcdef",
    image: `example/agent@sha256:${"a".repeat(64)}`,
    command: [command],
    mounts: [
      { source: join(temporaryRoot, "skill"), target: "/skill", mode: "read-only" },
      { source: join(temporaryRoot, "input"), target: "/input", mode: "read-only" },
      { source: join(temporaryRoot, "output"), target: "/output", mode: "read-write" },
    ],
    network: "none",
    ...(policy === undefined ? {} : { policy }),
  });
}

beforeAll(async () => {
  fakeRoot = await mkdtemp(join(temporaryRoot, "skillpress-fake-docker-"));
  fakeDocker = join(fakeRoot, "docker");
  cleanupLog = join(fakeRoot, "cleanup.log");
  const source = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "rm") {
  appendFileSync(${JSON.stringify(cleanupLog)}, args.join(" ") + "\\n");
  process.exit(0);
}
const command = args.at(-1);
if (command === "pass") {
  process.stdout.write("sandbox stdout\\n");
  process.stderr.write("sandbox stderr\\n");
} else if (command === "fail") {
  process.exit(7);
} else if (command === "overflow") {
  process.stdout.write(Buffer.alloc(2048, 120));
} else if (command === "timeout") {
  setInterval(() => {}, 1000);
} else if (command === "environment") {
  process.stdout.write(JSON.stringify({
    skillpress: process.env.SKILLPRESS,
    secret: process.env.SKILLPRESS_EXECUTOR_TEST_SECRET,
    nodeOptions: process.env.NODE_OPTIONS
  }));
}
`;
  await writeFile(fakeDocker, source, { mode: 0o700 });
  await chmod(fakeDocker, 0o700);
  process.env.PATH = fakeRoot;
  ({ executeSandboxInvocation } = await import("../src/eval/sandbox-execute.js"));
});

afterAll(async () => {
  process.env.PATH = originalPath;
  await rm(fakeRoot, { recursive: true });
});

describe("sandbox executor", () => {
  it("captures bounded engine output and a successful exit", async () => {
    const result = await executeSandboxInvocation(invocation("pass"));

    expect(result).toMatchObject({
      status: "passed",
      exitCode: 0,
      signal: null,
      stdoutText: "sandbox stdout\n",
      stderrText: "sandbox stderr\n",
      stdoutBytes: 15,
      stderrBytes: 15,
      cleanupAttempted: false,
      cleanupOk: false,
    });
    expect(result.stdoutSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("reports a nonzero engine exit", async () => {
    await expect(executeSandboxInvocation(invocation("fail"))).resolves.toMatchObject({
      status: "failed",
      exitCode: 7,
      cleanupAttempted: false,
    });
  });

  it("does not forward arbitrary host variables to the engine client", async () => {
    process.env.SKILLPRESS_EXECUTOR_TEST_SECRET = "must-not-cross";
    process.env.NODE_OPTIONS = "--trace-warnings";
    try {
      const result = await executeSandboxInvocation(invocation("environment"));
      expect(JSON.parse(result.stdoutText)).toEqual({ skillpress: "1" });
    } finally {
      delete process.env.SKILLPRESS_EXECUTOR_TEST_SECRET;
      delete process.env.NODE_OPTIONS;
    }
  });

  it("kills and cleans up after output overflow", async () => {
    const policy = {
      ...invocation("pass").policy,
      maxOutputBytes: 1024,
    };

    const result = await executeSandboxInvocation(invocation("overflow", policy));

    expect(result.status).toBe("output_limit");
    expect(result.cleanupAttempted).toBe(true);
    expect(result.cleanupOk).toBe(true);
    expect(await readFile(cleanupLog, "utf8")).toContain("rm --force skillpress-0123456789abcdef");
  });

  it("kills and cleans up after the wall-time limit", async () => {
    const policy = {
      ...invocation("pass").policy,
      timeoutSeconds: 1,
    };

    const result = await executeSandboxInvocation(invocation("timeout", policy));

    expect(result.status).toBe("timed_out");
    expect(result.cleanupAttempted).toBe(true);
    expect(result.cleanupOk).toBe(true);
  });

  it("rejects counterfeit invocation records", async () => {
    await expect(executeSandboxInvocation({ ...invocation("pass") })).rejects.toThrow(
      "createSandboxInvocation",
    );
  });

  it("reports an engine startup failure and attempts cleanup", async () => {
    const moved = `${fakeDocker}.moved`;
    await rename(fakeDocker, moved);
    try {
      const result = await executeSandboxInvocation(invocation("pass"));
      expect(result.status).toBe("spawn_error");
      expect(result.cleanupAttempted).toBe(true);
      expect(result.cleanupOk).toBe(false);
    } finally {
      await rename(moved, fakeDocker);
    }
  });
});
