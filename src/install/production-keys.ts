import type { SkillPressPinnedKey } from "./types.js";

/** Public release-verification roots. Private signing material never ships with the CLI. */
export const SKILL_PRESS_PINNED_KEYS: readonly SkillPressPinnedKey[] = Object.freeze([
  Object.freeze({
    keyId: "skill-press-p256-2026-08-01",
    roles: Object.freeze(["release-attestation"] as const),
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2027-08-31T23:59:59.999Z",
    jwk: Object.freeze({
      kty: "EC" as const,
      crv: "P-256" as const,
      x: "qzyanlW0oeOy_Q4COiJnHQ5NjKm-93tU55JL7OBG_Fk",
      y: "BsoledKUCElcx4UBr2ryWQT674f85fCYHD3lcgS1pXU",
    }),
  }),
  Object.freeze({
    keyId: "skill-press-trust-p256-2026-08-27",
    roles: Object.freeze(["trust-event"] as const),
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2027-08-31T23:59:59.999Z",
    minimumTrustSequence: 1,
    jwk: Object.freeze({
      kty: "EC" as const,
      crv: "P-256" as const,
      x: "isQaOWPA6lc9T2iG06kjRaPbW0slNZEfHSGeVW2QIec",
      y: "TE7FIngwr5pCQ4yYp3OVSh3IBLOv65QMQknP9vGpOQ8",
    }),
  }),
  Object.freeze({
    keyId: "skill-press-checkpoint-p256-2026-08-27",
    roles: Object.freeze(["current-trust"] as const),
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2027-08-31T23:59:59.999Z",
    minimumTrustSequence: 1,
    jwk: Object.freeze({
      kty: "EC" as const,
      crv: "P-256" as const,
      x: "x3lTSW8uTfrvd6s7ndO_F7oNlfTbDIteR3gDqObMOqU",
      y: "pcYDKdUgxwnKrI9T2xWPKkLUNWl-tFlGyQxIVeGxU-A",
    }),
  }),
]);
