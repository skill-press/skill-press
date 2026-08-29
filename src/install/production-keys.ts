import type { SkillPressPinnedKey } from "./types.js";

// Generated from production-public-keys.json (sha256:e5e07629046cbbcfbda788483ed66b1ca6b83d57d4407bb1d69372b64293efe7). Do not edit.
export const SKILL_PRESS_PINNED_KEYS: readonly SkillPressPinnedKey[] = Object.freeze([
  Object.freeze({
    keyId: "skill-press-attestation-p256-2026-08-28",
    roles: Object.freeze(["release-attestation"] as const),
    validFrom: "2026-08-28T00:00:00.000Z",
    validUntil: "2027-08-31T23:59:59.999Z",
    jwk: Object.freeze({
      kty: "EC" as const,
      crv: "P-256" as const,
      x: "xKRn71aQ0xRJKlbJ6RnD-QI3TrMxwuflWwRB3SqZSXA",
      y: "3TwtdsHRW2TtbB-Eo9jn5XzAVMNvlRIQOevLWNHIr5E",
    }),
  }),
  Object.freeze({
    keyId: "skill-press-trust-p256-2026-08-28",
    roles: Object.freeze(["trust-event"] as const),
    validFrom: "2026-08-28T00:00:00.000Z",
    validUntil: "2027-08-31T23:59:59.999Z",
    minimumTrustSequence: 1,
    jwk: Object.freeze({
      kty: "EC" as const,
      crv: "P-256" as const,
      x: "6yRTecGuBpgkQ92mCCfiecwRLTt9Sh_xsEl-kvDXdMU",
      y: "NAiztMcKaBORuitUXP9ud3CbD7iaGiDqbPfsQeHTd3U",
    }),
  }),
  Object.freeze({
    keyId: "skill-press-checkpoint-p256-2026-08-28",
    roles: Object.freeze(["current-trust"] as const),
    validFrom: "2026-08-28T00:00:00.000Z",
    validUntil: "2027-08-31T23:59:59.999Z",
    minimumTrustSequence: 1,
    jwk: Object.freeze({
      kty: "EC" as const,
      crv: "P-256" as const,
      x: "B7rDCK6fDyvL10ebdTCAGe87zpTzD6eA0ZPL-wOWMK0",
      y: "OZ17e9aIdiX6S8Kj8r8P5jHy3ul-5p2ESoy6ur0mRbE",
    }),
  }),
]);
