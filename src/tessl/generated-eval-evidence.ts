/* Generated from schemas/tessl-eval-evidence.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressTesslEvalEvidence`'s JSON-Schema
 * via the `definition` "timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `SkillPressTesslEvalEvidence`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;

/**
 * Paired Impact evidence parsed from completed Tessl CLI eval results.
 */
export interface SkillPressTesslEvalEvidence {
  schemaVersion: 1;
  evidenceType: "skillpress.tessl-eval";
  provider: "tessl";
  createdAt: Timestamp;
  sourceCommit: string;
  projectConfigSha256: Digest;
  skillSha256: Digest;
  scenarioSourceSha256: Digest;
  cli: Cli;
  runId: string;
  agent: string;
  model: string;
  runs: number;
  impactScore: number;
  baselineScore: number;
  impactDelta: number;
  upliftRatio: number | null;
  /**
   * @minItems 1
   * @maxItems 256
   */
  scenarios: [
    {
      fingerprintSha256: Digest;
      baselineScore: number;
      withContextScore: number;
      delta: number;
    },
    ...{
      fingerprintSha256: Digest;
      baselineScore: number;
      withContextScore: number;
      delta: number;
    }[],
  ];
  start: Invocation;
  result: Invocation;
  storagePath: string;
  evidenceEligible: boolean;
  ineligibilityReasons: (
    | "custom_executor"
    | "dirty_inputs"
    | "source_changed"
    | "untrusted_cli"
    | "missing_baseline"
    | "scenario_regression"
    | "critical_failure"
  )[];
}
/**
 * This interface was referenced by `SkillPressTesslEvalEvidence`'s JSON-Schema
 * via the `definition` "cli".
 */
export interface Cli {
  version: string;
  executableSha256: Digest;
  commandSha256: Digest;
  exitCode: 0;
  signal: null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: Digest;
  stderrSha256: Digest;
}
/**
 * This interface was referenced by `SkillPressTesslEvalEvidence`'s JSON-Schema
 * via the `definition` "invocation".
 */
export interface Invocation {
  passed: boolean;
  commandSha256: Digest;
  exitCode: 0;
  signal: null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: Digest;
  stderrSha256: Digest;
}
