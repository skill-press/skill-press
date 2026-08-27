import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";
import { digestBoundedTree } from "../src/evidence/tree-digest.js";
import type { CapturedCommandResult } from "../src/process/capture.js";
import { checkTesslReleaseGate, TesslReleaseGateError } from "../src/release/tessl-gate.js";
import { tesslCommandDigest } from "../src/tessl/command-digest.js";
import {
  captureTesslEvalEvidence,
  captureTesslReviewEvidence,
  type TesslCommandExecutor,
} from "../src/tessl/evidence.js";

const execFileAsync = promisify(execFile);
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));
const trustedDigest = "9494050a66ec8a6f3f82405f7d7c5afccbdc03c1a195a823e07b6bfc5dea2f6c";
const now = new Date("2026-08-24T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function result(stdout: string, stderr = ""): CapturedCommandResult {
  const stdoutBuffer = Buffer.from(stdout);
  const stderrBuffer = Buffer.from(stderr);
  return Object.freeze({
    status: "passed",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdout: stdoutBuffer,
    stderr: stderrBuffer,
    stdoutBytes: stdoutBuffer.byteLength,
    stderrBytes: stderrBuffer.byteLength,
    stdoutSha256: createHash("sha256").update(stdoutBuffer).digest("hex"),
    stderrSha256: createHash("sha256").update(stderrBuffer).digest("hex"),
  });
}

function executor(): TesslCommandExecutor {
  let evalContext = "";
  let evalCliInvocation = "";
  return async (command) => {
    const args = command.argv.slice(1);
    if (args[0] === "--version") return result("0.101.0\n");
    if (args[0] === "skill") return result("lint passed\n");
    if (args[0] === "review") {
      return result(
        '{"reviewRunId":"review-1","validation":{"overallPassed":true},"review":{"reviewScore":94}}\n',
      );
    }
    if (args[0] === "eval" && args[1] === "run") {
      evalContext = args[args.indexOf("--context") + 1] as string;
      evalCliInvocation = args.join(" ");
      return result(
        `${JSON.stringify({
          evalRunId: "eval-1",
          agent: "codex",
          model: "model",
          scenariosCount: 2,
          context: {
            definition: { type: "plugin-directory", path: evalContext },
          },
        })}\n`,
      );
    }
    return result(
      JSON.stringify({
        data: {
          id: "eval-1",
          attributes: {
            status: "completed",
            agent: "codex",
            model: "model",
            evalRunFixtures: {
              context: { type: "plugin-directory", path: evalContext },
            },
            metadata: { cliInvocation: evalCliInvocation },
            scenarios: [
              {
                fingerprint: "one",
                solutions: [
                  {
                    variant: "baseline",
                    assessmentResults: [{ score: 4, max_score: 10 }],
                  },
                  {
                    variant: "with-context",
                    assessmentResults: [{ score: 9, max_score: 10 }],
                  },
                ],
              },
              {
                fingerprint: "two",
                solutions: [
                  {
                    variant: "baseline",
                    assessmentResults: [{ score: 6, max_score: 10 }],
                  },
                  {
                    variant: "with-context",
                    assessmentResults: [{ score: 10, max_score: 10 }],
                  },
                ],
              },
            ],
          },
        },
      }),
    );
  };
}

interface Fixture {
  readonly root: string;
  readonly reviewPath: string;
  readonly evalPath: string;
}

function capturedEvalSource(evaluation: {
  readonly storagePath: string;
  readonly scenarioSourceSha256: string;
}): string {
  return `${evaluation.storagePath}/eval-plugin-${evaluation.scenarioSourceSha256}`;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fixture(): Promise<Fixture> {
  const parent = await mkdtemp(join(temporaryRoot, "skillpress-release-gate-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "project");
  await writeRenderedProject(renderCapabilityProject(await loadCapabilityBrief(briefPath)), root);
  const evalSource = join(root, "tessl-evals");
  await mkdir(join(evalSource, ".tessl-plugin"), { recursive: true });
  await mkdir(join(evalSource, "evals"));
  await mkdir(join(evalSource, "skills"));
  await writeFile(
    join(evalSource, ".tessl-plugin", "plugin.json"),
    '{"name":"test/incident-summary","version":"0.1.0","private":true,"skills":["skills/incident-summary"]}\n',
  );
  await writeFile(join(evalSource, "evals", "scenario.json"), "{}\n");
  await cp(
    join(root, "skills", "incident-summary"),
    join(evalSource, "skills", "incident-summary"),
    {
      recursive: true,
    },
  );
  const executable = join(parent, "tessl-fake");
  await writeFile(executable, "#!/bin/sh\nexit 99\n");
  await chmod(executable, 0o755);
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
  const review = await captureTesslReviewEvidence(root, {
    executable,
    executor: executor(),
    now: () => now,
  });
  const evaluation = await captureTesslEvalEvidence(root, {
    source: "tessl-evals",
    agent: "codex",
    model: "model",
    executable,
    executor: executor(),
    pollIntervalMs: 1,
    wait: async () => undefined,
    now: () => now,
  });
  const reviewPath = `${review.storagePath}/evidence.json`;
  const evalPath = `${evaluation.storagePath}/evidence.json`;
  const eligibleReview = structuredClone(review);
  eligibleReview.evidenceEligible = true;
  eligibleReview.ineligibilityReasons = [];
  eligibleReview.cli.executableSha256 = trustedDigest;
  eligibleReview.cli.commandSha256 = tesslCommandDigest(trustedDigest, ["--version"]);
  eligibleReview.lint.commandSha256 = tesslCommandDigest(trustedDigest, [
    "skill",
    "lint",
    `${review.storagePath}/lint-plugin/.tessl-plugin/plugin.json`,
  ]);
  eligibleReview.review.commandSha256 = tesslCommandDigest(trustedDigest, [
    "review",
    "run",
    "quality",
    "--json",
    "--force",
    "--threshold",
    "0",
    "skills/incident-summary",
  ]);
  const eligibleEval = structuredClone(evaluation);
  eligibleEval.evidenceEligible = true;
  eligibleEval.ineligibilityReasons = [];
  eligibleEval.cli.executableSha256 = trustedDigest;
  eligibleEval.cli.commandSha256 = tesslCommandDigest(trustedDigest, ["--version"]);
  eligibleEval.start.commandSha256 = tesslCommandDigest(trustedDigest, [
    "eval",
    "run",
    "--json",
    "--force",
    "--context",
    capturedEvalSource(evaluation),
    "--skill",
    "incident-summary",
    "--agent",
    "codex",
    "--model",
    "model",
    "--runs",
    "1",
    "tessl-evals",
  ]);
  eligibleEval.result.commandSha256 = tesslCommandDigest(trustedDigest, [
    "eval",
    "view",
    "--json",
    "eval-1",
  ]);
  await writePrivateJson(join(root, reviewPath), eligibleReview);
  await writePrivateJson(join(root, evalPath), eligibleEval);
  return { root, reviewPath, evalPath };
}

async function gate(value: Fixture, clock = now) {
  return checkTesslReleaseGate(value.root, {
    reviewEvidencePath: value.reviewPath,
    evalEvidencePath: value.evalPath,
    evalSource: "tessl-evals",
    now: () => clock,
  });
}

async function replaceRawStdout(
  value: Fixture,
  evidencePath: string,
  invocationKey: "cli" | "review" | "start" | "result",
  rawName: string,
  text: string,
): Promise<void> {
  const evidenceFile = join(value.root, evidencePath);
  const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
  const bytes = Buffer.from(text);
  await writeFile(join(value.root, evidence.storagePath, `${rawName}.stdout`), bytes, {
    mode: 0o600,
  });
  evidence[invocationKey].stdoutBytes = bytes.byteLength;
  evidence[invocationKey].stdoutSha256 = createHash("sha256").update(bytes).digest("hex");
  await writePrivateJson(evidenceFile, evidence);
}

describe("Tessl release gate", () => {
  it("passes only current, raw-bound official Quality and Impact evidence", async () => {
    const value = await fixture();
    const report = await gate(value);
    expect(report).toMatchObject({
      gateType: "skillpress.tessl-release",
      passed: true,
      thresholds: { quality: 90, impact: 90, maxAgeHours: 168 },
      scores: { quality: 94, impact: 95 },
      issues: [],
    });
    expect(Object.isFrozen(report.scores)).toBe(true);
  });

  it("accepts omitted provider selections only when the exact command is bound", async () => {
    const selections = [[], ["--agent", "codex"], ["--model", "model"]] as const;
    for (const selection of selections) {
      const value = await fixture();
      const evalFile = join(value.root, value.evalPath);
      const evaluation = JSON.parse(await readFile(evalFile, "utf8"));
      const invocation = [
        "eval",
        "run",
        "--json",
        "--force",
        "--context",
        capturedEvalSource(evaluation),
        "--skill",
        "incident-summary",
        ...selection,
        "--runs",
        "1",
        "tessl-evals",
      ];
      evaluation.start.commandSha256 = tesslCommandDigest(trustedDigest, invocation);
      await writePrivateJson(evalFile, evaluation);
      await replaceRawStdout(
        value,
        value.evalPath,
        "start",
        "eval-start",
        `${JSON.stringify({
          evalRunId: "eval-1",
          scenariosCount: 2,
          context: {
            definition: {
              type: "plugin-directory",
              path: capturedEvalSource(evaluation),
            },
          },
        })}\n`,
      );
      const rawResult = JSON.parse(
        await readFile(join(value.root, evaluation.storagePath, "eval-result.stdout"), "utf8"),
      );
      rawResult.data.attributes.metadata.cliInvocation = invocation.join(" ");
      await replaceRawStdout(
        value,
        value.evalPath,
        "result",
        "eval-result",
        `${JSON.stringify(rawResult)}\n`,
      );

      expect((await gate(value)).passed).toBe(true);
    }
  });

  it("accepts Tessl's nested-repository basename normalization when raw echoes agree", async () => {
    const value = await fixture();
    const evaluation = JSON.parse(await readFile(join(value.root, value.evalPath), "utf8"));
    const providerPath = capturedEvalSource(evaluation).split("/").at(-1) as string;
    const rawStart = JSON.parse(
      await readFile(join(value.root, evaluation.storagePath, "eval-start.stdout"), "utf8"),
    );
    rawStart.context.definition.path = providerPath;
    await replaceRawStdout(
      value,
      value.evalPath,
      "start",
      "eval-start",
      `${JSON.stringify(rawStart)}\n`,
    );
    const rawResult = JSON.parse(
      await readFile(join(value.root, evaluation.storagePath, "eval-result.stdout"), "utf8"),
    );
    rawResult.data.attributes.evalRunFixtures.context.path = providerPath;
    await replaceRawStdout(
      value,
      value.evalPath,
      "result",
      "eval-result",
      `${JSON.stringify(rawResult)}\n`,
    );

    expect((await gate(value)).passed).toBe(true);
  });

  it("rejects mixed full-path and basename provider context echoes", async () => {
    const value = await fixture();
    const evaluation = JSON.parse(await readFile(join(value.root, value.evalPath), "utf8"));
    const rawResult = JSON.parse(
      await readFile(join(value.root, evaluation.storagePath, "eval-result.stdout"), "utf8"),
    );
    rawResult.data.attributes.evalRunFixtures.context.path = capturedEvalSource(evaluation)
      .split("/")
      .at(-1);
    await replaceRawStdout(
      value,
      value.evalPath,
      "result",
      "eval-result",
      `${JSON.stringify(rawResult)}\n`,
    );

    expect((await gate(value)).issues.map((entry) => entry.code)).toContain(
      "release.evidence.output",
    );
  });

  it("rejects eval evidence storage with a residual nested Git boundary", async () => {
    const value = await fixture();
    const evaluation = JSON.parse(await readFile(join(value.root, value.evalPath), "utf8"));
    await mkdir(join(value.root, evaluation.storagePath, ".git"));

    expect((await gate(value)).issues.map((entry) => entry.code)).toContain(
      "release.evidence.git_boundary",
    );
  });

  it("rejects Quality commands that can reuse cached review results", async () => {
    const value = await fixture();
    const reviewFile = join(value.root, value.reviewPath);
    const review = JSON.parse(await readFile(reviewFile, "utf8"));
    review.review.commandSha256 = tesslCommandDigest(trustedDigest, [
      "review",
      "run",
      "quality",
      "--json",
      "--threshold",
      "0",
      "skills/incident-summary",
    ]);
    await writePrivateJson(reviewFile, review);

    expect((await gate(value)).issues.map((entry) => entry.code)).toContain(
      "release.evidence.command",
    );
  });

  it("rejects eval start commands that can reuse cached solutions", async () => {
    const value = await fixture();
    const evalFile = join(value.root, value.evalPath);
    const evaluation = JSON.parse(await readFile(evalFile, "utf8"));
    evaluation.start.commandSha256 = tesslCommandDigest(trustedDigest, [
      "eval",
      "run",
      "--json",
      "--context",
      capturedEvalSource(evaluation),
      "--skill",
      "incident-summary",
      "--agent",
      "codex",
      "--model",
      "model",
      "--runs",
      "1",
      "tessl-evals",
    ]);
    await writePrivateJson(evalFile, evaluation);

    expect((await gate(value)).issues.map((entry) => entry.code)).toContain(
      "release.evidence.command",
    );
  });

  it("rejects eval commands that do not narrow context to the canonical skill", async () => {
    const value = await fixture();
    const evalFile = join(value.root, value.evalPath);
    const evaluation = JSON.parse(await readFile(evalFile, "utf8"));
    evaluation.start.commandSha256 = tesslCommandDigest(trustedDigest, [
      "eval",
      "run",
      "--json",
      "--force",
      "--context",
      capturedEvalSource(evaluation),
      "--agent",
      "codex",
      "--model",
      "model",
      "--runs",
      "1",
      "tessl-evals",
    ]);
    await writePrivateJson(evalFile, evaluation);

    expect((await gate(value)).issues.map((entry) => entry.code)).toContain(
      "release.evidence.command",
    );
  });

  it("rejects a resolved agent or model that drifts in the raw final result", async () => {
    const value = await fixture();
    const evalFile = join(value.root, value.evalPath);
    const evaluation = JSON.parse(await readFile(evalFile, "utf8"));
    const raw = JSON.parse(
      await readFile(join(value.root, evaluation.storagePath, "eval-result.stdout"), "utf8"),
    );
    raw.data.attributes.agent = "different-agent";
    await replaceRawStdout(value, value.evalPath, "result", "eval-result", JSON.stringify(raw));

    expect((await gate(value)).issues.map((entry) => entry.code)).toContain(
      "release.evidence.output",
    );
  });

  it("rejects stale and future evidence without weakening score thresholds", async () => {
    const value = await fixture();
    const stale = await gate(value, new Date("2026-09-02T00:00:01.000Z"));
    const future = await gate(value, new Date("2026-08-24T11:59:59.000Z"));
    expect(stale.passed).toBe(false);
    expect(stale.issues.filter((entry) => entry.code === "release.evidence.stale")).toHaveLength(2);
    expect(future.issues.filter((entry) => entry.code === "release.evidence.stale")).toHaveLength(
      2,
    );
    expect(stale.thresholds).toMatchObject({ quality: 90, impact: 90 });
  });

  it("rejects an ineligible CLI identity, low scores, and scenario regression", async () => {
    const value = await fixture();
    const reviewFile = join(value.root, value.reviewPath);
    const evalFile = join(value.root, value.evalPath);
    const review = JSON.parse(await readFile(reviewFile, "utf8"));
    const evaluation = JSON.parse(await readFile(evalFile, "utf8"));
    review.evidenceEligible = false;
    review.ineligibilityReasons = ["untrusted_cli"];
    review.cli.executableSha256 = "0".repeat(64);
    review.review.qualityScore = 89;
    evaluation.impactScore = 89;
    evaluation.scenarios[0].delta = -1;
    await writePrivateJson(reviewFile, review);
    await writePrivateJson(evalFile, evaluation);
    const report = await gate(value);
    expect(report.passed).toBe(false);
    expect(report.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "release.evidence.ineligible",
        "release.evidence.cli",
        "release.quality.minimum",
        "release.impact.minimum",
        "release.evidence.command",
      ]),
    );
  });

  it("rejects current source, commit, configuration, and scenario drift", async () => {
    const value = await fixture();
    await writeFile(join(value.root, "skills/incident-summary/LICENSE"), "changed\n");
    await writeFile(join(value.root, "tessl-evals/evals/scenario.json"), "changed\n");
    const report = await gate(value);
    expect(report.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "release.git.dirty",
        "release.evidence.skill",
        "release.evidence.scenarios",
      ]),
    );

    const configValue = await fixture();
    await writeFile(
      join(configValue.root, "skillpress.yaml"),
      `${await readFile(join(configValue.root, "skillpress.yaml"), "utf8")}\n`,
    );
    const configReport = await gate(configValue);
    expect(
      configReport.issues.filter((entry) => entry.code === "release.evidence.config"),
    ).toHaveLength(2);

    const commitValue = await fixture();
    await writeFile(join(commitValue.root, "README.md"), "new commit\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: commitValue.root });
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
        "advance",
      ],
      { cwd: commitValue.root },
    );
    const commitReport = await gate(commitValue);
    expect(
      commitReport.issues.filter((entry) => entry.code === "release.evidence.commit"),
    ).toHaveLength(2);
  });

  it("rejects a release-bound eval source whose embedded skill differs from canonical", async () => {
    const value = await fixture();
    const evalFile = join(value.root, value.evalPath);
    const evaluation = JSON.parse(await readFile(evalFile, "utf8"));
    const oldCapturedSource = capturedEvalSource(evaluation);
    await writeFile(
      join(value.root, "tessl-evals", "skills", "incident-summary", "LICENSE"),
      "changed\n",
    );
    await writeFile(
      join(value.root, oldCapturedSource, "skills", "incident-summary", "LICENSE"),
      "changed\n",
    );
    await execFileAsync("git", ["add", "tessl-evals"], { cwd: value.root });
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
        "change embedded eval skill",
      ],
      { cwd: value.root },
    );
    const sourceCommit = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: value.root })
    ).stdout.trim();
    const reviewFile = join(value.root, value.reviewPath);
    const review = JSON.parse(await readFile(reviewFile, "utf8"));
    review.sourceCommit = sourceCommit;
    evaluation.sourceCommit = sourceCommit;
    evaluation.scenarioSourceSha256 = await digestBoundedTree(join(value.root, "tessl-evals"));
    await rename(
      join(value.root, oldCapturedSource),
      join(value.root, capturedEvalSource(evaluation)),
    );
    await writePrivateJson(reviewFile, review);
    await writePrivateJson(evalFile, evaluation);

    const report = await gate(value);
    expect(report.issues.map((entry) => entry.code)).toContain("release.eval_source.skill_binding");
  });

  it("rejects additional plugin skill context even when evidence digests are rebound", async () => {
    const value = await fixture();
    const reviewFile = join(value.root, value.reviewPath);
    const evalFile = join(value.root, value.evalPath);
    const review = JSON.parse(await readFile(reviewFile, "utf8"));
    const evaluation = JSON.parse(await readFile(evalFile, "utf8"));
    const oldCapturedSource = capturedEvalSource(evaluation);
    const originalSkill = join(value.root, "tessl-evals", "skills", "incident-summary");
    const capturedSkill = join(value.root, oldCapturedSource, "skills", "incident-summary");
    await cp(originalSkill, join(value.root, "tessl-evals", "skills", "answer-key"), {
      recursive: true,
    });
    await cp(capturedSkill, join(value.root, oldCapturedSource, "skills", "answer-key"), {
      recursive: true,
    });
    await execFileAsync("git", ["add", "tessl-evals"], { cwd: value.root });
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
        "add extra eval context",
      ],
      { cwd: value.root },
    );
    const sourceCommit = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: value.root })
    ).stdout.trim();
    review.sourceCommit = sourceCommit;
    evaluation.sourceCommit = sourceCommit;
    evaluation.scenarioSourceSha256 = await digestBoundedTree(join(value.root, "tessl-evals"));
    await rename(
      join(value.root, oldCapturedSource),
      join(value.root, capturedEvalSource(evaluation)),
    );
    await writePrivateJson(reviewFile, review);
    await writePrivateJson(evalFile, evaluation);

    const report = await gate(value);
    expect(report.issues.map((entry) => entry.code)).toContain("release.eval_source.skill_binding");
  });

  it("rejects a captured eval snapshot that drifts from its original source", async () => {
    const value = await fixture();
    const evaluation = JSON.parse(await readFile(join(value.root, value.evalPath), "utf8"));
    await writeFile(
      join(value.root, capturedEvalSource(evaluation), "evals", "scenario.json"),
      "changed\n",
    );

    const report = await gate(value);
    expect(report.issues.map((entry) => entry.code)).toContain("release.evidence.scenarios");
  });

  it("rejects laundering old provider scores onto rebound eval content", async () => {
    const value = await fixture();
    const reviewFile = join(value.root, value.reviewPath);
    const evalFile = join(value.root, value.evalPath);
    const review = JSON.parse(await readFile(reviewFile, "utf8"));
    const evaluation = JSON.parse(await readFile(evalFile, "utf8"));
    const oldCapturedSource = capturedEvalSource(evaluation);
    await writeFile(join(value.root, "tessl-evals", "evals", "scenario.json"), "changed\n");
    await writeFile(join(value.root, oldCapturedSource, "evals", "scenario.json"), "changed\n");
    await execFileAsync("git", ["add", "tessl-evals"], { cwd: value.root });
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
        "replace eval content",
      ],
      { cwd: value.root },
    );
    const sourceCommit = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: value.root })
    ).stdout.trim();
    review.sourceCommit = sourceCommit;
    evaluation.sourceCommit = sourceCommit;
    evaluation.scenarioSourceSha256 = await digestBoundedTree(join(value.root, "tessl-evals"));
    const reboundCapturedSource = capturedEvalSource(evaluation);
    await rename(join(value.root, oldCapturedSource), join(value.root, reboundCapturedSource));
    evaluation.start.commandSha256 = tesslCommandDigest(trustedDigest, [
      "eval",
      "run",
      "--json",
      "--force",
      "--context",
      reboundCapturedSource,
      "--skill",
      "incident-summary",
      "--agent",
      "codex",
      "--model",
      "model",
      "--runs",
      "1",
      "tessl-evals",
    ]);
    await writePrivateJson(reviewFile, review);
    await writePrivateJson(evalFile, evaluation);

    const report = await gate(value);
    expect(report.issues.map((entry) => entry.code)).toContain("release.evidence.output");
  });

  it.each(["start context", "final context", "final invocation"] as const)(
    "rejects release evidence whose provider echo drifts in %s",
    async (fault) => {
      const value = await fixture();
      const evaluation = JSON.parse(await readFile(join(value.root, value.evalPath), "utf8"));
      if (fault === "start context") {
        const rawStart = JSON.parse(
          await readFile(join(value.root, evaluation.storagePath, "eval-start.stdout"), "utf8"),
        );
        rawStart.context.definition.path = "stale-context";
        await replaceRawStdout(
          value,
          value.evalPath,
          "start",
          "eval-start",
          `${JSON.stringify(rawStart)}\n`,
        );
      } else {
        const rawResult = JSON.parse(
          await readFile(join(value.root, evaluation.storagePath, "eval-result.stdout"), "utf8"),
        );
        if (fault === "final context") {
          rawResult.data.attributes.evalRunFixtures.context.path = "stale-context";
        } else {
          rawResult.data.attributes.metadata.cliInvocation = "eval run --json";
        }
        await replaceRawStdout(
          value,
          value.evalPath,
          "result",
          "eval-result",
          `${JSON.stringify(rawResult)}\n`,
        );
      }

      expect((await gate(value)).issues.map((entry) => entry.code)).toContain(
        "release.evidence.output",
      );
    },
  );

  it("rejects raw output and normalized command digest tampering", async () => {
    const value = await fixture();
    const review = JSON.parse(await readFile(join(value.root, value.reviewPath), "utf8"));
    review.lint.commandSha256 = "0".repeat(64);
    await writePrivateJson(join(value.root, value.reviewPath), review);
    await writeFile(
      join(value.root, review.storagePath, "review.stdout"),
      '{"reviewRunId":"review-1","validation":{"overallPassed":true},"review":{"reviewScore":99}}\n',
      { mode: 0o600 },
    );
    const report = await gate(value);
    expect(report.issues.map((entry) => entry.code)).toContain("release.evidence.command");

    const outputValue = await fixture();
    const outputReviewFile = join(outputValue.root, outputValue.reviewPath);
    const outputReview = JSON.parse(await readFile(outputReviewFile, "utf8"));
    const forgedOutput = Buffer.from(
      '{"reviewRunId":"review-1","validation":{"overallPassed":true},"review":{"reviewScore":99}}\n',
    );
    await writeFile(
      join(outputValue.root, outputReview.storagePath, "review.stdout"),
      forgedOutput,
      { mode: 0o600 },
    );
    outputReview.review.stdoutBytes = forgedOutput.byteLength;
    outputReview.review.stdoutSha256 = createHash("sha256").update(forgedOutput).digest("hex");
    await writePrivateJson(outputReviewFile, outputReview);
    const outputReport = await gate(outputValue);
    expect(outputReport.issues.map((entry) => entry.code)).toContain("release.evidence.output");
  });

  it("rejects manual evidence outside private capture storage and malformed stored JSON", async () => {
    const value = await fixture();
    await expect(
      checkTesslReleaseGate(value.root, {
        reviewEvidencePath: "manual-review.json",
        evalEvidencePath: value.evalPath,
        evalSource: "tessl-evals",
      }),
    ).rejects.toBeInstanceOf(TesslReleaseGateError);
    await writeFile(join(value.root, value.reviewPath), "not json\n", { mode: 0o600 });
    await expect(gate(value)).rejects.toBeInstanceOf(TesslReleaseGateError);
  });

  it("rejects mismatched storage bindings, unsafe sources, and invalid clocks", async () => {
    const value = await fixture();
    const reviewFile = join(value.root, value.reviewPath);
    const review = JSON.parse(await readFile(reviewFile, "utf8"));
    review.storagePath = value.evalPath.slice(0, -"/evidence.json".length);
    await writePrivateJson(reviewFile, review);
    await expect(gate(value)).rejects.toBeInstanceOf(TesslReleaseGateError);

    const sourceValue = await fixture();
    await expect(
      checkTesslReleaseGate(sourceValue.root, {
        reviewEvidencePath: sourceValue.reviewPath,
        evalEvidencePath: sourceValue.evalPath,
        evalSource: ".",
      }),
    ).rejects.toBeInstanceOf(TesslReleaseGateError);
    await expect(
      checkTesslReleaseGate(sourceValue.root, {
        reviewEvidencePath: sourceValue.reviewPath,
        evalEvidencePath: sourceValue.evalPath,
        evalSource: "tessl-evals",
        now: () => new Date(Number.NaN),
      }),
    ).rejects.toBeInstanceOf(TesslReleaseGateError);
  });

  it("reparses raw provider outputs and fails closed across malformed shapes", async () => {
    const cases: Array<{
      readonly evidence: "review" | "eval";
      readonly key: "cli" | "review" | "start" | "result";
      readonly raw: string;
      readonly text: string;
    }> = [
      { evidence: "review", key: "review", raw: "review", text: "no object\n" },
      {
        evidence: "review",
        key: "review",
        raw: "review",
        text: '{"validation":null,"review":null}\n',
      },
      {
        evidence: "review",
        key: "review",
        raw: "review",
        text: '{"reviewRunId":"review-1","validation":{"overallPassed":true},"review":{"reviewScore":"94"}}\n',
      },
      {
        evidence: "eval",
        key: "start",
        raw: "eval-start",
        text: '{"evalRunId":"wrong","agent":"codex","model":"model","scenariosCount":2}\n',
      },
      { evidence: "eval", key: "result", raw: "eval-result", text: '{"data":{}}\n' },
      {
        evidence: "eval",
        key: "result",
        raw: "eval-result",
        text: '{"data":{"id":"eval-1","attributes":{"status":"pending","scenarios":[]}}}\n',
      },
      {
        evidence: "eval",
        key: "result",
        raw: "eval-result",
        text: '{"data":{"id":"eval-1","attributes":{"status":"completed","scenarios":[{"fingerprint":7,"solutions":[]}]}}}\n',
      },
      {
        evidence: "eval",
        key: "result",
        raw: "eval-result",
        text: '{"data":{"id":"eval-1","attributes":{"status":"completed","scenarios":[{"fingerprint":"x","solutions":null}]}}}\n',
      },
      {
        evidence: "eval",
        key: "result",
        raw: "eval-result",
        text: '{"data":{"id":"eval-1","attributes":{"status":"completed","scenarios":[{"fingerprint":"x","solutions":[{"variant":"with-context","assessmentResults":[{"score":9,"max_score":10}]},{"variant":"other","assessmentResults":[{"score":9,"max_score":10}]}]}]}}}\n',
      },
      {
        evidence: "eval",
        key: "result",
        raw: "eval-result",
        text: '{"data":{"id":"eval-1","attributes":{"status":"completed","scenarios":[{"fingerprint":"x","solutions":[{"variant":"baseline","assessmentResults":[{"score":4,"max_score":10}]},{"variant":"with-context","assessmentResults":[{"score":11,"max_score":10}]}]}]}}}\n',
      },
      {
        evidence: "eval",
        key: "result",
        raw: "eval-result",
        text: '{"data":{"id":"eval-1","attributes":{"status":"completed","scenarios":[{"fingerprint":"x","solutions":[{"variant":"baseline","assessmentResults":[{"score":4,"max_score":10}]},{"variant":"with-context","assessmentResults":[{"score":9,"max_score":10}]}]},{"fingerprint":"x","solutions":[{"variant":"baseline","assessmentResults":[{"score":5,"max_score":10}]},{"variant":"with-context","assessmentResults":[{"score":9,"max_score":10}]}]}]}}}\n',
      },
    ];
    for (const fault of cases) {
      const value = await fixture();
      await replaceRawStdout(
        value,
        fault.evidence === "review" ? value.reviewPath : value.evalPath,
        fault.key,
        fault.raw,
        fault.text,
      );
      const report = await gate(value);
      expect(report.issues.map((entry) => entry.code)).toContain("release.evidence.output");
    }
  });

  it("binds version text, workspace argv, validation failure, and zero baselines", async () => {
    const versionValue = await fixture();
    await replaceRawStdout(versionValue, versionValue.reviewPath, "cli", "version", "0.98.0\n");
    const versionReport = await gate(versionValue);
    expect(versionReport.issues.map((entry) => entry.code)).toContain("release.evidence.version");

    const workspaceValue = await fixture();
    const workspaceFile = join(workspaceValue.root, workspaceValue.reviewPath);
    const workspaceReview = JSON.parse(await readFile(workspaceFile, "utf8"));
    workspaceReview.review.workspace = "workspace";
    workspaceReview.review.commandSha256 = tesslCommandDigest(trustedDigest, [
      "review",
      "run",
      "quality",
      "--json",
      "--force",
      "--workspace",
      "workspace",
      "--threshold",
      "0",
      "skills/incident-summary",
    ]);
    await writePrivateJson(workspaceFile, workspaceReview);
    expect((await gate(workspaceValue)).passed).toBe(true);

    const validationValue = await fixture();
    const validationFile = join(validationValue.root, validationValue.reviewPath);
    const validationReview = JSON.parse(await readFile(validationFile, "utf8"));
    const validationOutput = Buffer.from(
      JSON.stringify({
        validation: { overallPassed: false },
        review: { reviewScore: null, note: 'brace } and "quote"' },
      }),
    );
    await writeFile(
      join(validationValue.root, validationReview.storagePath, "review.stdout"),
      validationOutput,
      { mode: 0o600 },
    );
    validationReview.review.stdoutBytes = validationOutput.byteLength;
    validationReview.review.stdoutSha256 = createHash("sha256")
      .update(validationOutput)
      .digest("hex");
    validationReview.review.qualityScore = 0;
    validationReview.review.validationPassed = false;
    validationReview.review.runId = null;
    await writePrivateJson(validationFile, validationReview);
    const validationReport = await gate(validationValue);
    expect(validationReport.issues.map((entry) => entry.code)).toContain("release.quality.minimum");
    expect(validationReport.issues.map((entry) => entry.code)).not.toContain(
      "release.evidence.output",
    );

    const baselineValue = await fixture();
    const resultFile = join(baselineValue.root, baselineValue.evalPath);
    const resultEvidence = JSON.parse(await readFile(resultFile, "utf8"));
    const resultRaw = JSON.parse(
      await readFile(
        join(baselineValue.root, resultEvidence.storagePath, "eval-result.stdout"),
        "utf8",
      ),
    );
    for (const scenario of resultRaw.data.attributes.scenarios) {
      scenario.solutions = scenario.solutions.filter(
        (solution: { variant: string }) => solution.variant !== "baseline",
      );
    }
    await replaceRawStdout(
      baselineValue,
      baselineValue.evalPath,
      "result",
      "eval-result",
      JSON.stringify(resultRaw),
    );
    expect((await gate(baselineValue)).issues.map((entry) => entry.code)).toContain(
      "release.evidence.output",
    );
  });

  it("rejects unsafe evidence permissions, schema drift, raw files, and missing Git HEAD", async () => {
    const permissionValue = await fixture();
    await chmod(join(permissionValue.root, permissionValue.reviewPath), 0o644);
    await expect(gate(permissionValue)).rejects.toBeInstanceOf(TesslReleaseGateError);

    const schemaValue = await fixture();
    await writePrivateJson(join(schemaValue.root, schemaValue.reviewPath), {});
    await expect(gate(schemaValue)).rejects.toBeInstanceOf(TesslReleaseGateError);

    const rawValue = await fixture();
    const rawReview = JSON.parse(await readFile(join(rawValue.root, rawValue.reviewPath), "utf8"));
    await chmod(join(rawValue.root, rawReview.storagePath, "lint.stdout"), 0o644);
    const rawReport = await gate(rawValue);
    expect(rawReport.issues.map((entry) => entry.code)).toContain("release.evidence.raw");

    const gitValue = await fixture();
    await rm(join(gitValue.root, ".git"), { recursive: true });
    await expect(gate(gitValue)).rejects.toBeInstanceOf(TesslReleaseGateError);

    const defaultClock = await fixture();
    await expect(
      checkTesslReleaseGate(defaultClock.root, {
        reviewEvidencePath: defaultClock.reviewPath,
        evalEvidencePath: defaultClock.evalPath,
        evalSource: "tessl-evals",
      }),
    ).resolves.toMatchObject({ gateType: "skillpress.tessl-release" });
  });
});
