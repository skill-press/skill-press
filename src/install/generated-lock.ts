/* Generated from schemas/skill-lock.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressLockfile`'s JSON-Schema
 * via the `definition` "locator".
 */
export type Locator = string;
/**
 * This interface was referenced by `SkillPressLockfile`'s JSON-Schema
 * via the `definition` "name".
 */
export type Name = string;
/**
 * This interface was referenced by `SkillPressLockfile`'s JSON-Schema
 * via the `definition` "semver".
 */
export type Semver = string;
/**
 * This interface was referenced by `SkillPressLockfile`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;
/**
 * This interface was referenced by `SkillPressLockfile`'s JSON-Schema
 * via the `definition` "keyId".
 */
export type KeyId = string;

/**
 * Deterministic project lockfile for trusted Skill Press installations.
 */
export interface SkillPressLockfile {
  schemaVersion: 1;
  lockfileType: "skillpress.lock";
  registry: {
    origin: "https://skill-press.com";
    protocolVersion: 1;
  };
  /**
   * @maxItems 128
   */
  skills: Entry[];
}
/**
 * This interface was referenced by `SkillPressLockfile`'s JSON-Schema
 * via the `definition` "entry".
 */
export interface Entry {
  locator: Locator;
  namespace: Name;
  skill: Name;
  version: Semver;
  artifact: {
    sha256: Digest;
    bytes: number;
  };
  attestation: {
    sha256: Digest;
    keyId: KeyId;
  };
  trust: {
    sequence: number;
    status: "trusted";
    keyId: KeyId;
    sha256: Digest;
    updatedAt: string;
  };
  installedPath: string;
}
