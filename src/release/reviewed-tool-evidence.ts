import { isReviewedToolEnvelope } from "../eval/reviewed-tool-schema.js";
import { assessReviewedToolMeasurement } from "./reviewed-tool-measurement.js";

/** Encode already size-bounded parsed receipts against trusted prepared inputs.
 * Caller owns source/artifact entry/exit verification. No inference, file/network
 * I/O or admission authority; quality failures are retained, not thrown away.
 */
export function encodeReviewedToolEvidence(
  prepared: Parameters<typeof assessReviewedToolMeasurement>[1],
  training: unknown,
  holdout: unknown,
  now = new Date(),
) {
  const assessments = {
    training: assessReviewedToolMeasurement(training, prepared, "training", now),
    holdout: assessReviewedToolMeasurement(holdout, prepared, "holdout", now),
  };
  const encode = (measurement: unknown) => {
    const envelope = {
      schemaVersion: 1,
      evidenceType: "skillpress.reviewed-tool-evidence",
      advisory: true,
      inputs: prepared.inputs,
      measurement,
    };
    if (!isReviewedToolEnvelope(envelope))
      throw new Error("Reviewed tool evidence does not match the upload contract.");
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
    if (bytes.length > 1024 * 1024)
      throw new Error("Reviewed tool evidence exceeds the upload limit.");
    return bytes;
  };
  const reviewBytes = encode(training);
  const evaluationBytes = encode(holdout);
  const issues = [
    ...assessments.training.issues.map((issue) => `training:${issue}`),
    ...assessments.holdout.issues.map((issue) => `holdout:${issue}`),
  ];
  // Shape checks above establish both IDs. Run separation is still required even
  // when individual suites have independently consistent derived pair IDs.
  if ((training as { runId: string }).runId === (holdout as { runId: string }).runId)
    issues.push("tool.pair.run_reuse");
  return {
    reviewBytes,
    evaluationBytes,
    report: Object.freeze({
      ...assessments,
      issues: Object.freeze(issues),
      passed: issues.length === 0,
      advisory: true as const,
      independentVerificationRequired: true as const,
      releaseAuthorized: false as const,
    }),
  };
}
