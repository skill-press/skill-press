import { checkProject } from "../check/project.js";
import { loadProjectConfig } from "../config/load.js";
import { loadPackagedSkill, type LoadedSkillPackageArtifacts } from "../package/archive.js";
import {
  readPublicationReceipt,
  type PublicationReceipt,
  type PublicationTargetStatus,
} from "../publish/saga.js";
import {
  checkTesslReleaseGate,
  type TesslReleaseGateOptions,
  type TesslReleaseGateReport,
} from "../release/tessl-gate.js";

export interface ProjectStatusIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ProjectStatusOptions {
  readonly evidence?: TesslReleaseGateOptions;
  readonly artifactsPath?: string;
  readonly receiptPath?: string;
  readonly now?: () => Date;
}

interface ProjectStatusOperations {
  readonly loadConfig: typeof loadProjectConfig;
  readonly checkLocal: typeof checkProject;
  readonly checkGate: typeof checkTesslReleaseGate;
  readonly loadPackage: typeof loadPackagedSkill;
  readonly readReceipt: typeof readPublicationReceipt;
}

const defaultOperations: ProjectStatusOperations = Object.freeze({
  loadConfig: loadProjectConfig,
  checkLocal: checkProject,
  checkGate: checkTesslReleaseGate,
  loadPackage: loadPackagedSkill,
  readReceipt: readPublicationReceipt,
});

export interface ProjectStatusReport {
  readonly schemaVersion: 1;
  readonly statusType: "skillpress.status";
  readonly evaluatedAt: string;
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
  readonly publication: null | {
    readonly receiptPath: string;
    readonly status: PublicationReceipt["status"];
    readonly sourceCommit: string;
    readonly artifactSha256: string;
    readonly targets: readonly {
      readonly id: string;
      readonly status: PublicationTargetStatus;
      readonly preflightOk: boolean;
      readonly url?: string;
    }[];
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

function publicationSummary(path: string, value: PublicationReceipt) {
  return {
    receiptPath: path,
    status: value.status,
    sourceCommit: value.sourceCommit,
    artifactSha256: value.artifactSha256,
    targets: value.targets.map((target) => ({
      id: target.id,
      status: target.status,
      preflightOk: target.preflight.ok,
      ...(target.url === undefined ? {} : { url: target.url }),
    })),
  };
}

/** Summarize local, external-evidence, package, and receipt bindings without provider mutations. */
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
  const publication =
    options.receiptPath === undefined
      ? null
      : await dependencies.readReceipt(projectDirectory, options.receiptPath);
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
  if (publication !== null) {
    if (packaged === null) {
      issues.push(
        issue(
          "status.publication.package_missing",
          "/publication",
          "an artifact path is required to verify a publication receipt",
        ),
      );
    } else if (
      publication.sourceCommit !== packaged.sourceCommit ||
      publication.artifactSha256 !== packaged.artifactSha256 ||
      publication.projectVersion !== config.project.version
    ) {
      issues.push(
        issue(
          "status.publication.binding",
          "/publication",
          "publication receipt does not match the current package and project version",
        ),
      );
    }
    if (["blocked", "failed", "running"].includes(publication.status)) {
      issues.push(
        issue(
          "status.publication.incomplete",
          "/publication/status",
          "publication requires recovery or completion",
        ),
      );
    }
    if (publication.targets.some((target) => !target.preflight.ok)) {
      issues.push(
        issue(
          "status.publication.preflight",
          "/publication/targets",
          "one or more publication preflights are blocked",
        ),
      );
    }
  }
  return freeze({
    schemaVersion: 1,
    statusType: "skillpress.status",
    evaluatedAt: evaluatedAt.toISOString(),
    ready: issues.length === 0,
    local: {
      eligible: local.eligible,
      score: local.score,
      minimum: local.minimum,
    },
    gate,
    package: packaged === null ? null : packageSummary(packaged),
    publication:
      publication === null || options.receiptPath === undefined
        ? null
        : publicationSummary(options.receiptPath, publication),
    issues,
  });
}
