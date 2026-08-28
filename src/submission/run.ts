import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { type LoadedSkillPackageArtifacts, loadPackagedSkill } from "../package/archive.js";
import { checkTesslReleaseGate, type TesslReleaseGateOptions } from "../release/tessl-gate.js";
import {
  createCanonicalSubmissionClient,
  SKILL_PRESS_API_BASE,
  SKILL_PRESS_ORIGIN,
  type SkillPressSubmissionClient,
  SubmissionClientError,
} from "./client.js";
import type { SkillPressSubmissionResource } from "./generated-resource.js";
import {
  createSubmissionStorage,
  persistSubmissionReceipt,
  readMutableSubmissionReceipt,
  type SubmissionReceipt,
  submissionReceiptExists,
  submissionReceiptPath,
} from "./journal.js";
import {
  type PreparedSubmissionPayload,
  prepareSkillSubmission,
  type SubmissionEvidencePaths,
} from "./manifest.js";

export interface SkillSubmissionOptions {
  readonly evidence: TesslReleaseGateOptions;
  readonly dryRun?: boolean;
  readonly resumeReceiptPath?: string;
  readonly client?: SkillPressSubmissionClient;
  readonly now?: () => Date;
}

export interface SubmissionRunIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class SubmissionRunError extends Error {
  readonly issues: readonly SubmissionRunIssue[];

  constructor(message: string, issues: readonly SubmissionRunIssue[]) {
    super(message);
    this.name = "SubmissionRunError";
    this.issues = Object.freeze([...issues]);
  }
}

function issue(code: string, path: string, message: string): SubmissionRunIssue {
  return Object.freeze({ code, path, message });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw new SubmissionRunError("Submission clock is invalid.", [
      issue("submission.clock.invalid", "/time", "clock must return a valid date"),
    ]);
  }
  return value.toISOString();
}

function bindings(
  artifacts: LoadedSkillPackageArtifacts,
  prepared: PreparedSubmissionPayload,
): SubmissionReceipt["bindings"] {
  return {
    sourceCommit: artifacts.sourceCommit,
    projectVersion: prepared.manifest.project.version,
    skillName: prepared.manifest.skill.name,
    projectConfigSha256: artifacts.projectConfigSha256,
    skillSha256: artifacts.skillSha256,
    artifactSha256: artifacts.artifactSha256,
    provenanceSha256: artifacts.provenanceSha256,
    checksumsSha256: artifacts.checksumsSha256,
    manifestSha256: prepared.manifestSha256,
    reviewEvidenceSha256: prepared.manifest.evidence.review.sha256,
    evalEvidenceSha256: prepared.manifest.evidence.evaluation.sha256,
    evalSourceSha256: prepared.manifest.evidence.evalSourceSha256,
  };
}

function sameBindings(
  left: SubmissionReceipt["bindings"],
  right: SubmissionReceipt["bindings"],
): boolean {
  return Object.keys(left).every(
    (key) =>
      left[key as keyof SubmissionReceipt["bindings"]] ===
      right[key as keyof SubmissionReceipt["bindings"]],
  );
}

function validateRemote(
  remote: SkillPressSubmissionResource,
  prepared: PreparedSubmissionPayload,
): void {
  const release = remote.release;
  const locator =
    release === undefined
      ? null
      : /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)@(.+)$/u.exec(release.locator);
  const releasePath =
    locator === null
      ? null
      : `${encodeURIComponent(locator[1] as string)}/${encodeURIComponent(locator[2] as string)}/${encodeURIComponent(locator[3] as string)}`;
  const receivedAt = Date.parse(remote.receivedAt);
  const updatedAt = Date.parse(remote.updatedAt);
  const trustUpdatedAt = release === undefined ? null : Date.parse(release.trust.updatedAt);
  if (
    remote.idempotencyKey !== prepared.idempotencyKey ||
    remote.namespace !== prepared.manifest.registry.namespace ||
    remote.sourceCommit !== prepared.manifest.source.commit ||
    remote.artifactSha256 !== prepared.manifest.package.artifact.sha256 ||
    remote.projectVersion !== prepared.manifest.project.version ||
    !Number.isFinite(receivedAt) ||
    !Number.isFinite(updatedAt) ||
    updatedAt < receivedAt ||
    remote.url !== `${SKILL_PRESS_API_BASE}/submissions/${encodeURIComponent(remote.id)}` ||
    (remote.status === "published") !== (release !== undefined) ||
    (release !== undefined &&
      (locator === null ||
        locator[1] !== remote.namespace ||
        locator[2] !== prepared.manifest.skill.name ||
        locator[3] !== remote.projectVersion ||
        release.version !== remote.projectVersion ||
        release.artifactSha256 !== remote.artifactSha256 ||
        release.canonicalUrl !== `${SKILL_PRESS_ORIGIN}/skills/${releasePath}` ||
        release.attestationUrl !== `${SKILL_PRESS_ORIGIN}/attestations/${releasePath}` ||
        trustUpdatedAt === null ||
        !Number.isFinite(trustUpdatedAt) ||
        trustUpdatedAt < receivedAt))
  ) {
    throw new SubmissionRunError("Skill Press returned a mismatched submission.", [
      issue(
        "submission.remote.binding",
        "/remote",
        "remote resource must bind the exact namespace, manifest, source, version, and artifact",
      ),
    ]);
  }
}

function remoteSummary(
  remote: SkillPressSubmissionResource,
  observedAt: string,
): NonNullable<SubmissionReceipt["remote"]> {
  return {
    id: remote.id,
    namespace: remote.namespace,
    url: remote.url,
    status: remote.status,
    statusVersion: remote.statusVersion,
    observedAt,
    ...(remote.release === undefined ? {} : { release: remote.release }),
  };
}

interface ReleaseHistory {
  readonly locator: string;
  readonly version: string;
  readonly artifactSha256: string;
  readonly canonicalUrl: string;
  readonly attestationUrl: string;
  readonly trust: {
    readonly status: "trusted" | "quarantined" | "revoked";
    readonly sequence: number;
    readonly updatedAt: string;
    readonly reasonCode?: string;
  };
}

function preservesReleaseHistory(
  previous: ReleaseHistory | undefined,
  current: ReleaseHistory | undefined,
): boolean {
  if (previous === undefined) return true;
  if (
    current === undefined ||
    current.locator !== previous.locator ||
    current.version !== previous.version ||
    current.artifactSha256 !== previous.artifactSha256 ||
    current.canonicalUrl !== previous.canonicalUrl ||
    current.attestationUrl !== previous.attestationUrl ||
    current.trust.sequence < previous.trust.sequence
  ) {
    return false;
  }
  return (
    current.trust.sequence !== previous.trust.sequence ||
    (current.trust.status === previous.trust.status &&
      current.trust.updatedAt === previous.trust.updatedAt &&
      current.trust.reasonCode === previous.trust.reasonCode)
  );
}

function failureCode(error: unknown): string {
  if (error instanceof SubmissionClientError) return error.code;
  if (error instanceof SubmissionRunError)
    return error.issues[0]?.code.replaceAll(".", "_") ?? "submission_failed";
  return "submission_failed";
}

function evidencePaths(options: TesslReleaseGateOptions): SubmissionEvidencePaths {
  return {
    reviewEvidencePath: options.reviewEvidencePath,
    evalEvidencePath: options.evalEvidencePath,
    evalSource: options.evalSource,
  };
}

async function revalidate(
  root: string,
  artifacts: LoadedSkillPackageArtifacts,
  prepared: PreparedSubmissionPayload,
  evidence: TesslReleaseGateOptions,
): Promise<void> {
  const [gate, currentArtifacts] = await Promise.all([
    checkTesslReleaseGate(root, evidence),
    loadPackagedSkill(root, artifacts.artifactsPath),
  ]);
  if (!gate.passed || gate.sourceCommit !== artifacts.sourceCommit) {
    throw new SubmissionRunError("Submission inputs changed after preparation.", [
      issue(
        "submission.gate.changed",
        "/evidence",
        "release evidence must remain current and passing",
      ),
    ]);
  }
  const current = await prepareSkillSubmission(root, currentArtifacts, evidencePaths(evidence));
  if (
    current.idempotencyKey !== prepared.idempotencyKey ||
    current.manifestSha256 !== prepared.manifestSha256
  ) {
    throw new SubmissionRunError("Submission inputs changed after preparation.", [
      issue("submission.binding.changed", "/manifest", "submission manifest must remain unchanged"),
    ]);
  }
}

/** Prepare locally by default; submit exactly once to the canonical registry with idempotent recovery. */
export async function runSkillSubmission(
  projectDirectory: string,
  inputArtifacts: LoadedSkillPackageArtifacts,
  options: SkillSubmissionOptions,
): Promise<SubmissionReceipt> {
  const root = await realpath(resolve(projectDirectory));
  const gate = await checkTesslReleaseGate(root, options.evidence);
  if (!gate.passed || gate.sourceCommit !== inputArtifacts.sourceCommit) {
    throw new SubmissionRunError("Submission is blocked by the current release gate.", [
      issue(
        "submission.gate.blocked",
        "/evidence",
        "current source-bound Tessl evidence must pass",
      ),
    ]);
  }
  const artifacts = await loadPackagedSkill(root, inputArtifacts.artifactsPath);
  if (
    artifacts.sourceCommit !== inputArtifacts.sourceCommit ||
    artifacts.artifactSha256 !== inputArtifacts.artifactSha256
  ) {
    throw new SubmissionRunError("Submission package changed after loading.", [
      issue("submission.package.changed", "/package", "package must retain its verified binding"),
    ]);
  }
  const prepared = await prepareSkillSubmission(root, artifacts, evidencePaths(options.evidence));
  const receiptBindings = bindings(artifacts, prepared);
  const now = options.now ?? (() => new Date());
  const createdAt = timestamp(now);
  const dryRun = options.dryRun === true;
  if (dryRun) {
    if (options.resumeReceiptPath !== undefined) {
      throw new SubmissionRunError("Dry-run cannot resume a submitted operation.", [
        issue("submission.resume.dry_run", "/resume", "remove --dry-run when resuming"),
      ]);
    }
    return freeze({
      schemaVersion: 1,
      receiptType: "skillpress.submission",
      runId: randomBytes(32).toString("hex"),
      idempotencyKey: prepared.idempotencyKey,
      registry: {
        origin: SKILL_PRESS_ORIGIN,
        protocolVersion: 1,
        namespace: prepared.manifest.registry.namespace,
      },
      bindings: receiptBindings,
      dryRun: true,
      operationStatus: "prepared",
      request: { status: "pending", attempts: 0 },
      remote: null,
      createdAt,
      updatedAt: createdAt,
      storagePath: null,
    });
  }

  const expectedPath = submissionReceiptPath(prepared.idempotencyKey);
  let receipt: SubmissionReceipt;
  if (options.resumeReceiptPath !== undefined) {
    receipt = await readMutableSubmissionReceipt(root, options.resumeReceiptPath);
    if (
      options.resumeReceiptPath !== expectedPath ||
      receipt.idempotencyKey !== prepared.idempotencyKey ||
      receipt.registry.origin !== SKILL_PRESS_ORIGIN ||
      receipt.registry.protocolVersion !== 1 ||
      receipt.registry.namespace !== prepared.manifest.registry.namespace ||
      receipt.dryRun ||
      !sameBindings(receipt.bindings, receiptBindings)
    ) {
      throw new SubmissionRunError("Submission receipt does not match current inputs.", [
        issue(
          "submission.resume.binding",
          "/resume",
          "receipt and current manifest must match exactly",
        ),
      ]);
    }
  } else {
    if (await submissionReceiptExists(root, prepared.idempotencyKey)) {
      throw new SubmissionRunError("A submission journal already exists for these inputs.", [
        issue(
          "submission.resume.required",
          "/resume",
          `resume the existing receipt at ${expectedPath}`,
        ),
      ]);
    }
    await createSubmissionStorage(root, prepared.idempotencyKey);
    receipt = {
      schemaVersion: 1,
      receiptType: "skillpress.submission",
      runId: randomBytes(32).toString("hex"),
      idempotencyKey: prepared.idempotencyKey,
      registry: {
        origin: SKILL_PRESS_ORIGIN,
        protocolVersion: 1,
        namespace: prepared.manifest.registry.namespace,
      },
      bindings: receiptBindings,
      dryRun: false,
      operationStatus: "submitting",
      request: { status: "pending", attempts: 0 },
      remote: null,
      createdAt,
      updatedAt: createdAt,
      storagePath: expectedPath,
    };
    await persistSubmissionReceipt(root, receipt);
  }

  let client: SkillPressSubmissionClient;
  try {
    client = options.client ?? createCanonicalSubmissionClient();
    await client.checkSession();
    if (receipt.request.status === "completed" && receipt.remote !== null) {
      const previousRemote = receipt.remote;
      const verified = await client.getSubmission(previousRemote.id);
      validateRemote(verified, prepared);
      if (
        verified.id !== previousRemote.id ||
        verified.url !== previousRemote.url ||
        verified.statusVersion < previousRemote.statusVersion ||
        (verified.statusVersion === previousRemote.statusVersion &&
          verified.status !== previousRemote.status) ||
        !preservesReleaseHistory(previousRemote.release, verified.release)
      ) {
        throw new SubmissionRunError("Skill Press verification did not match the saved resource.", [
          issue(
            "submission.remote.verify",
            "/remote",
            "refreshed resource must keep its identity and must not regress status history",
          ),
        ]);
      }
      await revalidate(root, artifacts, prepared, options.evidence);
      receipt.remote = remoteSummary(verified, timestamp(now));
      receipt.operationStatus = "submitted";
      delete receipt.errorCode;
      receipt.updatedAt = timestamp(now);
      await persistSubmissionReceipt(root, receipt);
      return freeze(structuredClone(receipt));
    }
    await revalidate(root, artifacts, prepared, options.evidence);
    receipt.operationStatus = "submitting";
    receipt.request.status = "pending";
    receipt.remote = null;
    delete receipt.errorCode;
    receipt.request.attempts += 1;
    receipt.updatedAt = timestamp(now);
    await persistSubmissionReceipt(root, receipt);
    const submitted = await client.submit(prepared);
    validateRemote(submitted, prepared);
    receipt.request.status = "completed";
    receipt.remote = remoteSummary(submitted, timestamp(now));
    receipt.operationStatus = "submitted";
    receipt.updatedAt = timestamp(now);
    await persistSubmissionReceipt(root, receipt);
    const verified = await client.getSubmission(submitted.id);
    validateRemote(verified, prepared);
    if (
      verified.id !== submitted.id ||
      verified.url !== submitted.url ||
      verified.statusVersion < submitted.statusVersion ||
      (verified.statusVersion === submitted.statusVersion &&
        verified.status !== submitted.status) ||
      !preservesReleaseHistory(submitted.release, verified.release)
    ) {
      throw new SubmissionRunError(
        "Skill Press verification did not match the submitted resource.",
        [
          issue(
            "submission.remote.verify",
            "/remote",
            "verified resource must be the same or newer",
          ),
        ],
      );
    }
    await revalidate(root, artifacts, prepared, options.evidence);
    receipt.remote = remoteSummary(verified, timestamp(now));
    receipt.operationStatus = "submitted";
    receipt.updatedAt = timestamp(now);
    await persistSubmissionReceipt(root, receipt);
    return freeze(structuredClone(receipt));
  } catch (error) {
    receipt.operationStatus = "failed";
    receipt.errorCode = failureCode(error);
    receipt.updatedAt = timestamp(now);
    await persistSubmissionReceipt(root, receipt);
    return freeze(structuredClone(receipt));
  }
}
