import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

export type CapturedCommandStatus =
  | "passed"
  | "failed"
  | "spawn_error"
  | "timed_out"
  | "output_limit";

export interface CapturedCommand {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly maxOutputBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface CapturedCommandResult {
  readonly status: CapturedCommandStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const spawnSnapshot = spawn;
const processKillSnapshot = process.kill.bind(process);
const platformSnapshot = process.platform;
const inheritedEnvironment = ["PATH", "SystemRoot", "PATHEXT", "ComSpec"] as const;
const baseEnvironment: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    inheritedEnvironment.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  ),
);

function terminate(child: ChildProcess, detached: boolean): void {
  try {
    if (detached && child.pid !== undefined) processKillSnapshot(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // A concurrent process exit is already the desired terminal state.
  }
}

function environment(additional: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  return Object.assign(Object.create(null), baseEnvironment, additional ?? {}) as NodeJS.ProcessEnv;
}

/** Run explicit argv without a shell while retaining only bounded output for a strict parser. */
export async function runCapturedCommand(command: CapturedCommand): Promise<CapturedCommandResult> {
  const startedAt = performance.now();
  const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(command.timeoutSeconds) ||
    command.timeoutSeconds < 1 ||
    command.timeoutSeconds > 7200 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1024 ||
    maxOutputBytes > 16 * 1024 * 1024
  ) {
    throw new TypeError("Captured command limits are invalid.");
  }
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let retainedBytes = 0;
  let forcedStatus: CapturedCommandStatus | undefined;
  const detached = platformSnapshot !== "win32";
  let child: ChildProcess;
  try {
    child = spawnSnapshot(command.argv[0], command.argv.slice(1), {
      cwd: command.cwd,
      detached,
      env: environment(command.env),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return Object.freeze({
      status: "spawn_error",
      exitCode: null,
      signal: null,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutSha256: stdoutHash.digest("hex"),
      stderrSha256: stderrHash.digest("hex"),
    });
  }

  const force = (status: CapturedCommandStatus): void => {
    if (forcedStatus !== undefined) return;
    forcedStatus = status;
    terminate(child, detached);
  };
  const retain = (chunk: Buffer, destination: Buffer[]): void => {
    const available = Math.max(0, maxOutputBytes - retainedBytes);
    if (available === 0) return;
    const retained = chunk.subarray(0, available);
    destination.push(retained);
    retainedBytes += retained.byteLength;
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    stdoutHash.update(chunk);
    retain(chunk, stdoutChunks);
    if (stdoutBytes + stderrBytes > maxOutputBytes) force("output_limit");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    stderrHash.update(chunk);
    retain(chunk, stderrChunks);
    if (stdoutBytes + stderrBytes > maxOutputBytes) force("output_limit");
  });

  const timeout = setTimeout(() => force("timed_out"), command.timeoutSeconds * 1000);
  return new Promise((resolveResult) => {
    child.once("error", () => force("spawn_error"));
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolveResult(
        Object.freeze({
          status: forcedStatus ?? (exitCode === 0 ? "passed" : "failed"),
          exitCode,
          signal,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
          stdoutBytes,
          stderrBytes,
          stdoutSha256: stdoutHash.digest("hex"),
          stderrSha256: stderrHash.digest("hex"),
        }),
      );
    });
  });
}
