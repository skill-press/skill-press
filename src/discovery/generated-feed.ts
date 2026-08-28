/* Generated from schemas/discovery-feed.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "locator".
 */
export type Locator = string;
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "namespace".
 */
export type Namespace = string;
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "name".
 */
export type Name = string;
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "semver".
 */
export type Semver = string;
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "canonicalUrl".
 */
export type CanonicalUrl = string;
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "reasonCode".
 */
export type ReasonCode = string;
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "mirror".
 */
export type Mirror = ListingMirror | ArtifactMirror;
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "id".
 */
export type Id = string;
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "mirrorUrl".
 */
export type MirrorUrl = string;
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "cursor".
 */
export type Cursor = string;

/**
 * A page from the canonical, platform-controlled Skill Press discovery feed.
 */
export interface SkillPressDiscoveryFeed {
  schemaVersion: 1;
  feedType: "skillpress.discovery-feed";
  /**
   * SHA-256 of the version-1 domain string followed by JSON.stringify of the complete normalized release array.
   */
  snapshot: string;
  generatedAt: Timestamp;
  /**
   * The exact release count in the complete snapshot, repeated unchanged on every page.
   */
  totalEntries: number;
  /**
   * @maxItems 100
   */
  entries: Release[];
  /**
   * An opaque authenticated server token bound to this snapshot, the last position, and an expiry.
   */
  nextCursor: Cursor | null;
}
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "release".
 */
export interface Release {
  releaseState: "published";
  locator: Locator;
  namespace: Namespace;
  skill: Name;
  version: Semver;
  artifactSha256: Digest;
  canonicalUrl: CanonicalUrl;
  attestationUrl: CanonicalUrl;
  publishedAt: Timestamp;
  trust: Trust;
  /**
   * @maxItems 8
   */
  mirrors: Mirror[];
}
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "trust".
 */
export interface Trust {
  status: "trusted" | "quarantined" | "revoked";
  sequence: number;
  updatedAt: Timestamp;
  reasonCode?: ReasonCode;
}
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "listingMirror".
 */
export interface ListingMirror {
  projectionType: "skillpress.mirror-projection";
  id: Id;
  operator: "skill-press";
  provider: "github";
  mirrorKind: "listing";
  url: MirrorUrl;
  verifiedAt: Timestamp;
  source: MirrorSource;
}
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "mirrorSource".
 */
export interface MirrorSource {
  locator: Locator;
  artifactSha256: Digest;
  canonicalUrl: CanonicalUrl;
  attestationUrl: CanonicalUrl;
}
/**
 * This interface was referenced by `SkillPressDiscoveryFeed`'s JSON-Schema
 * via the `definition` "artifactMirror".
 */
export interface ArtifactMirror {
  projectionType: "skillpress.mirror-projection";
  id: Id;
  operator: "skill-press";
  provider: "github";
  mirrorKind: "artifact";
  url: MirrorUrl;
  verifiedAt: Timestamp;
  artifactSha256: Digest;
  source: MirrorSource;
}
