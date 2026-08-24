/* Generated from schemas/tessl-review-evidence.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressTesslReviewEvidence`'s JSON-Schema
 * via the `definition` "timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `SkillPressTesslReviewEvidence`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;

/**
 * Evidence parsed from an actual Tessl CLI lint and quality-review invocation.
 */
export interface SkillPressTesslReviewEvidence {
  schemaVersion: 1;
  evidenceType: "skillpress.tessl-review";
  provider: "tessl";
  createdAt: Timestamp;
  sourceCommit: string;
  projectConfigSha256: Digest;
  skillSha256: Digest;
  cli: Cli;
  lint: Invocation;
  review: {
    passed: boolean;
    commandSha256: Digest;
    exitCode: 0;
    signal: null;
    durationMs: number;
    stdoutBytes: number;
    stderrBytes: number;
    stdoutSha256: Digest;
    stderrSha256: Digest;
    runId: string | null;
    workspace: string | null;
    qualityScore: number;
    validationPassed: boolean;
  };
  storagePath: string;
  evidenceEligible: boolean;
  ineligibilityReasons: ("custom_executor" | "dirty_inputs" | "source_changed" | "untrusted_cli")[];
}
/**
 * This interface was referenced by `SkillPressTesslReviewEvidence`'s JSON-Schema
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
 * This interface was referenced by `SkillPressTesslReviewEvidence`'s JSON-Schema
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
