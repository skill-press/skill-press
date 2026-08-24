/* Generated from schemas/eval-suite.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressEvaluationSuite`'s JSON-Schema
 * via the `definition` "portableName".
 */
export type PortableName = string;
/**
 * @minItems 1
 * @maxItems 16
 *
 * This interface was referenced by `SkillPressEvaluationSuite`'s JSON-Schema
 * via the `definition` "behaviorList".
 */
export type BehaviorList = [string, ...string[]];

/**
 * A versioned collection of behavioral evaluation scenarios.
 */
export interface SkillPressEvaluationSuite {
  schemaVersion: 1;
  suite: "training" | "holdout";
  skill: PortableName;
  /**
   * @minItems 1
   * @maxItems 128
   */
  scenarios: [Scenario, ...Scenario[]];
}
/**
 * This interface was referenced by `SkillPressEvaluationSuite`'s JSON-Schema
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
     * @maxItems 32
     */
    files?: {
      path: string;
      content: string;
    }[];
    environment?: {
      [k: string]: string;
    };
  };
}
