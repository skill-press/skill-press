import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { checkProject } from "../check/project.js";
import {
  prepareReviewedTextProject,
  verifyReviewedTextProject,
} from "../eval/reviewed-text-project.js";
import {
  loadPrivateEvaluationJson,
  type ImprovementEvidencePaths,
} from "../improve/project-input.js";
import { NATIVE_REVIEW_POLICY } from "./native-policy.js";
import { assessReviewedTextMeasurement } from "./reviewed-text-measurement.js";

function runId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).runId;
  return typeof id === "string" && /^[a-f0-9]{64}$/u.test(id) ? id : null;
}

/** Local advisory check. Rebuilds a private package; never invokes inference or project commands. */
export async function checkReviewedTextEvaluation(
  projectDirectory: string,
  paths: ImprovementEvidencePaths,
  now: Date = new Date(),
) {
  const root = await realpath(resolve(projectDirectory));
  const prepared = await prepareReviewedTextProject(root);
  const [readiness, training, holdout] = await Promise.all([
    checkProject(root),
    loadPrivateEvaluationJson(root, paths.trainingEvidencePath, "training"),
    loadPrivateEvaluationJson(root, paths.holdoutEvidencePath, "holdout"),
  ]);
  const trainingAssessment = assessReviewedTextMeasurement(training, prepared, "training", now);
  const holdoutAssessment = assessReviewedTextMeasurement(holdout, prepared, "holdout", now);
  const issues = [
    ...trainingAssessment.issues.map((issue) => `training:${issue}`),
    ...holdoutAssessment.issues.map((issue) => `holdout:${issue}`),
  ];
  if (!readiness.ok) issues.push("text.readiness.failed");
  const trainingId = runId(training);
  const holdoutId = runId(holdout);
  if (
    trainingId === null ||
    paths.trainingEvidencePath !== `.skill-press/runs/${trainingId}/evidence.json`
  )
    issues.push("training:text.storage.binding");
  if (
    holdoutId === null ||
    paths.holdoutEvidencePath !== `.skill-press/runs/${holdoutId}/evidence.json`
  )
    issues.push("holdout:text.storage.binding");
  if (trainingId !== null && trainingId === holdoutId) issues.push("text.pair.run_reuse");
  // Both assessments enforce the same fixed model, effort, authentication and
  // protocol. Pair IDs derive from disjoint suite run IDs, so cannot overlap.
  await verifyReviewedTextProject(root, prepared);
  return Object.freeze({
    schemaVersion: 1 as const,
    reportType: "skillpress.reviewed-text-evaluation-check" as const,
    policy: NATIVE_REVIEW_POLICY,
    passed: issues.length === 0,
    advisory: true as const,
    independentVerificationRequired: true as const,
    releaseAuthorized: false as const,
    releaseEligible: false as const,
    admissionIssues: ["text_profile_not_admitted"],
    readiness,
    training: trainingAssessment,
    holdout: holdoutAssessment,
    issues,
  });
}
