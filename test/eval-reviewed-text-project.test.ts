import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

vi.mock("../src/eval/codex-text.js", () => ({ runReviewedSelectedTextPair: vi.fn() }));
import { runReviewedSelectedTextPair } from "../src/eval/codex-text.js";
import { runCli } from "../src/cli.js";
import { runNativeCheckCommand } from "../src/cli/native-check.js";
import { checkReviewedTextEvaluation } from "../src/release/reviewed-text-check.js";
import * as projects from "../src/eval/reviewed-text-project.js";
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
async function fixture(licensed = false) {
  const root = await mkdtemp(join(tmpdir(), "reviewed-text-project-"));
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

async function evidenceFixture(licensed = true) {
  const root = await fixture(licensed);
  const prepared = await prepareReviewedTextProject(root);
  vi.mocked(runReviewedSelectedTextPair).mockImplementation(async (scenario, rubric, text) => {
    const selected = scenario.shouldActivate;
    const leg = (withSkill: boolean) => {
      const actor = response(
        createTextActorPrompt(scenario, withSkill && selected ? text : null),
        "Synthetic answer.",
      );
      const criteria = rubric.criteria
        .filter((c) => c.evaluator === "judge")
        .map((c) => ({ id: c.id, score: withSkill ? 1 : 0.5, rationale: "Synthetic." }));
      const judge = response(
        createTextJudgePrompt(scenario, rubric, actor.text),
        JSON.stringify({ criteria }),
      );
      return { actor, judge, criteria, activated: withSkill && selected };
    };
    const rationale = "Synthetic selection.";
    return {
      kind: "skillpress.reviewed-selected-text-pair-pilot",
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
    admissionIssues: ["text_profile_not_admitted"],
    readiness: { ok: true },
  });
  expect(await runNativeCheckCommand(args, io)).toBe(0);
  expect(outputs[1]).toContain("Text profile is not release-admitted");
  expect(await runNativeCheckCommand([...args, "--reviewed-text"], io)).toBe(2);
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("retains readiness failure instead of waiving missing licenses", async () => {
  const f = await evidenceFixture(false);
  const report = await checkReviewedTextEvaluation(f.root, f.paths);
  expect(report.issues).toEqual(["text.readiness.failed"]);
  expect(report.passed).toBe(false);
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
