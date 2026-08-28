import { describe, expect, it, vi } from "vitest";

import { runSubmitCommand, SUBMIT_HELP } from "../src/cli/submission.js";
import { ProjectConfigError } from "../src/config/errors.js";
import { type LoadedSkillPackageArtifacts, SkillPackageError } from "../src/package/archive.js";
import { SkillStagingError, type StagedCanonicalSkill } from "../src/package/stage.js";
import { TesslReleaseGateError, type TesslReleaseGateReport } from "../src/release/tessl-gate.js";
import { SubmissionJournalError, type SubmissionReceipt } from "../src/submission/journal.js";
import { SubmissionManifestError } from "../src/submission/manifest.js";
import { SubmissionRunError } from "../src/submission/run.js";

const sourceCommit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const runId = "1".repeat(64);
const artifactsPath = `.skill-press/staging/${runId}/artifacts`;
const receiptPath = `.skill-press/submissions/${"2".repeat(64)}/receipt.json`;
const issue = Object.freeze({ code: "test.blocked", path: "/test", message: "blocked" });

type Operations = NonNullable<Parameters<typeof runSubmitCommand>[2]>;

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

function gate(overrides: Partial<TesslReleaseGateReport> = {}): TesslReleaseGateReport {
  return {
    schemaVersion: 1,
    gateType: "skillpress.tessl-release",
    evaluatedAt: "2026-08-27T12:00:00.000Z",
    sourceCommit,
    passed: true,
    thresholds: { quality: 90, impact: 90, maxAgeHours: 168 },
    scores: { quality: 96, impact: 94 },
    evidence: { reviewPath: "review.json", evalPath: "eval.json" },
    issues: [],
    ...overrides,
  };
}

function staged(commit = sourceCommit): StagedCanonicalSkill {
  return {
    schemaVersion: 1,
    sourceCommit: commit,
    projectConfigSha256: "3".repeat(64),
    skillSha256: "4".repeat(64),
    stagingPath: `.skill-press/staging/${runId}`,
    skillPath: `.skill-press/staging/${runId}/skill`,
    files: [],
  };
}

function artifacts(commit = sourceCommit): LoadedSkillPackageArtifacts {
  return {
    schemaVersion: 1,
    artifactsPath,
    skillArchive: `${artifactsPath}/skill.tar.gz`,
    zipArchive: `${artifactsPath}/skill.zip`,
    checksums: `${artifactsPath}/SHA256SUMS`,
    provenance: `${artifactsPath}/provenance.json`,
    provenanceSha256: "5".repeat(64),
    provenanceBytes: 10,
    checksumsSha256: "6".repeat(64),
    checksumsBytes: 20,
    artifactSha256: "7".repeat(64),
    artifactBytes: 30,
    sourceCommit: commit,
    projectConfigSha256: "3".repeat(64),
    skillSha256: "4".repeat(64),
  };
}

function receipt(overrides: Partial<SubmissionReceipt> = {}): SubmissionReceipt {
  return {
    schemaVersion: 1,
    receiptType: "skillpress.submission",
    runId: "8".repeat(64),
    idempotencyKey: "2".repeat(64),
    registry: {
      origin: "https://skill-press.com",
      protocolVersion: 1,
      namespace: "skill-press",
    },
    bindings: {
      sourceCommit,
      projectVersion: "1.0.0",
      skillName: "skill-press",
      projectConfigSha256: "3".repeat(64),
      skillSha256: "4".repeat(64),
      artifactSha256: "7".repeat(64),
      provenanceSha256: "5".repeat(64),
      checksumsSha256: "6".repeat(64),
      manifestSha256: "9".repeat(64),
      reviewEvidenceSha256: "a".repeat(64),
      evalEvidenceSha256: "b".repeat(64),
      evalSourceSha256: "c".repeat(64),
    },
    dryRun: true,
    operationStatus: "prepared",
    request: { status: "pending", attempts: 0 },
    remote: null,
    createdAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
    storagePath: null,
    ...overrides,
  };
}

function submittedReceipt(withRelease = false): SubmissionReceipt {
  return receipt({
    dryRun: false,
    operationStatus: "submitted",
    request: { status: "completed", attempts: 1 },
    remote: {
      id: "submission_12345678",
      namespace: "skill-press",
      url: "https://skill-press.com/api/v1/submissions/submission_12345678",
      status: withRelease ? "published" : "accepted",
      statusVersion: 2,
      observedAt: "2026-08-27T12:01:00.000Z",
      ...(withRelease
        ? {
            release: {
              locator: "skill-press/example@1.0.0",
              version: "1.0.0",
              artifactSha256: "7".repeat(64),
              canonicalUrl: "https://skill-press.com/skills/skill-press/example/1.0.0",
              attestationUrl: "https://skill-press.com/attestations/skill-press/example/1.0.0",
              trust: {
                status: "trusted" as const,
                sequence: 1,
                updatedAt: "2026-08-27T12:01:00.000Z",
              },
            },
          }
        : {}),
    },
    storagePath: receiptPath,
  });
}

function operations(overrides: Partial<Operations> = {}): Operations {
  return {
    checkGate: vi.fn(async () => gate()),
    stage: vi.fn(async () => staged()),
    package: vi.fn(async () => artifacts()),
    load: vi.fn(async () => artifacts()),
    submit: vi.fn(async () => receipt()),
    ...overrides,
  };
}

function requiredArgs(...extra: string[]): string[] {
  return [
    "--project",
    ".",
    "--review-evidence",
    "review.json",
    "--eval-evidence",
    "eval.json",
    "--eval-source",
    "eval-source",
    ...extra,
  ];
}

describe("submission CLI orchestration", () => {
  it("documents the canonical command and its local-only dry run", () => {
    expect(SUBMIT_HELP).toContain("skpress submit");
    expect(SUBMIT_HELP).toContain("--dry-run");
    expect(SUBMIT_HELP).toContain("only to Skill Press");
    expect(SUBMIT_HELP).not.toContain("askill");
    expect(SUBMIT_HELP).not.toContain("ClawHub");
  });

  it.each([
    { name: "missing required input", args: [] },
    { name: "unknown option", args: ["FORGED\u001b[31m"] },
    { name: "duplicate boolean", args: ["--json", "--json"] },
    { name: "duplicate value", args: ["--project", ".", "--project", "."] },
    { name: "missing value", args: ["--project"] },
    { name: "option-like value", args: ["--project", "--json"] },
    { name: "unsafe value", args: ["--project", "bad\0path"] },
    { name: "oversized value", args: ["--project", "x".repeat(4097)] },
    { name: "resume without artifacts", args: requiredArgs("--resume", receiptPath) },
    {
      name: "dry-run resume",
      args: requiredArgs("--artifacts", artifactsPath, "--resume", receiptPath, "--dry-run"),
    },
  ])("rejects $name without invoking release operations", async ({ args }) => {
    const result = capture();
    const ops = operations();
    await expect(runSubmitCommand(args, result.io, ops)).resolves.toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toHaveLength(1);
    expect(result.stderr[0]).toContain("cli.usage");
    expect(result.stderr[0]).not.toContain("FORGED");
    expect(ops.checkGate).not.toHaveBeenCalled();
  });

  it("emits stable JSON for a dry run that reuses exact artifacts", async () => {
    const result = capture();
    const ops = operations();
    await expect(
      runSubmitCommand(
        requiredArgs("--artifacts", artifactsPath, "--dry-run", "--json"),
        result.io,
        ops,
      ),
    ).resolves.toBe(0);

    expect(ops.load).toHaveBeenCalledWith(".", artifactsPath);
    expect(ops.stage).not.toHaveBeenCalled();
    expect(ops.package).not.toHaveBeenCalled();
    expect(ops.submit).toHaveBeenCalledWith(".", artifacts(), {
      evidence: {
        reviewEvidencePath: "review.json",
        evalEvidencePath: "eval.json",
        evalSource: "eval-source",
      },
      dryRun: true,
    });
    expect(JSON.parse(result.stdout[0] as string)).toMatchObject({
      command: "submit",
      ok: true,
      status: "prepared",
      receipt: { dryRun: true, remote: null },
    });
    expect(result.stderr).toEqual([]);
  });

  it("stages and packages a fresh candidate and renders human submission state", async () => {
    const result = capture();
    const accepted = submittedReceipt();
    const ops = operations({ submit: vi.fn(async () => accepted) });
    const args = requiredArgs().slice(2);

    await expect(runSubmitCommand(args, result.io, ops)).resolves.toBe(0);

    expect(ops.checkGate).toHaveBeenCalledTimes(2);
    expect(ops.checkGate).toHaveBeenCalledWith(process.cwd(), {
      reviewEvidencePath: "review.json",
      evalEvidencePath: "eval.json",
      evalSource: "eval-source",
    });
    expect(ops.stage).toHaveBeenCalledWith(process.cwd());
    expect(ops.package).toHaveBeenCalledWith(process.cwd(), staged());
    expect(ops.load).toHaveBeenCalledWith(process.cwd(), artifactsPath);
    expect(result.stdout.join("")).toContain("Tessl release gate: passed");
    expect(result.stdout.join("")).toContain("Submission: submitted");
    expect(result.stdout.join("")).toContain("Namespace: skill-press");
    expect(result.stdout.join("")).toContain("Remote review: accepted");
    expect(result.stdout.join("")).toContain("Observed release trust: not released");
  });

  it("passes the exact resume journal and reports observed published trust", async () => {
    const result = capture();
    const ops = operations({ submit: vi.fn(async () => submittedReceipt(true)) });
    await expect(
      runSubmitCommand(
        requiredArgs("--artifacts", artifactsPath, "--resume", receiptPath),
        result.io,
        ops,
      ),
    ).resolves.toBe(0);

    expect(ops.submit).toHaveBeenCalledWith(".", artifacts(), {
      evidence: {
        reviewEvidencePath: "review.json",
        evalEvidencePath: "eval.json",
        evalSource: "eval-source",
      },
      dryRun: false,
      resumeReceiptPath: receiptPath,
    });
    expect(result.stdout.join("")).toContain("Mode: submit");
    expect(result.stdout.join("")).toContain("Observed release trust: trusted");
  });

  it("returns blocked before packaging when the first Tessl gate fails", async () => {
    const result = capture();
    const blocked = gate({
      passed: false,
      scores: { quality: null, impact: null },
      issues: [issue],
    });
    const ops = operations({ checkGate: vi.fn(async () => blocked) });
    await expect(runSubmitCommand(requiredArgs("--json"), result.io, ops)).resolves.toBe(3);
    expect(ops.stage).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout[0] as string)).toMatchObject({
      command: "submit",
      ok: false,
      status: "blocked",
      gate: { scores: { quality: null, impact: null } },
    });
  });

  it.each([
    {
      name: "the final gate becomes blocked",
      finalGate: gate({ passed: false, issues: [issue] }),
    },
    {
      name: "the final gate binds a different commit",
      finalGate: gate({ sourceCommit: otherCommit }),
    },
  ])("returns blocked when $name", async ({ finalGate }) => {
    const result = capture();
    const checkGate = vi.fn(async () => gate());
    checkGate.mockResolvedValueOnce(gate()).mockResolvedValueOnce(finalGate);
    const ops = operations({ checkGate });
    await expect(runSubmitCommand(requiredArgs("--json"), result.io, ops)).resolves.toBe(3);
    expect(ops.submit).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout[0] as string)).toMatchObject({
      ok: false,
      status: "blocked",
    });
  });

  it("rejects source changes during staging or artifact reuse", async () => {
    for (const ops of [
      operations({ stage: vi.fn(async () => staged(otherCommit)) }),
      operations({ load: vi.fn(async () => artifacts(otherCommit)) }),
    ]) {
      const result = capture();
      await expect(runSubmitCommand(requiredArgs("--json"), result.io, ops)).resolves.toBe(3);
      expect(JSON.parse(result.stderr[0] as string)).toMatchObject({
        ok: false,
        code: "submission_blocked",
        issues: [{ code: expect.stringMatching(/^submission[.]/u) }],
      });
      expect(ops.submit).not.toHaveBeenCalled();
    }
  });

  it("uses exit 3 when the server workflow returns a non-success receipt", async () => {
    const result = capture();
    const failed = receipt({
      dryRun: false,
      operationStatus: "failed",
      storagePath: receiptPath,
      errorCode: "registry_unavailable",
    });
    const ops = operations({ submit: vi.fn(async () => failed) });
    await expect(runSubmitCommand(requiredArgs("--json"), result.io, ops)).resolves.toBe(3);
    expect(JSON.parse(result.stdout[0] as string)).toMatchObject({
      ok: false,
      status: "failed",
    });
  });

  it.each([
    new ProjectConfigError("config", [issue]),
    new TesslReleaseGateError("gate", [issue]),
    new SkillStagingError("stage", [issue]),
    new SkillPackageError("package", [issue]),
    new SubmissionManifestError("manifest", [issue]),
    new SubmissionJournalError("journal", [issue]),
    new SubmissionRunError("submission", [issue]),
  ])("renders known release failures without leaking internals", async (error) => {
    const result = capture();
    const ops = operations({
      checkGate: vi.fn(async () => {
        throw error;
      }),
    });
    await expect(runSubmitCommand(requiredArgs("--json"), result.io, ops)).resolves.toBe(3);
    expect(JSON.parse(result.stderr[0] as string)).toEqual({
      ok: false,
      code: "submission_blocked",
      message: error.message,
      issues: [issue],
    });
  });

  it("maps unavailable private storage to a stable blocked diagnostic", async () => {
    const result = capture();
    const unavailable = Object.assign(new Error("sensitive path"), { code: "EACCES" });
    const ops = operations({
      checkGate: vi.fn(async () => {
        throw unavailable;
      }),
    });
    await expect(runSubmitCommand(requiredArgs(), result.io, ops)).resolves.toBe(3);
    expect(result.stderr.join("")).toContain("Required private release evidence");
    expect(result.stderr.join("")).toContain("submission.storage.unavailable");
    expect(result.stderr.join("")).not.toContain("sensitive path");
  });

  it.each([
    new Error("secret"),
    Object.assign(new Error("secret"), { code: 7 }),
    Object.assign(new Error("secret"), { code: "EIO" }),
    "secret",
  ])("redacts an unknown internal failure", async (error) => {
    const result = capture();
    const ops = operations({
      checkGate: vi.fn(async () => {
        throw error;
      }),
    });
    await expect(runSubmitCommand(requiredArgs(), result.io, ops)).resolves.toBe(1);
    expect(result.stderr.join("")).toBe("submit: Submission failed unexpectedly.\n");
    expect(result.stderr.join("")).not.toContain("secret");
  });

  it("treats stdout and stderr sink failures as internal failures", async () => {
    const blocked = gate({ passed: false });
    await expect(
      runSubmitCommand(
        requiredArgs(),
        { stdout: () => Promise.reject(new Error("sink")), stderr: () => {} },
        operations({ checkGate: vi.fn(async () => blocked) }),
      ),
    ).resolves.toBe(1);

    await expect(
      runSubmitCommand(
        [],
        { stdout: () => {}, stderr: () => Promise.reject(new Error("sink")) },
        operations(),
      ),
    ).resolves.toBe(1);

    await expect(
      runSubmitCommand(
        requiredArgs(),
        { stdout: () => {}, stderr: () => Promise.reject(new Error("sink")) },
        operations({
          checkGate: vi.fn(async () => {
            throw new Error("secret");
          }),
        }),
      ),
    ).resolves.toBe(1);
  });
});
