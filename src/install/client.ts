import { createHash } from "node:crypto";

import { parseJsonBytes, parseReleaseResource } from "./contract.js";
import { TrustedInstallError } from "./errors.js";
import { parseExactSkillLocator, releaseApiPath } from "./locator.js";
import { createTrustedSignatureVerifier } from "./signatures.js";
import {
  type ExactSkillLocator,
  SKILL_PRESS_INSTALL_API_BASE,
  type SkillPressCurrentTrustCheckpoint,
  type SkillPressPinnedKey,
  type SkillPressReleaseAttestation,
  type SkillPressReleaseResource,
  type SkillPressSignedEnvelope,
  type SkillPressTrustStatement,
} from "./types.js";

export interface CanonicalInstallClientOptions {
  readonly fetcher?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly keyring?: readonly SkillPressPinnedKey[];
  readonly now?: () => Date;
}

export interface VerifiedSkillRelease {
  readonly locator: ExactSkillLocator;
  readonly release: SkillPressReleaseResource;
  readonly artifactBytes: Buffer;
  readonly attestation: {
    readonly envelope: SkillPressSignedEnvelope;
    readonly statement: SkillPressReleaseAttestation;
  };
  readonly trust: {
    readonly envelope: SkillPressSignedEnvelope;
    readonly envelopeSha256: string;
    readonly statement: SkillPressTrustStatement & { readonly status: "trusted" };
  };
}

export interface VerifiedCurrentTrustCheckpoint {
  readonly envelope: SkillPressSignedEnvelope;
  readonly statement: SkillPressCurrentTrustCheckpoint & { readonly trustStatus: "trusted" };
}

export interface CanonicalInstallClient {
  readonly resolve: (
    locator: string,
    minimumTrustSequence?: number,
  ) => Promise<VerifiedSkillRelease>;
  readonly verifyCurrentTrust: (
    release: VerifiedSkillRelease,
  ) => Promise<VerifiedCurrentTrustCheckpoint>;
  readonly assertCurrentTrustFresh: (checkpoint: VerifiedCurrentTrustCheckpoint) => void;
}

const MAX_METADATA_BYTES = 256 * 1024;

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function contentType(response: Response): string | undefined {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

async function boundedBody(
  response: Response,
  maximum: number,
  interruptedCode: "artifact_unavailable" | "registry_unavailable",
): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const advertisedLength = response.headers.get("content-length");
  const capacity = advertisedLength === null ? maximum : Number(advertisedLength);
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > maximum) {
    await reader.cancel();
    throw new TrustedInstallError(
      "registry_contract_invalid",
      "Skill Press returned an invalid response length.",
    );
  }
  // Retain one bounded allocation rather than an attacker-controlled number of tiny chunks and
  // a second full-size Buffer.concat allocation for a signed release artifact.
  const bytes = Buffer.alloc(capacity);
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > capacity) {
        await reader.cancel();
        throw new TrustedInstallError(
          "response_oversized",
          "Skill Press returned more data than its signed size limit allows.",
        );
      }
      bytes.set(part.value, total - part.value.byteLength);
    }
    if (advertisedLength !== null && total !== capacity) {
      throw new TrustedInstallError(
        "registry_contract_invalid",
        "Skill Press returned a body that did not match Content-Length.",
      );
    }
  } catch (error) {
    if (error instanceof TrustedInstallError) throw error;
    try {
      await reader.cancel();
    } catch {
      // Preserve the interrupted-response classification.
    }
    throw new TrustedInstallError(interruptedCode, "A Skill Press response was interrupted.");
  }
  return bytes.subarray(0, total);
}

function validContentLength(response: Response, expected?: number): boolean {
  const header = response.headers.get("content-length");
  if (header === null) return true;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(header)) return false;
  const value = Number(header);
  return (
    Number.isSafeInteger(value) && value >= 0 && (expected === undefined || value === expected)
  );
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the transport-contract error that caused cancellation.
  }
}

async function assertResponse(
  response: Response,
  url: string,
  expectedType: "application/json" | "application/zip",
  expectedLength?: number,
  requireFresh = false,
): Promise<void> {
  if (response.status !== 200) {
    await cancelResponseBody(response);
    throw new TrustedInstallError(
      "registry_rejected",
      `Skill Press rejected a release request with HTTP ${response.status}.`,
    );
  }
  if (
    response.redirected ||
    (response.url !== "" && response.url !== url) ||
    contentType(response) !== expectedType ||
    response.headers.has("content-encoding") ||
    !validContentLength(response, expectedLength) ||
    (requireFresh &&
      (!response.headers
        .get("cache-control")
        ?.split(",")
        .some((directive) => directive.trim().toLowerCase() === "no-store") ||
        (response.headers.get("age") !== null && response.headers.get("age") !== "0")))
  ) {
    await cancelResponseBody(response);
    throw new TrustedInstallError(
      "registry_contract_invalid",
      "Skill Press returned a response with unsafe transport metadata.",
    );
  }
}

function timeout(options: CanonicalInstallClientOptions): number {
  const value = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new TrustedInstallError(
      "registry_contract_invalid",
      "The Skill Press installation timeout is invalid.",
    );
  }
  return value;
}

/** Create a read-only release client whose network origin cannot be configured. */
export function createCanonicalInstallClient(
  options: CanonicalInstallClientOptions = {},
): CanonicalInstallClient {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());
  const timeoutMs = timeout(options);
  let verifierPromise: ReturnType<typeof createTrustedSignatureVerifier> | undefined;
  const get = async (
    url: string,
    expectedType: "application/json" | "application/zip",
    maximum: number,
    expectedLength?: number,
    requireFresh = false,
  ): Promise<Buffer> => {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: expectedType,
          "accept-encoding": "identity",
          "cache-control": "no-cache, no-store, max-age=0",
          "skill-press-protocol-version": "1",
        },
      });
    } catch (error) {
      if (error instanceof TrustedInstallError) throw error;
      throw new TrustedInstallError(
        expectedType === "application/zip" ? "artifact_unavailable" : "registry_unavailable",
        "The canonical Skill Press registry is unavailable.",
      );
    }
    await assertResponse(response, url, expectedType, expectedLength, requireFresh);
    return boundedBody(
      response,
      maximum,
      expectedType === "application/zip" ? "artifact_unavailable" : "registry_unavailable",
    );
  };

  return Object.freeze({
    resolve: async (locatorValue: string, minimumTrustSequence = 0) => {
      const locator = parseExactSkillLocator(locatorValue);
      if (
        !Number.isSafeInteger(minimumTrustSequence) ||
        minimumTrustSequence < 0 ||
        minimumTrustSequence > Number.MAX_SAFE_INTEGER
      ) {
        throw new TrustedInstallError("lock_invalid", "The locked trust sequence is invalid.");
      }
      const resolverUrl = `${SKILL_PRESS_INSTALL_API_BASE}/releases/${releaseApiPath(locator)}`;
      const releaseBytes = await get(
        resolverUrl,
        "application/json",
        MAX_METADATA_BYTES,
        undefined,
        true,
      );
      const release = parseReleaseResource(
        parseJsonBytes(releaseBytes, "release resource"),
        locator,
      );
      if (release.trust.status !== "trusted") {
        throw new TrustedInstallError(
          "trust_rejected",
          `Skill Press marks ${locator.locator} as ${release.trust.status}.`,
        );
      }

      const attestationBytes = await get(
        release.attestation.url,
        "application/json",
        MAX_METADATA_BYTES,
      );
      if (sha256(attestationBytes) !== release.attestation.sha256) {
        throw new TrustedInstallError(
          "signature_invalid",
          "The release attestation digest did not match its resolver binding.",
        );
      }
      verifierPromise ??= createTrustedSignatureVerifier(options.keyring, now);
      const verifier = await verifierPromise;
      const attestation = await verifier.verifyAttestation(
        parseJsonBytes(attestationBytes, "attestation"),
        locator,
      );
      if (
        attestation.envelope.keyId !== release.attestation.keyId ||
        attestation.statement.artifactSha256 !== release.artifact.sha256 ||
        attestation.statement.artifactBytes !== release.artifact.bytes ||
        attestation.statement.artifactMediaType !== release.artifact.mediaType
      ) {
        throw new TrustedInstallError(
          "registry_contract_invalid",
          "The signed attestation did not bind the resolved artifact.",
        );
      }

      const artifactBytes = await get(
        release.artifact.url,
        "application/zip",
        release.artifact.bytes,
        release.artifact.bytes,
      );
      if (
        artifactBytes.byteLength !== release.artifact.bytes ||
        sha256(artifactBytes) !== release.artifact.sha256
      ) {
        throw new TrustedInstallError(
          "artifact_invalid",
          "The downloaded artifact did not match its signed digest and size.",
        );
      }

      // Trust is intentionally fetched last so a revocation races ahead of local installation.
      const trustBytes = await get(
        release.trust.url,
        "application/json",
        MAX_METADATA_BYTES,
        undefined,
        true,
      );
      const trust = await verifier.verifyTrust(
        parseJsonBytes(trustBytes, "trust statement"),
        locator,
      );
      if (
        trust.envelope.keyId !== release.trust.keyId ||
        trust.statement.artifactSha256 !== release.artifact.sha256 ||
        trust.statement.attestationSha256 !== release.attestation.sha256 ||
        trust.statement.sequence < release.trust.sequence ||
        trust.statement.sequence < minimumTrustSequence ||
        Date.parse(trust.statement.updatedAt) < Date.parse(release.trust.updatedAt)
      ) {
        throw new TrustedInstallError(
          trust.statement.sequence < minimumTrustSequence ? "lock_rollback" : "trust_rejected",
          "The signed trust statement did not match the release or moved backwards.",
        );
      }
      if (
        trust.statement.sequence === release.trust.sequence &&
        (trust.statement.status !== release.trust.status ||
          trust.statement.updatedAt !== release.trust.updatedAt)
      ) {
        throw new TrustedInstallError(
          "trust_rejected",
          "The resolver trust summary did not match the signed trust statement.",
        );
      }
      if (trust.statement.status !== "trusted") {
        throw new TrustedInstallError(
          "trust_rejected",
          `Skill Press marks ${locator.locator} as ${trust.statement.status}.`,
        );
      }
      if (Date.parse(trust.statement.updatedAt) < Date.parse(attestation.statement.issuedAt)) {
        throw new TrustedInstallError(
          "trust_rejected",
          "The trust statement predates its release attestation.",
        );
      }

      return Object.freeze({
        locator,
        release,
        artifactBytes,
        attestation,
        trust: Object.freeze({
          envelope: trust.envelope,
          envelopeSha256: sha256(trustBytes),
          statement: trust.statement as SkillPressTrustStatement & { readonly status: "trusted" },
        }),
      });
    },
    verifyCurrentTrust: async (verifiedRelease: VerifiedSkillRelease) => {
      const release = parseReleaseResource(verifiedRelease.release, verifiedRelease.locator);
      const checkpointBytes = await get(
        release.checkpoint.url,
        "application/json",
        MAX_METADATA_BYTES,
        undefined,
        true,
      );
      verifierPromise ??= createTrustedSignatureVerifier(options.keyring, now);
      const verifier = await verifierPromise;
      const checkpoint = await verifier.verifyCurrentTrust(
        parseJsonBytes(checkpointBytes, "current-trust checkpoint"),
        verifiedRelease.locator,
      );
      const statement = checkpoint.statement;
      if (
        checkpoint.envelope.keyId !== release.checkpoint.keyId ||
        statement.artifactSha256 !== release.artifact.sha256 ||
        statement.attestationSha256 !== release.attestation.sha256 ||
        statement.trustSequence !== verifiedRelease.trust.statement.sequence ||
        statement.trustStatus !== verifiedRelease.trust.statement.status ||
        statement.trustUpdatedAt !== verifiedRelease.trust.statement.updatedAt ||
        statement.trustEnvelopeSha256 !== verifiedRelease.trust.envelopeSha256 ||
        Date.parse(statement.issuedAt) < Date.parse(statement.trustUpdatedAt)
      ) {
        throw new TrustedInstallError(
          "trust_rejected",
          "The signed current-trust checkpoint did not bind the verified release state.",
        );
      }
      if (statement.trustStatus !== "trusted") {
        throw new TrustedInstallError(
          "trust_rejected",
          `Skill Press currently marks ${verifiedRelease.locator.locator} as ${statement.trustStatus}.`,
        );
      }
      return Object.freeze({
        envelope: checkpoint.envelope,
        statement: statement as SkillPressCurrentTrustCheckpoint & {
          readonly trustStatus: "trusted";
        },
      });
    },
    assertCurrentTrustFresh: (checkpoint: VerifiedCurrentTrustCheckpoint) => {
      const current = now();
      const milliseconds = current.getTime();
      if (
        !Number.isFinite(milliseconds) ||
        new Date(milliseconds).toISOString() !== current.toISOString() ||
        Date.parse(checkpoint.statement.expiresAt) - milliseconds < 30 * 1000
      ) {
        throw new TrustedInstallError(
          "trust_rejected",
          "The signed current-trust checkpoint expired before installation activation.",
        );
      }
    },
  });
}
