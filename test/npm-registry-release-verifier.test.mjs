import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  verifyAuditResult,
  verifyRegistryRelease,
} from "../scripts/verify-npm-registry-release.mjs";

const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const manifest = Object.freeze({
  schemaVersion: 2,
  package: "@mushanyoung/skillpress@0.1.0",
  name: "@mushanyoung/skillpress",
  version: "0.1.0",
  repository: "https://github.com/mushanyoung/skillpress",
  filename: "mushanyoung-skillpress-0.1.0.tgz",
  bytes: 1,
  shasum: "1".repeat(40),
  integrity,
  sha256: "2".repeat(64),
  sourceCommit: "c".repeat(40),
});
const provenanceUrl =
  "https://registry.npmjs.org/-/npm/v1/attestations/%40mushanyoung%2Fskillpress%400.1.0";
const execFileAsync = promisify(execFile);

function metadata(overrides = {}) {
  return JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    dist: {
      integrity,
      shasum: manifest.shasum,
      tarball: "https://registry.npmjs.org/@mushanyoung/skillpress/-/skillpress-0.1.0.tgz",
      signatures: [{}],
      attestations: {
        url: provenanceUrl,
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
    ...overrides,
  });
}

function attestation(commit = manifest.sourceCommit) {
  const payload = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: "pkg:npm/%40mushanyoung/skillpress@0.1.0",
        digest: { sha512: Buffer.alloc(64, 1).toString("hex") },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: { repository: manifest.repository },
        },
        resolvedDependencies: [{ digest: { gitCommit: commit } }],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
  return JSON.stringify({
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          verificationMaterial: { tlogEntries: [{}] },
          dsseEnvelope: {
            payloadType: "application/vnd.in-toto+json",
            payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
            signatures: [{}],
          },
        },
      },
    ],
  });
}

describe("npm registry release verifier", () => {
  it("classifies only an explicit registry 404 as absent", async () => {
    const fetcher = vi.fn(async () => new Response("not found", { status: 404 }));
    await expect(verifyRegistryRelease(manifest, fetcher)).resolves.toEqual({
      status: "absent",
      package: manifest.package,
    });
  });

  it("binds exact metadata and SLSA provenance to tarball, repository, and commit", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(metadata(), { status: 200 }))
      .mockResolvedValueOnce(new Response(attestation(), { status: 200 }));
    await expect(verifyRegistryRelease(manifest, fetcher)).resolves.toEqual({
      status: "match",
      package: manifest.package,
      integrity,
      provenanceUrl,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects conflicting package bytes or source provenance", async () => {
    const wrongBytes = vi.fn(
      async () =>
        new Response(metadata({ dist: { integrity: "sha512-conflict" } }), { status: 200 }),
    );
    await expect(verifyRegistryRelease(manifest, wrongBytes)).rejects.toThrow(/conflicts/u);

    const wrongSource = vi
      .fn()
      .mockResolvedValueOnce(new Response(metadata(), { status: 200 }))
      .mockResolvedValueOnce(new Response(attestation("f".repeat(40)), { status: 200 }));
    await expect(verifyRegistryRelease(manifest, wrongSource)).rejects.toThrow(/does not match/u);
  });

  it("fails closed when registry state is unavailable or malformed", async () => {
    await expect(
      verifyRegistryRelease(manifest, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow(/unavailable/u);
    await expect(
      verifyRegistryRelease(manifest, async () => new Response("not json", { status: 200 })),
    ).rejects.toThrow(/valid JSON/u);
  });

  it("binds npm's cryptographic audit result to the exact provenance bundle", () => {
    const bundle = JSON.parse(attestation()).attestations[0].bundle;
    const audit = {
      invalid: [],
      missing: [],
      verified: [
        {
          name: manifest.name,
          version: manifest.version,
          location: `node_modules/${manifest.name}`,
          registry: "https://registry.npmjs.org/",
          attestations: {
            url: provenanceUrl,
            provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          },
          attestationBundles: [{ predicateType: "https://slsa.dev/provenance/v1", bundle }],
        },
      ],
    };
    expect(verifyAuditResult(manifest, audit)).toEqual({
      status: "audit-match",
      package: manifest.package,
    });
    expect(() =>
      verifyAuditResult(manifest, {
        ...audit,
        verified: [{ ...audit.verified[0], attestationBundles: [] }],
      }),
    ).toThrow(/provenance/u);
  });

  it("runs after being copied through a platform temporary-path alias", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "skillpress-npm-verifier-"));
    try {
      const script = join(temporary, "verify-npm-registry-release.mjs");
      const invalidManifest = join(temporary, "manifest.json");
      await copyFile(
        new URL("../scripts/verify-npm-registry-release.mjs", import.meta.url),
        script,
      );
      await writeFile(invalidManifest, "{}\n");
      await expect(
        execFileAsync(process.execPath, [script, invalidManifest]),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("manifest identity or digest contract is invalid"),
      });
    } finally {
      await rm(temporary, { recursive: true });
    }
  });
});
