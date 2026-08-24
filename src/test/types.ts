export type TestCommandStatus =
  | "passed"
  | "failed"
  | "timed_out"
  | "output_limit"
  | "spawn_error"
  | "invalid_cwd";

export interface TestCommandResult {
  readonly name: string;
  readonly cwd: string;
  readonly status: TestCommandStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
}

export interface ProjectTestReport {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly project: {
    readonly name: string;
    readonly version: string;
  };
  readonly results: readonly TestCommandResult[];
}
