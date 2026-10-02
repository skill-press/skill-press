import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/eval/codex-text.js", () => ({ runReviewedCodexText: vi.fn() }));
import { runReviewedCodexText } from "../src/eval/codex-text.js";
import { loadProjectConfig } from "../src/config/load.js";
import { runReviewedToolSuite } from "../src/eval/reviewed-tool-suite.js";
import { TOOL_ACTION_SCHEMA_JSON } from "../src/eval/tool-action-schema.js";
import { assessReviewedToolMeasurement } from "../src/release/reviewed-tool-measurement.js";
import type { SkillPressEvaluationSuite } from "../src/eval/generated-suite.js";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const now = new Date("2026-10-01T12:00:00.000Z");
type Prepared = Parameters<typeof assessReviewedToolMeasurement>[1];
async function fixture(
  name: "training" | "holdout" = "training",
  before = 0.7,
  after = 1,
  customize: (p: Prepared) => void = () => {},
  wrongSelection = false,
) {
  const config = await loadProjectConfig(process.cwd());
  const skillText = "---\nname: sample\ndescription: Inspect supplied facts.\n---\nBe accurate.";
  const suite = (name: "training" | "holdout"): SkillPressEvaluationSuite => ({
    schemaVersion: 1,
    suite: name,
    skill: "sample",
    scenarios: (name === "training"
      ? (["positive", "near-miss", "failure", "adversarial"] as const)
      : (["positive", "near-miss"] as const)
    ).map((category) => ({
      id: `${name}-${category}`,
      category,
      shouldActivate: category !== "near-miss",
      prompt: `Synthetic ${name} ${category} task.`,
      expectedBehavior: ["Correct facts."],
      forbiddenBehavior: ["Invent a deployment."],
    })) as SkillPressEvaluationSuite["scenarios"],
  });
  const prepared = {
    config,
    skillText,
    skillTextSha256: hash(skillText),
    image: `python@sha256:${"a".repeat(64)}`,
    skillFiles: [{ path: "SKILL.md", content: skillText }],
    source: {
      commit: "a".repeat(40),
      projectConfigSha256: "b".repeat(64),
      skillSha256: "c".repeat(64),
      evalSource: "evals",
      evalSourceSha256: "d".repeat(64),
    },
    artifacts: {
      artifactSha256: "e".repeat(64),
      artifactBytes: 10,
      provenanceSha256: "f".repeat(64),
    },
    inputs: {
      training: suite("training"),
      holdout: suite("holdout"),
      rubric: {
        schemaVersion: 1,
        name: "quality",
        criteria: [
          {
            id: "activation",
            evaluator: "deterministic",
            weight: 20,
            description: "Correct selection",
          },
          { id: "accuracy", evaluator: "judge", weight: 80, description: "Correct facts" },
        ],
      },
    },
    releaseEligible: false,
  } as Prepared;
  customize(prepared);
  let calls = 0;
  vi.mocked(runReviewedCodexText).mockImplementation(async (prompt, _signal, schema) => {
    const index = calls++;
    const stage = index % 5;
    const scenario =
      prepared.inputs[name].scenarios[Math.floor(index / 5 / config.evaluation.repetitions)];
    const text =
      stage === 0
        ? JSON.stringify({
            selected: wrongSelection ? !scenario.shouldActivate : scenario.shouldActivate,
            rationale: "Synthetic selection",
          })
        : stage === 1 || stage === 3
          ? JSON.stringify({ action: { kind: "answer", text: "Synthetic answer." } })
          : JSON.stringify({
              criteria: [
                {
                  id: "accuracy",
                  score: stage === 2 ? before : after,
                  rationale: "Synthetic score",
                },
              ],
            });
    return {
      text,
      inputSha256: hash(prompt),
      outputSha256: hash(text),
      ...(schema ? { outputSchemaSha256: hash(TOOL_ACTION_SCHEMA_JSON) } : {}),
      requestedModel: "gpt-6.1-sol",
      effort: "medium",
      authentication: "forced-chatgpt",
      cliVersion: "0.160.0",
      execution: "reviewed-host-text-pilot",
      releaseEligible: false,
      diagnostics: [],
      durationMs: 1,
      usage: { inputTokens: 10, cachedInputTokens: 1, outputTokens: 2 },
    };
  });
  const result = await runReviewedToolSuite({
    ...prepared,
    suite: prepared.inputs[name],
    rubric: prepared.inputs.rubric,
    repetitions: config.evaluation.repetitions,
    readinessMinimum: config.quality.readinessMinimum,
    onEvent: async () => {},
    onResult: async () => {},
  });
  const measurement = structuredClone({
    ...result,
    source: prepared.source,
    config,
    artifact: {
      sha256: prepared.artifacts.artifactSha256,
      bytes: prepared.artifacts.artifactBytes,
      provenanceSha256: prepared.artifacts.provenanceSha256,
    },
    createdAt: "2026-10-01T11:00:00.000Z",
    ineligibilityReasons: ["tool_profile_not_admitted"],
  });
  return { prepared, measurement, name };
}
afterEach(() => vi.resetAllMocks());
it("rejects a self-consistent changed answer with a stale judge binding", async () => {
  const f = await fixture();
  const data = JSON.parse(JSON.stringify(f.measurement));
  const actor = data.records[0].pair.withSkill.actor;
  actor.answer = "Changed answer.";
  actor.steps[0].action.text = actor.answer;
  actor.steps[0].response.text = JSON.stringify({ action: actor.steps[0].action });
  actor.steps[0].response.outputSha256 = hash(actor.steps[0].response.text);
  expect(assessReviewedToolMeasurement(data, f.prepared, f.name, now).issues).toContain(
    "tool.measurement.inconsistent",
  );
});
it("rejects wrong selection even with completely consistent downstream receipts", async () => {
  const f = await fixture("training", 0.7, 1, () => {}, true);
  const result = assessReviewedToolMeasurement(f.measurement, f.prepared, f.name, now);
  expect(result.issues).toContain("tool.safety.failed");
  expect(result.issues).not.toContain("tool.measurement.inconsistent");
});
it.each(["training", "holdout"] as const)(
  "recomputes %s without granting release",
  async (name) => {
    const f = await fixture(name);
    expect(assessReviewedToolMeasurement(f.measurement, f.prepared, name, now)).toEqual({
      passed: true,
      issues: [],
      advisory: true,
      independentVerificationRequired: true,
      releaseAuthorized: false,
    });
  },
);
it.each([null, [], {}, "private-data"])("sanitizes malformed receipts", async (value) => {
  const f = await fixture();
  expect(assessReviewedToolMeasurement(value, f.prepared, f.name, now).issues).toEqual([
    "tool.measurement.inconsistent",
  ]);
});
it.each([
  ["source.commit", "x"],
  ["artifact.sha256", "x"],
  ["image", "x"],
  ["skillFiles", []],
  ["complete", false],
  ["unattemptedPairs", 1],
  ["plannedPairs", 1],
  ["maximumModelCalls", 1],
  ["runId", "invalid"],
  ["createdAt", "invalid"],
  ["summary.impactDelta", 0.5],
  ["evidenceType", "skillpress.reviewed-text-suite"],
  ["records.0.runId", "a".repeat(64)],
  ["records.0.scenarioId", "wrong"],
  ["records.0.repetition", 2],
  ["records.0.status", "failed"],
  ["records.0.pair.selection.selected", false],
  ["records.0.pair.selection.prompt.text", "forged"],
  ["records.0.pair.selection.response.requestedModel", "other"],
  ["records.0.pair.selection.response.usage.inputTokens", -1],
  ["records.0.pair.selection.response.diagnostics", ["unknown"]],
  ["records.0.pair.selection.response.outputSchemaSha256", "forged"],
  ["records.0.pair.modelInvocations", 11],
  ["records.0.pair.withSkill.score", 0],
  ["records.0.pair.withSkill.actor.answer", "forged"],
  ["records.0.pair.baseline.activated", true],
  ["records.0.pair.withSkill.judgePrompt.text", "forged"],
  ["records.0.pair.withSkill.criteria.0.score", 0],
])("rejects changed %s", async (path, value) => {
  const f = await fixture();
  const data = JSON.parse(JSON.stringify(f.measurement));
  const parts = (path as string).split(".");
  let target = data;
  for (const part of parts.slice(0, -1)) target = target[part];
  target[parts.at(-1) as string] = value;
  expect(assessReviewedToolMeasurement(data, f.prepared, f.name, now).issues).toContain(
    "tool.measurement.inconsistent",
  );
});
it("preserves honest quality failure despite complete execution", async () => {
  const f = await fixture("training", 1, 1);
  expect(assessReviewedToolMeasurement(f.measurement, f.prepared, f.name, now).issues).toEqual([
    "tool.impact.failed",
  ]);
});
it("reports regressions, safety and success failures", async () => {
  const f = await fixture("training", 1, 0.7);
  expect(assessReviewedToolMeasurement(f.measurement, f.prepared, f.name, now).issues).toEqual(
    expect.arrayContaining([
      "tool.scenario.regression",
      "tool.safety.failed",
      "tool.success_rate.failed",
      "tool.impact.failed",
    ]),
  );
});
it.each(["2026-10-01T10:00:00.000Z", "2026-10-08T11:00:00.000Z"])(
  "rejects future or expired evidence",
  async (date) => {
    const f = await fixture();
    expect(
      assessReviewedToolMeasurement(f.measurement, f.prepared, f.name, new Date(date)).issues,
    ).toContain("tool.evidence.age");
  },
);
it("rejects weakened minimums and missing categories", async () => {
  const f = await fixture("training", 0.7, 1, (p) => {
    p.config.evaluation.repetitions = 1;
    p.inputs.training.scenarios = p.inputs.training.scenarios.slice(
      0,
      1,
    ) as typeof p.inputs.training.scenarios;
  });
  expect(assessReviewedToolMeasurement(f.measurement, f.prepared, f.name, now).issues).toEqual(
    expect.arrayContaining(["tool.policy.minimums", "tool.scenarios.coverage"]),
  );
});
it("rejects insufficient judge weight", async () => {
  const f = await fixture("training", 0.7, 1, (p) => {
    p.inputs.rubric.criteria[0].weight = 40;
    p.inputs.rubric.criteria[1].weight = 60;
  });
  expect(assessReviewedToolMeasurement(f.measurement, f.prepared, f.name, now).issues).toContain(
    "tool.rubric.judge_weight",
  );
});
