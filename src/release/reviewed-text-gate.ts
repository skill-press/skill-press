import { prepareReviewedTextEvidence } from "./reviewed-text-evidence.js";
import { TesslReleaseGateError, type TesslReleaseGateOptions } from "./tessl-gate.js";

/** Local submission admission only; never authorizes publication or runs inference. */
export async function prepareReviewedTextRelease(
  projectDirectory: string,
  options: TesslReleaseGateOptions,
) {
  if (options.evalSource !== "evals")
    throw new TesslReleaseGateError("Reviewed text requires the canonical evals directory.", [
      { code: "text.source.path", path: "/evidence", message: "Use evals as evaluation source." },
    ]);
  let evidence: Awaited<ReturnType<typeof prepareReviewedTextEvidence>>;
  try {
    evidence = await prepareReviewedTextEvidence(
      projectDirectory,
      {
        trainingEvidencePath: options.reviewEvidencePath,
        holdoutEvidencePath: options.evalEvidencePath,
      },
      (options.now ?? (() => new Date()))(),
    );
  } catch {
    // Do not expose raw source/evidence/provider details through the CLI error channel.
    throw new TesslReleaseGateError("Reviewed text release inputs could not be verified.", [
      {
        code: "text.evidence.invalid",
        path: "/evidence",
        message: "Check private receipt paths, current source, archive and evidence validity.",
      },
    ]);
  }
  const report = {
    schemaVersion: 1 as const,
    gateType: "skillpress.reviewed-text-release" as const,
    sourceCommit: evidence.source.commit,
    passed: evidence.report.passed,
    advisory: true as const,
    releaseAuthorized: false as const,
    independentVerificationRequired: true as const,
    assessment: evidence.report,
    issues: evidence.report.issues.map((code) => ({
      code,
      path: "/evidence",
      message: "Reviewed text measurement policy failed.",
    })),
  };
  return { ...evidence, report };
}

export type ReviewedTextReleaseGateReport = Awaited<
  ReturnType<typeof prepareReviewedTextRelease>
>["report"];

export async function checkReviewedTextReleaseGate(
  projectDirectory: string,
  options: TesslReleaseGateOptions,
): Promise<ReviewedTextReleaseGateReport> {
  return (await prepareReviewedTextRelease(projectDirectory, options)).report;
}
