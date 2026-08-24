import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadProjectConfig } from "../config/load.js";
import { isSafePathInput } from "../path-safety.js";
import { validateAgentSkill } from "../validate/agent-skill.js";
import type { AgentSkillDiagnostic } from "../validate/types.js";
import type { ProjectCheckDiagnostic, ReadinessCriterion, SkillPressCheckReport } from "./types.js";

interface CriterionInput {
  readonly id: ReadinessCriterion["id"];
  readonly label: string;
  readonly weight: number;
  readonly passed: boolean;
}

function diagnostic(code: string, path: string, message: string): ProjectCheckDiagnostic {
  return Object.freeze({ code, severity: "error", scope: "skillpress", path, message });
}

function mapSkillDiagnostic(
  skillPath: string,
  entry: AgentSkillDiagnostic,
): ProjectCheckDiagnostic {
  return Object.freeze({
    code: entry.code,
    severity: entry.severity,
    scope: entry.scope,
    path: `${skillPath}/${entry.file}`,
    message: entry.message,
    ...(entry.line === undefined ? {} : { line: entry.line }),
    ...(entry.column === undefined ? {} : { column: entry.column }),
  });
}

async function isRegularProjectFile(root: string, relativePath: string): Promise<boolean> {
  let current = root;
  const segments = relativePath.split("/");
  try {
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index] as string);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) return false;
      if (index === segments.length - 1) return metadata.isFile();
      if (!metadata.isDirectory()) return false;
    }
  } catch {
    return false;
  }
  return false;
}

function criterion(input: CriterionInput): ReadinessCriterion {
  return Object.freeze({
    ...input,
    earned: input.passed ? input.weight : 0,
  });
}

function finish(
  project: SkillPressCheckReport["project"],
  minimum: number,
  criterionInputs: readonly CriterionInput[],
  diagnostics: readonly ProjectCheckDiagnostic[],
): SkillPressCheckReport {
  const criteria = Object.freeze(criterionInputs.map(criterion));
  const score = criteria.reduce((total, entry) => total + entry.earned, 0);
  const frozenDiagnostics = Object.freeze([...diagnostics]);
  const eligible = frozenDiagnostics.every((entry) => entry.severity !== "error");
  return Object.freeze({
    schemaVersion: 1 as const,
    ok: eligible && score >= minimum,
    eligible,
    score,
    minimum,
    project: Object.freeze(project),
    criteria,
    diagnostics: frozenDiagnostics,
  });
}

/**
 * Run deterministic local readiness checks without executing project commands or fetching URLs.
 */
export async function checkProject(
  projectDirectory: string = process.cwd(),
): Promise<SkillPressCheckReport> {
  if (!isSafePathInput(projectDirectory)) {
    throw new TypeError("projectDirectory must be a bounded, unambiguous filesystem path.");
  }
  const root = resolve(projectDirectory);
  const config = await loadProjectConfig(root);
  const skillReport = await validateAgentSkill(join(root, config.skill.path), {
    expectedName: config.skill.name,
  });
  const diagnostics = skillReport.diagnostics.map((entry) =>
    mapSkillDiagnostic(config.skill.path, entry),
  );

  const identityPassed = config.project.name === config.skill.name;
  if (!identityPassed) {
    diagnostics.push(
      diagnostic(
        "project.skill_name_mismatch",
        "/skill/name",
        "project and canonical skill names must match",
      ),
    );
  }

  const licensePaths = ["LICENSE", `${config.skill.path}/LICENSE`] as const;
  const licenseStates = await Promise.all(
    licensePaths.map((path) => isRegularProjectFile(root, path)),
  );
  const licensesPassed = licenseStates.every(Boolean);
  for (let index = 0; index < licensePaths.length; index += 1) {
    if (!licenseStates[index]) {
      diagnostics.push(
        diagnostic(
          "project.license_missing",
          licensePaths[index] as string,
          "release licenses must be regular files and may not use symbolic links",
        ),
      );
    }
  }

  const scenarioPaths = ["evals/training.yaml", "evals/holdout.yaml"] as const;
  const scenarioStates = await Promise.all(
    scenarioPaths.map((path) => isRegularProjectFile(root, path)),
  );
  const scenariosPassed = scenarioStates.every(Boolean);
  for (let index = 0; index < scenarioPaths.length; index += 1) {
    if (!scenarioStates[index]) {
      diagnostics.push(
        diagnostic(
          "project.scenarios_missing",
          scenarioPaths[index] as string,
          "training and holdout scenario files must be regular files",
        ),
      );
    }
  }

  const testsPassed = config.tests.commands.length > 0;
  if (!testsPassed) {
    diagnostics.push(
      diagnostic(
        "project.tests_missing",
        "/tests/commands",
        "at least one deterministic project test command is required",
      ),
    );
  }

  return finish(
    {
      name: config.project.name,
      version: config.project.version,
      skillPath: config.skill.path,
    },
    config.quality.readinessMinimum,
    [
      {
        id: "canonical-skill",
        label: "Canonical Agent Skill validation",
        weight: 60,
        passed: skillReport.ok,
      },
      {
        id: "project-identity",
        label: "Project and skill identity",
        weight: 10,
        passed: identityPassed,
      },
      {
        id: "licenses",
        label: "Project and canonical skill licenses",
        weight: 10,
        passed: licensesPassed,
      },
      {
        id: "scenarios",
        label: "Training and holdout scenario inputs",
        weight: 10,
        passed: scenariosPassed,
      },
      {
        id: "tests",
        label: "Deterministic project test plan",
        weight: 10,
        passed: testsPassed,
      },
    ],
    diagnostics,
  );
}
