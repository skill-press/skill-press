/* Generated from schemas/eval-evidence.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;
/**
 * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
 * via the `definition` "rate".
 */
export type Rate = number;

/**
 * Redacted local evidence from paired baseline and with-skill sandbox runs.
 */
export interface SkillPressPairedEvaluationEvidence {
  schemaVersion: 1;
  evidenceType: "skillpress.paired-eval";
  runId: Digest;
  createdAt: string;
  project: {
    name: string;
    version: string;
  };
  suite: "training" | "holdout";
  model: string;
  adapter: {
    backend: "docker" | "podman";
    image: string;
    commandSha256: Digest;
  };
  skillSha256: Digest;
  configSha256: Digest;
  repetitions: number;
  /**
   * @minItems 1
   * @maxItems 128
   */
  scenarioResults: [ScenarioEvidence, ...ScenarioEvidence[]];
  summary: {
    baselineSuccessRate: Rate;
    withSkillSuccessRate: Rate;
    impactDelta: number;
    minimumSuccessRate: Rate;
    minimumImpactDelta: Rate;
    behavioralGatePassed: boolean;
  };
  evidenceEligible: boolean;
  /**
   * @maxItems 64
   */
  ineligibilityReasons: string[];
  storagePath: string;
}
/**
 * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
 * via the `definition` "scenarioEvidence".
 */
export interface ScenarioEvidence {
  id: string;
  expectedActivation: boolean;
  /**
   * @minItems 1
   * @maxItems 20
   */
  runs: [RepetitionEvidence, ...RepetitionEvidence[]];
}
/**
 * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
 * via the `definition` "repetitionEvidence".
 */
export interface RepetitionEvidence {
  repetition: number;
  baseline: LegEvidence;
  withSkill: LegEvidence;
}
/**
 * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
 * via the `definition` "legEvidence".
 */
export interface LegEvidence {
  runId: Digest;
  status: "passed" | "failed" | "timed_out" | "output_limit" | "spawn_error" | "invalid_result";
  activated: boolean | null;
  loadedSkillSha256: Digest | null;
  rubricScore: number | null;
  successful: boolean;
  inputSha256: Digest;
  transcript: TranscriptEvidence;
  engineStdoutSha256: Digest;
  engineStderrSha256: Digest;
}
/**
 * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
 * via the `definition` "transcriptEvidence".
 */
export interface TranscriptEvidence {
  bytes: number;
  sha256: Digest;
  redactedExcerpt: string;
}
