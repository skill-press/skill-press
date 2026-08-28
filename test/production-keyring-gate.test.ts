import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyProductionKeyring } from "../scripts/verify-production-keyring.mjs";

const jwks = [
  {
    kty: "EC",
    crv: "P-256",
    x: "AHqLCmaxvXq_7sU69JJyis5wrlfx-AIUfiWKmprXQsY",
    y: "zYverufiuTsWxLFBhy2xx8kLh2n_kXpzdbvtjlWa5Yk",
  },
  {
    kty: "EC",
    crv: "P-256",
    x: "enFmYV8R4qqUlsQ6DpFkhZk3UFy13298BQjKFem0OvY",
    y: "AjEnFqN9jHfVXF3He3g5eqT31tBbsFWDXFBS1e-kEPY",
  },
  {
    kty: "EC",
    crv: "P-256",
    x: "Ak4_QJbzmDh2X3Gzo5eKa3Ds-SCUBP_7zd6-_bgDGUU",
    y: "wjjpQZYZBH4PK0DiivyGLgZ0dRknLkjzADQ31CITqCY",
  },
] as const;

function thumbprint(jwk: (typeof jwks)[number]): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y }))
    .digest("hex");
}

function manifest() {
  return {
    schemaVersion: 1,
    keyringType: "skillpress.production-signing-keyring",
    keys: [
      {
        role: "release-attestation",
        binding: "ATTESTATION_SIGNING_PRIVATE_JWK",
        keyId: "skill-press-attestation-p256-2026-08-28",
        validFrom: "2026-08-28T00:00:00.000Z",
        validUntil: "2027-08-31T23:59:59.999Z",
        jwk: jwks[0],
        thumbprintSha256: thumbprint(jwks[0]),
      },
      {
        role: "trust-event",
        binding: "TRUST_SIGNING_PRIVATE_JWK",
        keyId: "skill-press-trust-p256-2026-08-28",
        validFrom: "2026-08-28T00:00:00.000Z",
        validUntil: "2027-08-31T23:59:59.999Z",
        minimumTrustSequence: 1,
        jwk: jwks[1],
        thumbprintSha256: thumbprint(jwks[1]),
      },
      {
        role: "current-trust",
        binding: "CHECKPOINT_SIGNING_PRIVATE_JWK",
        keyId: "skill-press-checkpoint-p256-2026-08-28",
        validFrom: "2026-08-28T00:00:00.000Z",
        validUntil: "2027-08-31T23:59:59.999Z",
        minimumTrustSequence: 1,
        jwk: jwks[2],
        thumbprintSha256: thumbprint(jwks[2]),
      },
    ],
  };
}

function source(value: ReturnType<typeof manifest>, manifestBytes: Buffer): string {
  const digest = createHash("sha256").update(manifestBytes).digest("hex");
  let output = 'import type { SkillPressPinnedKey } from "./types.js";\n\n';
  output += `// Generated from production-public-keys.json (sha256:${digest}). Do not edit.\n`;
  output +=
    "export const SKILL_PRESS_PINNED_KEYS: readonly SkillPressPinnedKey[] = Object.freeze([\n";
  for (const entry of value.keys) {
    output += "  Object.freeze({\n";
    output += `    keyId: ${JSON.stringify(entry.keyId)},\n`;
    output += `    roles: Object.freeze([${JSON.stringify(entry.role)}] as const),\n`;
    output += `    validFrom: ${JSON.stringify(entry.validFrom)},\n`;
    output += `    validUntil: ${JSON.stringify(entry.validUntil)},\n`;
    if ("minimumTrustSequence" in entry) {
      output += `    minimumTrustSequence: ${entry.minimumTrustSequence},\n`;
    }
    output += "    jwk: Object.freeze({\n";
    output += '      kty: "EC" as const,\n      crv: "P-256" as const,\n';
    output += `      x: ${JSON.stringify(entry.jwk.x)},\n      y: ${JSON.stringify(entry.jwk.y)},\n`;
    output += "    }),\n  }),\n";
  }
  output += "]);\n";
  return output;
}

function signatures(): string {
  return `import { webcrypto } from "node:crypto";
import { parseSignedEnvelope } from "./contract.js";
import { TrustedInstallError } from "./errors.js";
import { SKILL_PRESS_PINNED_KEYS } from "./production-keys.js";
import type { SkillPressPinnedKey } from "./types.js";

export { SKILL_PRESS_PINNED_KEYS } from "./production-keys.js";

export function createTrustedSignatureVerifier(
  suppliedKeys: readonly SkillPressPinnedKey[] = SKILL_PRESS_PINNED_KEYS,
): readonly SkillPressPinnedKey[] {
  void webcrypto;
  void parseSignedEnvelope;
  void TrustedInstallError;
  for (const supplied of suppliedKeys) {
    void supplied;
  }
  return suppliedKeys;
}
`;
}

async function fixture(value = manifest()): Promise<{ root: string; manifestBytes: Buffer }> {
  const created = await mkdtemp(join(tmpdir(), "skill-press-keyring-gate-"));
  const root = await realpath(created);
  await mkdir(join(root, "src", "install"), { recursive: true, mode: 0o700 });
  const manifestBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(join(root, "production-public-keys.json"), manifestBytes, { mode: 0o600 });
  await writeFile(
    join(root, "src", "install", "production-keys.ts"),
    source(value, manifestBytes),
    {
      mode: 0o600,
    },
  );
  await writeFile(join(root, "src", "install", "signatures.ts"), signatures(), {
    mode: 0o600,
  });
  return { root, manifestBytes };
}

describe("production keyring release gate", () => {
  it("fails closed when the ceremony manifest is absent", async () => {
    const missing = await fixture();
    try {
      await unlink(join(missing.root, "production-public-keys.json"));
      await expect(verifyProductionKeyring(missing.root)).rejects.toThrow(
        /production-public-keys[.]json is missing/u,
      );
    } finally {
      missing.manifestBytes.fill(0);
      await rm(missing.root, { recursive: true, force: true });
    }
  });

  it("accepts only the exact three independent launch keys and generated source", async () => {
    const current = await fixture();
    try {
      const verified = await verifyProductionKeyring(current.root);
      expect(verified).toMatchObject({
        status: "verified",
        keyIds: [
          "skill-press-attestation-p256-2026-08-28",
          "skill-press-trust-p256-2026-08-28",
          "skill-press-checkpoint-p256-2026-08-28",
        ],
      });
      expect(verified.pinnedKeys).toEqual([
        {
          keyId: "skill-press-attestation-p256-2026-08-28",
          roles: ["release-attestation"],
          validFrom: "2026-08-28T00:00:00.000Z",
          validUntil: "2027-08-31T23:59:59.999Z",
          jwk: jwks[0],
        },
        {
          keyId: "skill-press-trust-p256-2026-08-28",
          roles: ["trust-event"],
          validFrom: "2026-08-28T00:00:00.000Z",
          validUntil: "2027-08-31T23:59:59.999Z",
          minimumTrustSequence: 1,
          jwk: jwks[1],
        },
        {
          keyId: "skill-press-checkpoint-p256-2026-08-28",
          roles: ["current-trust"],
          validFrom: "2026-08-28T00:00:00.000Z",
          validUntil: "2027-08-31T23:59:59.999Z",
          minimumTrustSequence: 1,
          jwk: jwks[2],
        },
      ]);
    } finally {
      current.manifestBytes.fill(0);
      await rm(current.root, { recursive: true, force: true });
    }
  });

  it("rejects a retired key ID even when the generated source is changed with it", async () => {
    const value = manifest();
    value.keys[0].keyId = "skill-press-p256-2026-08-01";
    const current = await fixture(value);
    try {
      await expect(verifyProductionKeyring(current.root)).rejects.toThrow(
        /sole launch key policy/u,
      );
    } finally {
      current.manifestBytes.fill(0);
      await rm(current.root, { recursive: true, force: true });
    }
  });

  it("rejects generated-source drift and key reuse", async () => {
    const drift = await fixture();
    try {
      await writeFile(join(drift.root, "src", "install", "production-keys.ts"), "drift\n", {
        mode: 0o600,
      });
      await expect(verifyProductionKeyring(drift.root)).rejects.toThrow(/does not exactly match/u);
    } finally {
      drift.manifestBytes.fill(0);
      await rm(drift.root, { recursive: true, force: true });
    }

    const reused = manifest();
    reused.keys[2].jwk = jwks[1];
    reused.keys[2].thumbprintSha256 = thumbprint(jwks[1]);
    const duplicate = await fixture(reused);
    try {
      await expect(verifyProductionKeyring(duplicate.root)).rejects.toThrow(/independent keys/u);
    } finally {
      duplicate.manifestBytes.fill(0);
      await rm(duplicate.root, { recursive: true, force: true });
    }
  });

  it("rejects inline, alternate, and retired keyring paths in signatures.ts", async () => {
    const inline = await fixture();
    try {
      await writeFile(
        join(inline.root, "src", "install", "signatures.ts"),
        `${signatures()}\nconst fallback = "skill-press-p256-2026-08-01";\n`,
        { mode: 0o600 },
      );
      await expect(verifyProductionKeyring(inline.root)).rejects.toThrow(
        /inline or retired signing key fallback/u,
      );
    } finally {
      inline.manifestBytes.fill(0);
      await rm(inline.root, { recursive: true, force: true });
    }

    const alternate = await fixture();
    try {
      await writeFile(
        join(alternate.root, "src", "install", "signatures.ts"),
        signatures().replace(
          'export { SKILL_PRESS_PINNED_KEYS } from "./production-keys.js";',
          'export { SKILL_PRESS_PINNED_KEYS } from "./alternate-keys.js";',
        ),
        { mode: 0o600 },
      );
      await expect(verifyProductionKeyring(alternate.root)).rejects.toThrow(/re-export/u);
    } finally {
      alternate.manifestBytes.fill(0);
      await rm(alternate.root, { recursive: true, force: true });
    }
  });
});
