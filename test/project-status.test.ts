import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";
import { packageStagedSkill } from "../src/package/archive.js";
import { stageCanonicalSkill } from "../src/package/stage.js";
import type { PublicationAdapter } from "../src/publish/saga.js";
import { runPublicationSaga } from "../src/publish/saga.js";
import { inspectProjectStatus } from "../src/status/project.js";
import { checkProject } from "../src/check/project.js";
import type { PublicationReceipt } from "../src/publish/saga.js";
import type { TesslReleaseGateReport } from "../src/release/tessl-gate.js";

const execFileAsync = promisify(execFile);
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function project(): Promise<string> {
  const parent = await mkdtemp(join(temporaryRoot, "skillpress-status-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "project");
  await writeRenderedProject(renderCapabilityProject(await loadCapabilityBrief(briefPath)), root);
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=SkillPress Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  return root;
}

function adapter(id: string): PublicationAdapter {
  return {
    id,
    capability: "publish",
    auth: [],
    rollback: "manual",
    steps: ["publish"],
    preflight: async () => ({ ok: true, code: "ready", message: "ready" }),
    execute: async () => ({}),
    verify: async () => ({ ok: true, url: `https://example.invalid/${id}` }),
  };
}

function gate(passed: boolean, sourceCommit = "1".repeat(40)): TesslReleaseGateReport {
  return {
    schemaVersion: 1,
    gateType: "skillpress.tessl-release",
    evaluatedAt: "2026-08-24T12:00:00.000Z",
    sourceCommit,
    passed,
    thresholds: { quality: 90, impact: 90, maxAgeHours: 168 },
    scores: { quality: passed ? 95 : 80, impact: 95 },
    evidence: { reviewPath: "review", evalPath: "eval" },
    issues: [],
  };
}

function injectedReceipt(overrides: Partial<PublicationReceipt> = {}): PublicationReceipt {
  const sourceCommit = "2".repeat(40);
  const artifactSha256 = "3".repeat(64);
  return {
    schemaVersion: 1,
    receiptType: "skillpress.publication",
    runId: "4".repeat(64),
    idempotencyKey: "5".repeat(64),
    sourceCommit,
    artifactSha256,
    projectVersion: "0.1.0",
    execute: true,
    status: "running",
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
    targets: [
      {
        id: "github",
        capability: "publish",
        auth: [],
        rollback: "manual",
        preflight: { ok: false, code: "blocked", message: "blocked" },
        status: "preflight_failed",
        steps: [{ id: "publish", status: "pending" }],
        url: "https://example.invalid/release",
      },
    ],
    storagePath: `.skillpress/publications/${"4".repeat(64)}/receipt.json`,
    ...overrides,
  };
}

describe("project status", () => {
  it("reports missing release evidence without inventing a gate result", async () => {
    const root = await project();
    const report = await inspectProjectStatus(root, {
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });

    expect(report).toMatchObject({
      statusType: "skillpress.status",
      ready: false,
      local: { eligible: true, score: 100, minimum: 90 },
      gate: null,
      package: null,
      publication: null,
      issues: [{ code: "status.evidence.missing", path: "/gate" }],
    });
    expect(Object.isFrozen(report.issues)).toBe(true);
  });

  it("binds a private package and completed receipt while preserving missing evidence", async () => {
    const root = await project();
    const staged = await stageCanonicalSkill(root);
    const packaged = await packageStagedSkill(root, staged);
    const artifacts = { ...packaged, sourceCommit: staged.sourceCommit };
    const published = await runPublicationSaga(
      root,
      artifacts,
      [adapter("github"), adapter("tessl")],
      {
        execute: true,
      },
    );

    const report = await inspectProjectStatus(root, {
      artifactsPath: packaged.artifactsPath,
      receiptPath: published.storagePath as string,
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });
    expect(report.package).toEqual({
      artifactsPath: packaged.artifactsPath,
      sourceCommit: staged.sourceCommit,
      artifactSha256: packaged.artifactSha256,
    });
    expect(report.publication).toMatchObject({
      status: "completed",
      sourceCommit: staged.sourceCommit,
      artifactSha256: packaged.artifactSha256,
      targets: [
        { id: "github", status: "verified", preflightOk: true },
        { id: "tessl", status: "verified", preflightOk: true },
      ],
    });
    expect(report.issues).toEqual([expect.objectContaining({ code: "status.evidence.missing" })]);
  });

  it("requires package evidence to interpret an explicit receipt", async () => {
    const root = await project();
    const staged = await stageCanonicalSkill(root);
    const packaged = await packageStagedSkill(root, staged);
    const receipt = await runPublicationSaga(
      root,
      { ...packaged, sourceCommit: staged.sourceCommit },
      [adapter("github"), adapter("tessl")],
      { execute: true },
    );

    const report = await inspectProjectStatus(root, {
      receiptPath: receipt.storagePath as string,
    });
    expect(report.issues.map((entry) => entry.code)).toEqual([
      "status.evidence.missing",
      "status.publication.package_missing",
    ]);
  });

  it("rejects a receipt whose embedded storage path does not match its file", async () => {
    const root = await project();
    const staged = await stageCanonicalSkill(root);
    const packaged = await packageStagedSkill(root, staged);
    const receipt = await runPublicationSaga(
      root,
      { ...packaged, sourceCommit: staged.sourceCommit },
      [adapter("github"), adapter("tessl")],
      { execute: true },
    );
    const receiptFile = join(root, receipt.storagePath as string);
    const forged = JSON.parse(await readFile(receiptFile, "utf8"));
    forged.storagePath = `.skillpress/publications/${"6".repeat(64)}/receipt.json`;
    await writeFile(receiptFile, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
    await expect(
      inspectProjectStatus(root, {
        receiptPath: receipt.storagePath as string,
      }),
    ).rejects.toThrow();
  });

  it("reports every stale, blocked, incomplete, and preflight issue from bound inputs", async () => {
    const root = await project();
    const local = await checkProject(root);
    const packageValue = {
      schemaVersion: 1 as const,
      sourceCommit: "6".repeat(40),
      artifactsPath: `.skillpress/staging/${"7".repeat(64)}/artifacts`,
      skillArchive: "incident-summary-1.0.0.skill",
      zipArchive: "incident-summary-1.0.0.zip",
      checksums: "SHA256SUMS",
      provenance: "provenance.json",
      provenanceSha256: "8".repeat(64),
      provenanceBytes: 10,
      checksumsSha256: "9".repeat(64),
      checksumsBytes: 10,
      artifactSha256: "a".repeat(64),
      artifactBytes: 10,
    };
    const report = await inspectProjectStatus(
      root,
      {
        evidence: { reviewEvidencePath: "review", evalEvidencePath: "eval", evalSource: "source" },
        artifactsPath: packageValue.artifactsPath,
        receiptPath: `.skillpress/publications/${"4".repeat(64)}/receipt.json`,
        now: () => new Date("2026-08-24T12:00:00.000Z"),
      },
      {
        checkLocal: async () => ({ ...local, eligible: false, score: 40 }),
        checkGate: async () => gate(false),
        loadPackage: async () => packageValue,
        readReceipt: async () => injectedReceipt(),
      },
    );
    expect(report.issues.map((entry) => entry.code)).toEqual([
      "status.local.blocked",
      "status.gate.blocked",
      "status.package.stale",
      "status.publication.binding",
      "status.publication.incomplete",
      "status.publication.preflight",
    ]);
    expect(report.publication?.targets[0]).toMatchObject({
      url: "https://example.invalid/release",
      preflightOk: false,
    });
  });

  it("reports ready when all supplied bindings and the external gate pass", async () => {
    const root = await project();
    const local = await checkProject(root);
    const sourceCommit = "1".repeat(40);
    const artifactSha256 = "3".repeat(64);
    const packageValue = {
      schemaVersion: 1 as const,
      sourceCommit,
      artifactsPath: `.skillpress/staging/${"7".repeat(64)}/artifacts`,
      skillArchive: "incident-summary-1.0.0.skill",
      zipArchive: "incident-summary-1.0.0.zip",
      checksums: "SHA256SUMS",
      provenance: "provenance.json",
      provenanceSha256: "8".repeat(64),
      provenanceBytes: 10,
      checksumsSha256: "9".repeat(64),
      checksumsBytes: 10,
      artifactSha256,
      artifactBytes: 10,
    };
    const receipt = injectedReceipt({
      sourceCommit,
      artifactSha256,
      status: "completed",
      targets: [
        {
          ...injectedReceipt().targets[0],
          preflight: { ok: true, code: "ready", message: "ready" },
          status: "verified",
          steps: [{ id: "publish", status: "completed" }],
        },
      ],
    });
    const report = await inspectProjectStatus(
      root,
      {
        evidence: { reviewEvidencePath: "review", evalEvidencePath: "eval", evalSource: "source" },
        artifactsPath: packageValue.artifactsPath,
        receiptPath: receipt.storagePath as string,
      },
      {
        checkLocal: async () => local,
        checkGate: async () => gate(true, sourceCommit),
        loadPackage: async () => packageValue,
        readReceipt: async () => receipt,
      },
    );
    expect(report.ready).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("rejects an invalid status clock before reading project state", async () => {
    await expect(inspectProjectStatus(".", { now: () => new Date(Number.NaN) })).rejects.toThrow(
      "clock is invalid",
    );
  });
});
