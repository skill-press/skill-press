/* Generated from schemas/submission-resource.schema.json. Do not edit by hand. */

/**
 * The canonical Skill Press server resource for a submitted candidate.
 */
export type SkillPressSubmissionResource = {
  [k: string]: unknown;
} & {
  schemaVersion: 1;
  resourceType: "skillpress.submission";
  id: Id;
  idempotencyKey: Digest;
  namespace: Namespace;
  status: ReviewStatus;
  statusVersion: number;
  sourceCommit: Commit;
  artifactSha256: Digest;
  projectVersion: Semver;
  url: Url;
  receivedAt: Timestamp;
  updatedAt: Timestamp;
  release?: Release;
};
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "id".
 */
export type Id = string;
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "namespace".
 */
export type Namespace = string;
/**
 * This interface was referenced by `undefined`'s JSON-Schema
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
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "commit".
 */
export type Commit = string;
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "semver".
 */
export type Semver = string;
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "url".
 */
export type Url = string;
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "trustStatus".
 */
export type TrustStatus = "trusted" | "quarantined" | "revoked";

/**
 * This interface was referenced by `undefined`'s JSON-Schema
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
