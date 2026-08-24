/* Generated from schemas/eval-agent-result.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressAgentResult`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;

/**
 * The strict result protocol emitted by a pinned sandbox evaluation adapter.
 */
export interface SkillPressAgentResult {
  schemaVersion: 1;
  runId: Digest;
  variant: "baseline" | "with-skill";
  model: string;
  inputSha256: Digest;
  activated: boolean;
  loadedSkillSha256: Digest | null;
  transcript: string;
  /**
   * @maxItems 32
   */
  criteria: CriterionResult[];
}
/**
 * This interface was referenced by `SkillPressAgentResult`'s JSON-Schema
 * via the `definition` "criterionResult".
 */
export interface CriterionResult {
  id: string;
  score: number;
  rationale: string;
}
