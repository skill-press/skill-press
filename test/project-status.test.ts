import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { checkProject } from "../src/check/project.js";
import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";
import type { LoadedSkillPackageArtifacts } from "../src/package/archive.js";
import type { TesslReleaseGateReport } from "../src/release/tessl-gate.js";
import { inspectProjectStatus } from "../src/status/project.js";
import type { SubmissionReceipt } from "../src/submission/journal.js";
import type { PreparedSubmissionPayload } from "../src/submission/manifest.js";

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));
const evaluatedAt = "2026-08-27T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function project(): Promise<string> {
  const parent = await mkdtemp(join(temporaryRoot, "skill-press-status-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "project");
  await writeRenderedProject(renderCapabilityProject(await loadCapabilityBrief(briefPath)), root);
  return root;
}

function gate(passed: boolean, sourceCommit = "1".repeat(40)): TesslReleaseGateReport {
  return {
    schemaVersion: 1,
    gateType: "skillpress.tessl-release",
    evaluatedAt,
    sourceCommit,
    passed,
    thresholds: { quality: 90, impact: 90, maxAgeHours: 168 },
    scores: { quality: passed ? 95 : 80, impact: 95 },
    evidence: { reviewPath: "review", evalPath: "eval" },
    issues: [],
  };
}

function packaged(
  sourceCommit = "1".repeat(40),
  artifactSha256 = "2".repeat(64),
): LoadedSkillPackageArtifacts {
  return {
    schemaVersion: 1,
    sourceCommit,
    artifactsPath: `.skill-press/staging/${"3".repeat(64)}/artifacts`,
    skillArchive: "incident-summary-0.1.0.skill",
    zipArchive: "incident-summary-0.1.0.zip",
    checksums: "SHA256SUMS",
    provenance: "provenance.json",
    provenanceSha256: "4".repeat(64),
    provenanceBytes: 10,
    checksumsSha256: "5".repeat(64),
    checksumsBytes: 10,
    artifactSha256,
    artifactBytes: 10,
    projectConfigSha256: "6".repeat(64),
    skillSha256: "7".repeat(64),
  };
}

function receipt(trust: "trusted" | "quarantined" | "revoked" = "trusted"): SubmissionReceipt {
  const idempotencyKey = "8".repeat(64);
  return {
    schemaVersion: 1,
    receiptType: "skillpress.submission",
    runId: "9".repeat(64),
    idempotencyKey,
    registry: { origin: "https://skill-press.com", protocolVersion: 1, namespace: "example" },
    bindings: {
      sourceCommit: "1".repeat(40),
      projectVersion: "0.1.0",
      skillName: "incident-summary",
      projectConfigSha256: "6".repeat(64),
      skillSha256: "7".repeat(64),
      artifactSha256: "2".repeat(64),
      provenanceSha256: "4".repeat(64),
      checksumsSha256: "5".repeat(64),
      manifestSha256: "a".repeat(64),
      reviewEvidenceSha256: "b".repeat(64),
      evalEvidenceSha256: "c".repeat(64),
      evalSourceSha256: "d".repeat(64),
    },
    dryRun: false,
    operationStatus: "submitted",
    request: { status: "completed", attempts: 1 },
    remote: {
      id: "submission_12345678",
      namespace: "example",
      url: "https://skill-press.com/submissions/submission_12345678",
      status: "published",
      statusVersion: 7,
      observedAt: evaluatedAt,
      release: {
        locator: "example/incident-summary@0.1.0",
        version: "0.1.0",
        artifactSha256: "2".repeat(64),
        canonicalUrl: "https://skill-press.com/skills/example/incident-summary/0.1.0",
        attestationUrl: "https://skill-press.com/attestations/example/incident-summary/0.1.0",
        trust: {
          status: trust,
          sequence: 1,
          updatedAt: evaluatedAt,
          ...(trust === "trusted" ? {} : { reasonCode: "security_review" }),
        },
      },
    },
    createdAt: evaluatedAt,
    updatedAt: evaluatedAt,
    storagePath: `.skill-press/submissions/${idempotencyKey}/receipt.json`,
  };
}

function preparedFor(value: SubmissionReceipt): PreparedSubmissionPayload {
  return {
    idempotencyKey: value.idempotencyKey,
    manifestSha256: value.bindings.manifestSha256,
    manifest: {
      skill: { name: value.bindings.skillName },
      evidence: {
        review: { sha256: value.bindings.reviewEvidenceSha256 },
        evaluation: { sha256: value.bindings.evalEvidenceSha256 },
        evalSourceSha256: value.bindings.evalSourceSha256,
      },
    },
  } as unknown as PreparedSubmissionPayload;
}

const evidence = {
  reviewEvidencePath: "review",
  evalEvidencePath: "eval",
  evalSource: "source",
};

describe("project status", () => {
  it("reports missing release evidence without inventing remote state", async () => {
    const root = await project();
    const report = await inspectProjectStatus(root, { now: () => new Date(evaluatedAt) });

    expect(report).toMatchObject({
      ready: false,
      currentTrustVerified: false,
      local: { eligible: true, score: 100, minimum: 90 },
      gate: null,
      package: null,
      submission: null,
      issues: [{ code: "status.evidence.missing", path: "/gate" }],
    });
    expect(Object.isFrozen(report.issues)).toBe(true);
  });

  it("reports ready only for exact package bindings and a trusted published release", async () => {
    const root = await project();
    const local = await checkProject(root);
    const packageValue = packaged();
    const submission = receipt();
    const report = await inspectProjectStatus(
      root,
      {
        evidence,
        artifactsPath: packageValue.artifactsPath,
        submissionReceiptPath: submission.storagePath as string,
      },
      {
        checkLocal: async () => local,
        checkGate: async () => gate(true),
        loadPackage: async () => packageValue,
        readReceipt: async () => submission,
        prepareSubmission: async () => preparedFor(submission),
      },
    );

    expect(report.ready).toBe(true);
    expect(report.currentTrustVerified).toBe(false);
    expect(report.submission?.remote?.status).toBe("published");
    expect(report.submission?.remote?.release?.trust.status).toBe("trusted");
    expect(report.issues).toEqual([]);
  });

  it.each(["quarantined", "revoked"] as const)(
    "blocks a published release whose mutable trust state is %s",
    async (trust) => {
      const root = await project();
      const local = await checkProject(root);
      const packageValue = packaged();
      const submission = receipt(trust);
      const report = await inspectProjectStatus(
        root,
        {
          evidence,
          artifactsPath: packageValue.artifactsPath,
          submissionReceiptPath: submission.storagePath as string,
        },
        {
          checkLocal: async () => local,
          checkGate: async () => gate(true),
          loadPackage: async () => packageValue,
          readReceipt: async () => submission,
          prepareSubmission: async () => preparedFor(submission),
        },
      );

      expect(report.ready).toBe(false);
      expect(report.issues).toContainEqual(
        expect.objectContaining({ code: "status.release.trust_blocked" }),
      );
    },
  );

  it("binds every available package digest rather than only commit and artifact", async () => {
    const root = await project();
    const local = await checkProject(root);
    const packageValue = packaged();
    const canonical = receipt();
    const submission = {
      ...canonical,
      bindings: { ...canonical.bindings, provenanceSha256: "f".repeat(64) },
    };
    const report = await inspectProjectStatus(
      root,
      {
        evidence,
        artifactsPath: packageValue.artifactsPath,
        submissionReceiptPath: submission.storagePath as string,
      },
      {
        checkLocal: async () => local,
        checkGate: async () => gate(true),
        loadPackage: async () => packageValue,
        readReceipt: async () => submission,
        prepareSubmission: async () => preparedFor(canonical),
      },
    );

    expect(report.ready).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "status.submission.binding" }),
    );
  });

  it("reconstructs the current manifest to detect changed evidence bindings", async () => {
    const root = await project();
    const local = await checkProject(root);
    const packageValue = packaged();
    const canonical = receipt();
    const submission = {
      ...canonical,
      bindings: { ...canonical.bindings, reviewEvidenceSha256: "f".repeat(64) },
    };
    const report = await inspectProjectStatus(
      root,
      {
        evidence,
        artifactsPath: packageValue.artifactsPath,
        submissionReceiptPath: submission.storagePath as string,
      },
      {
        checkLocal: async () => local,
        checkGate: async () => gate(true),
        loadPackage: async () => packageValue,
        readReceipt: async () => submission,
        prepareSubmission: async () => preparedFor(canonical),
      },
    );

    expect(report.issues.map((entry) => entry.code)).toEqual([
      "status.submission.manifest_binding",
    ]);
  });

  it("rejects a receipt targeting a different registry namespace", async () => {
    const root = await project();
    const local = await checkProject(root);
    const packageValue = packaged();
    const canonical = receipt();
    const submission = {
      ...canonical,
      registry: { ...canonical.registry, namespace: "different-namespace" },
    };
    const report = await inspectProjectStatus(
      root,
      {
        evidence,
        artifactsPath: packageValue.artifactsPath,
        submissionReceiptPath: submission.storagePath as string,
      },
      {
        checkLocal: async () => local,
        checkGate: async () => gate(true),
        loadPackage: async () => packageValue,
        readReceipt: async () => submission,
        prepareSubmission: async () => preparedFor(canonical),
      },
    );

    expect(report.ready).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "status.submission.namespace" }),
    );
  });

  it("reports stale, mismatched, and incomplete supplied state", async () => {
    const root = await project();
    const local = await checkProject(root);
    const packageValue = packaged("e".repeat(40), "f".repeat(64));
    const submission = {
      ...receipt(),
      operationStatus: "failed" as const,
      request: { status: "pending" as const, attempts: 1 },
      remote: null,
      errorCode: "registry_unavailable",
    };
    const report = await inspectProjectStatus(
      root,
      {
        evidence,
        artifactsPath: packageValue.artifactsPath,
        submissionReceiptPath: submission.storagePath as string,
      },
      {
        checkLocal: async () => ({ ...local, eligible: false, score: 40 }),
        checkGate: async () => gate(false),
        loadPackage: async () => packageValue,
        readReceipt: async () => submission,
        prepareSubmission: async () => preparedFor(receipt()),
      },
    );

    expect(report.issues.map((entry) => entry.code)).toEqual([
      "status.local.blocked",
      "status.gate.blocked",
      "status.package.stale",
      "status.submission.binding",
      "status.submission.incomplete",
    ]);
  });

  it("requires a package to interpret an explicit submission journal", async () => {
    const root = await project();
    const local = await checkProject(root);
    const submission = receipt();
    const report = await inspectProjectStatus(
      root,
      { evidence, submissionReceiptPath: submission.storagePath as string },
      {
        checkLocal: async () => local,
        checkGate: async () => gate(true),
        readReceipt: async () => submission,
      },
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "status.submission.package_missing" }),
    );
  });

  it("rejects an invalid clock before reading project state", async () => {
    await expect(inspectProjectStatus(".", { now: () => new Date(Number.NaN) })).rejects.toThrow(
      "clock is invalid",
    );
  });
});
