/* Generated from schemas/submission-receipt.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressSubmissionReceipt`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;
/**
 * This interface was referenced by `SkillPressSubmissionReceipt`'s JSON-Schema
 * via the `definition` "namespace".
 */
export type Namespace = string;
/**
 * This interface was referenced by `SkillPressSubmissionReceipt`'s JSON-Schema
 * via the `definition` "commit".
 */
export type Commit = string;
/**
 * This interface was referenced by `SkillPressSubmissionReceipt`'s JSON-Schema
 * via the `definition` "semver".
 */
export type Semver = string;
/**
 * This interface was referenced by `SkillPressSubmissionReceipt`'s JSON-Schema
 * via the `definition` "name".
 */
export type Name = string;
/**
 * This interface was referenced by `SkillPressSubmissionReceipt`'s JSON-Schema
 * via the `definition` "remote".
 */
export type Remote = {
  [k: string]: unknown;
} & {
  id: string;
  namespace: Namespace;
  url: Url;
  status: ReviewStatus;
  statusVersion: number;
  observedAt: Timestamp;
  release?: Release;
};
/**
 * This interface was referenced by `SkillPressSubmissionReceipt`'s JSON-Schema
 * via the `definition` "url".
 */
export type Url = string;
/**
 * This interface was referenced by `SkillPressSubmissionReceipt`'s JSON-Schema
 * via the `definition` "reviewStatus".
 */
export type ReviewStatus =
  | "received"
  | "automated-review"
  | "curator-review"
  | "changes-requested"
  | "accepted"
  | "published"
  | "rejected";
/**
 * This interface was referenced by `SkillPressSubmissionReceipt`'s JSON-Schema
 * via the `definition` "timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `SkillPressSubmissionReceipt`'s JSON-Schema
 * via the `definition` "trustStatus".
 */
export type TrustStatus = "trusted" | "quarantined" | "revoked";

/**
 * A private retry journal for one canonical Skill Press submission.
 */
export interface SkillPressSubmissionReceipt {
  schemaVersion: 1;
  receiptType: "skillpress.submission";
  runId: Digest;
  idempotencyKey: Digest;
  registry: {
    origin: "https://skill-press.com";
    protocolVersion: 1;
    namespace: Namespace;
  };
  bindings: {
    sourceCommit: Commit;
    projectVersion: Semver;
    skillName: Name;
    projectConfigSha256: Digest;
    skillSha256: Digest;
    artifactSha256: Digest;
    provenanceSha256: Digest;
    checksumsSha256: Digest;
    manifestSha256: Digest;
    reviewEvidenceSha256: Digest;
    evalEvidenceSha256: Digest;
    evalSourceSha256: Digest;
  };
  dryRun: boolean;
  operationStatus: "prepared" | "submitting" | "failed" | "submitted";
  request: {
    status: "pending" | "completed";
    attempts: number;
  };
  remote: null | Remote;
  errorCode?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  storagePath: null | string;
}
/**
 * This interface was referenced by `SkillPressSubmissionReceipt`'s JSON-Schema
 * via the `definition` "release".
 */
export interface Release {
  locator: string;
  version: Semver;
  artifactSha256: Digest;
  canonicalUrl: Url;
  attestationUrl: Url;
  trust: {
    status: TrustStatus;
    sequence: number;
    updatedAt: Timestamp;
    reasonCode?: string;
  };
}
