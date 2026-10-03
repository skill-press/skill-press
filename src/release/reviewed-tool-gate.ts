import { TOOL_REVIEW_POLICY } from "./tool-policy.js";
import { prepareReviewedToolEvidence } from "./reviewed-tool-evidence.js";
import { TesslReleaseGateError, type TesslReleaseGateOptions } from "./tessl-gate.js";

/** Local submission admission only; never authorizes publication or runs inference. */
export async function prepareReviewedToolRelease(
  projectDirectory: string,
  options: TesslReleaseGateOptions,
) {
  if (options.evalSource !== "evals")
    throw new TesslReleaseGateError("Reviewed tool requires the canonical evals directory.", [
      { code: "tool.source.path", path: "/evidence", message: "Use evals as evaluation source." },
    ]);
  let evidence: Awaited<ReturnType<typeof prepareReviewedToolEvidence>>;
  try {
    evidence = await prepareReviewedToolEvidence(
      projectDirectory,
      {
        trainingEvidencePath: options.reviewEvidencePath,
        holdoutEvidencePath: options.evalEvidencePath,
      },
      TOOL_REVIEW_POLICY.image,
      (options.now ?? (() => new Date()))(),
    );
  } catch {
    // Do not expose raw source/evidence/provider details through the CLI error channel.
    throw new TesslReleaseGateError("Reviewed tool release inputs could not be verified.", [
      {
        code: "tool.evidence.invalid",
        path: "/evidence",
        message: "Check private receipt paths, current source, archive and evidence validity.",
      },
    ]);
  }
  const report = {
    schemaVersion: 1 as const,
    gateType: "skillpress.reviewed-tool-release" as const,
    policy: TOOL_REVIEW_POLICY,
    sourceCommit: evidence.source.commit,
    passed: evidence.report.passed,
    advisory: true as const,
    releaseAuthorized: false as const,
    independentVerificationRequired: true as const,
    assessment: evidence.report,
    issues: evidence.report.issues.map((code) => ({
      code,
      path: "/evidence",
      message: "Reviewed tool measurement policy failed.",
    })),
  };
  return { ...evidence, report };
}

export type ReviewedToolReleaseGateReport = Awaited<
  ReturnType<typeof prepareReviewedToolRelease>
>["report"];

export async function checkReviewedToolReleaseGate(
  projectDirectory: string,
  options: TesslReleaseGateOptions,
): Promise<ReviewedToolReleaseGateReport> {
  return (await prepareReviewedToolRelease(projectDirectory, options)).report;
}
