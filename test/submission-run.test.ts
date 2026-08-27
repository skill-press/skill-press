import { realpathSync } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadedSkillPackageArtifacts } from "../src/package/archive.js";
import {
  SubmissionClientError,
  type SkillPressSubmissionClient,
} from "../src/submission/client.js";
import type { SkillPressSubmissionResource } from "../src/submission/generated-resource.js";
import { readSubmissionReceipt } from "../src/submission/journal.js";
import type { PreparedSubmissionPayload } from "../src/submission/manifest.js";

const dependencies = vi.hoisted(() => ({
  checkGate: vi.fn(),
  loadPackage: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("../src/release/tessl-gate.js", () => ({
  checkTesslReleaseGate: dependencies.checkGate,
}));
vi.mock("../src/package/archive.js", () => ({
  loadPackagedSkill: dependencies.loadPackage,
}));
vi.mock("../src/submission/manifest.js", () => ({
  prepareSkillSubmission: dependencies.prepare,
}));

const { runSkillSubmission, SubmissionRunError } = await import("../src/submission/run.js");

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const now = new Date("2026-08-27T12:00:00.000Z");
const evidence = {
  reviewEvidencePath: `.skill-press/tessl/${"8".repeat(64)}/evidence.json`,
  evalEvidencePath: `.skill-press/tessl/${"9".repeat(64)}/evidence.json`,
  evalSource: "tessl-evals",
};

function artifacts(): LoadedSkillPackageArtifacts {
  return {
    schemaVersion: 1,
    artifactsPath: `.skill-press/staging/${"1".repeat(64)}/artifacts`,
    skillArchive: "example-skill-1.2.3.skill",
    zipArchive: "example-skill-1.2.3.zip",
    checksums: "SHA256SUMS",
    provenance: "provenance.json",
    provenanceSha256: "2".repeat(64),
    provenanceBytes: 10,
    checksumsSha256: "3".repeat(64),
    checksumsBytes: 20,
    artifactSha256: "4".repeat(64),
    artifactBytes: 30,
    sourceCommit: "5".repeat(40),
    projectConfigSha256: "6".repeat(64),
    skillSha256: "7".repeat(64),
  };
}

function prepared(
  inputArtifacts: LoadedSkillPackageArtifacts,
  idempotencyKey = "a".repeat(64),
): PreparedSubmissionPayload {
  const manifest = {
    schemaVersion: 1 as const,
    manifestType: "skillpress.submission-manifest" as const,
    configSchemaVersion: 2 as const,
    project: {
      name: "example-skill",
      version: "1.2.3",
      repository: "https://github.com/example/example-skill",
      license: "MIT",
      author: { name: "Example Author", github: "example" },
    },
    registry: { namespace: "example" },
    skill: { name: "example-skill", path: "skills/example-skill", risk: "moderate" as const },
    source: {
      commit: inputArtifacts.sourceCommit,
      projectConfigSha256: inputArtifacts.projectConfigSha256,
      skillSha256: inputArtifacts.skillSha256,
    },
    package: {
      artifact: {
        name: inputArtifacts.skillArchive,
        sha256: inputArtifacts.artifactSha256,
        bytes: inputArtifacts.artifactBytes,
        mediaType: "application/zip" as const,
      },
      provenance: {
        name: inputArtifacts.provenance,
        sha256: inputArtifacts.provenanceSha256,
        bytes: inputArtifacts.provenanceBytes,
        mediaType: "application/json" as const,
      },
      checksums: {
        name: inputArtifacts.checksums,
        sha256: inputArtifacts.checksumsSha256,
        bytes: inputArtifacts.checksumsBytes,
        mediaType: "text/plain" as const,
      },
    },
    evidence: {
      advisory: true as const,
      review: {
        name: "review-evidence.json",
        sha256: "b".repeat(64),
        bytes: 10,
        mediaType: "application/json" as const,
      },
      evaluation: {
        name: "eval-evidence.json",
        sha256: "c".repeat(64),
        bytes: 10,
        mediaType: "application/json" as const,
      },
      evalSourceSha256: "d".repeat(64),
    },
    serverValidationRequired: true as const,
    tool: { name: "@skill-press/cli" as const },
  };
  return {
    manifest,
    manifestBytes: Buffer.from(`${JSON.stringify(manifest)}\n`),
    manifestSha256: "e".repeat(64),
    idempotencyKey,
    artifactBytes: Buffer.from("artifact"),
    provenanceBytes: Buffer.from("provenance"),
    checksumsBytes: Buffer.from("checksums"),
    reviewEvidenceBytes: Buffer.from("review"),
    evalEvidenceBytes: Buffer.from("evaluation"),
  };
}

function resource(
  payload: PreparedSubmissionPayload,
  overrides: Partial<SkillPressSubmissionResource> = {},
): SkillPressSubmissionResource {
  return {
    schemaVersion: 1,
    resourceType: "skillpress.submission",
    id: "submission_12345678",
    idempotencyKey: payload.idempotencyKey,
    namespace: payload.manifest.registry.namespace,
    status: "received",
    statusVersion: 1,
    sourceCommit: payload.manifest.source.commit,
    artifactSha256: payload.manifest.package.artifact.sha256,
    projectVersion: payload.manifest.project.version,
    url: "https://skill-press.com/submissions/submission_12345678",
    receivedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function client(
  payload: PreparedSubmissionPayload,
  options: {
    readonly submit?: (payload: PreparedSubmissionPayload) => Promise<SkillPressSubmissionResource>;
    readonly get?: (id: string) => Promise<SkillPressSubmissionResource>;
  } = {},
): SkillPressSubmissionClient & {
  readonly checkSession: ReturnType<typeof vi.fn>;
  readonly submit: ReturnType<typeof vi.fn>;
  readonly getSubmission: ReturnType<typeof vi.fn>;
} {
  const submitted = resource(payload);
  return {
    checkSession: vi.fn(async () => ({
      schemaVersion: 1 as const,
      sessionType: "skillpress.session" as const,
      authenticated: true as const,
    })),
    submit: vi.fn(options.submit ?? (async () => submitted)),
    getSubmission: vi.fn(options.get ?? (async () => submitted)),
  };
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(temporaryRoot, "skill-press-submission-run-"));
  temporaryDirectories.push(root);
  return root;
}

beforeEach(() => {
  const packageArtifacts = artifacts();
  const payload = prepared(packageArtifacts);
  dependencies.checkGate.mockReset();
  dependencies.loadPackage.mockReset();
  dependencies.prepare.mockReset();
  dependencies.checkGate.mockResolvedValue({
    passed: true,
    sourceCommit: packageArtifacts.sourceCommit,
  });
  dependencies.loadPackage.mockResolvedValue(packageArtifacts);
  dependencies.prepare.mockResolvedValue(payload);
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("canonical submission orchestration", () => {
  it("rejects a blocked initial gate before loading or preparing a package", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    dependencies.checkGate.mockResolvedValueOnce({
      passed: false,
      sourceCommit: packageArtifacts.sourceCommit,
    });

    await expect(
      runSkillSubmission(root, packageArtifacts, {
        evidence,
        client: client(prepared(packageArtifacts)),
        now: () => now,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "submission.gate.blocked" })],
    });
    expect(dependencies.loadPackage).not.toHaveBeenCalled();
    expect(dependencies.prepare).not.toHaveBeenCalled();
  });

  it("rejects a package that changes after the initial gate", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    dependencies.loadPackage.mockResolvedValueOnce({
      ...packageArtifacts,
      artifactSha256: "f".repeat(64),
    });

    await expect(
      runSkillSubmission(root, packageArtifacts, {
        evidence,
        client: client(prepared(packageArtifacts)),
        now: () => now,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "submission.package.changed" })],
    });
    expect(dependencies.prepare).not.toHaveBeenCalled();
  });

  it("rejects an invalid submission clock and a dry-run resume", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    const remote = client(prepared(packageArtifacts));

    await expect(
      runSkillSubmission(root, packageArtifacts, {
        evidence,
        dryRun: true,
        client: remote,
        now: () => new Date(Number.NaN),
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "submission.clock.invalid" })],
    });
    await expect(
      runSkillSubmission(root, packageArtifacts, {
        evidence,
        dryRun: true,
        resumeReceiptPath: `.skill-press/submissions/${"a".repeat(64)}/receipt.json`,
        client: remote,
        now: () => now,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "submission.resume.dry_run" })],
    });
    expect(remote.checkSession).not.toHaveBeenCalled();
  });

  it("performs a dry-run without network access or persistent state", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    const payload = prepared(packageArtifacts);
    const remote = client(payload);

    const result = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      dryRun: true,
      client: remote,
      now: () => now,
    });

    expect(result).toMatchObject({
      dryRun: true,
      operationStatus: "prepared",
      request: { status: "pending", attempts: 0 },
      remote: null,
      storagePath: null,
    });
    expect(remote.checkSession).not.toHaveBeenCalled();
    expect(remote.submit).not.toHaveBeenCalled();
    expect(remote.getSubmission).not.toHaveBeenCalled();
    await expect(lstat(join(root, ".skill-press"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidates current inputs after session preflight and before the first POST", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    const payload = prepared(packageArtifacts);
    dependencies.checkGate
      .mockResolvedValueOnce({ passed: true, sourceCommit: packageArtifacts.sourceCommit })
      .mockResolvedValueOnce({ passed: false, sourceCommit: packageArtifacts.sourceCommit });
    const remote = client(payload);

    const result = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: remote,
      now: () => now,
    });

    expect(result).toMatchObject({
      operationStatus: "failed",
      request: { status: "pending", attempts: 0 },
      remote: null,
      errorCode: "submission_gate_changed",
    });
    expect(remote.checkSession).toHaveBeenCalledOnce();
    expect(remote.submit).not.toHaveBeenCalled();
  });

  it("journals one canonical request and reports review status without claiming publication", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    const payload = prepared(packageArtifacts);
    const submitted = resource(payload, { status: "received", statusVersion: 1 });
    const reviewing = resource(payload, {
      status: "curator-review",
      statusVersion: 2,
      updatedAt: "2026-08-27T12:01:00.000Z",
    });
    const remote = client(payload, {
      submit: async () => submitted,
      get: async () => reviewing,
    });

    const result = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: remote,
      now: () => now,
    });

    expect(result).toMatchObject({
      dryRun: false,
      operationStatus: "submitted",
      request: { status: "completed", attempts: 1 },
      remote: { id: submitted.id, status: "curator-review", statusVersion: 2 },
    });
    expect(JSON.stringify(result)).not.toMatch(/published|trusted|quarantined|revoked/u);
    expect(remote.checkSession).toHaveBeenCalledOnce();
    expect(remote.submit).toHaveBeenCalledOnce();
    expect(remote.getSubmission).toHaveBeenCalledWith(submitted.id);
    const stored = await readSubmissionReceipt(root, result.storagePath as string);
    expect(stored).toEqual(result);
  });

  it("persists published release trust separately from submission review status", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    const payload = prepared(packageArtifacts);
    const published = resource(payload, {
      status: "published",
      statusVersion: 7,
      release: {
        locator: "example/example-skill@1.2.3",
        version: "1.2.3",
        artifactSha256: payload.manifest.package.artifact.sha256,
        canonicalUrl: "https://skill-press.com/skills/example/example-skill/1.2.3",
        attestationUrl: "https://skill-press.com/attestations/example/example-skill/1.2.3",
        trust: {
          status: "quarantined",
          sequence: 2,
          updatedAt: now.toISOString(),
          reasonCode: "security_review",
        },
      },
    });

    const result = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: client(payload, {
        submit: async () => published,
        get: async () => published,
      }),
      now: () => now,
    });

    expect(result.remote).toMatchObject({
      status: "published",
      release: { trust: { status: "quarantined", sequence: 2 } },
    });
    expect((await readSubmissionReceipt(root, result.storagePath as string)).remote).toEqual(
      result.remote,
    );
  });

  it("rejects a published resource whose locator and canonical URLs do not bind", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    const payload = prepared(packageArtifacts);
    const mismatched = resource(payload, {
      status: "published",
      statusVersion: 7,
      release: {
        locator: "example/example-skill@1.2.3",
        version: "1.2.3",
        artifactSha256: payload.manifest.package.artifact.sha256,
        canonicalUrl: "https://skill-press.com/skills/other/example-skill/1.2.3",
        attestationUrl: "https://skill-press.com/attestations/example/example-skill/1.2.3",
        trust: { status: "trusted", sequence: 1, updatedAt: now.toISOString() },
      },
    });

    const result = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: client(payload, { submit: async () => mismatched }),
      now: () => now,
    });

    expect(result).toMatchObject({
      operationStatus: "failed",
      request: { status: "pending", attempts: 1 },
      remote: null,
      errorCode: "submission_remote_binding",
    });
  });

  it("rejects a resource assigned to a namespace other than the manifest request", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    const payload = prepared(packageArtifacts);
    const mismatched = resource(payload, { namespace: "different-namespace" });

    const result = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: client(payload, { submit: async () => mismatched }),
      now: () => now,
    });

    expect(result).toMatchObject({
      operationStatus: "failed",
      request: { status: "pending", attempts: 1 },
      remote: null,
      errorCode: "submission_remote_binding",
    });
  });

  it("resumes a failed idempotent request without replacing its journal", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    const payload = prepared(packageArtifacts);
    const unavailable = client(payload, {
      submit: async () => {
        throw new SubmissionClientError("registry_unavailable", "sensitive provider detail");
      },
    });
    const failed = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: unavailable,
      now: () => now,
    });
    expect(failed).toMatchObject({
      operationStatus: "failed",
      request: { status: "pending", attempts: 1 },
      errorCode: "registry_unavailable",
    });
    expect(JSON.stringify(failed)).not.toContain("sensitive provider detail");

    const recoveredClient = client(payload);
    const recovered = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: recoveredClient,
      resumeReceiptPath: failed.storagePath as string,
      now: () => now,
    });
    expect(recovered).toMatchObject({
      operationStatus: "submitted",
      request: { status: "completed", attempts: 2 },
    });
    expect("errorCode" in recovered).toBe(false);
    expect(recovered.storagePath).toBe(failed.storagePath);
    expect(recovered.runId).toBe(failed.runId);
    expect(recoveredClient.submit).toHaveBeenCalledOnce();
  });

  it("requires explicit resume when the exact journal already exists", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    const payload = prepared(packageArtifacts);
    const first = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: client(payload),
      now: () => now,
    });
    expect(first.operationStatus).toBe("submitted");

    const unused = client(payload);
    await expect(
      runSkillSubmission(root, packageArtifacts, {
        evidence,
        client: unused,
        now: () => now,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "submission.resume.required" })],
    });
    expect(unused.checkSession).not.toHaveBeenCalled();
  });

  it("recovers a completed POST after GET verification fails without posting again", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    const payload = prepared(packageArtifacts);
    const initial = client(payload, {
      get: async () => {
        throw new SubmissionClientError("registry_unavailable", "transient verification failure");
      },
    });
    const failed = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: initial,
      now: () => now,
    });
    expect(failed).toMatchObject({
      operationStatus: "failed",
      request: { status: "completed", attempts: 1 },
      remote: { id: "submission_12345678" },
      errorCode: "registry_unavailable",
    });

    const reviewing = resource(payload, { status: "curator-review", statusVersion: 2 });
    const recovery = client(payload, { get: async () => reviewing });
    const recovered = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: recovery,
      resumeReceiptPath: failed.storagePath as string,
      now: () => now,
    });

    expect(recovered).toMatchObject({
      operationStatus: "submitted",
      request: { status: "completed", attempts: 1 },
      remote: { status: "curator-review", statusVersion: 2 },
    });
    expect("errorCode" in recovered).toBe(false);
    expect(recovery.submit).not.toHaveBeenCalled();
    expect(recovery.getSubmission).toHaveBeenCalledWith("submission_12345678");
  });

  it("recovers a transient refresh failure without downgrading to a second POST", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    const payload = prepared(packageArtifacts);
    const submitted = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: client(payload),
      now: () => now,
    });

    const unavailable = client(payload, {
      get: async () => {
        throw new SubmissionClientError("registry_unavailable", "transient refresh failure");
      },
    });
    const failed = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: unavailable,
      resumeReceiptPath: submitted.storagePath as string,
      now: () => now,
    });
    expect(failed).toMatchObject({
      operationStatus: "failed",
      request: { status: "completed", attempts: 1 },
      remote: { id: submitted.remote?.id },
      errorCode: "registry_unavailable",
    });

    const recovery = client(payload);
    const recovered = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: recovery,
      resumeReceiptPath: failed.storagePath as string,
      now: () => now,
    });
    expect(recovered.operationStatus).toBe("submitted");
    expect(recovered.request.attempts).toBe(1);
    expect(recovery.submit).not.toHaveBeenCalled();
  });

  it("rejects resume when the deterministic manifest binding changes", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    const payload = prepared(packageArtifacts);
    const unavailable = client(payload, {
      submit: async () => {
        throw new SubmissionClientError("registry_unavailable", "unavailable");
      },
    });
    const failed = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: unavailable,
      now: () => now,
    });

    dependencies.prepare.mockResolvedValue(prepared(packageArtifacts, "f".repeat(64)));
    const unused = client(payload);
    await expect(
      runSkillSubmission(root, packageArtifacts, {
        evidence,
        client: unused,
        resumeReceiptPath: failed.storagePath as string,
        now: () => now,
      }),
    ).rejects.toBeInstanceOf(SubmissionRunError);
    expect(unused.checkSession).not.toHaveBeenCalled();
    expect(unused.submit).not.toHaveBeenCalled();
  });

  it("fails closed if status refresh returns a different remote submission ID", async () => {
    const root = await project();
    const packageArtifacts = artifacts();
    const payload = prepared(packageArtifacts);
    const initialClient = client(payload);
    const submitted = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: initialClient,
      now: () => now,
    });
    expect(submitted.operationStatus).toBe("submitted");

    const replacement = resource(payload, {
      id: "submission_replacement",
      url: "https://skill-press.com/submissions/submission_replacement",
      status: "accepted",
      statusVersion: 2,
    });
    const refreshClient = client(payload, { get: async () => replacement });
    const refreshed = await runSkillSubmission(root, packageArtifacts, {
      evidence,
      client: refreshClient,
      resumeReceiptPath: submitted.storagePath as string,
      now: () => now,
    });
    expect(refreshed).toMatchObject({
      operationStatus: "failed",
      errorCode: "submission_remote_verify",
      remote: { id: submitted.remote?.id },
    });
    expect(refreshClient.submit).not.toHaveBeenCalled();
  });
});
