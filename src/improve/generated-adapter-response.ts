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
  scenarioSetSha256: Digest;
  metrics: Metrics;
}
/**
 * This interface was referenced by `SkillPressImprovementAdapterResponse`'s JSON-Schema
 * via the `definition` "metrics".
 */
export interface Metrics {
  successRate: number;
  activationPrecision: number;
  safetyRate: number;
}
