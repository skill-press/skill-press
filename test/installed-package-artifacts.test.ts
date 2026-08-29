import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  REVIEWED_KEYRING_ARTIFACT_PATHS,
  verifyInstalledPackageArtifactSnapshot,
  withCapturedPackageArtifactSnapshot,
} from "../scripts/verify-installed-package-artifacts.mjs";

const pinnedKeys = [
  {
    keyId: "skill-press-attestation-p256-2026-08-28",
    roles: ["release-attestation"],
    validFrom: "2026-08-28T00:00:00.000Z",
    validUntil: "2027-08-31T23:59:59.999Z",
    jwk: {
      kty: "EC",
      crv: "P-256",
      x: "AHqLCmaxvXq_7sU69JJyis5wrlfx-AIUfiWKmprXQsY",
      y: "zYverufiuTsWxLFBhy2xx8kLh2n_kXpzdbvtjlWa5Yk",
    },
  },
  {
    keyId: "skill-press-trust-p256-2026-08-28",
    roles: ["trust-event"],
    validFrom: "2026-08-28T00:00:00.000Z",
    validUntil: "2027-08-31T23:59:59.999Z",
    minimumTrustSequence: 1,
    jwk: {
      kty: "EC",
      crv: "P-256",
      x: "enFmYV8R4qqUlsQ6DpFkhZk3UFy13298BQjKFem0OvY",
      y: "AjEnFqN9jHfVXF3He3g5eqT31tBbsFWDXFBS1e-kEPY",
    },
  },
  {
    keyId: "skill-press-checkpoint-p256-2026-08-28",
    roles: ["current-trust"],
    validFrom: "2026-08-28T00:00:00.000Z",
    validUntil: "2027-08-31T23:59:59.999Z",
    minimumTrustSequence: 1,
    jwk: {
      kty: "EC",
      crv: "P-256",
      x: "Ak4_QJbzmDh2X3Gzo5eKa3Ds-SCUBP_7zd6-_bgDGUU",
      y: "wjjpQZYZBH4PK0DiivyGLgZ0dRknLkjzADQ31CITqCY",
    },
  },
] as const;

const keyringProof = Object.freeze({
  status: "verified",
  manifestSha256: "1".repeat(64),
  pinnedKeys: Object.freeze(
    pinnedKeys.map((entry) =>
      Object.freeze({
        ...entry,
        roles: Object.freeze([...entry.roles]),
        jwk: Object.freeze({ ...entry.jwk }),
      }),
    ),
  ),
});

function productionKeysJavaScript(): string {
  let source = `// Generated from production-public-keys.json (sha256:${keyringProof.manifestSha256}). Do not edit.\n`;
  source += "export const SKILL_PRESS_PINNED_KEYS = Object.freeze([\n";
  for (const entry of pinnedKeys) {
    source += "    Object.freeze({\n";
    source += `        keyId: ${JSON.stringify(entry.keyId)},\n`;
    source += `        roles: Object.freeze([${JSON.stringify(entry.roles[0])}]),\n`;
    source += `        validFrom: ${JSON.stringify(entry.validFrom)},\n`;
    source += `        validUntil: ${JSON.stringify(entry.validUntil)},\n`;
    if ("minimumTrustSequence" in entry) {
      source += `        minimumTrustSequence: ${entry.minimumTrustSequence},\n`;
    }
    source += "        jwk: Object.freeze({\n";
    source += '            kty: "EC",\n            crv: "P-256",\n';
    source += `            x: ${JSON.stringify(entry.jwk.x)},\n`;
    source += `            y: ${JSON.stringify(entry.jwk.y)},\n`;
    source += "        }),\n    }),\n";
  }
  return `${source}]);\n//# sourceMappingURL=production-keys.js.map`;
}

function canonicalFiles(): Readonly<Record<string, string>> {
  const rootExport = 'export { SKILL_PRESS_PINNED_KEYS } from "./install/production-keys.js";';
  return Object.freeze({
    "package.json": `${JSON.stringify(
      {
        name: "@skill-press/cli",
        type: "module",
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      },
      null,
      2,
    )}\n`,
    "dist/index.js": `${rootExport}\nexport function checkProject() {}\n`,
    "dist/index.d.ts": `${rootExport}\nexport declare function checkProject(): void;\n`,
    "dist/install/production-keys.js": productionKeysJavaScript(),
    "dist/install/production-keys.d.ts":
      "export declare const SKILL_PRESS_PINNED_KEYS: readonly unknown[];\n",
    "dist/install/signatures.js":
      'import { SKILL_PRESS_PINNED_KEYS } from "./production-keys.js";\n' +
      'export { SKILL_PRESS_PINNED_KEYS } from "./production-keys.js";\n' +
      "export async function createTrustedSignatureVerifier(suppliedKeys = SKILL_PRESS_PINNED_KEYS, now = () => new Date()) { return { suppliedKeys, now }; }\n",
    "dist/install/signatures.d.ts":
      "export declare function createTrustedSignatureVerifier(suppliedKeys?: readonly unknown[]): Promise<unknown>;\n",
  });
}

type Fixture = Readonly<{
  expectedRoot: string;
  installAnchor: string;
  installedRoot: string;
  outerRoot: string;
}>;

async function writeTree(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, contents, { mode: 0o600 });
  }
}

async function fixture(): Promise<Fixture> {
  const outerRoot = await realpath(await mkdtemp(join(tmpdir(), "skill-press-static-package-")));
  const expectedRoot = join(outerRoot, "expected");
  const installAnchor = join(outerRoot, "install-smoke");
  const installedRoot = join(installAnchor, "node_modules", "@skill-press", "cli");
  await mkdir(expectedRoot, { recursive: true, mode: 0o700 });
  await mkdir(installedRoot, { recursive: true, mode: 0o700 });
  const files = canonicalFiles();
  await writeTree(expectedRoot, files);
  await writeTree(installedRoot, files);
  return { expectedRoot, installAnchor, installedRoot, outerRoot };
}

async function verify(current: Fixture): Promise<unknown> {
  let proof: unknown;
  await withCapturedPackageArtifactSnapshot(
    current.expectedRoot,
    REVIEWED_KEYRING_ARTIFACT_PATHS,
    keyringProof,
    async (snapshot) => {
      proof = await verifyInstalledPackageArtifactSnapshot(
        snapshot,
        current.installAnchor,
        current.installedRoot,
      );
    },
  );
  return proof;
}

describe("installed package static artifact gate", () => {
  it("accepts an exact captured build and byte-identical installed package without executing it", async () => {
    const current = await fixture();
    try {
      const proof = (await verify(current)) as {
        artifacts: readonly unknown[];
        files: number;
        status: string;
        totalBytes: number;
      };
      expect(proof.status).toBe("verified");
      expect(proof.files).toBe(REVIEWED_KEYRING_ARTIFACT_PATHS.length);
      expect(proof.artifacts).toHaveLength(REVIEWED_KEYRING_ARTIFACT_PATHS.length);
      expect(proof.totalBytes).toBeGreaterThan(0);
      expect(Object.isFrozen(proof)).toBe(true);
      expect(Object.isFrozen(proof.artifacts)).toBe(true);
    } finally {
      await rm(current.outerRoot, { recursive: true, force: true });
    }
  });

  it("rejects early verified-output/exit attacks in every executable keyring path without running them", async () => {
    for (const path of [
      "dist/index.js",
      "dist/install/signatures.js",
      "dist/install/production-keys.js",
    ]) {
      const current = await fixture();
      const marker = join(current.outerRoot, "attack-executed");
      try {
        await writeFile(
          join(current.installedRoot, path),
          `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); process.stdout.write("verified\\n"); process.exit(0);\n`,
          { mode: 0o600 },
        );
        await expect(verify(current)).rejects.toThrow(/differs between/u);
        await expect(stat(marker)).rejects.toThrow();
      } finally {
        await rm(current.outerRoot, { recursive: true, force: true });
      }
    }
  });

  it("rejects retired keys and executable/accessor/serialization additions in the captured build", async () => {
    for (const attack of [
      '"skill-press-p256-2026-08-01"',
      "get keyId() { return 'forged'; }",
      "function forged() {}",
      "toJSON() { return {}; }",
    ]) {
      const current = await fixture();
      let operationCalls = 0;
      try {
        await writeFile(
          join(current.expectedRoot, "dist", "install", "production-keys.js"),
          `${productionKeysJavaScript()}\n${attack}\n`,
          { mode: 0o600 },
        );
        await expect(
          withCapturedPackageArtifactSnapshot(
            current.expectedRoot,
            REVIEWED_KEYRING_ARTIFACT_PATHS,
            keyringProof,
            () => {
              operationCalls += 1;
            },
          ),
        ).rejects.toThrow(/exact manifest projection/u);
        expect(operationCalls).toBe(0);
      } finally {
        await rm(current.outerRoot, { recursive: true, force: true });
      }
    }
  });

  it("rejects package entry and root/signature binding drift before issuing a snapshot", async () => {
    for (const [path, contents] of [
      [
        "package.json",
        `${JSON.stringify(
          {
            name: "@skill-press/cli",
            type: "module",
            exports: { ".": { types: "./dist/index.d.ts", import: "./dist/alternate.js" } },
          },
          null,
          2,
        )}\n`,
      ],
      [
        "dist/index.js",
        'export { SKILL_PRESS_PINNED_KEYS as keys } from "./install/production-keys.js";\n',
      ],
      [
        "dist/index.js",
        'export * from "./install/production-keys.js";\nexport const SKILL_PRESS_PINNED_KEYS = [];\n',
      ],
      [
        "dist/install/signatures.js",
        'import { SKILL_PRESS_PINNED_KEYS } from "./alternate.js";\nexport async function createTrustedSignatureVerifier(suppliedKeys = []) {}\n',
      ],
    ] as const) {
      const current = await fixture();
      let operationCalls = 0;
      try {
        await writeFile(join(current.expectedRoot, path), contents, { mode: 0o600 });
        await expect(
          withCapturedPackageArtifactSnapshot(
            current.expectedRoot,
            REVIEWED_KEYRING_ARTIFACT_PATHS,
            keyringProof,
            () => {
              operationCalls += 1;
            },
          ),
        ).rejects.toThrow(/canonical CLI entry|production keyring|runtime keyring/u);
        expect(operationCalls).toBe(0);
      } finally {
        await rm(current.outerRoot, { recursive: true, force: true });
      }
    }
  });

  it("rejects extra, missing, symlinked, and hardlinked installed files", async () => {
    for (const attack of ["extra", "missing", "symlink", "hardlink"] as const) {
      const current = await fixture();
      try {
        const target = join(current.installedRoot, "dist", "index.d.ts");
        if (attack === "extra") {
          await writeFile(join(current.installedRoot, "extra.js"), "extra\n", { mode: 0o600 });
        } else if (attack === "missing") {
          await rm(target);
        } else if (attack === "symlink") {
          await rm(target);
          await symlink(join(current.expectedRoot, "dist", "index.d.ts"), target);
        } else {
          const other = join(current.outerRoot, "hardlink-target");
          await writeFile(other, await readFile(target), { mode: 0o600 });
          await rm(target);
          await link(other, target);
        }
        await expect(verify(current)).rejects.toThrow(
          /inventory differs|canonical|unsafe storage|required static artifact/u,
        );
      } finally {
        await rm(current.outerRoot, { recursive: true, force: true });
      }
    }
  });

  it("consumes snapshot authority once and revokes an escaped capability", async () => {
    const current = await fixture();
    let escaped: unknown;
    try {
      await withCapturedPackageArtifactSnapshot(
        current.expectedRoot,
        REVIEWED_KEYRING_ARTIFACT_PATHS,
        keyringProof,
        async (snapshot) => {
          escaped = snapshot;
          await verifyInstalledPackageArtifactSnapshot(
            snapshot,
            current.installAnchor,
            current.installedRoot,
          );
          await expect(
            verifyInstalledPackageArtifactSnapshot(
              snapshot,
              current.installAnchor,
              current.installedRoot,
            ),
          ).rejects.toThrow(/consumed/u);
        },
      );
      await expect(
        verifyInstalledPackageArtifactSnapshot(
          escaped,
          current.installAnchor,
          current.installedRoot,
        ),
      ).rejects.toThrow(/inactive or consumed/u);
    } finally {
      await rm(current.outerRoot, { recursive: true, force: true });
    }
  });

  it("rejects a caller that consumes snapshot authority without awaiting verification", async () => {
    const current = await fixture();
    let verificationSettled = Promise.resolve();
    try {
      await expect(
        withCapturedPackageArtifactSnapshot(
          current.expectedRoot,
          REVIEWED_KEYRING_ARTIFACT_PATHS,
          keyringProof,
          (snapshot) => {
            verificationSettled = verifyInstalledPackageArtifactSnapshot(
              snapshot,
              current.installAnchor,
              current.installedRoot,
            ).then(
              () => undefined,
              () => undefined,
            );
          },
        ),
      ).rejects.toThrow(/did not complete its consumed verification/u);
      await verificationSettled;
    } finally {
      await rm(current.outerRoot, { recursive: true, force: true });
    }
  });

  it("keeps static keyring acceptance before the only installed CLI execution", async () => {
    const verifier = await readFile(
      new URL("../scripts/verify-package.mjs", import.meta.url),
      "utf8",
    );
    expect(verifier).not.toContain('import("@skill-press/cli")');
    expect(verifier).not.toContain("createInstalledKeyringProbe");
    expect(verifier).toContain('"--ignore-scripts"');
    expect(verifier.indexOf("verifyInstalledPackageArtifactSnapshot(")).toBeGreaterThan(-1);
    expect(verifier.indexOf("run(installedBinary")).toBeGreaterThan(
      verifier.indexOf("verifyInstalledPackageArtifactSnapshot("),
    );
  });
});
