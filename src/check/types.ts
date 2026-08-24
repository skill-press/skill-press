import type { AgentSkillDiagnosticScope, AgentSkillDiagnosticSeverity } from "../validate/types.js";

export interface ProjectCheckDiagnostic {
  readonly code: string;
  readonly severity: AgentSkillDiagnosticSeverity;
  readonly scope: AgentSkillDiagnosticScope;
  readonly path: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export interface ReadinessCriterion {
  readonly id: "canonical-skill" | "project-identity" | "licenses" | "scenarios" | "tests";
  readonly label: string;
  readonly weight: number;
  readonly earned: number;
  readonly passed: boolean;
}

export interface SkillPressCheckReport {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly eligible: boolean;
  readonly score: number;
  readonly minimum: number;
  readonly project: {
    readonly name: string;
    readonly version: string;
    readonly skillPath: string;
  };
  readonly criteria: readonly ReadinessCriterion[];
  readonly diagnostics: readonly ProjectCheckDiagnostic[];
}
