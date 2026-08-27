import { checkProject } from "../check/project.js";
import { loadProjectConfig } from "../config/load.js";
import { loadPackagedSkill, type LoadedSkillPackageArtifacts } from "../package/archive.js";
import {
  checkTesslReleaseGate,
  type TesslReleaseGateOptions,
  type TesslReleaseGateReport,
} from "../release/tessl-gate.js";
import { readSubmissionReceipt, type SubmissionReceipt } from "../submission/journal.js";
import { prepareSkillSubmission, type PreparedSubmissionPayload } from "../submission/manifest.js";

export interface ProjectStatusIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ProjectStatusOptions {
  readonly evidence?: TesslReleaseGateOptions;
  readonly artifactsPath?: string;
  readonly submissionReceiptPath?: string;
  readonly now?: () => Date;
}

interface ProjectStatusOperations {
  readonly loadConfig: typeof loadProjectConfig;
  readonly checkLocal: typeof checkProject;
  readonly checkGate: typeof checkTesslReleaseGate;
  readonly loadPackage: typeof loadPackagedSkill;
  readonly readReceipt: typeof readSubmissionReceipt;
  readonly prepareSubmission: typeof prepareSkillSubmission;
}

const defaultOperations: ProjectStatusOperations = Object.freeze({
  loadConfig: loadProjectConfig,
  checkLocal: checkProject,
  checkGate: checkTesslReleaseGate,
  loadPackage: loadPackagedSkill,
  readReceipt: readSubmissionReceipt,
  prepareSubmission: prepareSkillSubmission,
});

export interface ProjectStatusReport {
  readonly schemaVersion: 1;
  readonly statusType: "skillpress.status";
  readonly evaluatedAt: string;
  /** Always false: status is an offline observation and never refreshes canonical trust. */
  readonly currentTrustVerified: false;
  readonly ready: boolean;
  readonly local: {
    readonly eligible: boolean;
    readonly score: number;
    readonly minimum: number;
  };
  readonly gate: TesslReleaseGateReport | null;
  readonly package: null | {
    readonly artifactsPath: string;
    readonly sourceCommit: string;
    readonly artifactSha256: string;
  };
  readonly submission: null | {
    readonly receiptPath: string;
    readonly namespace: string;
    readonly operationStatus: SubmissionReceipt["operationStatus"];
    readonly sourceCommit: string;
    readonly artifactSha256: string;
    readonly remote: SubmissionReceipt["remote"];
  };
  readonly issues: readonly ProjectStatusIssue[];
}

function issue(code: string, path: string, message: string): ProjectStatusIssue {
  return Object.freeze({ code, path, message });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function packageSummary(value: LoadedSkillPackageArtifacts) {
  return {
    artifactsPath: value.artifactsPath,
    sourceCommit: value.sourceCommit,
    artifactSha256: value.artifactSha256,
  };
}

function submissionSummary(path: string, value: SubmissionReceipt) {
  return {
    receiptPath: path,
    namespace: value.registry.namespace,
    operationStatus: value.operationStatus,
    sourceCommit: value.bindings.sourceCommit,
    artifactSha256: value.bindings.artifactSha256,
    remote: value.remote,
  };
}

/** Summarize local, evidence, package, and canonical submission bindings without mutation. */
export async function inspectProjectStatus(
  projectDirectory: string,
  options: ProjectStatusOptions = {},
  operations: Partial<ProjectStatusOperations> = {},
): Promise<ProjectStatusReport> {
  const dependencies = { ...defaultOperations, ...operations };
  const now = options.now ?? (() => new Date());
  const evaluatedAt = now();
  if (!Number.isFinite(evaluatedAt.getTime())) throw new TypeError("Status clock is invalid.");
  const config = await dependencies.loadConfig(projectDirectory);
  const local = await dependencies.checkLocal(projectDirectory);
  const gate =
    options.evidence === undefined
      ? null
      : await dependencies.checkGate(projectDirectory, {
          ...options.evidence,
          now: options.evidence.now ?? now,
        });
  const packaged =
    options.artifactsPath === undefined
      ? null
      : await dependencies.loadPackage(projectDirectory, options.artifactsPath);
  const submission =
    options.submissionReceiptPath === undefined
      ? null
      : await dependencies.readReceipt(projectDirectory, options.submissionReceiptPath);
  const prepared: PreparedSubmissionPayload | null =
    submission === null || packaged === null || options.evidence === undefined
      ? null
      : await dependencies.prepareSubmission(projectDirectory, packaged, {
          reviewEvidencePath: options.evidence.reviewEvidencePath,
          evalEvidencePath: options.evidence.evalEvidencePath,
          evalSource: options.evidence.evalSource,
        });
  const issues: ProjectStatusIssue[] = [];
  if (!local.eligible) {
    issues.push(issue("status.local.blocked", "/local", "local project readiness is blocked"));
  }
  if (gate === null) {
    issues.push(
      issue(
        "status.evidence.missing",
        "/gate",
        "review evidence, eval evidence, and eval source are required for release status",
      ),
    );
  } else if (!gate.passed) {
    issues.push(issue("status.gate.blocked", "/gate", "the current Tessl release gate is blocked"));
  }
  if (packaged !== null && gate !== null && packaged.sourceCommit !== gate.sourceCommit) {
    issues.push(
      issue(
        "status.package.stale",
        "/package/sourceCommit",
        "package source does not match current release evidence",
      ),
    );
  }
  if (submission !== null) {
    if (submission.registry.namespace !== config.registry.namespace) {
      issues.push(
        issue(
          "status.submission.namespace",
          "/submission/registry/namespace",
          "submission receipt targets a different canonical registry namespace",
        ),
      );
    }
    if (packaged === null) {
      issues.push(
        issue(
          "status.submission.package_missing",
          "/submission",
          "an artifact path is required to verify a submission receipt",
        ),
      );
    } else if (
      submission.bindings.sourceCommit !== packaged.sourceCommit ||
      submission.bindings.skillName !== config.skill.name ||
      submission.bindings.artifactSha256 !== packaged.artifactSha256 ||
      submission.bindings.projectConfigSha256 !== packaged.projectConfigSha256 ||
      submission.bindings.skillSha256 !== packaged.skillSha256 ||
      submission.bindings.provenanceSha256 !== packaged.provenanceSha256 ||
      submission.bindings.checksumsSha256 !== packaged.checksumsSha256 ||
      submission.bindings.projectVersion !== config.project.version
    ) {
      issues.push(
        issue(
          "status.submission.binding",
          "/submission",
          "submission receipt does not match the current package and project version",
        ),
      );
    }
    if (
      prepared !== null &&
      (submission.idempotencyKey !== prepared.idempotencyKey ||
        submission.bindings.skillName !== prepared.manifest.skill.name ||
        submission.bindings.manifestSha256 !== prepared.manifestSha256 ||
        submission.bindings.reviewEvidenceSha256 !== prepared.manifest.evidence.review.sha256 ||
        submission.bindings.evalEvidenceSha256 !== prepared.manifest.evidence.evaluation.sha256 ||
        submission.bindings.evalSourceSha256 !== prepared.manifest.evidence.evalSourceSha256)
    ) {
      issues.push(
        issue(
          "status.submission.manifest_binding",
          "/submission/bindings",
          "submission receipt does not match the current manifest and evidence",
        ),
      );
    }
    if (submission.operationStatus === "failed" || submission.operationStatus === "submitting") {
      issues.push(
        issue(
          "status.submission.incomplete",
          "/submission/operationStatus",
          "submission requires an exact retry or recovery",
        ),
      );
    }
    if (
      submission.remote?.status === "changes-requested" ||
      submission.remote?.status === "rejected"
    ) {
      issues.push(
        issue(
          "status.submission.review_blocked",
          "/submission/remote/status",
          "canonical review requires changes or rejected this candidate",
        ),
      );
    }
    if (
      submission.remote?.release !== undefined &&
      submission.remote.release.trust.status !== "trusted"
    ) {
      issues.push(
        issue(
          "status.release.trust_blocked",
          "/submission/remote/release/trust/status",
          `last observed published-release trust was ${submission.remote.release.trust.status}`,
        ),
      );
    }
  }
  return freeze({
    schemaVersion: 1,
    statusType: "skillpress.status",
    evaluatedAt: evaluatedAt.toISOString(),
    currentTrustVerified: false,
    ready: issues.length === 0,
    local: { eligible: local.eligible, score: local.score, minimum: local.minimum },
    gate,
    package: packaged === null ? null : packageSummary(packaged),
    submission:
      submission === null || options.submissionReceiptPath === undefined
        ? null
        : submissionSummary(options.submissionReceiptPath, submission),
    issues,
  });
}
