import { TextDecoder } from "node:util";

import { TrustedInstallError } from "./errors.js";
import { isExactSemver, isSkillPressName, releaseApiPath } from "./locator.js";
import {
  type ExactSkillLocator,
  SKILL_PRESS_INSTALL_ORIGIN,
  type SkillPressCurrentTrustCheckpoint,
  type SkillPressReleaseAttestation,
  type SkillPressReleaseResource,
  type SkillPressSignedEnvelope,
  type SkillPressTrustStatement,
  type SkillPressTrustStatus,
} from "./types.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const KEY_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const REASON_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/u;
const BASE64URL_PATTERN = /^(?:[A-Za-z0-9_-]{2,})$/u;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });
const ABSENT = Symbol("absent");

type JsonRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new TrustedInstallError("registry_contract_invalid", message);
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`Skill Press returned an invalid ${label}.`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const expected = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !expected.has(key))
  ) {
    invalid("Skill Press returned JSON with an unexpected shape.");
  }
}

function property(value: JsonRecord, name: string): unknown {
  return Object.hasOwn(value, name) ? value[name] : ABSENT;
}

function string(value: unknown, label: string): string {
  return typeof value === "string" ? value : invalid(`Skill Press returned an invalid ${label}.`);
}

function literal<T extends string | number>(value: unknown, expected: T, label: string): T {
  return value === expected ? expected : invalid(`Skill Press returned an invalid ${label}.`);
}

function digest(value: unknown, label: string): string {
  const candidate = string(value, label);
  return DIGEST_PATTERN.test(candidate)
    ? candidate
    : invalid(`Skill Press returned an invalid ${label}.`);
}

function positiveInteger(value: unknown, label: string): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : invalid(`Skill Press returned an invalid ${label}.`);
}

function timestamp(value: unknown, label: string): string {
  const candidate = string(value, label);
  const milliseconds = Date.parse(candidate);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === candidate
    ? candidate
    : invalid(`Skill Press returned an invalid ${label}.`);
}

function keyId(value: unknown): string {
  const candidate = string(value, "signing key ID");
  return candidate.length <= 128 && KEY_ID_PATTERN.test(candidate)
    ? candidate
    : invalid("Skill Press returned an invalid signing key ID.");
}

function trustStatus(value: unknown): SkillPressTrustStatus {
  return value === "trusted" || value === "quarantined" || value === "revoked"
    ? value
    : invalid("Skill Press returned an unknown trust status.");
}

function boundLocator(value: JsonRecord, expected: ExactSkillLocator): ExactSkillLocator {
  const locator = string(property(value, "locator"), "locator");
  const namespace = string(property(value, "namespace"), "namespace");
  const skill = string(property(value, "skill"), "skill name");
  const version = string(property(value, "version"), "version");
  if (
    locator !== expected.locator ||
    namespace !== expected.namespace ||
    skill !== expected.skill ||
    version !== expected.version ||
    !isSkillPressName(namespace) ||
    !isSkillPressName(skill) ||
    !isExactSemver(version)
  ) {
    invalid("Skill Press returned a resource bound to a different locator.");
  }
  return expected;
}

function expectedPublicUrl(
  kind: "artifacts" | "attestations" | "checkpoints" | "trust",
  path: string,
): string {
  return `${SKILL_PRESS_INSTALL_ORIGIN}/${kind}/${path}`;
}

export function parseReleaseResource(
  value: unknown,
  expected: ExactSkillLocator,
): SkillPressReleaseResource {
  const release = record(value, "release resource");
  exactKeys(release, [
    "schemaVersion",
    "resourceType",
    "locator",
    "namespace",
    "skill",
    "version",
    "artifact",
    "attestation",
    "trust",
    "checkpoint",
  ]);
  literal(property(release, "schemaVersion"), 1, "release schema version");
  literal(property(release, "resourceType"), "skillpress.release", "release type");
  boundLocator(release, expected);
  const path = releaseApiPath(expected);

  const artifactValue = record(property(release, "artifact"), "artifact binding");
  exactKeys(artifactValue, ["url", "sha256", "bytes", "mediaType"]);
  const artifactUrl = string(property(artifactValue, "url"), "artifact URL");
  const artifactSha256 = digest(property(artifactValue, "sha256"), "artifact digest");
  const artifactBytes = positiveInteger(property(artifactValue, "bytes"), "artifact size");
  if (artifactUrl !== expectedPublicUrl("artifacts", path) || artifactBytes > 64 * 1024 * 1024) {
    invalid("Skill Press returned an unsafe artifact binding.");
  }
  literal(property(artifactValue, "mediaType"), "application/zip", "artifact media type");

  const attestationValue = record(property(release, "attestation"), "attestation binding");
  exactKeys(attestationValue, ["url", "sha256", "keyId", "algorithm"]);
  const attestationUrl = string(property(attestationValue, "url"), "attestation URL");
  const attestationSha256 = digest(property(attestationValue, "sha256"), "attestation digest");
  const attestationKeyId = keyId(property(attestationValue, "keyId"));
  if (attestationUrl !== expectedPublicUrl("attestations", path)) {
    invalid("Skill Press returned a non-canonical attestation URL.");
  }
  literal(property(attestationValue, "algorithm"), "ES256", "attestation algorithm");

  const trustValue = record(property(release, "trust"), "trust binding");
  exactKeys(trustValue, ["url", "sequence", "status", "updatedAt", "keyId", "algorithm"]);
  const trustUrl = string(property(trustValue, "url"), "trust URL");
  const sequence = positiveInteger(property(trustValue, "sequence"), "trust sequence");
  const status = trustStatus(property(trustValue, "status"));
  const updatedAt = timestamp(property(trustValue, "updatedAt"), "trust timestamp");
  const trustKeyId = keyId(property(trustValue, "keyId"));
  if (trustUrl !== expectedPublicUrl("trust", path)) {
    invalid("Skill Press returned a non-canonical trust URL.");
  }
  literal(property(trustValue, "algorithm"), "ES256", "trust algorithm");

  const checkpointValue = record(property(release, "checkpoint"), "current-trust checkpoint");
  exactKeys(checkpointValue, ["url", "keyId", "algorithm"]);
  const checkpointUrl = string(property(checkpointValue, "url"), "checkpoint URL");
  const checkpointKeyId = keyId(property(checkpointValue, "keyId"));
  if (checkpointUrl !== expectedPublicUrl("checkpoints", path)) {
    invalid("Skill Press returned a non-canonical checkpoint URL.");
  }
  literal(property(checkpointValue, "algorithm"), "ES256", "checkpoint algorithm");

  return deepFreeze({
    schemaVersion: 1,
    resourceType: "skillpress.release",
    ...expected,
    artifact: {
      url: artifactUrl,
      sha256: artifactSha256,
      bytes: artifactBytes,
      mediaType: "application/zip",
    },
    attestation: {
      url: attestationUrl,
      sha256: attestationSha256,
      keyId: attestationKeyId,
      algorithm: "ES256",
    },
    trust: {
      url: trustUrl,
      sequence,
      status,
      updatedAt,
      keyId: trustKeyId,
      algorithm: "ES256",
    },
    checkpoint: {
      url: checkpointUrl,
      keyId: checkpointKeyId,
      algorithm: "ES256",
    },
  });
}

export function parseSignedEnvelope(
  value: unknown,
  expectedType: SkillPressSignedEnvelope["envelopeType"],
): SkillPressSignedEnvelope {
  const envelope = record(value, "signed envelope");
  exactKeys(envelope, [
    "schemaVersion",
    "envelopeType",
    "keyId",
    "algorithm",
    "payload",
    "signature",
  ]);
  literal(property(envelope, "schemaVersion"), 1, "envelope schema version");
  literal(property(envelope, "envelopeType"), expectedType, "envelope type");
  const parsedKeyId = keyId(property(envelope, "keyId"));
  literal(property(envelope, "algorithm"), "ES256", "signature algorithm");
  const payload = string(property(envelope, "payload"), "signed payload");
  const signature = string(property(envelope, "signature"), "signature");
  if (
    payload.length > 16 * 1024 ||
    signature.length > 256 ||
    !BASE64URL_PATTERN.test(payload) ||
    !BASE64URL_PATTERN.test(signature) ||
    payload.includes("=") ||
    signature.includes("=")
  ) {
    invalid("Skill Press returned malformed base64url signature material.");
  }
  return Object.freeze({
    schemaVersion: 1,
    envelopeType: expectedType,
    keyId: parsedKeyId,
    algorithm: "ES256",
    payload,
    signature,
  });
}

function decodePayload(value: string): { readonly bytes: Buffer; readonly parsed: unknown } {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength === 0 || bytes.toString("base64url") !== value) {
    invalid("Skill Press returned a non-canonical signed payload encoding.");
  }
  let text: string;
  try {
    text = FATAL_UTF8.decode(bytes);
  } catch {
    return invalid("Skill Press returned a signed payload with invalid UTF-8.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid("Skill Press returned a signed payload with invalid JSON.");
  }
  return { bytes, parsed };
}

export function parseAttestationPayload(
  encoded: string,
  expected: ExactSkillLocator,
): { readonly bytes: Buffer; readonly statement: SkillPressReleaseAttestation } {
  const decoded = decodePayload(encoded);
  const payload = record(decoded.parsed, "attestation payload");
  exactKeys(payload, [
    "schemaVersion",
    "statementType",
    "locator",
    "namespace",
    "skill",
    "version",
    "artifactSha256",
    "artifactBytes",
    "artifactMediaType",
    "issuedAt",
    "submissionId",
    "automatedReviewSha256",
    "curatorDecisionSha256",
  ]);
  literal(property(payload, "schemaVersion"), 1, "attestation schema version");
  literal(
    property(payload, "statementType"),
    "skillpress.release-attestation",
    "attestation statement type",
  );
  boundLocator(payload, expected);
  const statement: SkillPressReleaseAttestation = {
    schemaVersion: 1,
    statementType: "skillpress.release-attestation",
    ...expected,
    artifactSha256: digest(property(payload, "artifactSha256"), "artifact digest"),
    artifactBytes: positiveInteger(property(payload, "artifactBytes"), "artifact size"),
    artifactMediaType: literal(
      property(payload, "artifactMediaType"),
      "application/zip",
      "artifact media type",
    ),
    issuedAt: timestamp(property(payload, "issuedAt"), "attestation timestamp"),
    submissionId: string(property(payload, "submissionId"), "submission ID"),
    automatedReviewSha256: digest(
      property(payload, "automatedReviewSha256"),
      "automated review digest",
    ),
    curatorDecisionSha256: digest(
      property(payload, "curatorDecisionSha256"),
      "curator decision digest",
    ),
  };
  if (!ID_PATTERN.test(statement.submissionId)) {
    invalid("Skill Press returned an invalid submission binding.");
  }
  assertCanonicalPayload(decoded.bytes, statement);
  return Object.freeze({ bytes: decoded.bytes, statement: deepFreeze(statement) });
}

export function parseTrustPayload(
  encoded: string,
  expected: ExactSkillLocator,
): { readonly bytes: Buffer; readonly statement: SkillPressTrustStatement } {
  const decoded = decodePayload(encoded);
  const payload = record(decoded.parsed, "trust payload");
  exactKeys(
    payload,
    [
      "schemaVersion",
      "statementType",
      "locator",
      "namespace",
      "skill",
      "version",
      "artifactSha256",
      "attestationSha256",
      "sequence",
      "status",
      "updatedAt",
    ],
    ["reasonCode"],
  );
  literal(property(payload, "schemaVersion"), 1, "trust schema version");
  literal(property(payload, "statementType"), "skillpress.trust-statement", "trust statement type");
  boundLocator(payload, expected);
  const reasonValue = property(payload, "reasonCode");
  let reasonCode: string | undefined;
  if (reasonValue !== ABSENT) {
    reasonCode = string(reasonValue, "trust reason code");
    if (reasonCode.length > 64 || !REASON_PATTERN.test(reasonCode)) {
      invalid("Skill Press returned an invalid trust reason code.");
    }
  }
  const base = {
    schemaVersion: 1 as const,
    statementType: "skillpress.trust-statement" as const,
    ...expected,
    artifactSha256: digest(property(payload, "artifactSha256"), "artifact digest"),
    attestationSha256: digest(property(payload, "attestationSha256"), "attestation digest"),
    sequence: positiveInteger(property(payload, "sequence"), "trust sequence"),
    status: trustStatus(property(payload, "status")),
    updatedAt: timestamp(property(payload, "updatedAt"), "trust timestamp"),
  };
  const statement: SkillPressTrustStatement =
    reasonCode === undefined ? base : { ...base, reasonCode };
  assertCanonicalPayload(decoded.bytes, statement);
  return Object.freeze({ bytes: decoded.bytes, statement: deepFreeze(statement) });
}

export function parseCurrentTrustCheckpointPayload(
  encoded: string,
  expected: ExactSkillLocator,
): { readonly bytes: Buffer; readonly statement: SkillPressCurrentTrustCheckpoint } {
  const decoded = decodePayload(encoded);
  const payload = record(decoded.parsed, "current-trust checkpoint payload");
  exactKeys(payload, [
    "schemaVersion",
    "statementType",
    "locator",
    "namespace",
    "skill",
    "version",
    "artifactSha256",
    "attestationSha256",
    "trustSequence",
    "trustStatus",
    "trustUpdatedAt",
    "trustEnvelopeSha256",
    "issuedAt",
    "expiresAt",
  ]);
  literal(property(payload, "schemaVersion"), 1, "checkpoint schema version");
  literal(
    property(payload, "statementType"),
    "skillpress.current-trust-checkpoint",
    "checkpoint statement type",
  );
  boundLocator(payload, expected);
  const statement: SkillPressCurrentTrustCheckpoint = {
    schemaVersion: 1,
    statementType: "skillpress.current-trust-checkpoint",
    ...expected,
    artifactSha256: digest(property(payload, "artifactSha256"), "artifact digest"),
    attestationSha256: digest(property(payload, "attestationSha256"), "attestation digest"),
    trustSequence: positiveInteger(property(payload, "trustSequence"), "trust sequence"),
    trustStatus: trustStatus(property(payload, "trustStatus")),
    trustUpdatedAt: timestamp(property(payload, "trustUpdatedAt"), "trust timestamp"),
    trustEnvelopeSha256: digest(property(payload, "trustEnvelopeSha256"), "trust envelope digest"),
    issuedAt: timestamp(property(payload, "issuedAt"), "checkpoint issuance timestamp"),
    expiresAt: timestamp(property(payload, "expiresAt"), "checkpoint expiration timestamp"),
  };
  assertCanonicalPayload(decoded.bytes, statement);
  return Object.freeze({ bytes: decoded.bytes, statement: deepFreeze(statement) });
}

function assertCanonicalPayload(bytes: Buffer, statement: object): void {
  if (!bytes.equals(Buffer.from(JSON.stringify(statement), "utf8"))) {
    invalid("Skill Press returned a signed payload that was not canonical JSON.");
  }
}

export function parseJsonBytes(bytes: Buffer, label: string): unknown {
  let text: string;
  try {
    text = FATAL_UTF8.decode(bytes);
  } catch {
    return invalid(`Skill Press returned invalid UTF-8 for ${label}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return invalid(`Skill Press returned invalid JSON for ${label}.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
