import { isReviewedTextEnvelope } from "../eval/reviewed-text-schema.js";
import type { ImprovementEvidencePaths } from "../improve/project-input.js";
import { loadReviewedTextEvaluation } from "./reviewed-text-check.js";

/**
 * Prepare deterministic, bounded wire evidence without inference or network I/O.
 * Quality failures remain in the report; this never enables release submission.
 */
export async function prepareReviewedTextEvidence(
  projectDirectory: string,
  paths: ImprovementEvidencePaths,
  now: Date = new Date(),
) {
  const { prepared, training, holdout, report } = await loadReviewedTextEvaluation(
    projectDirectory,
    paths,
    now,
  );
  const encode = (measurement: unknown) => {
    const envelope = {
      schemaVersion: 1,
      evidenceType: "skillpress.reviewed-text-evidence",
      advisory: true,
      inputs: prepared.inputs,
      measurement,
    };
    if (!isReviewedTextEnvelope(envelope))
      throw new Error("Reviewed text evidence does not match the versioned upload contract.");
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
    if (bytes.byteLength > 1024 * 1024)
      throw new Error("Reviewed text evidence exceeds the upload limit.");
    return bytes;
  };
  return { report, reviewBytes: encode(training), evaluationBytes: encode(holdout) };
}
