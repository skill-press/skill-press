/* Generated from schemas/capability-brief.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "name".
 */
export type Name = string;
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "shortLine".
 */
export type ShortLine = string;
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "semver".
 */
export type Semver = string;
/**
 * @minItems 1
 * @maxItems 32
 *
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "lineList".
 */
export type LineList = [Line, ...Line[]];
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "line".
 */
export type Line = string;
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "identifier".
 */
export type Identifier = string;
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "scenarioText".
 */
export type ScenarioText = string;
/**
 * @maxItems 64
 *
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "scenarioList".
 */
export type ScenarioList = ScenarioCase[];

/**
 * A complete, testable capability brief from which Skill Press renders one canonical Agent Skill.
 */
export interface SkillPressCapabilityBrief {
  schemaVersion: 2;
  name: Name;
  title: ShortLine;
  /**
   * Project version used when rendering skill-press.yaml; defaults to 0.1.0 without mutating the input document.
   */
  version?: Semver;
  summary: string;
  /**
   * The canonical Skill Press registry namespace requested by the generated project.
   */
  namespace: string;
  repository: string;
  author: Author;
  license: License;
  risk: "low" | "moderate" | "high";
  execution: Execution;
  capability: Capability;
  tests: Tests;
  scenarios: Scenarios;
}
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "author".
 */
export interface Author {
  name: string;
  github: string;
}
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "license".
 */
export interface License {
  id: string;
  text: string;
}
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "execution".
 */
export interface Execution {
  sandbox: "docker" | "podman";
  network: "none" | "restricted";
}
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "capability".
 */
export interface Capability {
  outcome: string;
  useWhen: LineList;
  doNotUseWhen: LineList;
  /**
   * @minItems 1
   * @maxItems 32
   */
  inputs: [NamedInput, ...NamedInput[]];
  /**
   * @minItems 1
   * @maxItems 32
   */
  outputs: [NamedOutput, ...NamedOutput[]];
  /**
   * @minItems 2
   * @maxItems 32
   */
  workflow: [WorkflowStep, WorkflowStep, ...WorkflowStep[]];
  constraints: LineList;
  stopConditions: LineList;
}
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "namedInput".
 */
export interface NamedInput {
  name: Identifier;
  required: boolean;
  description: Line;
}
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "namedOutput".
 */
export interface NamedOutput {
  name: Identifier;
  description: Line;
}
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "workflowStep".
 */
export interface WorkflowStep {
  action: Line;
  verification: Line;
}
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "tests".
 */
export interface Tests {
  /**
   * @minItems 1
   * @maxItems 32
   */
  commands: [TestCommand, ...TestCommand[]];
}
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "testCommand".
 */
export interface TestCommand {
  name: string;
  /**
   * @minItems 1
   * @maxItems 32
   */
  argv: [string, ...string[]];
  cwd?: string;
  timeoutSeconds: number;
}
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "scenarios".
 */
export interface Scenarios {
  training: TrainingScenarios;
  holdout: HoldoutScenarios;
}
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "trainingScenarios".
 */
export interface TrainingScenarios {
  /**
   * @minItems 2
   * @maxItems 64
   */
  positive: [ScenarioCase, ScenarioCase, ...ScenarioCase[]];
  /**
   * @minItems 2
   * @maxItems 64
   */
  nearMiss: [ScenarioCase, ScenarioCase, ...ScenarioCase[]];
  /**
   * @minItems 1
   * @maxItems 64
   */
  failure: [ScenarioCase, ...ScenarioCase[]];
  /**
   * @minItems 1
   * @maxItems 64
   */
  adversarial: [ScenarioCase, ...ScenarioCase[]];
}
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "scenarioCase".
 */
export interface ScenarioCase {
  id: Identifier;
  prompt: ScenarioText;
  /**
   * @minItems 1
   * @maxItems 20
   */
  expectedBehavior: [Line, ...Line[]];
  /**
   * @minItems 1
   * @maxItems 20
   */
  forbiddenBehavior?: [Line, ...Line[]];
}
/**
 * This interface was referenced by `SkillPressCapabilityBrief`'s JSON-Schema
 * via the `definition` "holdoutScenarios".
 */
export interface HoldoutScenarios {
  /**
   * @minItems 1
   * @maxItems 64
   */
  positive: [ScenarioCase, ...ScenarioCase[]];
  /**
   * @minItems 1
   * @maxItems 64
   */
  nearMiss: [ScenarioCase, ...ScenarioCase[]];
}
