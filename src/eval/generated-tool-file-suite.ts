/* Generated from schemas/tool-file-suite.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressToolFileSuite`'s JSON-Schema
 * via the `definition` "portableName".
 */
export type PortableName = string;
/**
 * @minItems 1
 * @maxItems 16
 *
 * This interface was referenced by `SkillPressToolFileSuite`'s JSON-Schema
 * via the `definition` "behaviorList".
 */
export type BehaviorList = [string, ...string[]];

/**
 * Preview-only v2 source-bound tool fixtures. Not admitted for model evaluation.
 */
export interface SkillPressToolFileSuite {
  schemaVersion: 2;
  suite: "training" | "holdout";
  skill: PortableName;
  /**
   * @minItems 1
   * @maxItems 128
   */
  scenarios: [Scenario, ...Scenario[]];
}
/**
 * This interface was referenced by `SkillPressToolFileSuite`'s JSON-Schema
 * via the `definition` "scenario".
 */
export interface Scenario {
  id: PortableName;
  category: "positive" | "near-miss" | "failure" | "adversarial";
  shouldActivate: boolean;
  prompt: string;
  expectedBehavior: BehaviorList;
  forbiddenBehavior?: BehaviorList;
  fixture?: {
    /**
     * @maxItems 16
     */
    files?: {
      path: string;
      source: string;
      bytes: number;
      sha256: string;
    }[];
  };
}
