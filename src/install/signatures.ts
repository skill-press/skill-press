import { webcrypto } from "node:crypto";

import {
  parseAttestationPayload,
  parseCurrentTrustCheckpointPayload,
  parseSignedEnvelope,
  parseTrustPayload,
} from "./contract.js";
import { TrustedInstallError } from "./errors.js";
import { SKILL_PRESS_PINNED_KEYS } from "./production-keys.js";
import type {
  ExactSkillLocator,
  SkillPressCurrentTrustCheckpoint,
  SkillPressPinnedKey,
  SkillPressReleaseAttestation,
  SkillPressSignedEnvelope,
  SkillPressSigningKeyRole,
  SkillPressTrustStatement,
} from "./types.js";

export { SKILL_PRESS_PINNED_KEYS } from "./production-keys.js";

type ImportedKey = Awaited<ReturnType<typeof webcrypto.subtle.importKey>>;
type ImportedPinnedKey = Readonly<{
  key: ImportedKey;
  roles: ReadonlySet<SkillPressSigningKeyRole>;
  validFrom: number;
  validUntil: number;
  minimumTrustSequence?: number;
}>;

interface TrustedSignatureVerifier {
  readonly verifyAttestation: (
    envelopeValue: unknown,
    expected: ExactSkillLocator,
  ) => Promise<{
    readonly envelope: SkillPressSignedEnvelope;
    readonly statement: SkillPressReleaseAttestation;
  }>;
  readonly verifyTrust: (
    envelopeValue: unknown,
    expected: ExactSkillLocator,
  ) => Promise<{
    readonly envelope: SkillPressSignedEnvelope;
    readonly statement: SkillPressTrustStatement;
  }>;
  readonly verifyCurrentTrust: (
    envelopeValue: unknown,
    expected: ExactSkillLocator,
  ) => Promise<{
    readonly envelope: SkillPressSignedEnvelope;
    readonly statement: SkillPressCurrentTrustCheckpoint;
  }>;
}

function keyError(message: string): never {
  throw new TrustedInstallError("keyring_invalid", message);
}

function decodeCoordinate(value: unknown): boolean {
  if (typeof value !== "string" || value.length !== 43 || value.includes("=")) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 32 && bytes.toString("base64url") === value;
}

function validatePinnedKey(value: SkillPressPinnedKey): SkillPressPinnedKey {
  const allowedRoles = new Set(["release-attestation", "trust-event", "current-trust"]);
  const hasMinimumSequence =
    value !== null && typeof value === "object" && Object.hasOwn(value, "minimumTrustSequence");
  const validFrom = typeof value?.validFrom === "string" ? Date.parse(value.validFrom) : Number.NaN;
  const validUntil =
    typeof value?.validUntil === "string" ? Date.parse(value.validUntil) : Number.NaN;
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).length !== (hasMinimumSequence ? 6 : 5) ||
    !Object.hasOwn(value, "keyId") ||
    !Object.hasOwn(value, "jwk") ||
    !Object.hasOwn(value, "roles") ||
    !Object.hasOwn(value, "validFrom") ||
    !Object.hasOwn(value, "validUntil") ||
    typeof value.keyId !== "string" ||
    value.keyId.length < 1 ||
    value.keyId.length > 128 ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(value.keyId) ||
    !Array.isArray(value.roles) ||
    value.roles.length < 1 ||
    value.roles.length > 3 ||
    new Set(value.roles).size !== value.roles.length ||
    value.roles.some((role) => !allowedRoles.has(role)) ||
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validUntil) ||
    new Date(validFrom).toISOString() !== value.validFrom ||
    new Date(validUntil).toISOString() !== value.validUntil ||
    validUntil <= validFrom ||
    (hasMinimumSequence &&
      (!Number.isSafeInteger(value.minimumTrustSequence) ||
        (value.minimumTrustSequence as number) < 1)) ||
    value.jwk === null ||
    typeof value.jwk !== "object" ||
    Object.keys(value.jwk).length !== 4 ||
    value.jwk.kty !== "EC" ||
    value.jwk.crv !== "P-256" ||
    !decodeCoordinate(value.jwk.x) ||
    !decodeCoordinate(value.jwk.y)
  ) {
    return keyError("The Skill Press signing keyring is invalid.");
  }
  return Object.freeze({
    keyId: value.keyId,
    roles: Object.freeze([...value.roles]),
    validFrom: value.validFrom,
    validUntil: value.validUntil,
    ...(value.minimumTrustSequence === undefined
      ? {}
      : { minimumTrustSequence: value.minimumTrustSequence }),
    jwk: Object.freeze({ kty: "EC", crv: "P-256", x: value.jwk.x, y: value.jwk.y }),
  });
}

async function importKey(key: SkillPressPinnedKey): Promise<ImportedKey> {
  try {
    return await webcrypto.subtle.importKey(
      "jwk",
      { ...key.jwk, alg: "ES256", ext: true, key_ops: ["verify"] },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return keyError("A pinned Skill Press signing key could not be imported.");
  }
}

async function verifiedEnvelope(
  envelopeValue: unknown,
  expectedType: SkillPressSignedEnvelope["envelopeType"],
  keys: ReadonlyMap<string, ImportedPinnedKey>,
  requiredRole: SkillPressSigningKeyRole,
): Promise<SkillPressSignedEnvelope> {
  const envelope = parseSignedEnvelope(envelopeValue, expectedType);
  const pinned = keys.get(envelope.keyId);
  if (pinned === undefined || !pinned.roles.has(requiredRole)) {
    throw new TrustedInstallError(
      "signature_invalid",
      "Skill Press used a signing key that is not pinned by this CLI.",
    );
  }
  const signature = Buffer.from(envelope.signature, "base64url");
  const payload = Buffer.from(envelope.payload, "base64url");
  if (signature.byteLength !== 64) {
    throw new TrustedInstallError(
      "signature_invalid",
      "Skill Press returned a malformed signature.",
    );
  }
  let verified = false;
  try {
    verified = await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pinned.key,
      signature,
      payload,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new TrustedInstallError(
      "signature_invalid",
      "The Skill Press signature could not be verified.",
    );
  }
  return envelope;
}

function assertKeyAuthorization(
  envelope: SkillPressSignedEnvelope,
  keys: ReadonlyMap<string, ImportedPinnedKey>,
  statementTimestamp: string,
  trustSequence?: number,
): void {
  const pinned = keys.get(envelope.keyId);
  const timestamp = Date.parse(statementTimestamp);
  if (
    pinned === undefined ||
    timestamp < pinned.validFrom ||
    timestamp > pinned.validUntil ||
    (pinned.minimumTrustSequence !== undefined &&
      trustSequence !== undefined &&
      trustSequence < pinned.minimumTrustSequence)
  ) {
    throw new TrustedInstallError(
      "signature_invalid",
      "The Skill Press signing key is not authorized for this statement epoch.",
    );
  }
}

function validateCheckpointWindow(
  statement: SkillPressCurrentTrustCheckpoint,
  now: () => Date,
): void {
  rejectFutureTimestamp(statement.issuedAt, now);
  const issuedAt = Date.parse(statement.issuedAt);
  const expiresAt = Date.parse(statement.expiresAt);
  const current = now().getTime();
  if (
    !Number.isFinite(current) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 15 * 60 * 1000 ||
    expiresAt - current < 30 * 1000
  ) {
    throw new TrustedInstallError(
      "trust_rejected",
      "The signed current-trust checkpoint is expired or outside its freshness window.",
    );
  }
}

function rejectFutureTimestamp(value: string, now: () => Date): void {
  const current = now();
  const currentMilliseconds = current.getTime();
  if (
    !Number.isFinite(currentMilliseconds) ||
    new Date(currentMilliseconds).toISOString() !== current.toISOString() ||
    Date.parse(value) > currentMilliseconds + 5 * 60 * 1000
  ) {
    throw new TrustedInstallError(
      "registry_contract_invalid",
      "Skill Press returned a statement with an invalid future timestamp.",
    );
  }
}

export async function createTrustedSignatureVerifier(
  suppliedKeys: readonly SkillPressPinnedKey[] = SKILL_PRESS_PINNED_KEYS,
  now: () => Date = () => new Date(),
): Promise<TrustedSignatureVerifier> {
  if (!Array.isArray(suppliedKeys) || suppliedKeys.length < 1 || suppliedKeys.length > 32) {
    return keyError("No bounded Skill Press signing keyring is available.");
  }
  const imported = new Map<string, ImportedPinnedKey>();
  for (const supplied of suppliedKeys) {
    const pinned = validatePinnedKey(supplied);
    if (imported.has(pinned.keyId))
      return keyError("The Skill Press keyring has duplicate key IDs.");
    imported.set(
      pinned.keyId,
      Object.freeze({
        key: await importKey(pinned),
        roles: new Set(pinned.roles),
        validFrom: Date.parse(pinned.validFrom),
        validUntil: Date.parse(pinned.validUntil),
        ...(pinned.minimumTrustSequence === undefined
          ? {}
          : { minimumTrustSequence: pinned.minimumTrustSequence }),
      }),
    );
  }
  return Object.freeze({
    verifyAttestation: async (envelopeValue: unknown, expected: ExactSkillLocator) => {
      const envelope = await verifiedEnvelope(
        envelopeValue,
        "skillpress.signed-attestation",
        imported,
        "release-attestation",
      );
      const parsed = parseAttestationPayload(envelope.payload, expected);
      rejectFutureTimestamp(parsed.statement.issuedAt, now);
      assertKeyAuthorization(envelope, imported, parsed.statement.issuedAt);
      return Object.freeze({ envelope, statement: parsed.statement });
    },
    verifyTrust: async (envelopeValue: unknown, expected: ExactSkillLocator) => {
      const envelope = await verifiedEnvelope(
        envelopeValue,
        "skillpress.signed-trust",
        imported,
        "trust-event",
      );
      const parsed = parseTrustPayload(envelope.payload, expected);
      rejectFutureTimestamp(parsed.statement.updatedAt, now);
      assertKeyAuthorization(
        envelope,
        imported,
        parsed.statement.updatedAt,
        parsed.statement.sequence,
      );
      return Object.freeze({ envelope, statement: parsed.statement });
    },
    verifyCurrentTrust: async (envelopeValue: unknown, expected: ExactSkillLocator) => {
      const envelope = await verifiedEnvelope(
        envelopeValue,
        "skillpress.signed-current-trust",
        imported,
        "current-trust",
      );
      const parsed = parseCurrentTrustCheckpointPayload(envelope.payload, expected);
      validateCheckpointWindow(parsed.statement, now);
      assertKeyAuthorization(
        envelope,
        imported,
        parsed.statement.issuedAt,
        parsed.statement.trustSequence,
      );
      return Object.freeze({ envelope, statement: parsed.statement });
    },
  });
}
