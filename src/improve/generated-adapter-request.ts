/* Generated from schemas/improve-adapter-request.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressImprovementAdapterRequest`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;

/**
 * Private request passed to one external SkillPress improvement role adapter.
 */
export interface SkillPressImprovementAdapterRequest {
  schemaVersion: 1;
  requestType: "skillpress.improve-adapter-request";
  requestId: Digest;
  operation: "author" | "review" | "evaluate-training" | "evaluate-holdout";
  /**
   * Operation-specific context. Author payloads contain training context only; holdout suites are sent only to evaluate-holdout.
   */
  payload: {
    [k: string]: unknown;
  };
}
