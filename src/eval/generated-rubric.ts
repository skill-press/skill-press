/* Generated from schemas/eval-rubric.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressEvaluationRubric`'s JSON-Schema
 * via the `definition` "portableName".
 */
export type PortableName = string;

/**
 * A versioned, weighted rubric for paired behavioral evaluation.
 */
export interface SkillPressEvaluationRubric {
  schemaVersion: 1;
  name: PortableName;
  /**
   * @minItems 1
   * @maxItems 32
   */
  criteria: [Criterion, ...Criterion[]];
}
/**
 * This interface was referenced by `SkillPressEvaluationRubric`'s JSON-Schema
 * via the `definition` "criterion".
 */
export interface Criterion {
  id: PortableName;
  description: string;
  weight: number;
  evaluator: "deterministic" | "judge";
}
