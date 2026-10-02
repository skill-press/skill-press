import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

vi.mock("../src/eval/codex-text.js", () => ({ runReviewedSelectedTextPair: vi.fn() }));
import { runReviewedSelectedTextPair } from "../src/eval/codex-text.js";
import { runCli } from "../src/cli.js";
import { runNativeCheckCommand } from "../src/cli/native-check.js";
import { checkReviewedTextEvaluation } from "../src/release/reviewed-text-check.js";
import { prepareReviewedTextEvidence } from "../src/release/reviewed-text-evidence.js";
import { checkReleaseGate } from "../src/release/gate.js";
import { prepareSkillSubmission } from "../src/submission/manifest.js";
import { diagnoseProject } from "../src/doctor/project.js";
import { runSkillSubmission } from "../src/submission/run.js";
import type { SkillPressSubmissionResource } from "../src/submission/generated-resource.js";
import { isReviewedTextEnvelope } from "../src/eval/reviewed-text-schema.js";
import * as projects from "../src/eval/reviewed-text-project.js";
import * as capture from "../src/process/capture.js";
import {
  createTextActorPrompt,
  createTextJudgePrompt,
  createTextSelectionPrompt,
  type TextEvaluationPrompt,
} from "../src/eval/text-evaluation.js";
import {
  prepareReviewedTextProject,
  runPreparedReviewedTextSuite,
  verifyReviewedTextProject,
} from "../src/eval/reviewed-text-project.js";

const roots: string[] = [];
function textIo() {
  const stdout = vi.fn<(text: string) => void>();
  const stderr = vi.fn<(text: string) => void>();
  return { stdout, stderr };
}
const textArgs = (root: string) => [
  "eval-text",
  "--project",
  root,
  "--suite",
  "holdout",
  "--reviewed-inputs",
  "--max-model-calls",
  "30",
  "--json",
];

it.each([
  [],
  ["--suite", "unknown"],
  ["--suite", "training"],
  ["--suite", "holdout", "--reviewed-inputs"],
  ["--suite", "holdout", "--max-model-calls", "30"],
  ["--suite", "holdout", "--dry-run", "--max-model-calls", "0"],
  ["--suite", "holdout", "--dry-run", "--max-model-calls", "9007199254740992"],
  ["--dry-run", "--dry-run"],
  ["--suite", "holdout", "--suite", "training"],
  ["--unknown"],
  ["--suite"],
  ["--project", "--json"],
])("rejects eval-text usage before inference: %j", async (...args) => {
  expect(await runCli(["eval-text", ...args], textIo())).toBe(2);
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("documents eval-text and handles output failures", async () => {
  const io = textIo();
  expect(await runCli(["eval-text", "--help"], io)).toBe(0);
  expect(io.stdout.mock.calls[0][0]).toContain("--reviewed-inputs");
  io.stderr.mockImplementation(() => {
    throw new Error("broken output");
  });
  expect(await runCli(["eval-text"], io)).toBe(1);
  expect(await runCli(textArgs("/nonexistent-eval-project"), io)).toBe(1);
});

it("previews model cost without invoking models", async () => {
  const root = await fixture(true);
  const io = textIo();
  expect(
    await runCli(
      ["eval-text", "--project", root, "--suite", "training", "--dry-run", "--json"],
      io,
    ),
  ).toBe(0);
  expect(JSON.parse(io.stdout.mock.calls[0][0])).toMatchObject({
    status: "preview",
    plannedPairs: 15,
    plannedModelCalls: 75,
    releaseAuthorized: false,
  });
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it.each(["cap", "readiness", "stdout"])("blocks eval-text before models on %s", async (kind) => {
  const root = await fixture(kind !== "readiness");
  const io = textIo();
  const args = textArgs(root);
  if (kind === "cap") args[args.indexOf("30")] = "29";
  if (kind === "stdout") {
    args.push("--dry-run");
    args.splice(args.indexOf("--json"), 1);
    io.stdout.mockImplementation(() => {
      throw new Error("broken output");
    });
  }
  expect(await runCli(args, io)).toBe(kind === "stdout" ? 1 : 3);
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it.each(["training", "holdout"] as const)(
  "persists private %s model receipts through eval-text",
  async (suite) => {
    const f = await evidenceFixture();
    const io = textIo();
    const args = textArgs(f.root);
    args[args.indexOf("holdout")] = suite;
    args[args.indexOf("30")] = "75";
    expect(await runCli(args, io)).toBe(0);
    const report = JSON.parse(io.stdout.mock.calls[0][0]);
    expect(report).toMatchObject({ complete: true, status: "completed", releaseAuthorized: false });
    expect(runReviewedSelectedTextPair).toHaveBeenCalledTimes(suite === "training" ? 15 : 6);
    expect((await lstat(join(f.root, report.evidencePath))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(f.root, report.checkpointPath))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(join(f.root, report.evidencePath), "utf8")).complete).toBe(
      true,
    );
    expect(io.stderr.mock.calls.flat().join("")).not.toContain("Synthetic answer.");
  },
);

it.each(["SIGINT", "SIGTERM"] as const)(
  "cancels eval-text on %s and restores listeners",
  async (signal) => {
    const f = await evidenceFixture();
    const io = textIo();
    const before = process.listenerCount(signal);
    io.stderr.mockImplementation((text) => {
      if (JSON.parse(text).event === "eval-text.started") process.emit(signal);
    });
    expect(await runCli(textArgs(f.root), io)).toBe(3);
    expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
    expect(process.listenerCount(signal)).toBe(before);
    expect(JSON.parse(io.stdout.mock.calls[0][0])).toMatchObject({
      complete: false,
      status: "blocked",
    });
  },
);

it.each(["SIGINT", "SIGTERM"] as const)(
  "propagates in-flight %s cancellation without starting another pair",
  async (event) => {
    const f = await evidenceFixture();
    const before = process.listenerCount(event);
    let aborted = false;
    vi.mocked(runReviewedSelectedTextPair).mockImplementation(
      async (_scenario, _rubric, _text, signal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("cancelled"));
            },
            { once: true },
          );
          process.emit(event);
        });
      },
    );
    const io = textIo();
    expect(await runCli(textArgs(f.root), io)).toBe(3);
    expect(aborted).toBe(true);
    expect(runReviewedSelectedTextPair).toHaveBeenCalledTimes(1);
    expect(process.listenerCount(event)).toBe(before);
    expect(JSON.parse(io.stdout.mock.calls[0][0])).toMatchObject({
      complete: false,
      status: "blocked",
    });
  },
);

it("retains a failed model receipt without exposing provider errors or retrying", async () => {
  const f = await evidenceFixture();
  vi.mocked(runReviewedSelectedTextPair).mockRejectedValue(new Error("PRIVATE_PROVIDER_DETAIL"));
  const io = textIo();
  expect(await runCli(textArgs(f.root), io)).toBe(3);
  expect(runReviewedSelectedTextPair).toHaveBeenCalledTimes(1);
  expect(JSON.parse(io.stdout.mock.calls[0][0])).toMatchObject({ complete: false, summary: null });
  expect(JSON.stringify([io.stdout.mock.calls, io.stderr.mock.calls])).not.toContain(
    "PRIVATE_PROVIDER_DETAIL",
  );
});

it.each(["quality", "stdout", "oversize"])("handles eval-text final %s outcomes", async (kind) => {
  const f = await evidenceFixture(true, kind === "quality" ? 1 : 0.5);
  const io = textIo();
  const args = textArgs(f.root).filter((arg) => arg !== "--json");
  if (kind === "stdout")
    io.stdout.mockImplementation(() => {
      throw new Error("broken output");
    });
  if (kind === "oversize") {
    const result = structuredClone(f.holdout.result);
    vi.spyOn(projects, "runPreparedReviewedTextSuite").mockResolvedValue({
      ...result,
      ineligibilityReasons: ["x".repeat(1024 * 1024)],
    });
  }
  expect(await runCli(args, io)).toBe(kind === "stdout" ? 1 : 3);
  if (kind === "quality") expect(io.stdout.mock.calls[0][0]).toContain("Text evaluation blocked");
});

it("requires ignored capture storage before inference", async () => {
  const root = await fixture(true);
  await writeFile(join(root, ".gitignore"), "");
  expect(await runCli(textArgs(root), textIo())).toBe(3);
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("checks the actual final evidence ignore boundary separately", async () => {
  const f = await evidenceFixture();
  const original = capture.runCapturedCommand;
  let refused = "";
  vi.spyOn(capture, "runCapturedCommand").mockImplementation(async (options) => {
    if (options.argv[1] === "check-ignore" && options.argv.at(-1)?.endsWith("/evidence.json")) {
      refused = options.argv.at(-1) as string;
      return original({
        ...options,
        argv: ["git", "check-ignore", "--quiet", "--", "not-ignored"],
      });
    }
    return original(options);
  });
  const io = textIo();
  expect(await runCli(textArgs(f.root), io)).toBe(3);
  expect(refused).toContain("/evidence.json");
  await expect(lstat(join(f.root, refused))).rejects.toThrow();
  expect(io.stdout).not.toHaveBeenCalled();
});

it.each(["source", "checkpoint", "progress"])(
  "retains checkpoints without a success report on %s failure",
  async (kind) => {
    const f = await evidenceFixture();
    const io = textIo();
    io.stderr.mockImplementation(async (text) => {
      const event = JSON.parse(text);
      if (event.event === "eval-text.started" && kind === "checkpoint")
        await mkdir(join(f.root, event.checkpointPath, "pair-1.json"));
      if (event.event === "eval-text.progress" && kind === "source")
        await writeFile(join(f.root, "evals/holdout.yaml"), "changed source");
      if (event.event === "eval-text.progress" && kind === "progress")
        throw new Error("broken progress");
    });
    expect(await runCli(textArgs(f.root), io)).toBe(3);
    expect(io.stdout).not.toHaveBeenCalled();
    expect(JSON.parse(io.stderr.mock.calls.at(-1)?.[0] ?? "{}").code).toBe(
      "text.evaluation.failed",
    );
  },
);
async function fixture(licensed = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "reviewed-text-project-"));
  roots.push(root);
  await mkdir(join(root, "skills"));
  await cp("skills/release-notes", join(root, "skills/release-notes"), { recursive: true });
  await cp("examples/launch-skills/release-notes-evals", join(root, "evals"), { recursive: true });
  if (licensed) {
    await cp("LICENSE", join(root, "LICENSE"));
    await cp("LICENSE", join(root, "skills/release-notes/LICENSE"));
  }
  const config = parse(await readFile("skill-press.yaml", "utf8"));
  config.project.name = "release-notes";
  config.skill.name = "release-notes";
  config.skill.path = "skills/release-notes";
  await writeFile(join(root, "skill-press.yaml"), stringify(config));
  await writeFile(join(root, ".gitignore"), ".skill-press/\n");
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Synthetic source",
    ],
  ])
    execFileSync("git", args, { cwd: root });
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it("rejects old artifact provenance combined with a new eval-only commit before inference", async () => {
  const root = await fixture();
  const old = await prepareReviewedTextProject(root);
  const path = join(root, "evals/training.yaml");
  const suite = parse(await readFile(path, "utf8"));
  suite.scenarios[0].prompt += " Preserve supplied references.";
  await writeFile(path, stringify(suite));
  execFileSync("git", ["add", "evals/training.yaml"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Update synthetic evaluation inputs",
    ],
    { cwd: root },
  );
  const current = structuredClone(await prepareReviewedTextProject(root));
  current.artifacts = old.artifacts;
  await expect(
    runPreparedReviewedTextSuite(root, current, "training", async () => {}),
  ).rejects.toThrow("changed after preparation");
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("binds reviewed text, full source, config, suites and a verified release archive without inference", async () => {
  const root = await fixture();
  const prepared = await prepareReviewedTextProject(root);
  expect(prepared.source.commit).toBe(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  );
  expect(prepared.source.skillSha256).toBe(prepared.artifacts.skillSha256);
  expect(prepared.skillTextSha256).toBe(
    createHash("sha256").update(prepared.skillText).digest("hex"),
  );
  expect(prepared.skillTextSha256).not.toBe(prepared.source.skillSha256);
  expect(prepared.inputs.training.scenarios).toHaveLength(5);
  expect(prepared.inputs.holdout.scenarios).toHaveLength(2);
  expect(prepared.releaseEligible).toBe(false);
  await verifyReviewedTextProject(root, prepared);
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("connects the prepared project to all holdout repetitions while keeping admission false", async () => {
  const root = await fixture();
  const prepared = await prepareReviewedTextProject(root);
  vi.mocked(runReviewedSelectedTextPair).mockImplementation(async (scenario, rubric) => {
    const criteria = rubric.criteria
      .filter((c) => c.evaluator === "judge")
      .map((c) => ({ id: c.id, score: 1, rationale: "Synthetic protocol test." }));
    return {
      baseline: { criteria },
      withSkill: { activated: scenario.shouldActivate, criteria },
      releaseEligible: false,
    } as Awaited<ReturnType<typeof runReviewedSelectedTextPair>>;
  });
  const persisted = vi.fn().mockResolvedValue(undefined);
  const result = await runPreparedReviewedTextSuite(root, prepared, "holdout", persisted);
  expect(result).toMatchObject({
    complete: true,
    plannedPairs: 6,
    releaseEligible: false,
    source: prepared.source,
    artifact: { sha256: prepared.artifacts.artifactSha256 },
    ineligibilityReasons: ["text_profile_not_admitted"],
  });
  expect(persisted).toHaveBeenCalledTimes(6);
  expect(Object.isFrozen(prepared.inputs.holdout.scenarios)).toBe(true);
});

it.each(["text", "inputs", "config"])(
  "rejects altered prepared %s before inference",
  async (kind) => {
    const root = await fixture();
    const prepared = await prepareReviewedTextProject(root);
    const altered = structuredClone(prepared);
    if (kind === "text") {
      altered.skillText = "replacement";
      altered.skillTextSha256 = createHash("sha256").update(altered.skillText).digest("hex");
    }
    if (kind === "inputs") altered.inputs.training.scenarios[0].prompt = "A different task.";
    if (kind === "config") altered.config.evaluation.repetitions = 1;
    await expect(
      runPreparedReviewedTextSuite(root, altered, "training", async () => {}),
    ).rejects.toThrow(/changed/);
    expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
  },
);

it("refuses to return bound evidence when source changes during model evaluation", async () => {
  const root = await fixture();
  const prepared = await prepareReviewedTextProject(root);
  vi.mocked(runReviewedSelectedTextPair).mockRejectedValue(new Error("Synthetic interrupted pair"));
  await expect(
    runPreparedReviewedTextSuite(root, prepared, "holdout", async () => {
      await writeFile(join(root, "evals/holdout.yaml"), "changed during evaluation");
    }),
  ).rejects.toThrow();
  expect(runReviewedSelectedTextPair).toHaveBeenCalledTimes(1);
});

it("rejects dirty evaluation inputs before preparing evidence", async () => {
  const root = await fixture();
  await writeFile(join(root, "evals/untracked.txt"), "unreviewed data");
  await expect(prepareReviewedTextProject(root)).rejects.toThrow(/clean and tracked/);
});

it("rejects bundled resources instead of silently evaluating only the document", async () => {
  const root = await fixture();
  await mkdir(join(root, "skills/release-notes/references"));
  await writeFile(
    join(root, "skills/release-notes/references/terms.md"),
    "# Terms\nA release note describes a change.\n",
  );
  const document = join(root, "skills/release-notes/SKILL.md");
  await writeFile(
    document,
    `${await readFile(document, "utf8")}\nRead [terminology](references/terms.md) when interpreting release terminology.\n`,
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Add resource",
    ],
    { cwd: root },
  );
  await expect(prepareReviewedTextProject(root)).rejects.toThrow(/optional LICENSE only/);
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it.each(["source", "artifact"])("detects changed %s at the exit boundary", async (kind) => {
  const root = await fixture();
  const prepared = await prepareReviewedTextProject(root);
  const target =
    kind === "source"
      ? join(root, "evals/training.yaml")
      : join(root, prepared.artifacts.artifactsPath, prepared.artifacts.skillArchive);
  await writeFile(target, "modified");
  await expect(verifyReviewedTextProject(root, prepared)).rejects.toThrow();
});

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const response = (prompt: TextEvaluationPrompt, text: string) => ({
  text,
  diagnostics: [],
  usage: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 },
  requestedModel: "gpt-6.1-sol" as const,
  effort: "medium" as const,
  authentication: "forced-chatgpt" as const,
  cliVersion: "0.160.0" as const,
  execution: "reviewed-host-text-pilot" as const,
  releaseEligible: false as const,
  inputSha256: prompt.sha256,
  outputSha256: hash(text),
  durationMs: 1,
});

async function evidenceFixture(
  licensed = true,
  baselineScore = 0.5,
  language: "english" | "task" = "english",
) {
  const root = await fixture(licensed);
  const prepared = await prepareReviewedTextProject(root);
  vi.mocked(runReviewedSelectedTextPair).mockImplementation(async (scenario, rubric, text) => {
    const selected = scenario.shouldActivate;
    const leg = (withSkill: boolean) => {
      const actor = response(
        createTextActorPrompt(scenario, withSkill && selected ? text : null, language),
        "Synthetic answer.",
      );
      const criteria = rubric.criteria
        .filter((c) => c.evaluator === "judge")
        .map((c) => ({ id: c.id, score: withSkill ? 1 : baselineScore, rationale: "Synthetic." }));
      const judge = response(
        createTextJudgePrompt(scenario, rubric, actor.text, language),
        JSON.stringify({ criteria }),
      );
      return { actor, judge, criteria, activated: withSkill && selected };
    };
    const rationale = "Synthetic selection.";
    return {
      kind:
        language === "english"
          ? "skillpress.reviewed-selected-text-pair-pilot"
          : "skillpress.reviewed-selected-text-pair-pilot.v2",
      baseline: leg(false),
      withSkill: leg(true),
      selection: {
        ...response(
          createTextSelectionPrompt(scenario, text),
          JSON.stringify({ selected, rationale }),
        ),
        selected,
        rationale,
      },
      skillTextSha256: hash(text),
      modelInvocations: 5,
      activationMeasurement: "harness-metadata-selection",
      releaseEligible: false,
    };
  });
  const values = await Promise.all(
    ["training", "holdout"].map(async (name) => {
      const result = await runPreparedReviewedTextSuite(
        root,
        prepared,
        name as "training" | "holdout",
        async () => {},
      );
      const path = `.skill-press/runs/${result.runId}/evidence.json`;
      await mkdir(join(root, ".skill-press/runs"), { recursive: true, mode: 0o700 });
      await mkdir(join(root, `.skill-press/runs/${result.runId}`), { mode: 0o700 });
      await writeFile(join(root, path), JSON.stringify(result), { mode: 0o600 });
      return { path, result };
    }),
  );
  vi.mocked(runReviewedSelectedTextPair).mockClear();
  return {
    root,
    prepared,
    training: values[0],
    holdout: values[1],
    paths: { trainingEvidencePath: values[0].path, holdoutEvidencePath: values[1].path },
  };
}

it("checks v2 stored evidence and rejects mixed training/holdout protocol generations", async () => {
  const f = await evidenceFixture(true, 0.5, "task");
  expect((await prepareReviewedTextEvidence(f.root, f.paths)).report.passed).toBe(true);
  const holdout = structuredClone(f.holdout.result);
  for (const record of holdout.records) {
    if (record.status !== "passed") throw new Error("Expected passed fixture.");
    const scenario = holdout.suite.scenarios.find((s) => s.id === record.scenarioId);
    if (!scenario) throw new Error("Missing fixture scenario.");
    const pair = record.pair;
    pair.kind = "skillpress.reviewed-selected-text-pair-pilot";
    for (const arm of ["baseline", "withSkill"] as const) {
      const leg = pair[arm];
      leg.actor.inputSha256 = createTextActorPrompt(
        scenario,
        arm === "withSkill" && pair.selection.selected ? f.prepared.skillText : null,
      ).sha256;
      leg.judge.inputSha256 = createTextJudgePrompt(
        scenario,
        holdout.rubric,
        leg.actor.text,
      ).sha256;
    }
  }
  await writeFile(join(f.root, f.holdout.path), JSON.stringify(holdout), { mode: 0o600 });
  const report = (await prepareReviewedTextEvidence(f.root, f.paths)).report;
  expect(report.training.passed).toBe(true);
  expect(report.holdout.passed).toBe(true);
  expect(report.issues).toEqual(["text.pair.protocol_mismatch"]);
  expect(report.passed).toBe(false);
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("checks a real licensed project and both stored suites through the CLI without inference", async () => {
  const f = await evidenceFixture();
  expect(f.prepared.skillText).not.toContain("Permission is hereby granted");
  const outputs: string[] = [];
  const args = [
    "--reviewed-text",
    "--project",
    f.root,
    "--training-evidence",
    f.paths.trainingEvidencePath,
    "--holdout-evidence",
    f.paths.holdoutEvidencePath,
  ];
  const io = {
    stdout: (text: string) => {
      outputs.push(text);
    },
    stderr: vi.fn(),
  };
  expect(await runCli(["eval-check", ...args, "--json"], io)).toBe(0);
  expect(JSON.parse(outputs[0])).toMatchObject({
    passed: true,
    releaseEligible: false,
    releaseAuthorized: false,
    admissionIssues: ["release_gate_required"],
    readiness: { ok: true },
  });
  expect(await runNativeCheckCommand(args, io)).toBe(0);
  expect(outputs[1]).toContain("separate submission gate");
  expect(await runNativeCheckCommand([...args, "--reviewed-text"], io)).toBe(2);
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("retains readiness failure instead of waiving missing licenses", async () => {
  const f = await evidenceFixture(false);
  const report = await checkReviewedTextEvaluation(f.root, f.paths);
  expect(report.issues).toEqual(["text.readiness.failed"]);
  expect(report.passed).toBe(false);
});

it("prepares deterministic text upload bytes without granting admission or running inference", async () => {
  const f = await evidenceFixture();
  const first = await prepareReviewedTextEvidence(f.root, f.paths);
  const second = await prepareReviewedTextEvidence(f.root, f.paths);
  expect(first.reviewBytes.equals(second.reviewBytes)).toBe(true);
  expect(first.evaluationBytes.equals(second.evaluationBytes)).toBe(true);
  for (const [bytes, suite] of [
    [first.reviewBytes, "training"],
    [first.evaluationBytes, "holdout"],
  ] as const) {
    const value = JSON.parse(bytes.toString("utf8"));
    expect(isReviewedTextEnvelope(value)).toBe(true);
    expect(value).toMatchObject({
      schemaVersion: 1,
      evidenceType: "skillpress.reviewed-text-evidence",
      advisory: true,
      inputs: f.prepared.inputs,
      measurement: { suite: { suite }, source: f.prepared.source },
    });
    value.evidenceType = "skillpress.native-evidence";
    expect(isReviewedTextEnvelope(value)).toBe(false);
    value.evidenceType = "skillpress.reviewed-text-evidence";
    value.schemaVersion = 2;
    expect(isReviewedTextEnvelope(value)).toBe(false);
  }
  expect(first.report).toMatchObject({
    passed: true,
    releaseEligible: false,
    releaseAuthorized: false,
    admissionIssues: ["release_gate_required"],
  });
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("does not turn failed readiness into release approval when preparing text evidence", async () => {
  const f = await evidenceFixture(false);
  const { report } = await prepareReviewedTextEvidence(f.root, f.paths);
  expect(report).toMatchObject({
    passed: false,
    issues: ["text.readiness.failed"],
    releaseAuthorized: false,
  });
});

it("rejects malformed wire evidence during preparation", async () => {
  const f = await evidenceFixture();
  const value = { ...f.training.result, unversionedClaim: "accepted" };
  await writeFile(join(f.root, f.paths.trainingEvidencePath), JSON.stringify(value));
  await expect(prepareReviewedTextEvidence(f.root, f.paths)).rejects.toThrow(
    "versioned upload contract",
  );
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("enforces the upload limit after adding the complete evaluation inputs", async () => {
  const f = await evidenceFixture();
  const value = JSON.parse(JSON.stringify(f.training.result));
  const actor = value.records[0].pair.baseline.actor;
  const originalSize = Buffer.byteLength(JSON.stringify(value));
  actor.text = "x".repeat(1048500 - originalSize + actor.text.length);
  const text = JSON.stringify(value);
  expect(Buffer.byteLength(text)).toBe(1048500);
  await writeFile(join(f.root, f.paths.trainingEvidencePath), text);
  await expect(prepareReviewedTextEvidence(f.root, f.paths)).rejects.toThrow("upload limit");
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("refuses reused suite runs and mismatched private storage IDs", async () => {
  const f = await evidenceFixture();
  const reused = await checkReviewedTextEvaluation(f.root, {
    ...f.paths,
    holdoutEvidencePath: f.paths.trainingEvidencePath,
  });
  expect(reused.issues).toContain("text.pair.run_reuse");
  const wrongPath = `.skill-press/runs/${"f".repeat(64)}/evidence.json`;
  await mkdir(join(f.root, `.skill-press/runs/${"f".repeat(64)}`), { mode: 0o700 });
  await writeFile(join(f.root, wrongPath), JSON.stringify(f.training.result), { mode: 0o600 });
  expect(
    (await checkReviewedTextEvaluation(f.root, { ...f.paths, trainingEvidencePath: wrongPath }))
      .issues,
  ).toEqual(["training:text.storage.binding"]);
  await writeFile(
    join(f.root, f.paths.holdoutEvidencePath),
    JSON.stringify({ ...f.holdout.result, runId: "invalid" }),
  );
  expect((await checkReviewedTextEvaluation(f.root, f.paths)).issues).toContain(
    "holdout:text.storage.binding",
  );
});

it.each([null, [], {}, { runId: 42 }])(
  "reports malformed parsed receipts without throwing or accepting them",
  async (value) => {
    const f = await evidenceFixture();
    await writeFile(join(f.root, f.paths.trainingEvidencePath), JSON.stringify(value));
    const report = await checkReviewedTextEvaluation(f.root, f.paths);
    expect(report.issues).toContain("training:text.measurement.inconsistent");
    expect(report.issues).toContain("training:text.storage.binding");
  },
);

it.each(["oversized", "symlink", "public", "invalid-json", "outside"])(
  "refuses unsafe %s evidence",
  async (kind) => {
    const f = await evidenceFixture();
    const path = join(f.root, f.paths.trainingEvidencePath);
    if (kind === "oversized") await writeFile(path, "x".repeat(1024 * 1024 + 1));
    if (kind === "invalid-json") await writeFile(path, "provider-secret-not-json");
    if (kind === "public") await chmod(path, 0o644);
    if (kind === "symlink") {
      await rm(path);
      await symlink(join(f.root, f.paths.holdoutEvidencePath), path);
    }
    const paths =
      kind === "outside" ? { ...f.paths, trainingEvidencePath: "../outside.json" } : f.paths;
    await expect(checkReviewedTextEvaluation(f.root, paths)).rejects.toThrow();
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    expect(
      await runNativeCheckCommand(
        [
          "--reviewed-text",
          "--project",
          f.root,
          "--training-evidence",
          paths.trainingEvidencePath,
          "--holdout-evidence",
          paths.holdoutEvidencePath,
        ],
        io,
      ),
    ).toBe(3);
    expect(io.stderr.mock.calls[0][0]).not.toContain("provider-secret");
  },
);

it("rechecks source at exit and detects a changed license as part of the full tree", async () => {
  const f = await evidenceFixture();
  const original = projects.verifyReviewedTextProject;
  vi.spyOn(projects, "verifyReviewedTextProject").mockImplementation(async (root, prepared) => {
    await writeFile(join(root, "skills/release-notes/LICENSE"), "Changed license.");
    return original(root, prepared);
  });
  await expect(checkReviewedTextEvaluation(f.root, f.paths)).rejects.toThrow();
});

function releaseOptions(f: Awaited<ReturnType<typeof evidenceFixture>>) {
  return {
    provider: "reviewed-text" as const,
    reviewEvidencePath: f.paths.trainingEvidencePath,
    evalEvidencePath: f.paths.holdoutEvidencePath,
    evalSource: "evals",
  };
}
function releaseArgs(f: Awaited<ReturnType<typeof evidenceFixture>>) {
  return [
    "--reviewed-text",
    "--project",
    f.root,
    "--review-evidence",
    f.paths.trainingEvidencePath,
    "--eval-evidence",
    f.paths.holdoutEvidencePath,
    "--eval-source",
    "evals",
  ];
}

it("binds text release gate and submission payload without inference or network", async () => {
  const f = await evidenceFixture();
  const options = releaseOptions(f);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const gate = await checkReleaseGate(f.root, options);
  expect(gate).toMatchObject({
    gateType: "skillpress.reviewed-text-release",
    passed: true,
    releaseAuthorized: false,
    independentVerificationRequired: true,
    sourceCommit: f.prepared.source.commit,
  });
  const payload = await prepareSkillSubmission(f.root, f.prepared.artifacts, options);
  const prepared = await prepareReviewedTextEvidence(f.root, f.paths);
  expect(payload.reviewEvidenceBytes).toEqual(prepared.reviewBytes);
  expect(payload.evalEvidenceBytes).toEqual(prepared.evaluationBytes);
  expect(payload.manifest.evidence.review.sha256).toBe(hash(prepared.reviewBytes.toString()));
  expect(JSON.parse(payload.reviewEvidenceBytes.toString()).measurement.releaseEligible).toBe(
    false,
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("packages and prepares a text submission through real CLI paths", async () => {
  const f = await evidenceFixture();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const output: string[] = [];
  const io = {
    stdout: (text: string) => {
      output.push(text);
    },
    stderr: vi.fn(),
  };
  const args = releaseArgs(f);
  expect(await runCli(["package", ...args], io)).toBe(0);
  expect(output.at(-1)).toContain("Reviewed text release gate: passed (advisory)");
  expect(await runCli(["submit", ...args, "--dry-run", "--json"], io)).toBe(0);
  expect(JSON.parse(output.at(-1) as string)).toMatchObject({
    ok: true,
    receipt: { operationStatus: "prepared", dryRun: true },
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("prepares and inspects text submission with explicit artifacts through real CLI paths", async () => {
  const f = await evidenceFixture();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const output: string[] = [];
  const io = {
    stdout: (text: string) => {
      output.push(text);
    },
    stderr: vi.fn(),
  };
  const args = releaseArgs(f);
  expect(
    await runCli(
      ["submit", ...args, "--dry-run", "--artifacts", f.prepared.artifacts.artifactsPath],
      io,
    ),
  ).toBe(0);
  expect(output.at(-1)).toContain("Reviewed text release gate: passed (advisory)");
  const statusCode = await runCli(
    ["status", ...args, "--artifacts", f.prepared.artifacts.artifactsPath],
    io,
  );
  expect(statusCode, `${output.at(-1)} ${JSON.stringify(io.stderr.mock.calls)}`).toBe(0);
  expect(output.at(-1)).toContain("Reviewed text gate: passed");
  expect(fetch).not.toHaveBeenCalled();
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("diagnoses text submission readiness without inference or network", async () => {
  const f = await evidenceFixture();
  const options = releaseOptions(f);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const commands: string[] = [];
  const doctor = await diagnoseProject(f.root, {
    evidence: options,
    homeDirectory: f.root,
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
  expect(commands).toEqual(["git"]);
  expect(doctor.checks.map(({ id }) => id)).toContain("evidence.reviewed-text");
  expect(doctor.checks.map(({ id }) => id)).not.toContain("credential.tessl");
  expect(fetch).not.toHaveBeenCalled();
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("sends text envelopes through submission orchestration without granting publication", async () => {
  const f = await evidenceFixture();
  const options = releaseOptions(f);
  const payload = await prepareSkillSubmission(f.root, f.prepared.artifacts, options);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const date = new Date().toISOString();
  const remote: SkillPressSubmissionResource = {
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
    url: "https://skill-press.com/api/v1/submissions/submission_12345678",
    receivedAt: date,
    updatedAt: date,
  };
  const client = {
    checkSession: vi.fn(async () => ({
      schemaVersion: 1 as const,
      sessionType: "skillpress.session" as const,
      authenticated: true as const,
    })),
    submit: vi.fn(async () => remote),
    getSubmission: vi.fn(async () => remote),
  };
  const receipt = await runSkillSubmission(f.root, f.prepared.artifacts, {
    evidence: options,
    client,
  });
  expect(receipt.operationStatus).toBe("submitted");
  expect(receipt.remote?.status).toBe("received");
  expect(receipt.remote?.release).toBeUndefined();
  expect(client.submit).toHaveBeenCalledExactlyOnceWith(payload);
  expect(client.getSubmission).toHaveBeenCalledExactlyOnceWith(remote.id);
  expect(fetch).not.toHaveBeenCalled();
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("blocks quality-failed text before submission, with no native or legacy fallback", async () => {
  const f = await evidenceFixture(true, 1);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const options = releaseOptions(f);
  const gate = await checkReleaseGate(f.root, options);
  expect(gate.passed).toBe(false);
  expect(gate.issues.map(({ code }) => code)).toContain("training:text.impact.failed");
  const output: string[] = [];
  const io = {
    stdout: (text: string) => {
      output.push(text);
    },
    stderr: vi.fn(),
  };
  for (const command of ["package", "submit"]) {
    expect(await runCli([command, ...releaseArgs(f)], io)).toBe(3);
    expect(output.at(-1)).toContain("Reviewed text release gate: blocked");
  }
  await expect(prepareSkillSubmission(f.root, f.prepared.artifacts, options)).rejects.toThrow(
    "exact package",
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("rejects wrong package bindings, stale receipts and unsafe text inputs", async () => {
  const f = await evidenceFixture();
  const options = releaseOptions(f);
  for (const key of [
    "sourceCommit",
    "projectConfigSha256",
    "skillSha256",
    "artifactSha256",
    "artifactBytes",
    "provenanceSha256",
  ] as const) {
    await expect(
      prepareSkillSubmission(
        f.root,
        {
          ...f.prepared.artifacts,
          [key]: key === "artifactBytes" ? 1 : "f".repeat(key === "sourceCommit" ? 40 : 64),
        },
        options,
      ),
    ).rejects.toThrow("exact package");
  }
  expect(
    (await checkReleaseGate(f.root, { ...options, now: () => new Date("2030-01-01") })).passed,
  ).toBe(false);
  await expect(checkReleaseGate(f.root, { ...options, evalSource: "other" })).rejects.toThrow(
    "canonical evals",
  );
  await writeFile(join(f.root, f.paths.trainingEvidencePath), "provider-secret-not-json");
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(await runCli(["submit", ...releaseArgs(f)], io)).toBe(3);
  expect(io.stderr.mock.calls[0][0]).not.toContain("provider-secret");
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("rejects duplicate, conflicting and incomplete text protocol CLI options", async () => {
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  for (const command of ["package", "submit", "status", "doctor"]) {
    expect(await runCli([command, "--reviewed-text", "--reviewed-text"], io)).toBe(2);
    expect(await runCli([command, "--reviewed-text", "--native"], io)).toBe(2);
    expect(await runCli([command, "--reviewed-text"], io)).toBe(2);
  }
  expect(
    await runCli(
      [
        "doctor",
        "--reviewed-text",
        "--review-evidence",
        "a",
        "--eval-evidence",
        "b",
        "--eval-source",
        "evals",
        "--tessl-executable",
        "tessl",
      ],
      io,
    ),
  ).toBe(2);
});

it.each(["training", "holdout", "both"])(
  "rejects native-discriminated %s evidence without uploading",
  async (which) => {
    const f = await evidenceFixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    for (const [name, value] of [
      ["training", f.training],
      ["holdout", f.holdout],
    ] as const) {
      if (which !== "both" && which !== name) continue;
      await writeFile(
        join(f.root, value.path),
        JSON.stringify({ ...value.result, evidenceType: "skillpress.native-evidence" }),
      );
    }
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    expect(await runCli(["submit", ...releaseArgs(f)], io)).toBe(3);
    expect(io.stderr.mock.calls[0][0]).toContain("text.evidence.invalid");
    expect(fetch).not.toHaveBeenCalled();
    expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
  },
);
