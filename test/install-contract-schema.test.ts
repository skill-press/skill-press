import { readFile } from "node:fs/promises";

import { Ajv, type ValidateFunction } from "ajv";
import { beforeAll, describe, expect, it } from "vitest";

import { parseExactSkillLocator } from "../src/install/locator.js";

const digest = (value: string): string => value.repeat(64);
const locator = "skill-press/example@1.2.3-alpha.1+build.01";

const release = {
  schemaVersion: 1,
  resourceType: "skillpress.release",
  locator,
  namespace: "skill-press",
  skill: "example",
  version: "1.2.3-alpha.1+build.01",
  artifact: {
    url: "https://skill-press.com/artifacts/skill-press/example/1.2.3-alpha.1%2Bbuild.01",
    sha256: digest("a"),
    bytes: 123,
    mediaType: "application/zip",
  },
  attestation: {
    url: "https://skill-press.com/attestations/skill-press/example/1.2.3-alpha.1%2Bbuild.01",
    sha256: digest("b"),
    keyId: "skill-press-p256-2026-08-01",
    algorithm: "ES256",
  },
  trust: {
    url: "https://skill-press.com/trust/skill-press/example/1.2.3-alpha.1%2Bbuild.01",
    sequence: 2,
    status: "trusted",
    updatedAt: "2026-08-27T12:00:00.000Z",
    keyId: "skill-press-trust-p256-2026-08-27",
    algorithm: "ES256",
  },
  checkpoint: {
    url: "https://skill-press.com/checkpoints/skill-press/example/1.2.3-alpha.1%2Bbuild.01",
    keyId: "skill-press-checkpoint-p256-2026-08-27",
    algorithm: "ES256",
  },
};

const attestation = {
  schemaVersion: 1,
  statementType: "skillpress.release-attestation",
  locator,
  namespace: "skill-press",
  skill: "example",
  version: "1.2.3-alpha.1+build.01",
  artifactSha256: digest("a"),
  artifactBytes: 123,
  artifactMediaType: "application/zip",
  issuedAt: "2026-08-27T11:00:00.000Z",
  submissionId: `submission_${"1".repeat(32)}`,
  automatedReviewSha256: digest("c"),
  curatorDecisionSha256: digest("d"),
};

const trust = {
  schemaVersion: 1,
  statementType: "skillpress.trust-statement",
  locator,
  namespace: "skill-press",
  skill: "example",
  version: "1.2.3-alpha.1+build.01",
  artifactSha256: digest("a"),
  attestationSha256: digest("b"),
  sequence: 2,
  status: "trusted",
  updatedAt: "2026-08-27T12:00:00.000Z",
};

const checkpoint = {
  schemaVersion: 1,
  statementType: "skillpress.current-trust-checkpoint",
  locator,
  namespace: "skill-press",
  skill: "example",
  version: "1.2.3-alpha.1+build.01",
  artifactSha256: digest("a"),
  attestationSha256: digest("b"),
  trustSequence: 2,
  trustStatus: "trusted",
  trustUpdatedAt: "2026-08-27T12:00:00.000Z",
  trustEnvelopeSha256: digest("e"),
  issuedAt: "2026-08-27T12:00:01.000Z",
  expiresAt: "2026-08-27T12:10:01.000Z",
};

const envelope = {
  schemaVersion: 1,
  envelopeType: "skillpress.signed-current-trust",
  keyId: "skill-press-checkpoint-p256-2026-08-27",
  algorithm: "ES256",
  payload: "eyJzY2hlbWFWZXJzaW9uIjoxfQ",
  signature: "a".repeat(86),
};

describe("public trusted-install schemas", () => {
  const validators = new Map<string, ValidateFunction>();

  beforeAll(async () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    for (const name of [
      "release-resource",
      "release-attestation",
      "trust-statement",
      "current-trust-checkpoint",
      "signed-envelope",
    ]) {
      const source = await readFile(
        new URL(`../schemas/${name}.schema.json`, import.meta.url),
        "utf8",
      );
      validators.set(name, ajv.compile(JSON.parse(source) as object));
    }
  });

  it.each([
    ["release-resource", release],
    ["release-attestation", attestation],
    ["trust-statement", trust],
    ["current-trust-checkpoint", checkpoint],
    ["signed-envelope", envelope],
  ])("accepts a canonical %s contract", (name, value) => {
    expect(validators.get(name)?.(structuredClone(value))).toBe(true);
  });

  it("rejects non-canonical SemVer in every locator-bearing contract", () => {
    for (const [name, original] of [
      ["release-resource", release],
      ["release-attestation", attestation],
      ["trust-statement", trust],
      ["current-trust-checkpoint", checkpoint],
    ] as const) {
      const value = structuredClone(original) as { version: string; locator: string };
      value.version = "1.2.3-01";
      value.locator = "skill-press/example@1.2.3-01";
      expect(validators.get(name)?.(value), name).toBe(false);
    }
  });

  it("rejects extension fields, unbounded artifacts, and padded signature material", () => {
    expect(validators.get("release-resource")?.({ ...release, unexpected: true })).toBe(false);
    expect(
      validators.get("release-resource")?.({
        ...release,
        artifact: { ...release.artifact, bytes: 67_108_865 },
      }),
    ).toBe(false);
    expect(validators.get("signed-envelope")?.({ ...envelope, signature: "abc=" })).toBe(false);
  });

  it("accepts the exact 258-character locator boundary and rejects longer input", () => {
    const namespace = "n".repeat(64);
    const skill = "s".repeat(64);
    const version = `1.0.0+${"a".repeat(122)}`;
    const maximum = `${namespace}/${skill}@${version}`;

    expect(maximum).toHaveLength(258);
    expect(parseExactSkillLocator(maximum)).toEqual({
      locator: maximum,
      namespace,
      skill,
      version,
    });
    expect(() => parseExactSkillLocator(`${maximum}a`)).toThrow("namespace/skill@exact-semver");
  });
});
