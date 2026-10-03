import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { checkProject } from "../check/project.js";
import {
  prepareReviewedToolProject,
  verifyReviewedToolProject,
} from "../eval/reviewed-tool-project.js";
import {
  loadPrivateEvaluationJson,
  type ImprovementEvidencePaths,
} from "../improve/project-input.js";
import { NATIVE_REVIEW_POLICY } from "./native-policy.js";
import {
  assessReviewedToolMeasurement,
  reviewedToolMeasurementActorKind,
} from "./reviewed-tool-measurement.js";

function runId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).runId;
  return typeof id === "string" && /^[a-f0-9]{64}$/u.test(id) ? id : null;
}

/** Local advisory check. Rebuilds a private package; never invokes inference or project commands. */
export async function loadReviewedToolEvaluation(
  projectDirectory: string,
  paths: ImprovementEvidencePaths,
  image: string,
  now: Date = new Date(),
) {
  const root = await realpath(resolve(projectDirectory));
  const prepared = await prepareReviewedToolProject(root, image);
  const [readiness, training, holdout] = await Promise.all([
    checkProject(root),
    loadPrivateEvaluationJson(root, paths.trainingEvidencePath, "training"),
    loadPrivateEvaluationJson(root, paths.holdoutEvidencePath, "holdout"),
  ]);
  const trainingAssessment = assessReviewedToolMeasurement(training, prepared, "training", now);
  const holdoutAssessment = assessReviewedToolMeasurement(holdout, prepared, "holdout", now);
  const issues = [
    ...trainingAssessment.issues.map((issue) => `training:${issue}`),
    ...holdoutAssessment.issues.map((issue) => `holdout:${issue}`),
  ];
  if (!readiness.ok) issues.push("tool.readiness.failed");
  const trainingId = runId(training);
  const holdoutId = runId(holdout);
  if (
    trainingId === null ||
    paths.trainingEvidencePath !== `.skill-press/runs/${trainingId}/evidence.json`
  )
    issues.push("training:tool.storage.binding");
  if (
    holdoutId === null ||
    paths.holdoutEvidencePath !== `.skill-press/runs/${holdoutId}/evidence.json`
  )
    issues.push("holdout:tool.storage.binding");
  if (trainingId !== null && trainingId === holdoutId) issues.push("tool.pair.run_reuse");
  if (reviewedToolMeasurementActorKind(training) !== reviewedToolMeasurementActorKind(holdout))
    issues.push("tool.pair.protocol_mismatch");
  // Each assessment enforces a single actor/judge version across all records;
  // both suites must also match. Fixed model/effort/authentication remain unchanged.
  await verifyReviewedToolProject(root, prepared);
  const report = Object.freeze({
    schemaVersion: 1 as const,
    reportType: "skillpress.reviewed-tool-evaluation-check" as const,
    policy: NATIVE_REVIEW_POLICY,
    passed: issues.length === 0,
    advisory: true as const,
    independentVerificationRequired: true as const,
    releaseAuthorized: false as const,
    releaseEligible: false as const,
    admissionIssues: ["release_gate_required"],
    readiness,
    training: trainingAssessment,
    holdout: holdoutAssessment,
    issues,
  });
  return { prepared, training, holdout, report };
}

export async function checkReviewedToolEvaluation(
  projectDirectory: string,
  paths: ImprovementEvidencePaths,
  image: string,
  now: Date = new Date(),
) {
  return (await loadReviewedToolEvaluation(projectDirectory, paths, image, now)).report;
}
