/* Generated from schemas/submission-manifest.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressSubmissionManifest`'s JSON-Schema
 * via the `definition` "name".
 */
export type Name = string;
/**
 * This interface was referenced by `SkillPressSubmissionManifest`'s JSON-Schema
 * via the `definition` "semver".
 */
export type Semver = string;
/**
 * This interface was referenced by `SkillPressSubmissionManifest`'s JSON-Schema
 * via the `definition` "repository".
 */
export type Repository = string;
/**
 * This interface was referenced by `SkillPressSubmissionManifest`'s JSON-Schema
 * via the `definition` "relativePath".
 */
export type RelativePath = string;
/**
 * This interface was referenced by `SkillPressSubmissionManifest`'s JSON-Schema
 * via the `definition` "commit".
 */
export type Commit = string;
/**
 * This interface was referenced by `SkillPressSubmissionManifest`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;

/**
 * The deterministic client manifest for one canonical Skill Press submission.
 */
export interface SkillPressSubmissionManifest {
  schemaVersion: 1;
  manifestType: "skillpress.submission-manifest";
  configSchemaVersion: 2;
  project: {
    name: Name;
    version: Semver;
    repository: Repository;
    license: string;
    author: {
      name: string;
      github: string;
    };
  };
  registry: {
    namespace: Name;
  };
  skill: {
    name: Name;
    path: RelativePath;
    risk: "low" | "moderate" | "high";
  };
  source: {
    commit: Commit;
    projectConfigSha256: Digest;
    skillSha256: Digest;
  };
  package: {
    artifact: ArtifactPayload;
    provenance: ProvenancePayload;
    checksums: ChecksumsPayload;
  };
  evidence: {
    advisory: true;
    review: ReviewEvidencePayload;
    evaluation: EvalEvidencePayload;
    evalSourceSha256: Digest;
  };
  serverValidationRequired: true;
  tool: {
    name: "@skill-press/cli";
  };
}
/**
 * This interface was referenced by `SkillPressSubmissionManifest`'s JSON-Schema
 * via the `definition` "artifactPayload".
 */
export interface ArtifactPayload {
  name: string;
  sha256: Digest;
  bytes: number;
  mediaType: "application/zip";
}
/**
 * This interface was referenced by `SkillPressSubmissionManifest`'s JSON-Schema
 * via the `definition` "provenancePayload".
 */
export interface ProvenancePayload {
  name: "provenance.json";
  sha256: Digest;
  bytes: number;
  mediaType: "application/json";
}
/**
 * This interface was referenced by `SkillPressSubmissionManifest`'s JSON-Schema
 * via the `definition` "checksumsPayload".
 */
export interface ChecksumsPayload {
  name: "SHA256SUMS";
  sha256: Digest;
  bytes: number;
  mediaType: "text/plain";
}
/**
 * This interface was referenced by `SkillPressSubmissionManifest`'s JSON-Schema
 * via the `definition` "reviewEvidencePayload".
 */
export interface ReviewEvidencePayload {
  name: "review-evidence.json";
  sha256: Digest;
  bytes: number;
  mediaType: "application/json";
}
/**
 * This interface was referenced by `SkillPressSubmissionManifest`'s JSON-Schema
 * via the `definition` "evalEvidencePayload".
 */
export interface EvalEvidencePayload {
  name: "eval-evidence.json";
  sha256: Digest;
  bytes: number;
  mediaType: "application/json";
}
