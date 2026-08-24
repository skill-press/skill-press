/* Generated from schemas/skillpress.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressProject`'s JSON-Schema
 * via the `definition` "skillName".
 */
export type SkillName = string;
/**
 * This interface was referenced by `SkillPressProject`'s JSON-Schema
 * via the `definition` "semver".
 */
export type Semver = string;
/**
 * This interface was referenced by `SkillPressProject`'s JSON-Schema
 * via the `definition` "relativePath".
 */
export type RelativePath = string;

/**
 * The versioned project contract for a SkillPress-managed Agent Skill.
 */
export interface SkillPressProject {
  /**
   * The SkillPress configuration schema version.
   */
  schemaVersion: 1;
  project: Project;
  skill: Skill;
  quality: Quality;
  tests: Tests;
  evaluation: Evaluation;
  improve: Improve;
  publish: Publish;
}
/**
 * This interface was referenced by `SkillPressProject`'s JSON-Schema
 * via the `definition` "project".
 */
export interface Project {
  name: SkillName;
  version: Semver;
  description: string;
  license: string;
  repository: string;
  author: {
    name: string;
    github: string;
  };
}
/**
 * This interface was referenced by `SkillPressProject`'s JSON-Schema
 * via the `definition` "skill".
 */
export interface Skill {
  name: SkillName;
  path: RelativePath;
  risk: "low" | "moderate" | "high";
}
/**
 * This interface was referenced by `SkillPressProject`'s JSON-Schema
 * via the `definition` "quality".
 */
export interface Quality {
  readinessMinimum: number;
  tesslQualityMinimum: number;
  tesslImpactMinimum: number;
  evidenceMaxAgeHours: number;
}
/**
 * This interface was referenced by `SkillPressProject`'s JSON-Schema
 * via the `definition` "tests".
 */
export interface Tests {
  /**
   * @minItems 1
   * @maxItems 32
   */
  commands: [
    {
      name: string;
      /**
       * @minItems 1
       * @maxItems 32
       */
      argv: [string, ...string[]];
      cwd?: RelativePath;
      timeoutSeconds: number;
    },
    ...{
      name: string;
      /**
       * @minItems 1
       * @maxItems 32
       */
      argv: [string, ...string[]];
      cwd?: RelativePath;
      timeoutSeconds: number;
    }[],
  ];
}
/**
 * This interface was referenced by `SkillPressProject`'s JSON-Schema
 * via the `definition` "evaluation".
 */
export interface Evaluation {
  repetitions: number;
  minimumSuccessRate: number;
  minimumImpactDelta: number;
  sandbox: "docker" | "podman";
  network: "none" | "restricted";
}
/**
 * This interface was referenced by `SkillPressProject`'s JSON-Schema
 * via the `definition` "improve".
 */
export interface Improve {
  maxIterations: number;
  maxNoImprovement: number;
  maxTokens: number;
  maxCostUsd: number;
  maxWallMinutes: number;
}
/**
 * This interface was referenced by `SkillPressProject`'s JSON-Schema
 * via the `definition` "publish".
 */
export interface Publish {
  /**
   * @minItems 1
   */
  targets: [
    (
      | "github"
      | "npm"
      | "tessl"
      | "skills-sh"
      | "askill-sh"
      | "agentskillhub-dev"
      | "agent-skills-hub-catalog"
      | "clawhub"
    ),
    ...(
      | "github"
      | "npm"
      | "tessl"
      | "skills-sh"
      | "askill-sh"
      | "agentskillhub-dev"
      | "agent-skills-hub-catalog"
      | "clawhub"
    )[],
  ];
}
