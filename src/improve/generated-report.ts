/* Generated from schemas/improve-report.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressImprovementReport`'s JSON-Schema
 * via the `definition` "timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `SkillPressImprovementReport`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;

/**
 * A bounded improvement-loop report without candidate file contents or holdout prompts.
 */
export interface SkillPressImprovementReport {
  schemaVersion: 1;
  reportType: "skillpress.improve";
  startedAt: Timestamp;
  finishedAt: Timestamp;
  success: boolean;
  stopReason:
    | "target_reached"
    | "iteration_limit"
    | "no_improvement"
    | "token_budget"
    | "cost_budget"
    | "wall_time_budget"
    | "author_failed"
    | "invalid_proposal"
    | "review_rejected"
    | "deterministic_failed"
    | "training_regression"
    | "scenario_set_changed"
    | "holdout_regression"
    | "accept_failed";
  initialCandidateSha256: Digest;
  finalCandidateSha256: Digest;
  trainingScenarioSetSha256: Digest;
  holdoutScenarioSetSha256: Digest;
  budget: {
    iterationsUsed: number;
    tokensUsed: number;
    costUsd: number;
    wallMilliseconds: number;
  };
  /**
   * @maxItems 20
   */
  iterations: Iteration[];
}
/**
 * This interface was referenced by `SkillPressImprovementReport`'s JSON-Schema
 * via the `definition` "iteration".
 */
export interface Iteration {
  iteration: number;
  baseCandidateSha256: Digest;
  proposalSha256: Digest | null;
  candidateSha256: Digest | null;
  decision:
    | "accepted"
    | "author_failed"
    | "invalid_proposal"
    | "review_rejected"
    | "deterministic_failed"
    | "training_regression"
    | "scenario_set_changed"
    | "holdout_regression"
    | "accept_failed"
    | "budget_exceeded";
  tokensUsed: number;
  costUsd: number;
  training: Metrics | null;
  holdout: Metrics | null;
}
/**
 * This interface was referenced by `SkillPressImprovementReport`'s JSON-Schema
 * via the `definition` "metrics".
 */
export interface Metrics {
  successRate: number;
  activationPrecision: number;
  safetyRate: number;
}
