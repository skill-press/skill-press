import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { TestCommandResult, TestCommandStatus } from "../test/types.js";

export const MAX_TEST_OUTPUT_BYTES = 1024 * 1024;

export interface BoundedCommand {
  readonly name: string;
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly reportCwd?: string;
  readonly timeoutSeconds: number;
  readonly signal?: AbortSignal;
}

const spawnSnapshot = spawn;
const processKillSnapshot = process.kill.bind(process);
const platformSnapshot = process.platform;
const pathSnapshot = process.env.PATH;
const systemRootSnapshot = process.env.SystemRoot;
const pathExtSnapshot = process.env.PATHEXT;
const comSpecSnapshot = process.env.ComSpec;

function childEnvironment(): NodeJS.ProcessEnv {
  const entries: Array<readonly [string, string | undefined]> = [
    ["PATH", pathSnapshot],
    ["SystemRoot", systemRootSnapshot],
    ["PATHEXT", pathExtSnapshot],
    ["ComSpec", comSpecSnapshot],
    ["SKILL_PRESS", "1"],
    ["", undefined],
  ];
  return Object.assign(
    Object.create(null),
    Object.fromEntries(
      entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
    ),
  ) as NodeJS.ProcessEnv;
}

function terminate(child: ChildProcess, detached: boolean): void {
  try {
    if (detached && child.pid !== undefined) {
      processKillSnapshot(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // A concurrent exit is already the desired terminal state.
  }
}

function fixedResult(
  command: BoundedCommand,
  status: TestCommandStatus,
  durationMs: number,
  stdoutBytes: number,
  stderrBytes: number,
  stdoutSha256: string,
  stderrSha256: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): TestCommandResult {
  return Object.freeze({
    name: command.name,
    cwd: command.reportCwd ?? command.cwd,
    status,
    exitCode,
    signal,
    durationMs: Math.max(0, Math.round(durationMs)),
    stdoutBytes,
    stderrBytes,
    stdoutSha256,
    stderrSha256,
  });
}

/** Execute one explicit argv without a shell and without retaining raw output. */
export async function runBoundedCommand(command: BoundedCommand): Promise<TestCommandResult> {
  const startedAt = performance.now();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let forcedStatus: TestCommandStatus | undefined;
  const detached = platformSnapshot !== "win32";
  let child: ChildProcess;
  try {
    child = spawnSnapshot(command.argv[0], command.argv.slice(1), {
      cwd: command.cwd,
      detached,
      env: childEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return fixedResult(
      command,
      "spawn_error",
      performance.now() - startedAt,
      0,
      0,
      stdoutHash.digest("hex"),
      stderrHash.digest("hex"),
      null,
      null,
    );
  }

  const force = (status: TestCommandStatus): void => {
    if (forcedStatus !== undefined) return;
    forcedStatus = status;
    terminate(child, detached);
  };
  const abort = (): void => force("failed");
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    stdoutHash.update(chunk);
    if (stdoutBytes + stderrBytes > MAX_TEST_OUTPUT_BYTES) force("output_limit");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    stderrHash.update(chunk);
    if (stdoutBytes + stderrBytes > MAX_TEST_OUTPUT_BYTES) force("output_limit");
  });

  const timeout = setTimeout(() => force("timed_out"), command.timeoutSeconds * 1000);
  timeout.unref();
  return new Promise((resolveResult) => {
    child.once("error", () => force("spawn_error"));
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      command.signal?.removeEventListener("abort", abort);
      const status = forcedStatus ?? (exitCode === 0 ? "passed" : "failed");
      resolveResult(
        fixedResult(
          command,
          status,
          performance.now() - startedAt,
          stdoutBytes,
          stderrBytes,
          stdoutHash.digest("hex"),
          stderrHash.digest("hex"),
          exitCode,
          signal,
        ),
      );
    });
    command.signal?.addEventListener("abort", abort, { once: true });
    if (command.signal?.aborted === true) abort();
  });
}
