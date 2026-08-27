import { describe, expect, it, vi } from "vitest";

import { PACKAGE_HELP, runPackageCommand } from "../src/cli/package.js";
import { ProjectConfigError } from "../src/config/errors.js";
import { type SkillPackageArtifacts, SkillPackageError } from "../src/package/archive.js";
import { SkillStagingError, type StagedCanonicalSkill } from "../src/package/stage.js";
import { TesslReleaseGateError, type TesslReleaseGateReport } from "../src/release/tessl-gate.js";

const SOURCE_COMMIT = "1".repeat(40);
const OTHER_COMMIT = "2".repeat(40);
const REVIEW_EVIDENCE = `.skill-press/tessl/${"3".repeat(64)}/evidence.json`;
const EVAL_EVIDENCE = `.skill-press/tessl/${"4".repeat(64)}/evidence.json`;
const REQUIRED_ARGS = [
  "--review-evidence",
  REVIEW_EVIDENCE,
  "--eval-evidence",
  EVAL_EVIDENCE,
  "--eval-source",
  "tessl-evals",
] as const;

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

function gate(
  passed = true,
  sourceCommit = SOURCE_COMMIT,
  scores: TesslReleaseGateReport["scores"] = { quality: 97, impact: 96 },
): TesslReleaseGateReport {
  return {
    schemaVersion: 1,
    gateType: "skillpress.tessl-release",
    evaluatedAt: "2026-08-27T12:00:00.000Z",
    sourceCommit,
    passed,
    thresholds: { quality: 90, impact: 90, maxAgeHours: 168 },
    scores,
    evidence: { reviewPath: REVIEW_EVIDENCE, evalPath: EVAL_EVIDENCE },
    issues: passed
      ? []
      : [
          {
            code: "release.score.quality",
            path: "/quality",
            message: "quality threshold was not reached",
          },
        ],
  };
}

function staged(sourceCommit = SOURCE_COMMIT): StagedCanonicalSkill {
  return {
    schemaVersion: 1,
    sourceCommit,
    projectConfigSha256: "5".repeat(64),
    skillSha256: "6".repeat(64),
    stagingPath: `.skill-press/staging/${"7".repeat(64)}`,
    skillPath: "canonical/example-skill",
    files: [],
  };
}

function artifacts(): SkillPackageArtifacts {
  return {
    schemaVersion: 1,
    artifactsPath: `.skill-press/staging/${"7".repeat(64)}/artifacts`,
    skillArchive: "example-skill.skill",
    zipArchive: "example-skill.zip",
    checksums: "SHA256SUMS",
    provenance: "provenance.json",
    provenanceSha256: "8".repeat(64),
    provenanceBytes: 512,
    checksumsSha256: "9".repeat(64),
    checksumsBytes: 256,
    artifactSha256: "a".repeat(64),
    artifactBytes: 1024,
  };
}

function operations(initialGate = gate()) {
  return {
    checkGate: vi.fn(async () => initialGate),
    stage: vi.fn(async () => staged()),
    package: vi.fn(async () => artifacts()),
  } satisfies NonNullable<Parameters<typeof runPackageCommand>[2]>;
}

describe("package CLI orchestration", () => {
  it("documents the evidence-bound package contract", () => {
    expect(PACKAGE_HELP).toContain(
      "skpress package --review-evidence <file> --eval-evidence <file> --eval-source <directory>",
    );
    expect(PACKAGE_HELP).toContain("--project <directory>");
    expect(PACKAGE_HELP).toContain("--json");
    expect(PACKAGE_HELP).toContain("fails closed");
    expect(PACKAGE_HELP).toContain("passed to submit");
  });

  it("packages an explicitly selected project and emits a stable JSON report", async () => {
    const ops = operations();
    const output = capture();

    await expect(
      runPackageCommand(["--project", "/repo", ...REQUIRED_ARGS, "--json"], output.io, ops),
    ).resolves.toBe(0);

    expect(ops.checkGate).toHaveBeenCalledTimes(2);
    expect(ops.checkGate).toHaveBeenNthCalledWith(1, "/repo", {
      reviewEvidencePath: REVIEW_EVIDENCE,
      evalEvidencePath: EVAL_EVIDENCE,
      evalSource: "tessl-evals",
    });
    expect(ops.stage).toHaveBeenCalledWith("/repo");
    expect(ops.package).toHaveBeenCalledWith("/repo", staged());
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      command: "package",
      ok: true,
      status: "packaged",
      gate: { passed: true, sourceCommit: SOURCE_COMMIT },
      artifacts: { artifactSha256: "a".repeat(64) },
    });
    expect(output.stderr).toEqual([]);
  });

  it("uses the current directory and renders successful human output", async () => {
    const ops = operations();
    const output = capture();

    await expect(runPackageCommand(REQUIRED_ARGS, output.io, ops)).resolves.toBe(0);

    expect(ops.checkGate).toHaveBeenNthCalledWith(1, process.cwd(), {
      reviewEvidencePath: REVIEW_EVIDENCE,
      evalEvidencePath: EVAL_EVIDENCE,
      evalSource: "tessl-evals",
    });
    expect(output.stdout.join("")).toContain("Tessl release gate: passed");
    expect(output.stdout.join("")).toContain("Quality: 97/90");
    expect(output.stdout.join("")).toContain(`Artifacts: ${artifacts().artifactsPath}`);
    expect(output.stdout.join("")).toContain(`SHA-256: ${"a".repeat(64)}`);
  });

  it("stops before staging when the initial Tessl gate is blocked", async () => {
    const ops = operations(gate(false, SOURCE_COMMIT, { quality: null, impact: null }));
    const output = capture();

    await expect(runPackageCommand(REQUIRED_ARGS, output.io, ops)).resolves.toBe(3);

    expect(ops.stage).not.toHaveBeenCalled();
    expect(output.stdout.join("")).toContain("Tessl release gate: blocked");
    expect(output.stdout.join("")).toContain("Quality: unavailable/90");
    expect(output.stdout.join("")).toContain("Impact: unavailable/90");
  });

  it.each([
    ["the final gate becomes blocked", gate(false)],
    ["the final gate changes commit", gate(true, OTHER_COMMIT)],
  ])("returns a blocked report when %s", async (_name, finalGate) => {
    const ops = operations();
    ops.checkGate.mockResolvedValueOnce(gate()).mockResolvedValueOnce(finalGate);
    const output = capture();

    await expect(runPackageCommand([...REQUIRED_ARGS, "--json"], output.io, ops)).resolves.toBe(3);

    expect(ops.package).toHaveBeenCalledOnce();
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      command: "package",
      ok: false,
      status: "blocked",
      gate: { sourceCommit: finalGate.sourceCommit, passed: finalGate.passed },
      artifacts: { artifactsPath: artifacts().artifactsPath },
    });
  });

  it("fails closed when the staged commit differs from the checked commit", async () => {
    const ops = operations();
    ops.stage.mockResolvedValue(staged(OTHER_COMMIT));
    const output = capture();

    await expect(runPackageCommand([...REQUIRED_ARGS, "--json"], output.io, ops)).resolves.toBe(3);

    expect(ops.package).not.toHaveBeenCalled();
    expect(JSON.parse(output.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "release_blocked",
      message: "Source changed after the Tessl release gate.",
      issues: [{ code: "release.configuration", path: "/project" }],
    });
  });

  it.each([
    ["missing required option", []],
    ["missing value", ["--review-evidence"]],
    ["option-like value", ["--review-evidence", "--json"]],
    ["oversized value", ["--review-evidence", "x".repeat(4097)]],
    ["unsafe value", ["--review-evidence", "bad\0path"]],
    ["unknown option", ["HOSTILE\u001b[31m"]],
    ["duplicate value option", [...REQUIRED_ARGS, "--eval-source", "other"]],
  ])("rejects %s without invoking dependencies", async (_name, args) => {
    const ops = operations();
    const output = capture();

    await expect(runPackageCommand(args, output.io, ops)).resolves.toBe(2);

    expect(ops.checkGate).not.toHaveBeenCalled();
    expect(output.stderr.join("")).toContain("cli.usage");
    expect(output.stderr.join("")).not.toContain("HOSTILE");
  });

  it("renders duplicate JSON as a JSON usage failure", async () => {
    const ops = operations();
    const output = capture();

    await expect(
      runPackageCommand([...REQUIRED_ARGS, "--json", "--json"], output.io, ops),
    ).resolves.toBe(2);

    expect(JSON.parse(output.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "usage",
      message: "--json may be specified only once.",
      issues: [{ code: "cli.usage" }],
    });
  });

  it.each([
    new ProjectConfigError("Invalid project configuration.", [
      { code: "config.invalid", path: "/", message: "configuration is invalid" },
    ]),
    new TesslReleaseGateError("Invalid Tessl evidence.", [
      { code: "release.evidence.invalid", path: "/evidence", message: "evidence is invalid" },
    ]),
    new SkillStagingError("Staging failed.", [
      { code: "stage.failed", path: "/skill", message: "skill staging failed" },
    ]),
    new SkillPackageError("Packaging failed.", [
      { code: "package.failed", path: "/artifacts", message: "artifact creation failed" },
    ]),
  ])("maps a known domain failure to release_blocked", async (error) => {
    const ops = operations();
    ops.checkGate.mockRejectedValue(error);
    const output = capture();

    await expect(runPackageCommand([...REQUIRED_ARGS, "--json"], output.io, ops)).resolves.toBe(3);

    expect(JSON.parse(output.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "release_blocked",
      message: error.message,
      issues: error.issues,
    });
  });

  it("redacts an unavailable private storage failure", async () => {
    const ops = operations();
    ops.checkGate.mockRejectedValue(Object.assign(new Error("secret path"), { code: "ENOENT" }));
    const output = capture();

    await expect(runPackageCommand([...REQUIRED_ARGS, "--json"], output.io, ops)).resolves.toBe(3);

    const report = JSON.parse(output.stderr[0] as string);
    expect(report).toMatchObject({
      ok: false,
      code: "release_blocked",
      message: "Required private release evidence or artifacts are unavailable.",
      issues: [{ code: "release.storage.unavailable", path: "/release" }],
    });
    expect(output.stderr.join("")).not.toContain("secret path");
  });

  it.each([
    ["a non-Error throw", "secret string"],
    ["an Error without a code", new Error("secret error")],
    ["a non-string error code", Object.assign(new Error("secret numeric"), { code: 5 })],
    ["an unrelated error code", Object.assign(new Error("secret I/O"), { code: "EIO" })],
  ])("redacts %s as an internal failure", async (_name, error) => {
    const ops = operations();
    ops.checkGate.mockRejectedValue(error);
    const output = capture();

    await expect(runPackageCommand(REQUIRED_ARGS, output.io, ops)).resolves.toBe(1);

    expect(output.stderr.join("")).toBe("package: Package failed unexpectedly.\n");
    expect(output.stderr.join("")).not.toContain("secret");
  });

  it("returns internal failure when an output sink is closed", async () => {
    const blocked = operations(gate(false));
    await expect(
      runPackageCommand(
        REQUIRED_ARGS,
        { stdout: () => Promise.reject(new Error("closed")), stderr: () => {} },
        blocked,
      ),
    ).resolves.toBe(1);

    const usage = operations();
    await expect(
      runPackageCommand(
        [],
        { stdout: () => {}, stderr: () => Promise.reject(new Error("closed")) },
        usage,
      ),
    ).resolves.toBe(1);

    const finalBlocked = operations();
    finalBlocked.checkGate.mockResolvedValueOnce(gate()).mockResolvedValueOnce(gate(false));
    await expect(
      runPackageCommand(
        REQUIRED_ARGS,
        { stdout: () => Promise.reject(new Error("closed")), stderr: () => {} },
        finalBlocked,
      ),
    ).resolves.toBe(1);

    const packaged = operations();
    await expect(
      runPackageCommand(
        REQUIRED_ARGS,
        { stdout: () => Promise.reject(new Error("closed")), stderr: () => {} },
        packaged,
      ),
    ).resolves.toBe(1);

    const storage = operations();
    storage.checkGate.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(
      runPackageCommand(
        REQUIRED_ARGS,
        { stdout: () => {}, stderr: () => Promise.reject(new Error("closed")) },
        storage,
      ),
    ).resolves.toBe(1);

    const known = operations();
    known.checkGate.mockRejectedValue(
      new ProjectConfigError("invalid", [
        { code: "config.invalid", path: "/", message: "configuration is invalid" },
      ]),
    );
    await expect(
      runPackageCommand(
        REQUIRED_ARGS,
        { stdout: () => {}, stderr: () => Promise.reject(new Error("closed")) },
        known,
      ),
    ).resolves.toBe(1);
  });
});
