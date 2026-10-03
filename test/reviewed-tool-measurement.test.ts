import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/eval/codex-text.js", () => ({ runReviewedCodexText: vi.fn() }));
import { runReviewedCodexText } from "../src/eval/codex-text.js";
import { CODE_MODE_DISABLED_DIAGNOSTIC } from "../src/eval/codex-transcript.js";
import { loadProjectConfig } from "../src/config/load.js";
import { runReviewedToolSuite } from "../src/eval/reviewed-tool-suite.js";
import { createReviewedToolActorPrompt } from "../src/eval/reviewed-tool-actor.js";
import { createToolJudgePrompt } from "../src/eval/reviewed-tool-pair.js";
import { TOOL_ACTION_SCHEMA_JSON } from "../src/eval/tool-action-schema.js";
import { assessReviewedToolMeasurement } from "../src/release/reviewed-tool-measurement.js";
import { encodeReviewedToolEvidence } from "../src/release/reviewed-tool-evidence.js";
import {
  isReviewedToolEvidence,
  isReviewedToolEnvelope,
} from "../src/eval/reviewed-tool-schema.js";
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
function useLegacyProtocol(
  f: Awaited<ReturnType<typeof fixture>>,
  recordCount = Infinity,
  arms: readonly ("baseline" | "withSkill")[] = ["baseline", "withSkill"],
) {
  for (const record of f.measurement.records.slice(0, recordCount)) {
    if (record.status !== "passed") throw new Error("Expected completed synthetic pair.");
    const scenario = f.prepared.inputs[f.name].scenarios.find((s) => s.id === record.scenarioId);
    if (!scenario) throw new Error("Missing fixture scenario.");
    for (const arm of arms) {
      const leg = record.pair[arm];
      const active = arm === "withSkill" && record.pair.selection.selected;
      leg.actor.kind = "skillpress.reviewed-tool-actor.v2";
      for (const step of leg.actor.steps) {
        step.prompt = createReviewedToolActorPrompt(
          {
            scenario,
            image: f.prepared.image,
            skillText: active ? f.prepared.skillText : null,
            skillFiles: active ? f.prepared.skillFiles : [],
          },
          leg.actor.steps.slice(0, step.index),
          "skillpress.tool-actor.v2",
        );
        if (!step.response) throw new Error("Missing fixture response.");
        step.response.inputSha256 = step.prompt.sha256;
      }
      leg.judgePrompt = createToolJudgePrompt(scenario, f.prepared.inputs.rubric, leg.actor);
      leg.judge.inputSha256 = leg.judgePrompt.sha256;
    }
  }
}
it("accepts fully legacy measurements without changing derived quality", async () => {
  const f = await fixture();
  const original = assessReviewedToolMeasurement(f.measurement, f.prepared, f.name, now);
  expect(original.passed).toBe(true);
  useLegacyProtocol(f);
  expect(assessReviewedToolMeasurement(f.measurement, f.prepared, f.name, now)).toEqual(original);
});
it("rejects otherwise consistent protocol mixing between records", async () => {
  const f = await fixture();
  useLegacyProtocol(f, 1);
  expect(assessReviewedToolMeasurement(f.measurement, f.prepared, f.name, now).passed).toBe(false);
});
it("rejects otherwise consistent protocol mixing between pair arms", async () => {
  const f = await fixture();
  useLegacyProtocol(f, Infinity, ["baseline"]);
  expect(assessReviewedToolMeasurement(f.measurement, f.prepared, f.name, now).passed).toBe(false);
});
it("rejects a complete legacy judge prompt and receipt bound to a new actor", async () => {
  const f = await fixture();
  const record = f.measurement.records[0];
  if (record.status !== "passed") throw new Error("Expected completed synthetic pair.");
  const leg = record.pair.baseline;
  leg.judgePrompt = createToolJudgePrompt(
    f.prepared.inputs.training.scenarios[0],
    f.prepared.inputs.rubric,
    {
      ...leg.actor,
      kind: "skillpress.reviewed-tool-actor.v2",
    },
  );
  leg.judge.inputSha256 = leg.judgePrompt.sha256;
  expect(assessReviewedToolMeasurement(f.measurement, f.prepared, f.name, now).passed).toBe(false);
});
it("rejects individually valid training and holdout from different protocols", async () => {
  const t = await fixture();
  const h = await fixture("holdout");
  useLegacyProtocol(h);
  const result = encodeReviewedToolEvidence(t.prepared, t.measurement, h.measurement, now);
  expect(result.report.training.passed).toBe(true);
  expect(result.report.holdout.passed).toBe(true);
  expect(result.report.issues).toEqual(["tool.pair.protocol_mismatch"]);
});
it("retains holdout failures and accepts the known benign diagnostic", async () => {
  const t = await fixture();
  const h = await fixture("holdout", 1, 1);
  const data = JSON.parse(JSON.stringify(t.measurement));
  data.records[0].pair.selection.response.diagnostics = [CODE_MODE_DISABLED_DIAGNOSTIC];
  const result = encodeReviewedToolEvidence(t.prepared, data, h.measurement, now);
  expect(result.report.training.passed).toBe(true);
  expect(result.report.issues).toEqual(["holdout:tool.impact.failed"]);
});
it("strictly checks nested Python records as well as no-tool answers", async () => {
  const f = await fixture();
  const data = JSON.parse(JSON.stringify(f.measurement));
  const actor = data.records[0].pair.baseline.actor;
  const step = structuredClone(actor.steps[0]);
  step.action = { kind: "python", code: "print(1)" };
  step.tool = {
    kind: "skillpress.reviewed-python-tool.v1",
    image: f.prepared.image,
    pythonSha256: hash("print(1)"),
    inputs: [],
    skillFiles: [],
    network: "none",
    outputStorage: "tmpfs",
    policy: {
      timeoutSeconds: 30,
      cpus: 1,
      memoryMib: 512,
      pids: 64,
      tmpfsMib: 8,
      shmMib: 16,
      maxOutputBytes: 65536,
      maxArtifactBytes: 67108864,
      maxArtifactFiles: 1024,
    },
    execution: {
      status: "passed",
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdoutBytes: 2,
      stderrBytes: 0,
      stdoutSha256: hash("1\n"),
      stderrSha256: hash(""),
      stdoutText: "1\n",
      stderrText: "",
      cleanupAttempted: false,
      cleanupOk: false,
    },
    releaseEligible: false,
  };
  actor.steps[0].index = 1;
  actor.steps.unshift(step);
  actor.modelInvocations = 2;
  actor.toolInvocations = 1;
  // Shape only: this deliberately does not forge a consistent execution transcript.
  expect(isReviewedToolEvidence(data)).toBe(true);
  for (const field of ["tool", "execution", "policy", "action"]) {
    const copy = structuredClone(data);
    const first = copy.records[0].pair.baseline.actor.steps[0];
    const target =
      field === "tool" ? first.tool : field === "action" ? first.action : first.tool[field];
    target.extra = true;
    expect(isReviewedToolEvidence(copy)).toBe(false);
  }
  delete step.tool;
  expect(isReviewedToolEvidence(data)).toBe(false);
});
it("encodes deterministic separate envelopes and retains quality failure", async () => {
  const training = await fixture("training", 1, 1);
  const holdout = await fixture("holdout");
  const first = encodeReviewedToolEvidence(
    training.prepared,
    training.measurement,
    holdout.measurement,
    now,
  );
  const second = encodeReviewedToolEvidence(
    training.prepared,
    training.measurement,
    holdout.measurement,
    now,
  );
  expect(first.reviewBytes.equals(second.reviewBytes)).toBe(true);
  expect(first.evaluationBytes.equals(second.evaluationBytes)).toBe(true);
  expect(isReviewedToolEnvelope(JSON.parse(first.reviewBytes.toString()))).toBe(true);
  expect(first.report.issues).toEqual(["training:tool.impact.failed"]);
  expect(first.report.releaseAuthorized).toBe(false);
});
it("rejects malformed, mixed and extra-field evidence", async () => {
  const f = await fixture();
  for (const value of [
    null,
    { ...f.measurement, extra: true },
    { ...f.measurement, evidenceType: "skillpress.reviewed-text-suite" },
  ]) {
    expect(isReviewedToolEvidence(value)).toBe(false);
    expect(() => encodeReviewedToolEvidence(f.prepared, value, f.measurement, now)).toThrow(
      "upload contract",
    );
  }
  for (const target of [
    "source",
    "artifact",
    "summary",
    "pair",
    "actor",
    "response",
    "prompt",
    "usage",
  ]) {
    const data = JSON.parse(JSON.stringify(f.measurement));
    const actor = data.records[0].pair.baseline.actor;
    const object =
      target === "pair"
        ? data.records[0].pair
        : target === "actor"
          ? actor
          : target === "response"
            ? actor.steps[0].response
            : target === "prompt"
              ? actor.steps[0].prompt
              : target === "usage"
                ? actor.steps[0].response.usage
                : data[target];
    object.extra = true;
    expect(isReviewedToolEvidence(data)).toBe(false);
  }
});
it("retains suite run reuse as an explicit failure", async () => {
  const t = await fixture();
  const h = await fixture("holdout");
  h.measurement.runId = t.measurement.runId;
  for (const [index, record] of h.measurement.records.entries())
    record.runId = hash(
      `${h.measurement.runId}:${Math.floor(index / h.measurement.repetitions)}:${record.repetition}`,
    );
  expect(
    encodeReviewedToolEvidence(t.prepared, t.measurement, h.measurement, now).report.issues,
  ).toContain("tool.pair.run_reuse");
});
it("enforces existing byte limit even for structurally valid envelopes", async () => {
  const t = await fixture();
  const h = await fixture("holdout");
  const data = JSON.parse(JSON.stringify(t.measurement));
  data.records[0].pair.selection.response.text = "界".repeat(400000);
  expect(isReviewedToolEvidence(data)).toBe(true);
  expect(() => encodeReviewedToolEvidence(t.prepared, data, h.measurement, now)).toThrow(
    "upload limit",
  );
});
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
    p.config.evaluation.minimumImpactDelta = 0.05;
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
