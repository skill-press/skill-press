import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LoadedSkillPackageArtifacts } from "../src/package/archive.js";
import { prepareSkillSubmission, SubmissionManifestError } from "../src/submission/manifest.js";

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ManifestFixture {
  readonly root: string;
  readonly artifacts: LoadedSkillPackageArtifacts;
  readonly evidence: {
    readonly reviewEvidencePath: string;
    readonly evalEvidencePath: string;
    readonly evalSource: string;
  };
}

async function fixture(): Promise<ManifestFixture> {
  const root = await mkdtemp(join(temporaryRoot, "skill-press-submission-manifest-"));
  temporaryDirectories.push(root);
  await writeFile(
    join(root, "skill-press.yaml"),
    `schemaVersion: 2
project:
  name: example-skill
  version: 1.2.3
  description: A complete project used to verify deterministic submission metadata.
  license: MIT
  repository: https://github.com/source-owner/example-skill
  author:
    name: Independent Maintainer
    github: maintainer-user
registry:
  namespace: registry-team
skill:
  name: example-skill
  path: skills/example-skill
  risk: moderate
quality:
  readinessMinimum: 90
  tesslQualityMinimum: 90
  tesslImpactMinimum: 90
  evidenceMaxAgeHours: 168
tests:
  commands:
    - name: repository tests
      argv: [npm, test]
      timeoutSeconds: 300
evaluation:
  repetitions: 3
  minimumSuccessRate: 0.9
  minimumImpactDelta: 0.1
  sandbox: docker
  network: none
improve:
  maxIterations: 5
  maxNoImprovement: 2
  maxTokens: 200000
  maxCostUsd: 100
  maxWallMinutes: 240
`,
  );
  const artifactRun = "1".repeat(64);
  const artifactsPath = `.skill-press/staging/${artifactRun}/artifacts`;
  const artifactRoot = join(root, artifactsPath);
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const artifactBytes = Buffer.from("exact deterministic skill archive\n");
  const provenanceBytes = Buffer.from('{"provenanceType":"skillpress.package"}\n');
  const checksumsBytes = Buffer.from(`${sha256(artifactBytes)}  example-skill-1.2.3.skill\n`);
  await writeFile(join(artifactRoot, "example-skill-1.2.3.skill"), artifactBytes, {
    mode: 0o600,
  });
  await writeFile(join(artifactRoot, "provenance.json"), provenanceBytes, { mode: 0o600 });
  await writeFile(join(artifactRoot, "SHA256SUMS"), checksumsBytes, { mode: 0o600 });

  const reviewEvidencePath = `.skill-press/tessl/${"2".repeat(64)}/evidence.json`;
  const evalEvidencePath = `.skill-press/tessl/${"3".repeat(64)}/evidence.json`;
  await mkdir(join(root, reviewEvidencePath, ".."), { recursive: true, mode: 0o700 });
  await mkdir(join(root, evalEvidencePath, ".."), { recursive: true, mode: 0o700 });
  await writeFile(join(root, reviewEvidencePath), '{"quality":94}\n', { mode: 0o600 });
  await writeFile(join(root, evalEvidencePath), '{"impact":95}\n', { mode: 0o600 });
  await mkdir(join(root, "tessl-evals"), { mode: 0o700 });
  await writeFile(join(root, "tessl-evals", "scenario.json"), '{"id":"one"}\n', {
    mode: 0o600,
  });

  return {
    root,
    artifacts: {
      schemaVersion: 1,
      artifactsPath,
      skillArchive: "example-skill-1.2.3.skill",
      zipArchive: "example-skill-1.2.3.zip",
      checksums: "SHA256SUMS",
      provenance: "provenance.json",
      provenanceSha256: sha256(provenanceBytes),
      provenanceBytes: provenanceBytes.byteLength,
      checksumsSha256: sha256(checksumsBytes),
      checksumsBytes: checksumsBytes.byteLength,
      artifactSha256: sha256(artifactBytes),
      artifactBytes: artifactBytes.byteLength,
      sourceCommit: "4".repeat(40),
      projectConfigSha256: "5".repeat(64),
      skillSha256: "6".repeat(64),
    },
    evidence: {
      reviewEvidencePath,
      evalEvidencePath,
      evalSource: "tessl-evals",
    },
  };
}

describe("canonical submission manifest", () => {
  it("produces deterministic bytes and an independently reproducible idempotency key", async () => {
    const value = await fixture();
    const first = await prepareSkillSubmission(value.root, value.artifacts, value.evidence);
    const second = await prepareSkillSubmission(value.root, value.artifacts, value.evidence);

    expect(second.manifest).toEqual(first.manifest);
    expect(second.manifestBytes).toEqual(first.manifestBytes);
    expect(second.manifestSha256).toBe(first.manifestSha256);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(first.manifestSha256).toBe(sha256(first.manifestBytes));
    expect(first.idempotencyKey).toBe(
      sha256(`skillpress.submission.v1\0${first.manifestBytes.toString("utf8")}`),
    );
    expect(first.manifest).toMatchObject({
      configSchemaVersion: 2,
      project: {
        repository: "https://github.com/source-owner/example-skill",
        author: { name: "Independent Maintainer", github: "maintainer-user" },
      },
      registry: { namespace: "registry-team" },
      evidence: { advisory: true, evalSource: "tessl-evals" },
      serverValidationRequired: true,
      tool: { name: "@skill-press/cli" },
    });
    expect(first.manifest.tool).toEqual({ name: "@skill-press/cli" });
    expect(JSON.parse(first.manifestBytes.toString("utf8"))).toEqual(first.manifest);
  });

  it("keeps registry namespace independent and binds it into the manifest key", async () => {
    const value = await fixture();
    const original = await prepareSkillSubmission(value.root, value.artifacts, value.evidence);
    const configPath = join(value.root, "skill-press.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace("namespace: registry-team", "namespace: other-team"),
    );

    const changed = await prepareSkillSubmission(value.root, value.artifacts, value.evidence);

    expect(changed.manifest.registry.namespace).toBe("other-team");
    expect(changed.manifest.project).toEqual(original.manifest.project);
    expect(changed.manifestSha256).not.toBe(original.manifestSha256);
    expect(changed.idempotencyKey).not.toBe(original.idempotencyKey);
  });

  it("accepts the longest artifact name reachable from valid project identity fields", async () => {
    const value = await fixture();
    const projectName = "a".repeat(64);
    const version = `1.0.0+${"b".repeat(122)}`;
    const artifactName = `${projectName}-${version}.skill`;
    const oldArtifact = join(
      value.root,
      value.artifacts.artifactsPath,
      value.artifacts.skillArchive,
    );
    const artifact = join(value.root, value.artifacts.artifactsPath, artifactName);
    await rename(oldArtifact, artifact);
    const checksumBytes = Buffer.from(`${value.artifacts.artifactSha256}  ${artifactName}\n`);
    await writeFile(join(value.root, value.artifacts.artifactsPath, "SHA256SUMS"), checksumBytes, {
      mode: 0o600,
    });
    const configPath = join(value.root, "skill-press.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config
        .replaceAll("example-skill", projectName)
        .replace("version: 1.2.3", `version: ${version}`),
    );

    const prepared = await prepareSkillSubmission(
      value.root,
      {
        ...value.artifacts,
        skillArchive: artifactName,
        zipArchive: `${projectName}-${version}.zip`,
        checksumsSha256: sha256(checksumBytes),
        checksumsBytes: checksumBytes.byteLength,
      },
      value.evidence,
    );

    expect(artifactName).toHaveLength(199);
    expect(prepared.manifest.package.artifact.name).toBe(artifactName);
  });

  it("rejects a project/skill identity that the server manifest contract cannot accept", async () => {
    const value = await fixture();
    const configPath = join(value.root, "skill-press.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace("skill:\n  name: example-skill", "skill:\n  name: different-skill"),
    );

    await expect(
      prepareSkillSubmission(value.root, value.artifacts, value.evidence),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "submission.project.identity" })],
    });
  });

  it("changes the key when advisory evidence or evaluated source bytes change", async () => {
    const value = await fixture();
    const original = await prepareSkillSubmission(value.root, value.artifacts, value.evidence);
    await writeFile(join(value.root, value.evidence.evalEvidencePath), '{"impact":96}\n', {
      mode: 0o600,
    });
    const changedEvidence = await prepareSkillSubmission(
      value.root,
      value.artifacts,
      value.evidence,
    );
    expect(changedEvidence.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(changedEvidence.manifest.evidence.evaluation.sha256).not.toBe(
      original.manifest.evidence.evaluation.sha256,
    );

    await writeFile(join(value.root, "tessl-evals", "scenario.json"), '{"id":"two"}\n', {
      mode: 0o600,
    });
    const changedSource = await prepareSkillSubmission(value.root, value.artifacts, value.evidence);
    expect(changedSource.idempotencyKey).not.toBe(changedEvidence.idempotencyKey);
    expect(changedSource.manifest.evidence.evalSourceSha256).not.toBe(
      changedEvidence.manifest.evidence.evalSourceSha256,
    );
  });

  it("fails closed when package bytes no longer match the verified artifact report", async () => {
    const value = await fixture();
    await writeFile(
      join(value.root, value.artifacts.artifactsPath, value.artifacts.skillArchive),
      "changed archive\n",
      { mode: 0o600 },
    );
    await expect(
      prepareSkillSubmission(value.root, value.artifacts, value.evidence),
    ).rejects.toBeInstanceOf(SubmissionManifestError);
  });

  it("rejects provenance and checksum payloads above the server reservation contract", async () => {
    for (const [name, bytes, patch] of [
      [
        "provenance.json",
        Buffer.alloc(64 * 1024 + 1, 0x20),
        (value: Buffer) => ({ provenanceBytes: value.byteLength, provenanceSha256: sha256(value) }),
      ],
      [
        "SHA256SUMS",
        Buffer.alloc(1024 + 1, 0x20),
        (value: Buffer) => ({ checksumsBytes: value.byteLength, checksumsSha256: sha256(value) }),
      ],
    ] as const) {
      const value = await fixture();
      await writeFile(join(value.root, value.artifacts.artifactsPath, name), bytes, {
        mode: 0o600,
      });
      await expect(
        prepareSkillSubmission(value.root, { ...value.artifacts, ...patch(bytes) }, value.evidence),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: "submission.payload.unsafe" })],
      });
    }
  });

  it("rejects traversal and noncanonical private payload paths at the public API boundary", async () => {
    const value = await fixture();
    await expect(
      prepareSkillSubmission(
        value.root,
        { ...value.artifacts, artifactsPath: "../outside" },
        value.evidence,
      ),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "submission.artifact.path" })],
    });
    await expect(
      prepareSkillSubmission(value.root, value.artifacts, {
        ...value.evidence,
        reviewEvidencePath: "../outside/evidence.json",
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "submission.evidence.path" })],
    });
    await expect(
      prepareSkillSubmission(value.root, value.artifacts, {
        ...value.evidence,
        evalSource: "../outside",
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "submission.path.unsafe" })],
    });
    await expect(
      prepareSkillSubmission(value.root, value.artifacts, {
        ...value.evidence,
        evalSource: join(value.root, "tessl-evals"),
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "submission.path.unsafe" })],
    });
  });

  it("rejects canonical-looking paths whose parent directory is a symbolic link", async () => {
    const value = await fixture();
    const artifactRoot = join(value.root, value.artifacts.artifactsPath);
    const actualRoot = `${artifactRoot}-real`;
    await rename(artifactRoot, actualRoot);
    await symlink(actualRoot, artifactRoot, "dir");

    await expect(
      prepareSkillSubmission(value.root, value.artifacts, value.evidence),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "submission.path.symlink" })],
    });
  });

  it("fails closed when a payload path is swapped and restored during descriptor reads", async () => {
    const value = await fixture();
    const reviewPath = join(value.root, value.evidence.reviewEvidencePath);
    const originalPath = `${reviewPath}.original`;
    const attackerPath = join(value.root, "attacker-evidence.json");
    await writeFile(attackerPath, '{"secret":"must-not-be-read"}\n', { mode: 0o600 });
    const expected = await lstat(reviewPath, { bigint: true });
    const probe = await open(reviewPath, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read;
    };
    const originalRead = prototype.read;
    await probe.close();
    let raceTriggered = false;

    prototype.read = async function patchedRead(
      this: typeof probe,
      ...arguments_: Parameters<typeof originalRead>
    ) {
      const opened = await this.stat({ bigint: true });
      if (!raceTriggered && opened.dev === expected.dev && opened.ino === expected.ino) {
        raceTriggered = true;
        await rename(reviewPath, originalPath);
        await symlink(attackerPath, reviewPath);
        return originalRead.apply(this, arguments_);
      }
      return originalRead.apply(this, arguments_);
    };

    let rejection: unknown;
    try {
      await prepareSkillSubmission(value.root, value.artifacts, value.evidence);
    } catch (error) {
      rejection = error;
    } finally {
      prototype.read = originalRead;
      if (raceTriggered) {
        await rm(reviewPath);
        await rename(originalPath, reviewPath);
      }
    }
    expect(raceTriggered).toBe(true);
    expect(rejection).toMatchObject({
      issues: [expect.objectContaining({ code: "submission.payload.changed" })],
    });
  });

  it("fails closed when a payload parent is replaced after canonical validation", async () => {
    const value = await fixture();
    const reviewPath = join(value.root, value.evidence.reviewEvidencePath);
    const reviewDirectory = join(reviewPath, "..");
    const originalDirectory = `${reviewDirectory}.original`;
    const attackerDirectory = join(value.root, "attacker-review");
    await mkdir(attackerDirectory, { mode: 0o700 });
    await writeFile(join(attackerDirectory, "evidence.json"), '{"secret":"outside"}\n', {
      mode: 0o600,
    });
    const expected = await lstat(reviewPath, { bigint: true });
    const probe = await open(reviewPath, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      stat: typeof probe.stat;
    };
    const originalStat = prototype.stat;
    await probe.close();
    let raceTriggered = false;

    prototype.stat = async function patchedStat(
      this: typeof probe,
      ...arguments_: Parameters<typeof originalStat>
    ) {
      const opened = await originalStat.apply(this, arguments_);
      if (!raceTriggered && opened.dev === expected.dev && opened.ino === expected.ino) {
        raceTriggered = true;
        await rename(reviewDirectory, originalDirectory);
        await symlink(attackerDirectory, reviewDirectory, "dir");
      }
      return opened;
    };

    let rejection: unknown;
    try {
      await prepareSkillSubmission(value.root, value.artifacts, value.evidence);
    } catch (error) {
      rejection = error;
    } finally {
      prototype.stat = originalStat;
      if (raceTriggered) {
        await rm(reviewDirectory);
        await rename(originalDirectory, reviewDirectory);
      }
    }
    expect(raceTriggered).toBe(true);
    expect(rejection).toMatchObject({
      issues: [expect.objectContaining({ code: "submission.payload.changed" })],
    });
  });

  it("rejects payload files with hard-link aliases", async () => {
    const value = await fixture();
    const reviewPath = join(value.root, value.evidence.reviewEvidencePath);
    await link(reviewPath, `${reviewPath}.alias`);

    await expect(
      prepareSkillSubmission(value.root, value.artifacts, value.evidence),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "submission.payload.unsafe" })],
    });
  });
});
