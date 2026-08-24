import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { isGenuineSandboxInvocation, type SandboxInvocation } from "./sandbox.js";

export type SandboxExecutionStatus =
  | "passed"
  | "failed"
  | "timed_out"
  | "output_limit"
  | "spawn_error";

export interface SandboxExecutionResult {
  readonly status: SandboxExecutionStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly stdoutText: string;
  readonly stderrText: string;
  readonly cleanupAttempted: boolean;
  readonly cleanupOk: boolean;
}

const spawnSnapshot = spawn;
const processKillSnapshot = process.kill.bind(process);
const platformSnapshot = process.platform;
const clientEnvironmentSnapshot = Object.freeze({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DOCKER_HOST: process.env.DOCKER_HOST,
  DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  CONTAINER_HOST: process.env.CONTAINER_HOST,
  SystemRoot: process.env.SystemRoot,
  PATHEXT: process.env.PATHEXT,
  ComSpec: process.env.ComSpec,
});

function clientEnvironment(): NodeJS.ProcessEnv {
  const entries = Object.entries(clientEnvironmentSnapshot).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return Object.assign(Object.create(null), Object.fromEntries(entries), {
    SKILLPRESS: "1",
  }) as NodeJS.ProcessEnv;
}

function terminateClient(child: ChildProcess, detached: boolean): void {
  try {
    if (detached && child.pid !== undefined) processKillSnapshot(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // A concurrent exit is already the required terminal state.
  }
}

async function removeContainer(invocation: SandboxInvocation): Promise<boolean> {
  let child: ChildProcess;
  try {
    child = spawnSnapshot(invocation.executable, ["rm", "--force", invocation.containerName], {
      detached: false,
      env: clientEnvironment(),
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    return false;
  }
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(ok);
    };
    child.once("error", () => finish(false));
    child.once("close", (exitCode) => finish(exitCode === 0));
    const timeout = setTimeout(() => {
      terminateClient(child, false);
      finish(false);
    }, 5000);
    timeout.unref();
  });
}

function fixedResult(
  status: SandboxExecutionStatus,
  startedAt: number,
  stdout: Buffer,
  stderr: Buffer,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  cleanupAttempted: boolean,
  cleanupOk: boolean,
): SandboxExecutionResult {
  return Object.freeze({
    status,
    exitCode,
    signal,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    stdoutBytes: stdout.byteLength,
    stderrBytes: stderr.byteLength,
    stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
    stderrSha256: createHash("sha256").update(stderr).digest("hex"),
    stdoutText: stdout.toString("utf8"),
    stderrText: stderr.toString("utf8"),
    cleanupAttempted,
    cleanupOk,
  });
}

/** Execute a genuine invocation and forcibly remove its named container after forced termination. */
export async function executeSandboxInvocation(
  invocation: SandboxInvocation,
): Promise<SandboxExecutionResult> {
  if (!isGenuineSandboxInvocation(invocation)) {
    throw new TypeError("invocation must come from createSandboxInvocation.");
  }
  const startedAt = performance.now();
  const detached = platformSnapshot !== "win32";
  let child: ChildProcess;
  try {
    child = spawnSnapshot(invocation.executable, invocation.argv, {
      detached,
      env: clientEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return fixedResult(
      "spawn_error",
      startedAt,
      Buffer.alloc(0),
      Buffer.alloc(0),
      null,
      null,
      false,
      false,
    );
  }

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let forcedStatus: SandboxExecutionStatus | undefined;
  let cleanupRequested = false;
  const force = (status: SandboxExecutionStatus): void => {
    if (forcedStatus !== undefined) return;
    forcedStatus = status;
    cleanupRequested = true;
    terminateClient(child, detached);
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes + stderrBytes > invocation.policy.maxOutputBytes) force("output_limit");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
    stderrBytes += chunk.byteLength;
    if (stdoutBytes + stderrBytes > invocation.policy.maxOutputBytes) force("output_limit");
  });

  const timeout = setTimeout(() => force("timed_out"), invocation.policy.timeoutSeconds * 1000);
  timeout.unref();
  return new Promise((resolveResult) => {
    child.once("error", () => force("spawn_error"));
    child.once("close", async (exitCode, signal) => {
      clearTimeout(timeout);
      const status = forcedStatus ?? (exitCode === 0 ? "passed" : "failed");
      const cleanupOk = cleanupRequested ? await removeContainer(invocation) : false;
      resolveResult(
        fixedResult(
          status,
          startedAt,
          Buffer.concat(stdout),
          Buffer.concat(stderr),
          exitCode,
          signal,
          cleanupRequested,
          cleanupOk,
        ),
      );
    });
  });
}
