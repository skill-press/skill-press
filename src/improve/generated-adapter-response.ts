/* Generated from schemas/improve-adapter-response.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressImprovementAdapterResponse`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;

/**
 * Strict response written by an external SkillPress improvement role adapter.
 */
export interface SkillPressImprovementAdapterResponse {
  schemaVersion: 1;
  responseType: "skillpress.improve-adapter-response";
  requestId: Digest;
  operation: "author" | "review" | "evaluate-training" | "evaluate-holdout";
  result: Proposal | Review | Evaluation;
}
/**
 * This interface was referenced by `SkillPressImprovementAdapterResponse`'s JSON-Schema
 * via the `definition` "proposal".
 */
export interface Proposal {
  baseCandidateSha256: Digest;
  /**
   * @minItems 2
   * @maxItems 64
   */
  files: [CandidateFile, CandidateFile, ...CandidateFile[]];
  rationale: string;
  tokensUsed: number;
  costUsd: number;
}
/**
 * This interface was referenced by `SkillPressImprovementAdapterResponse`'s JSON-Schema
 * via the `definition` "candidateFile".
 */
export interface CandidateFile {
  path: string;
  content: string;
  executable?: boolean;
}
/**
 * This interface was referenced by `SkillPressImprovementAdapterResponse`'s JSON-Schema
 * via the `definition` "review".
 */
export interface Review {
  approved: boolean;
  /**
   * @maxItems 128
   */
  issueCodes: string[];
}
/**
 * This interface was referenced by `SkillPressImprovementAdapterResponse`'s JSON-Schema
 * via the `definition` "evaluation".
 */
export interface Evaluation {
  candidateSha256: Digest;
  scenarioSetSha256: Digest;
  evidence: SkillPressPairedEvaluationEvidence;
}
/**
 * Redacted local evidence from paired baseline and with-skill sandbox runs.
 */
export interface SkillPressPairedEvaluationEvidence {
  schemaVersion: 1;
  evidenceType: "skillpress.paired-eval";
  /**
   * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
   * via the `definition` "digest".
   */
  runId: string;
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
    /**
     * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
     * via the `definition` "digest".
     */
    commandSha256: string;
  };
  /**
   * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
   * via the `definition` "digest".
   */
  skillSha256: string;
  /**
   * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
   * via the `definition` "digest".
   */
  configSha256: string;
  repetitions: number;
  /**
   * @minItems 1
   * @maxItems 128
   */
  scenarioResults: [ScenarioEvidence, ...ScenarioEvidence[]];
  summary: {
    /**
     * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
     * via the `definition` "rate".
     */
    baselineSuccessRate: number;
    /**
     * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
     * via the `definition` "rate".
     */
    withSkillSuccessRate: number;
    impactDelta: number;
    /**
     * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
     * via the `definition` "rate".
     */
    minimumSuccessRate: number;
    /**
     * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
     * via the `definition` "rate".
     */
    minimumImpactDelta: number;
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
  /**
   * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
   * via the `definition` "digest".
   */
  runId: string;
  status: "passed" | "failed" | "timed_out" | "output_limit" | "spawn_error" | "invalid_result";
  activated: boolean | null;
  loadedSkillSha256: string | null;
  rubricScore: number | null;
  successful: boolean;
  /**
   * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
   * via the `definition` "digest".
   */
  inputSha256: string;
  transcript: TranscriptEvidence;
  /**
   * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
   * via the `definition` "digest".
   */
  engineStdoutSha256: string;
  /**
   * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
   * via the `definition` "digest".
   */
  engineStderrSha256: string;
}
/**
 * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
 * via the `definition` "transcriptEvidence".
 */
export interface TranscriptEvidence {
  bytes: number;
  /**
   * This interface was referenced by `SkillPressPairedEvaluationEvidence`'s JSON-Schema
   * via the `definition` "digest".
   */
  sha256: string;
  redactedExcerpt: string;
}
