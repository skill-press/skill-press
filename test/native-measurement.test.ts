import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { runNativeCheckCommand } from "../src/cli/native-check.js";
import { checkNativeEvaluation } from "../src/release/native-check.js";
import * as nativeChecks from "../src/release/native-check.js";
import * as processes from "../src/process/capture.js";
import { prepareNativeEvidence } from "../src/release/native-evidence.js";
import { checkReleaseGate } from "../src/release/gate.js";
import { diagnoseProject } from "../src/doctor/project.js";
import { loadPackagedSkill } from "../src/package/archive.js";
import { prepareSkillSubmission } from "../src/submission/manifest.js";

import { loadProjectConfig } from "../src/config/load.js";
import type {
  LegEvidence,
  SkillPressPairedEvaluationEvidence,
} from "../src/eval/generated-evidence.js";
import { loadProjectEvaluationInputs } from "../src/eval/load.js";
import { evaluationInputsSha256, recomputeRubricScore } from "../src/eval/measurement.js";
import { assessNativeMeasurement } from "../src/release/native-measurement.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = await loadProjectConfig(root);
const inputs = await loadProjectEvaluationInputs(root);
const skillSha256 = "a".repeat(64);
const now = new Date("2026-10-01T12:00:00.000Z");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

// Synthetic protocol fixture only; never real model/launch acceptance evidence.
function evidence(
  suiteName: "training" | "holdout" = "training",
): SkillPressPairedEvaluationEvidence {
  const suite = inputs[suiteName];
  const model = "protocol-test-only";
  const runId = hash(suiteName);
  return {
    schemaVersion: 1,
    evidenceType: "skillpress.paired-eval",
    runId,
    createdAt: now.toISOString(),
    project: { name: config.project.name, version: config.project.version },
    suite: suiteName,
    model,
    adapter: {
      backend: "docker",
      image: `example/adapter@sha256:${"b".repeat(64)}`,
      commandSha256: hash("adapter"),
    },
    skillSha256,
    configSha256: hash(`${JSON.stringify(config)}\n`),
    evaluationInputsSha256: evaluationInputsSha256(suite, inputs.rubric),
    repetitions: config.evaluation.repetitions,
    scenarioResults: suite.scenarios.map((scenario, index) => ({
      id: scenario.id,
      expectedActivation: scenario.shouldActivate,
      runs: Array.from({ length: config.evaluation.repetitions }, (_, rep) => {
        const leg = (variant: "baseline" | "with-skill"): LegEvidence => {
          const id = hash(`${runId}:${index}:${rep + 1}:${variant}`);
          const withSkill = variant === "with-skill";
          const activated = withSkill && scenario.shouldActivate;
          const criterionScores = inputs.rubric.criteria
            .filter((criterion) => criterion.evaluator === "judge")
            .map(({ id: criterionId }) => ({ id: criterionId, score: withSkill ? 1 : 0 }));
          return {
            runId: id,
            status: "passed",
            activated,
            loadedSkillSha256: withSkill ? skillSha256 : null,
            rubricScore: recomputeRubricScore(
              activated,
              withSkill ? scenario.shouldActivate : false,
              inputs.rubric.criteria,
              criterionScores,
            ),
            successful: withSkill,
            criterionScores,
            inputSha256: hash(
              `${JSON.stringify({
                schemaVersion: 1,
                runId: id,
                variant,
                model,
                prompt: scenario.prompt,
                fixture: scenario.fixture ?? null,
                skill: withSkill
                  ? { available: true, sha256: skillSha256, path: "/skill" }
                  : { available: false, sha256: null },
              })}\n`,
            ),
            transcript: { bytes: 0, sha256: hash(""), redactedExcerpt: "" },
            engineStdoutSha256: hash(""),
            engineStderrSha256: hash(""),
          };
        };
        return { repetition: rep + 1, baseline: leg("baseline"), withSkill: leg("with-skill") };
      }) as SkillPressPairedEvaluationEvidence["scenarioResults"][number]["runs"],
    })) as SkillPressPairedEvaluationEvidence["scenarioResults"],
    summary: {
      baselineSuccessRate: 0,
      withSkillSuccessRate: 1,
      impactDelta: 1,
      minimumSuccessRate: config.evaluation.minimumSuccessRate,
      minimumImpactDelta: config.evaluation.minimumImpactDelta,
      behavioralGatePassed: true,
    },
    evidenceEligible: true,
    ineligibilityReasons: [],
    storagePath: `.skill-press/runs/${runId}`,
  };
}

const assess = (value: unknown, currentInputs = inputs, currentConfig = config, at = now) =>
  assessNativeMeasurement(value, currentConfig, currentInputs, "training", skillSha256, at);

async function nativeProject() {
  const project = await mkdtemp(join(await realpath(tmpdir()), "skillpress-native-check-"));
  temporaryDirectories.push(project);
  for (const path of ["skill-press.yaml", "LICENSE", "evals", "skills/skill-press"]) {
    await mkdir(join(project, path, ".."), { recursive: true });
    await cp(join(root, path), join(project, path), { recursive: true });
  }
  const reports = [evidence("training"), evidence("holdout")];
  for (const report of reports) {
    // Bind the actual copied skill tree instead of the pure-test placeholder.
    const { digestBoundedTree } = await import("../src/evidence/tree-digest.js");
    report.skillSha256 = await digestBoundedTree(join(project, config.skill.path));
    report.createdAt = new Date().toISOString();
    for (const [index, scenario] of report.scenarioResults.entries()) {
      const source = inputs[report.suite].scenarios[index];
      if (source === undefined) throw new Error("fixture scenario missing");
      for (const run of scenario.runs) {
        run.withSkill.loadedSkillSha256 = report.skillSha256;
        run.withSkill.inputSha256 = hash(
          `${JSON.stringify({
            schemaVersion: 1,
            runId: run.withSkill.runId,
            variant: "with-skill",
            model: report.model,
            prompt: source.prompt,
            fixture: source.fixture ?? null,
            skill: { available: true, sha256: report.skillSha256, path: "/skill" },
          })}\n`,
        );
      }
    }
    await mkdir(join(project, report.storagePath), { recursive: true, mode: 0o700 });
    await writeFile(join(project, report.storagePath, "evidence.json"), JSON.stringify(report), {
      mode: 0o600,
    });
  }
  const training = `${reports[0]?.storagePath}/evidence.json`;
  const holdout = `${reports[1]?.storagePath}/evidence.json`;
  return { project, reports, training, holdout };
}

describe("native measurement consistency (synthetic fixtures)", () => {
  it("fails closed on source snapshot and bounded envelope faults", async () => {
    const { project, training, holdout } = await nativeProject();
    const options = {
      reviewEvidencePath: training,
      evalEvidencePath: holdout,
      evalSource: "evals",
      now: () => new Date(),
    };
    let fault = "head";
    let heads = 0;
    vi.spyOn(processes, "runCapturedCommand").mockImplementation(async ({ argv }) => {
      let text = "";
      if (argv[1] === "rev-parse") {
        heads += 1;
        text =
          fault === "head" ? "invalid" : (fault === "changed" && heads > 1 ? "b" : "a").repeat(40);
      }
      if (argv[1] === "ls-files" && argv.includes("--error-unmatch"))
        text = fault === "tracked" ? "wrong-path" : (argv.at(-1) as string);
      return {
        status: "passed",
        exitCode: 0,
        signal: null,
        stdout: Buffer.from(text),
        stderr: Buffer.alloc(0),
      };
    });
    await expect(prepareNativeEvidence(project, options)).rejects.toThrow(/committed/u);
    fault = "tracked";
    await expect(prepareNativeEvidence(project, options)).rejects.toThrow(/must be tracked/u);
    fault = "changed";
    heads = 0;
    await expect(prepareNativeEvidence(project, options)).rejects.toThrow(
      /changed during preparation/u,
    );
    fault = "size";
    const loaded = await nativeChecks.loadNativeEvaluation(project, {
      trainingEvidencePath: training,
      holdoutEvidencePath: holdout,
    });
    // Fault-inject the loader boundary to verify both upload envelope size limits.
    const load = vi.spyOn(nativeChecks, "loadNativeEvaluation");
    for (const suite of ["training", "holdout"] as const) {
      const oversized = structuredClone(loaded);
      oversized[suite].scenarioResults[0].runs[0].withSkill.transcript.redactedExcerpt = "x".repeat(
        1024 * 1024,
      );
      load.mockResolvedValueOnce(oversized);
      await expect(prepareNativeEvidence(project, options)).rejects.toThrow(/upload limit/u);
    }
  });

  it("packages and prepares a native submission with exact deterministic envelopes and no Tessl", async () => {
    const { project, training, holdout, reports } = await nativeProject();
    const git = (args: string[]) => promisify(execFile)("git", args, { cwd: project });
    await writeFile(join(project, ".gitignore"), ".skill-press/\nevals/ignored.txt\n");
    await git(["init", "-q"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "synthetic fixture",
    ]);
    const options = {
      provider: "native" as const,
      reviewEvidencePath: training,
      evalEvidencePath: holdout,
      evalSource: "evals",
    };
    const prepared = await prepareNativeEvidence(project, options);
    expect(prepared.report).toMatchObject({ gateType: "skillpress.native-release", passed: true });
    expect((await prepareNativeEvidence(project, options)).reviewBytes).toEqual(
      prepared.reviewBytes,
    );
    expect(await checkReleaseGate(project, options)).toEqual(prepared.report);
    const output: string[] = [];
    const io = {
      stdout: (value: string) => {
        output.push(value);
      },
      stderr: (value: string) => {
        output.push(value);
      },
    };
    const args = [
      "--native",
      "--project",
      project,
      "--review-evidence",
      training,
      "--eval-evidence",
      holdout,
      "--eval-source",
      "evals",
    ];
    expect(await runCli(["package", ...args, "--json"], io)).toBe(0);
    const packaged = JSON.parse(output.at(-1) as string).artifacts;
    const artifacts = await loadPackagedSkill(project, packaged.artifactsPath);
    const submission = await prepareSkillSubmission(project, artifacts, options);
    expect(submission.reviewEvidenceBytes).toEqual(prepared.reviewBytes);
    expect(submission.manifest.evidence.review.sha256).toBe(hash(prepared.reviewBytes.toString()));
    expect(
      await runCli(
        ["submit", ...args, "--artifacts", packaged.artifactsPath, "--dry-run", "--json"],
        io,
      ),
    ).toBe(0);
    const statusCode = await runCli(["status", ...args, "--artifacts", packaged.artifactsPath], io);
    expect(statusCode, output.at(-1)).toBe(0);
    expect(output.at(-1)).toContain("Native gate: passed");
    expect(await runCli(["package", ...args], io)).toBe(0);
    expect(output.at(-1)).toContain("passed (advisory)");
    const commands: string[] = [];
    const doctor = await diagnoseProject(project, {
      evidence: options,
      homeDirectory: project,
      environment: {},
      executor: async (command) => {
        commands.push(command.argv[0]);
        return {
          status: "passed",
          exitCode: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        };
      },
    });
    expect(doctor.ready).toBe(true);
    expect(commands).toEqual(["git", "docker"]);
    expect(doctor.checks.map(({ id }) => id)).not.toContain("credential.tessl");
    await expect(
      prepareSkillSubmission(project, { ...artifacts, sourceCommit: "f".repeat(40) }, options),
    ).rejects.toThrow(/exact package/u);
    await expect(
      prepareNativeEvidence(project, { ...options, evalSource: "tessl-evals" }),
    ).rejects.toThrow(/canonical evals/u);
    await writeFile(join(project, "evals/ignored.txt"), "ignored");
    await expect(prepareNativeEvidence(project, options)).rejects.toThrow(/ignored files/u);
    await rm(join(project, "evals/ignored.txt"));
    await writeFile(join(project, "evals/untracked.txt"), "untracked");
    await expect(prepareNativeEvidence(project, options)).rejects.toThrow(/clean and tracked/u);
    await rm(join(project, "evals/untracked.txt"));
    const report = reports[0];
    if (report === undefined) throw new Error("missing fixture");
    report.summary.impactDelta = 0.1;
    await writeFile(join(project, training), JSON.stringify(report), { mode: 0o600 });
    expect((await prepareNativeEvidence(project, options)).report.passed).toBe(false);
    expect(await runCli(["package", ...args], io)).toBe(3);
    expect(output.at(-1)).toContain("blocked");
    await expect(prepareSkillSubmission(project, artifacts, options)).rejects.toThrow(
      /exact package/u,
    );
  });

  it("rejects native inspection misuse and source without a Git commit", async () => {
    const { project, training, holdout } = await nativeProject();
    await expect(
      prepareNativeEvidence(project, {
        reviewEvidencePath: training,
        evalEvidencePath: holdout,
        evalSource: "evals",
      }),
    ).rejects.toThrow(/Git/u);
    const io = { stdout: () => {}, stderr: () => {} };
    for (const command of ["package", "status", "doctor", "submit"]) {
      expect(await runCli([command, "--native", "--native"], io)).toBe(2);
    }
    expect(await runCli(["doctor", "--native"], io)).toBe(2);
    expect(
      await runCli(
        [
          "doctor",
          "--native",
          "--review-evidence",
          training,
          "--eval-evidence",
          holdout,
          "--eval-source",
          "evals",
          "--tessl-executable",
          "tessl",
        ],
        io,
      ),
    ).toBe(2);
  });

  it("runs the real local check and CLI without invoking Tessl or authorizing release", async () => {
    const { project, reports, training, holdout } = await nativeProject();
    const report = await checkNativeEvaluation(project, {
      trainingEvidencePath: training,
      holdoutEvidencePath: holdout,
    });
    expect(report).toMatchObject({
      passed: true,
      advisory: true,
      independentVerificationRequired: true,
      releaseAuthorized: false,
    });
    const output: string[] = [];
    expect(
      await runCli(
        [
          "eval-check",
          "--project",
          project,
          "--training-evidence",
          training,
          "--holdout-evidence",
          holdout,
          "--json",
        ],
        {
          stdout: (value) => {
            output.push(value);
          },
          stderr: (value) => {
            throw new Error(value);
          },
        },
      ),
    ).toBe(0);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      passed: true,
      releaseAuthorized: false,
    });
    const args = [
      "--project",
      project,
      "--training-evidence",
      training,
      "--holdout-evidence",
      holdout,
    ];
    expect(
      await runNativeCheckCommand(args, {
        stdout: (value) => {
          output.push(value);
        },
        stderr: () => {},
      }),
    ).toBe(0);
    expect(
      await runNativeCheckCommand(args, {
        stdout: () => {
          throw new Error("closed");
        },
        stderr: () => {},
      }),
    ).toBe(1);
    const changed = reports[1];
    if (changed === undefined) throw new Error("fixture holdout missing");
    changed.adapter.commandSha256 = hash("different adapter");
    await writeFile(join(project, holdout), JSON.stringify(changed), { mode: 0o600 });
    expect(
      (
        await checkNativeEvaluation(project, {
          trainingEvidencePath: training,
          holdoutEvidencePath: holdout,
        })
      ).issues,
    ).toContain("native.pair.adapter_mismatch");
    changed.scenarioResults[0].runs[0].baseline.runId = reports[0]?.scenarioResults[0].runs[0]
      .baseline.runId as string;
    await writeFile(join(project, holdout), JSON.stringify(changed), { mode: 0o600 });
    const trainingReport = reports[0];
    if (trainingReport === undefined) throw new Error("fixture training missing");
    trainingReport.summary.impactDelta = 0.5;
    await writeFile(join(project, training), JSON.stringify(trainingReport), { mode: 0o600 });
    await rm(join(project, "LICENSE"));
    const failed = await checkNativeEvaluation(project, {
      trainingEvidencePath: training,
      holdoutEvidencePath: holdout,
    });
    expect(failed.issues).toEqual(
      expect.arrayContaining([
        "native.pair.run_reuse",
        "native.readiness.failed",
        "training:native.measurement.inconsistent",
        "holdout:native.measurement.inconsistent",
      ]),
    );
    expect(
      await runNativeCheckCommand(args, {
        stdout: (value) => {
          output.push(value);
        },
        stderr: () => {},
      }),
    ).toBe(3);
    expect(output.at(-1)).toContain("blocked");
  });

  it("rejects CLI usage and missing evidence without leaking paths or throwing on broken output", async () => {
    const output: string[] = [];
    const io = {
      stdout: (value: string) => {
        output.push(value);
      },
      stderr: (value: string) => {
        output.push(value);
      },
    };
    expect(await runNativeCheckCommand([], io)).toBe(2);
    expect(
      await runNativeCheckCommand(
        ["--training-evidence", "missing", "--holdout-evidence", "missing"],
        io,
      ),
    ).toBe(3);
    expect(
      await runNativeCheckCommand([], {
        stdout: () => {},
        stderr: () => {
          throw new Error("closed");
        },
      }),
    ).toBe(1);
    expect(await runCli(["eval-check", "--help"], io)).toBe(0);
    for (const args of [
      ["--unknown"],
      ["--project"],
      ["--project", "--json"],
      ["--project", "x", "--project", "y"],
      ["--json", "--json"],
    ]) {
      expect(await runNativeCheckCommand(args, io)).toBe(2);
    }
    expect(
      await runNativeCheckCommand(
        ["--training-evidence", "missing", "--holdout-evidence", "missing"],
        {
          stdout: () => {},
          stderr: () => {
            throw new Error("closed");
          },
        },
      ),
    ).toBe(1);
  });

  it("rejects incomplete, unknown and non-finite judge scores and calculates failed activation", () => {
    const rubric = [
      {
        id: "activation",
        description: "activation",
        weight: 35,
        evaluator: "deterministic" as const,
      },
      { id: "quality", description: "quality", weight: 65, evaluator: "judge" as const },
    ] as typeof inputs.rubric.criteria;
    expect(recomputeRubricScore(false, true, rubric, [{ id: "quality", score: 1 }])).toBe(65);
    for (const scores of [
      [],
      [{ id: "unknown", score: 1 }],
      [{ id: "quality", score: Number.NaN }],
      [{ id: "quality", score: -1 }],
      [{ id: "quality", score: 2 }],
    ]) {
      expect(recomputeRubricScore(true, true, rubric, scores)).toBeNull();
    }
  });
  it.each(["training", "holdout"] as const)("recomputes complete %s evidence", (suite) => {
    expect(
      assessNativeMeasurement(evidence(suite), config, inputs, suite, skillSha256, now),
    ).toEqual({ passed: true, issues: [] });
  });

  it.each([
    [
      "activated baseline",
      (value: SkillPressPairedEvaluationEvidence) => {
        value.scenarioResults[0].runs[0].baseline.activated = true;
      },
    ],
    [
      "legacy missing binding",
      (value: SkillPressPairedEvaluationEvidence) => {
        delete value.evaluationInputsSha256;
      },
    ],
    [
      "missing criterion scores",
      (value: SkillPressPairedEvaluationEvidence) => {
        delete value.scenarioResults[0].runs[0].withSkill.criterionScores;
      },
    ],
    [
      "altered criterion score",
      (value: SkillPressPairedEvaluationEvidence) => {
        const score = value.scenarioResults[0].runs[0].withSkill.criterionScores?.[0];
        if (score === undefined) throw new Error("fixture criterion missing");
        score.score = 0;
      },
    ],
    [
      "duplicate criteria",
      (value: SkillPressPairedEvaluationEvidence) => {
        const scores = value.scenarioResults[0].runs[0].withSkill.criterionScores;
        if (scores?.[0] === undefined) throw new Error("fixture criteria missing");
        scores.push(scores[0]);
      },
    ],
    [
      "forged aggregate",
      (value: SkillPressPairedEvaluationEvidence) => {
        value.summary.impactDelta = 0.5;
      },
    ],
    [
      "forged successful flag",
      (value: SkillPressPairedEvaluationEvidence) => {
        value.scenarioResults[0].runs[0].withSkill.successful = false;
      },
    ],
    [
      "partial suite",
      (value: SkillPressPairedEvaluationEvidence) => {
        value.scenarioResults.pop();
      },
    ],
    [
      "missing repetition",
      (value: SkillPressPairedEvaluationEvidence) => {
        value.scenarioResults[0].runs.pop();
      },
    ],
    [
      "duplicate run",
      (value: SkillPressPairedEvaluationEvidence) => {
        value.scenarioResults[0].runs[0].withSkill.runId =
          value.scenarioResults[0].runs[0].baseline.runId;
      },
    ],
    [
      "custom executor",
      (value: SkillPressPairedEvaluationEvidence) => {
        value.evidenceEligible = false;
        value.ineligibilityReasons = ["custom_executor"];
      },
    ],
    [
      "unpinned adapter",
      (value: SkillPressPairedEvaluationEvidence) => {
        value.adapter.image = "adapter:latest";
      },
    ],
    [
      "baseline loads skill",
      (value: SkillPressPairedEvaluationEvidence) => {
        value.scenarioResults[0].runs[0].baseline.loadedSkillSha256 = skillSha256;
      },
    ],
    [
      "failed execution",
      (value: SkillPressPairedEvaluationEvidence) => {
        value.scenarioResults[0].runs[0].withSkill.status = "timed_out";
      },
    ],
    [
      "invalid date",
      (value: SkillPressPairedEvaluationEvidence) => {
        value.createdAt = "2026-99-99T12:00:00.000Z";
      },
    ],
  ] as const)("rejects %s", (_label, mutate) => {
    const value = evidence();
    mutate(value);
    expect(assess(value).passed).toBe(false);
  });

  it("rejects changed rubric and behavioral expectations even if prompt did not change", () => {
    for (const mutate of [
      (current: typeof inputs) => {
        current.rubric.criteria[0].description += " altered";
      },
      (current: typeof inputs) => {
        current.training.scenarios[0].expectedBehavior[0] += " altered";
      },
    ]) {
      const current = structuredClone(inputs);
      mutate(current);
      expect(assess(evidence(), current).issues).toContain("native.inputs.binding");
    }
  });

  it("does not let author configuration lower admission minima", () => {
    const current = structuredClone(config);
    current.evaluation.minimumImpactDelta = 0;
    expect(assess(evidence(), inputs, current).issues).toContain("native.policy.minimums");
  });

  it("rejects execution modes unsupported by the isolated runner even with matching config hash", () => {
    const current = structuredClone(config);
    current.evaluation.network = "restricted";
    const value = evidence();
    value.configSha256 = hash(`${JSON.stringify(current)}\n`);
    expect(assess(value, inputs, current).issues).toContain("native.execution.network");
  });

  it("rejects evidence at expiry and in the future", () => {
    expect(
      assess(evidence(), inputs, config, new Date(now.getTime() + 168 * 3_600_000)).issues,
    ).toContain("native.evidence.age");
    expect(assess(evidence(), inputs, config, new Date(now.getTime() - 1)).issues).toContain(
      "native.evidence.age",
    );
  });

  it("does not count activation-only rubric as behavioral quality", () => {
    const current = structuredClone(inputs);
    current.rubric.criteria = [
      { id: "activation", description: "activation only", weight: 100, evaluator: "deterministic" },
    ];
    expect(assess(evidence(), current).issues).toContain("native.rubric.judge_weight");
  });
});
