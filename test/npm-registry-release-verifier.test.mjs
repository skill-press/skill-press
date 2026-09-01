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
  package: "@skill-press/cli@0.1.0",
  name: "@skill-press/cli",
  version: "0.1.0",
  repository: "https://github.com/skill-press/skill-press",
  filename: "skill-press-cli-0.1.0.tgz",
  bytes: 1,
  shasum: "1".repeat(40),
  integrity,
  sha256: "2".repeat(64),
  sourceCommit: "c".repeat(40),
});
const provenanceUrl =
  "https://registry.npmjs.org/-/npm/v1/attestations/%40skill-press%2Fcli%400.1.0";
const execFileAsync = promisify(execFile);

function metadata(overrides = {}) {
  return JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    dist: {
      integrity,
      shasum: manifest.shasum,
      tarball: "https://registry.npmjs.org/@skill-press/cli/-/cli-0.1.0.tgz",
      signatures: [{}],
      attestations: {
        url: provenanceUrl,
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
    ...overrides,
  });
}

function metadataWithDist(overrides) {
  const value = JSON.parse(metadata());
  Object.assign(value.dist, overrides);
  return JSON.stringify(value);
}

function metadataWithTarball(tarball) {
  return metadataWithDist({ tarball });
}

function attestation(commit = manifest.sourceCommit) {
  const payload = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: "pkg:npm/%40skill-press/cli@0.1.0",
        digest: { sha512: Buffer.alloc(64, 1).toString("hex") },
      },
    ],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            repository: manifest.repository,
            path: ".github/workflows/release.yml",
            ref: "refs/tags/v0.1.0",
          },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/skill-press/skill-press@refs/tags/v0.1.0",
            digest: { gitCommit: commit },
          },
        ],
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

function mutatedAttestation(mutate) {
  const value = JSON.parse(attestation());
  const envelope = value.attestations[0].bundle.dsseEnvelope;
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  mutate(payload.predicate.buildDefinition);
  envelope.payload = Buffer.from(JSON.stringify(payload)).toString("base64");
  return JSON.stringify(value);
}

describe("npm registry release verifier", () => {
  it("classifies only an explicit registry 404 as absent", async () => {
    const fetcher = vi.fn(async () => new Response("not found", { status: 404 }));
    await expect(verifyRegistryRelease(manifest, fetcher)).resolves.toEqual({
      status: "absent",
      package: manifest.package,
    });
  });

  it("classifies an exact package whose attestation is still propagating as pending", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(metadata(), { status: 200 }))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(verifyRegistryRelease(manifest, fetcher)).resolves.toEqual({
      status: "pending",
      package: manifest.package,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 429, 500])(
    "fails closed when an exact package's attestation returns HTTP %i",
    async (status) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(new Response(metadata(), { status: 200 }))
        .mockResolvedValueOnce(new Response("unavailable", { status }));
      await expect(verifyRegistryRelease(manifest, fetcher)).rejects.toThrow(
        `registry attestation returned HTTP ${status}`,
      );
    },
  );

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
      tarballUrl: "https://registry.npmjs.org/@skill-press/cli/-/cli-0.1.0.tgz",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://registry.npmjs.org/%40skill-press%2Fcli/0.1.0",
      provenanceUrl,
    ]);
  });

  it("rejects conflicting package bytes or source provenance", async () => {
    const wrongBytes = vi.fn(
      async () => new Response(metadataWithDist({ integrity: "sha512-conflict" }), { status: 200 }),
    );
    await expect(verifyRegistryRelease(manifest, wrongBytes)).rejects.toThrow(/conflicts/u);

    const wrongSource = vi
      .fn()
      .mockResolvedValueOnce(new Response(metadata(), { status: 200 }))
      .mockResolvedValueOnce(new Response(attestation("f".repeat(40)), { status: 200 }));
    await expect(verifyRegistryRelease(manifest, wrongSource)).rejects.toThrow(/does not match/u);

    const invalidSources = [
      mutatedAttestation((definition) => {
        definition.buildType = "https://example.invalid/build";
      }),
      mutatedAttestation((definition) => {
        definition.externalParameters.workflow.path = ".github/workflows/other.yml";
      }),
      mutatedAttestation((definition) => {
        definition.externalParameters.workflow.ref = "refs/heads/main";
      }),
      mutatedAttestation((definition) => {
        definition.resolvedDependencies = [
          {
            uri: "git+https://example.invalid/other@refs/tags/v0.1.0",
            digest: { gitCommit: manifest.sourceCommit },
          },
          {
            uri: "git+https://github.com/skill-press/skill-press@refs/tags/v0.1.0",
            digest: { gitCommit: "f".repeat(40) },
          },
        ];
      }),
    ];
    for (const body of invalidSources) {
      const invalid = vi
        .fn()
        .mockResolvedValueOnce(new Response(metadata(), { status: 200 }))
        .mockResolvedValueOnce(new Response(body, { status: 200 }));
      await expect(verifyRegistryRelease(manifest, invalid)).rejects.toThrow(/does not match/u);
    }
  });

  it.each([
    "http://registry.npmjs.org/@skill-press/cli/-/cli-0.1.0.tgz",
    "https://example.invalid/@skill-press/cli/-/cli-0.1.0.tgz",
    "https://REGISTRY.NPMJS.ORG/@skill-press/cli/-/cli-0.1.0.tgz",
    "https://user:secret@registry.npmjs.org/@skill-press/cli/-/cli-0.1.0.tgz",
    "https://registry.npmjs.org:443/@skill-press/cli/-/cli-0.1.0.tgz",
    "https://registry.npmjs.org/./@skill-press/cli/-/cli-0.1.0.tgz",
    "https://registry.npmjs.org/@skill-press/cli/-/cli-0.1.0.tgz?download=1",
    "https://registry.npmjs.org/@skill-press/cli/-/cli-0.1.0.tgz#fragment",
    "https://registry.npmjs.org/@skill-press/other/-/other-0.1.0.tgz",
    "https://registry.npmjs.org/@skill-press/cli/-/skill-press-cli-0.1.0.tgz",
    "https://registry.npmjs.org/@skill-press/cli/-/cli-0.1.1.tgz",
  ])("rejects a non-canonical npm tarball URL: %s", async (tarball) => {
    const fetcher = vi.fn(async () => new Response(metadataWithTarball(tarball), { status: 200 }));
    await expect(verifyRegistryRelease(manifest, fetcher)).rejects.toThrow(/tarball/u);
    expect(fetcher).toHaveBeenCalledTimes(1);
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

    await expect(
      verifyRegistryRelease({
        ...manifest,
        name: "@mushanyoung/skillpress",
        package: "@mushanyoung/skillpress@0.1.0",
      }),
    ).rejects.toThrow(/identity/u);
    await expect(
      verifyRegistryRelease({
        ...manifest,
        repository: "https://github.com/mushanyoung/skillpress",
      }),
    ).rejects.toThrow(/identity/u);
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
    const temporary = await mkdtemp(join(tmpdir(), "skill-press-npm-verifier-"));
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
