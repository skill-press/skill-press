/* Generated from schemas/publication-receipt.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressPublicationReceipt`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;
/**
 * This interface was referenced by `SkillPressPublicationReceipt`'s JSON-Schema
 * via the `definition` "timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `SkillPressPublicationReceipt`'s JSON-Schema
 * via the `definition` "identifier".
 */
export type Identifier = string;

export interface SkillPressPublicationReceipt {
  schemaVersion: 1;
  receiptType: "skillpress.publication";
  runId: Digest;
  idempotencyKey: Digest;
  sourceCommit: string;
  artifactSha256: Digest;
  projectVersion: string;
  execute: boolean;
  status: "dry_run" | "blocked" | "running" | "failed" | "completed";
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /**
   * @minItems 1
   * @maxItems 16
   */
  targets: [Target, ...Target[]];
  storagePath: null | string;
}
/**
 * This interface was referenced by `SkillPressPublicationReceipt`'s JSON-Schema
 * via the `definition` "target".
 */
export interface Target {
  id: Identifier;
  capability: "publish" | "submit" | "derived";
  /**
   * @maxItems 16
   */
  auth: string[];
  rollback: string;
  preflight: Preflight;
  status: "planned" | "preflight_failed" | "running" | "failed" | "verified" | "derived";
  /**
   * @maxItems 32
   */
  steps: Step[];
  remoteId?: string;
  url?: string;
  errorCode?: string;
}
/**
 * This interface was referenced by `SkillPressPublicationReceipt`'s JSON-Schema
 * via the `definition` "preflight".
 */
export interface Preflight {
  ok: boolean;
  code: string;
  message: string;
}
/**
 * This interface was referenced by `SkillPressPublicationReceipt`'s JSON-Schema
 * via the `definition` "step".
 */
export interface Step {
  id: Identifier;
  status: "pending" | "completed";
  remoteId?: string;
  url?: string;
}
