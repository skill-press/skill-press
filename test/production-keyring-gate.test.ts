import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isReviewedRelativePath,
  verifyProductionKeyring,
} from "../scripts/verify-production-keyring.mjs";

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

function installIndex(): string {
  return 'export { SKILL_PRESS_PINNED_KEYS } from "./signatures.js";\n';
}

function rootIndex(): string {
  return (
    'export { SKILL_PRESS_PINNED_KEYS } from "./install/production-keys.js";\n' +
    "export function checkProject() {}\nexport function runSkillSubmission() {}\n"
  );
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
  await writeFile(join(root, "src", "install", "index.ts"), installIndex(), { mode: 0o600 });
  await writeFile(join(root, "src", "index.ts"), rootIndex(), { mode: 0o600 });
  return { root, manifestBytes };
}

describe("production keyring release gate", () => {
  it("contains reviewed paths across POSIX and Windows separators, prefixes, parents, and drives", () => {
    for (const [pathApi, root, accepted, rejected] of [
      [
        posix,
        "/work/skill-press",
        [
          "/work/skill-press/production-public-keys.json",
          "/work/skill-press/src/install/production-keys.ts",
        ],
        ["/work/skill-press", "/work/skill-press-other/key.json", "/work/key.json"],
      ],
      [
        win32,
        "C:\\work\\skill-press",
        [
          "C:\\work\\skill-press\\production-public-keys.json",
          "C:\\work\\skill-press\\src\\install\\production-keys.ts",
        ],
        [
          "C:\\work\\skill-press",
          "C:\\work\\skill-press-other\\key.json",
          "C:\\work\\key.json",
          "D:\\work\\skill-press\\production-public-keys.json",
        ],
      ],
    ] as const) {
      for (const candidate of accepted) {
        const remainder = pathApi.relative(root, candidate);
        expect(isReviewedRelativePath(remainder, pathApi.sep, pathApi.isAbsolute(remainder))).toBe(
          true,
        );
      }
      for (const candidate of rejected) {
        const remainder = pathApi.relative(root, candidate);
        expect(isReviewedRelativePath(remainder, pathApi.sep, pathApi.isAbsolute(remainder))).toBe(
          false,
        );
      }
    }
  });

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

  it("blocks npm prepack before build when the manifest is missing or generated source drifts", async () => {
    for (const failure of ["missing-manifest", "source-drift"] as const) {
      const current = await fixture();
      const sentinel = join(current.root, "build-ran");
      try {
        await mkdir(join(current.root, "scripts"), { mode: 0o700 });
        await copyFile(
          fileURLToPath(new URL("../scripts/verify-production-keyring.mjs", import.meta.url)),
          join(current.root, "scripts", "verify-production-keyring.mjs"),
        );
        await writeFile(
          join(current.root, "build-sentinel.mjs"),
          'import { writeFile } from "node:fs/promises"; await writeFile("build-ran", "ran\\n");\n',
          { mode: 0o600 },
        );
        await writeFile(
          join(current.root, "package.json"),
          `${JSON.stringify({
            name: "skill-press-prepack-gate-fixture",
            version: "1.0.0",
            private: true,
            scripts: {
              build: "node build-sentinel.mjs",
              prepack: "node scripts/verify-production-keyring.mjs --quiet && npm run build",
            },
          })}\n`,
          { mode: 0o600 },
        );
        if (failure === "missing-manifest") {
          await unlink(join(current.root, "production-public-keys.json"));
        } else {
          await writeFile(join(current.root, "src", "install", "production-keys.ts"), "drift\n", {
            mode: 0o600,
          });
        }
        const npm = process.platform === "win32" ? "npm.cmd" : "npm";
        const result = spawnSync(npm, ["pack", "--json", "--silent"], {
          cwd: current.root,
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(result.status).not.toBe(0);
        await expect(stat(sentinel)).rejects.toThrow();
      } finally {
        current.manifestBytes.fill(0);
        await rm(current.root, { recursive: true, force: true });
      }
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

  it("requires one direct first root export and one unambiguous install export", async () => {
    for (const [relativePath, replacement, message] of [
      [
        "src/index.ts",
        rootIndex().replace("./install/production-keys.js", "./install/index.js"),
        /production keyring export/u,
      ],
      ["src/index.ts", `export const before = true;\n${rootIndex()}`, /first runtime dependency/u],
      [
        "src/index.ts",
        `${rootIndex()}export * from "./alternate.js";\n`,
        /ambiguous production keyring export/u,
      ],
      [
        "src/install/index.ts",
        installIndex().replace("./signatures.js", "./alternate.js"),
        /production keyring export/u,
      ],
      [
        "src/install/index.ts",
        `${installIndex()}export { SKILL_PRESS_PINNED_KEYS } from "./alternate.js";\n`,
        /sole canonical occurrence|ambiguous production keyring export/u,
      ],
    ] as const) {
      const current = await fixture();
      try {
        await writeFile(join(current.root, relativePath), replacement, { mode: 0o600 });
        await expect(verifyProductionKeyring(current.root)).rejects.toThrow(message);
      } finally {
        current.manifestBytes.fill(0);
        await rm(current.root, { recursive: true, force: true });
      }
    }
  });
});
