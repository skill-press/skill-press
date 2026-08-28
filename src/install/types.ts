import type {
  Entry as GeneratedSkillLockEntry,
  SkillPressLockfile as GeneratedSkillPressLockfile,
} from "./generated-lock.js";

export const SKILL_PRESS_INSTALL_ORIGIN = "https://skill-press.com" as const;
export const SKILL_PRESS_INSTALL_API_BASE = `${SKILL_PRESS_INSTALL_ORIGIN}/api/v1` as const;

export type SkillPressTrustStatus = "trusted" | "quarantined" | "revoked";
export type SkillPressSigningKeyRole = "release-attestation" | "trust-event" | "current-trust";

export interface ExactSkillLocator {
  readonly locator: string;
  readonly namespace: string;
  readonly skill: string;
  readonly version: string;
}

export interface SkillPressReleaseResource extends ExactSkillLocator {
  readonly schemaVersion: 1;
  readonly resourceType: "skillpress.release";
  readonly artifact: {
    readonly url: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly mediaType: "application/zip";
  };
  readonly attestation: {
    readonly url: string;
    readonly sha256: string;
    readonly keyId: string;
    readonly algorithm: "ES256";
  };
  readonly trust: {
    readonly url: string;
    readonly sequence: number;
    readonly status: SkillPressTrustStatus;
    readonly updatedAt: string;
    readonly keyId: string;
    readonly algorithm: "ES256";
  };
  readonly checkpoint: {
    readonly url: string;
    readonly keyId: string;
    readonly algorithm: "ES256";
  };
}

export interface SkillPressReleaseAttestation extends ExactSkillLocator {
  readonly schemaVersion: 1;
  readonly statementType: "skillpress.release-attestation";
  readonly artifactSha256: string;
  readonly artifactBytes: number;
  readonly artifactMediaType: "application/zip";
  readonly issuedAt: string;
  readonly submissionId: string;
  readonly automatedReviewSha256: string;
  readonly curatorDecisionSha256: string;
}

export interface SkillPressTrustStatement extends ExactSkillLocator {
  readonly schemaVersion: 1;
  readonly statementType: "skillpress.trust-statement";
  readonly artifactSha256: string;
  readonly attestationSha256: string;
  readonly sequence: number;
  readonly status: SkillPressTrustStatus;
  readonly updatedAt: string;
  readonly reasonCode?: string;
}

export interface SkillPressCurrentTrustCheckpoint extends ExactSkillLocator {
  readonly schemaVersion: 1;
  readonly statementType: "skillpress.current-trust-checkpoint";
  readonly artifactSha256: string;
  readonly attestationSha256: string;
  readonly trustSequence: number;
  readonly trustStatus: SkillPressTrustStatus;
  readonly trustUpdatedAt: string;
  readonly trustEnvelopeSha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SkillPressSignedEnvelope {
  readonly schemaVersion: 1;
  readonly envelopeType:
    | "skillpress.signed-attestation"
    | "skillpress.signed-trust"
    | "skillpress.signed-current-trust";
  readonly keyId: string;
  readonly algorithm: "ES256";
  readonly payload: string;
  readonly signature: string;
}

export interface SkillPressP256PublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

export interface SkillPressPinnedKey {
  readonly keyId: string;
  readonly roles: readonly SkillPressSigningKeyRole[];
  readonly validFrom: string;
  readonly validUntil: string;
  readonly minimumTrustSequence?: number;
  readonly jwk: SkillPressP256PublicJwk;
}

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type SkillLockEntry = DeepReadonly<GeneratedSkillLockEntry>;
export type SkillPressLockfile = DeepReadonly<GeneratedSkillPressLockfile>;

export interface TrustedInstallResult {
  readonly entry: SkillLockEntry;
  readonly lockPath: string;
  readonly installedPath: string;
  readonly changed: boolean;
}

export interface TrustedAddOptions {
  readonly locator: string;
  readonly projectRoot?: string;
  readonly fetcher?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly keyring?: readonly SkillPressPinnedKey[];
  readonly now?: () => Date;
}

export interface TrustedInstallOptions {
  readonly projectRoot?: string;
  readonly fetcher?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly keyring?: readonly SkillPressPinnedKey[];
  readonly now?: () => Date;
}
