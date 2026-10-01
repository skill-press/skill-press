import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { checkProject } from "../check/project.js";
import { loadProjectConfig } from "../config/load.js";
import { digestBoundedTree } from "../evidence/tree-digest.js";
import { loadProjectEvaluationInputs } from "../eval/load.js";
import {
  loadPairedEvaluationEvidence,
  type ImprovementEvidencePaths,
} from "../improve/project-input.js";
import { assessNativeMeasurement } from "./native-measurement.js";
import { NATIVE_REVIEW_POLICY } from "./native-policy.js";

/** Local native assessment only: does not authorize package, submission or publication. */
export async function loadNativeEvaluation(
  projectDirectory: string,
  paths: ImprovementEvidencePaths,
  now: Date = new Date(),
) {
  const root = await realpath(resolve(projectDirectory));
  const config = await loadProjectConfig(root);
  const inputs = await loadProjectEvaluationInputs(root);
  const [readiness, skillSha256, training, holdout] = await Promise.all([
    checkProject(root),
    digestBoundedTree(join(root, config.skill.path)),
    loadPairedEvaluationEvidence(root, paths.trainingEvidencePath, "training"),
    loadPairedEvaluationEvidence(root, paths.holdoutEvidencePath, "holdout"),
  ]);
  const trainingAssessment = assessNativeMeasurement(
    training,
    config,
    inputs,
    "training",
    skillSha256,
    now,
  );
  const holdoutAssessment = assessNativeMeasurement(
    holdout,
    config,
    inputs,
    "holdout",
    skillSha256,
    now,
  );
  const issues = [
    ...trainingAssessment.issues.map((code) => `training:${code}`),
    ...holdoutAssessment.issues.map((code) => `holdout:${code}`),
  ];
  if (!readiness.ok) issues.push("native.readiness.failed");
  if (
    training.model !== holdout.model ||
    training.adapter.backend !== holdout.adapter.backend ||
    training.adapter.image !== holdout.adapter.image ||
    training.adapter.commandSha256 !== holdout.adapter.commandSha256
  )
    issues.push("native.pair.adapter_mismatch");
  const trainingRunIds = new Set(
    training.scenarioResults.flatMap((scenario) =>
      scenario.runs.flatMap((run) => [run.baseline.runId, run.withSkill.runId]),
    ),
  );
  if (
    training.runId === holdout.runId ||
    holdout.scenarioResults.some((scenario) =>
      scenario.runs.some(
        (run) => trainingRunIds.has(run.baseline.runId) || trainingRunIds.has(run.withSkill.runId),
      ),
    )
  )
    issues.push("native.pair.run_reuse");
  const report = {
    schemaVersion: 1 as const,
    reportType: "skillpress.native-evaluation-check" as const,
    policy: NATIVE_REVIEW_POLICY,
    passed: issues.length === 0,
    advisory: true as const,
    independentVerificationRequired: true as const,
    releaseAuthorized: false as const,
    readiness,
    training: trainingAssessment,
    holdout: holdoutAssessment,
    issues,
  };
  return { report, config, inputs, training, holdout };
}

export async function checkNativeEvaluation(
  projectDirectory: string,
  paths: ImprovementEvidencePaths,
  now: Date = new Date(),
) {
  return (await loadNativeEvaluation(projectDirectory, paths, now)).report;
}
