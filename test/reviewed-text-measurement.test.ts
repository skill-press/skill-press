import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/eval/codex-text.js", () => ({ runReviewedSelectedTextPair: vi.fn() }));
import { loadProjectConfig } from "../src/config/load.js";
import { runReviewedSelectedTextPair } from "../src/eval/codex-text.js";
import type { SkillPressEvaluationSuite } from "../src/eval/generated-suite.js";
import { runReviewedTextSuite } from "../src/eval/reviewed-text-suite.js";
import {
  createTextActorPrompt,
  createTextJudgePrompt,
  createTextSelectionPrompt,
  type TextEvaluationPrompt,
} from "../src/eval/text-evaluation.js";
import { assessReviewedTextMeasurement } from "../src/release/reviewed-text-measurement.js";
import { isReviewedTextEvidence } from "../src/eval/reviewed-text-schema.js";
import { CODE_MODE_DISABLED_DIAGNOSTIC } from "../src/eval/codex-transcript.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const skillText = "---\nname: notes\ndescription: Draft release notes.\n---\nUse supplied sources.";
const now = new Date("2026-10-01T12:00:00.000Z");
const response = (prompt: TextEvaluationPrompt, text: string) => ({
  text,
  diagnostics: [],
  usage: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 },
  releaseEligible: false as const,
  requestedModel: "gpt-6.1-sol" as const,
  effort: "medium" as const,
  authentication: "forced-chatgpt" as const,
  cliVersion: "0.160.0" as const,
  execution: "reviewed-host-text-pilot" as const,
  inputSha256: prompt.sha256,
  outputSha256: hash(text),
  durationMs: 10,
});

async function fixture(
  name: "training" | "holdout" = "training",
  skillScore = 1,
  baselineScore: number | ((index: number) => number) = 0.7,
  customize: (prepared: Parameters<typeof assessReviewedTextMeasurement>[1]) => void = () => {},
) {
  const config = await loadProjectConfig(process.cwd());
  config.project.name = "notes";
  config.skill.name = "notes";
  config.skill.path = "skills/notes";
  const suite = (suiteName: "training" | "holdout"): SkillPressEvaluationSuite => ({
    schemaVersion: 1,
    suite: suiteName,
    skill: "notes",
    scenarios: (suiteName === "training"
      ? (["positive", "near-miss", "failure", "adversarial"] as const)
      : (["positive", "near-miss"] as const)
    ).map((category) => ({
      id: `${suiteName}-${category}`,
      category,
      shouldActivate: category !== "near-miss",
      prompt: `Synthetic ${suiteName} ${category} request.`,
      expectedBehavior: ["Respect supplied facts."],
      forbiddenBehavior: ["Invent a deployment."],
    })) as SkillPressEvaluationSuite["scenarios"],
  });
  const rubric = {
    schemaVersion: 1 as const,
    name: "quality",
    criteria: [
      {
        id: "activation",
        evaluator: "deterministic" as const,
        weight: 20,
        description: "Correct selection",
      },
      { id: "accuracy", evaluator: "judge" as const, weight: 80, description: "Correct facts" },
    ] as [
      { id: string; evaluator: "deterministic"; weight: number; description: string },
      { id: string; evaluator: "judge"; weight: number; description: string },
    ],
  };
  const inputs = { training: suite("training"), holdout: suite("holdout"), rubric };
  const source = {
    commit: "a".repeat(40),
    projectConfigSha256: "b".repeat(64),
    skillSha256: "c".repeat(64),
    evalSource: "evals" as const,
    evalSourceSha256: "d".repeat(64),
  };
  const artifacts = {
    schemaVersion: 1 as const,
    artifactsPath: ".skill-press/staging/test/artifacts",
    skillArchive: "notes.skill",
    zipArchive: "notes.zip",
    checksums: "SHA256SUMS",
    provenance: "provenance.json",
    provenanceSha256: "e".repeat(64),
    provenanceBytes: 10,
    checksumsSha256: "f".repeat(64),
    checksumsBytes: 10,
    artifactSha256: "1".repeat(64),
    artifactBytes: 10,
    sourceCommit: source.commit,
    projectConfigSha256: source.projectConfigSha256,
    skillSha256: source.skillSha256,
  };
  const prepared = {
    source,
    config,
    inputs,
    artifacts,
    skillText,
    skillTextSha256: hash(skillText),
    releaseEligible: false as const,
  };
  customize(prepared);
  let pairIndex = 0;
  vi.mocked(runReviewedSelectedTextPair).mockImplementation(async (scenario, criteria) => {
    const before = typeof baselineScore === "function" ? baselineScore(pairIndex++) : baselineScore;
    const selected = scenario.shouldActivate;
    const selection = response(
      createTextSelectionPrompt(scenario, skillText),
      JSON.stringify({ selected, rationale: "Synthetic selection" }),
    );
    const leg = (withSkill: boolean) => {
      const actor = response(
        createTextActorPrompt(scenario, withSkill && selected ? skillText : null),
        "Synthetic answer.",
      );
      const scores = [
        {
          id: "accuracy",
          score: withSkill ? skillScore : before,
          rationale: "Synthetic score.",
        },
      ];
      const judge = response(
        createTextJudgePrompt(scenario, criteria, actor.text),
        JSON.stringify({ criteria: scores }),
      );
      return { actor, judge, criteria: scores, activated: withSkill && selected };
    };
    return {
      kind: "skillpress.reviewed-selected-text-pair-pilot",
      baseline: leg(false),
      withSkill: leg(true),
      selection: { ...selection, selected, rationale: "Synthetic selection" },
      skillTextSha256: hash(skillText),
      activationMeasurement: "harness-metadata-selection",
      modelInvocations: 5,
      releaseEligible: false,
    };
  });
  const measurement = {
    ...(await runReviewedTextSuite({
      suite: inputs[name],
      rubric,
      skillText,
      repetitions: config.evaluation.repetitions,
      readinessMinimum: config.quality.readinessMinimum,
      onResult: async () => {},
    })),
    createdAt: "2026-10-01T11:00:00.000Z",
    source,
    config,
    artifact: {
      sha256: artifacts.artifactSha256,
      bytes: artifacts.artifactBytes,
      provenanceSha256: artifacts.provenanceSha256,
    },
    ineligibilityReasons: ["text_profile_not_admitted"],
  };
  return { prepared, measurement: structuredClone(measurement), name };
}
afterEach(() => vi.resetAllMocks());

it.each(["training", "holdout"] as const)(
  "recomputes complete %s quality without authorizing release",
  async (name) => {
    const f = await fixture(name);
    expect(assessReviewedTextMeasurement(f.measurement, f.prepared, name, now)).toEqual({
      passed: true,
      issues: [],
      advisory: true,
      independentVerificationRequired: true,
      releaseAuthorized: false,
    });
  },
);

function set(value: unknown, path: string, replacement: unknown) {
  const keys = path.split(".");
  let target = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1) as string] = replacement;
}

it.each([
  ["schemaVersion", 2],
  ["evidenceType", "other"],
  ["execution", "docker"],
  ["activationMeasurement", "native-loader"],
  ["releaseEligible", true],
  ["ineligibilityReasons", []],
  ["source.commit", "f".repeat(40)],
  ["artifact.sha256", "f".repeat(64)],
  ["skillTextSha256", "f".repeat(64)],
  ["evaluationInputsSha256", "f".repeat(64)],
  ["runId", "bad"],
  ["complete", false],
  ["unattemptedPairs", 1],
  ["repetitions", 2],
  ["plannedPairs", 11],
  ["records", []],
  ["createdAt", "not-a-date"],
  ["records.0.status", "failed"],
  ["records.0.runId", "f".repeat(64)],
  ["records.0.scenarioId", "reordered"],
  ["records.0.repetition", 2],
  ["records.0.pair.modelInvocations", 4],
  ["records.0.pair.baseline.activated", true],
  ["records.0.pair.withSkill.activated", false],
  ["records.0.baselineScore", 100],
  ["summary.impactDelta", 0.9],
  ["records.0.pair.selection.selected", false],
  ["records.0.pair.baseline.actor.inputSha256", "f".repeat(64)],
  ["records.0.pair.baseline.actor.text", "Substituted answer"],
  ["records.0.pair.baseline.actor.requestedModel", "other-model"],
  ["records.0.pair.baseline.actor.authentication", "api-key"],
  ["records.0.pair.baseline.actor.cliVersion", "future"],
  ["records.0.pair.baseline.actor.diagnostics", ["Unknown error"]],
  ["records.0.pair.baseline.actor.usage.inputTokens", -1],
  ["records.0.pair.baseline.actor.usage.cachedInputTokens", 11],
  ["records.0.pair.baseline.actor.durationMs", -1],
  ["records.0.pair.baseline.criteria.0.score", 1],
] as const)("rejects altered %s without echoing input", async (path, replacement) => {
  const f = await fixture();
  set(f.measurement, path, replacement);
  const result = assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now);
  expect(result.passed).toBe(false);
  expect(result.issues).toContain("text.measurement.inconsistent");
  expect(result.releaseAuthorized).toBe(false);
});

it.each([null, [], {}, "secret-provider-error"])("rejects malformed JSON values", async (value) => {
  const f = await fixture();
  expect(assessReviewedTextMeasurement(value, f.prepared, f.name, now).issues).toEqual([
    "text.measurement.inconsistent",
  ]);
});

it.each(["2026-09-24T12:00:00.000Z", "2026-10-01T12:00:00.001Z"])(
  "rejects expired or future evidence %s",
  async (createdAt) => {
    const f = await fixture();
    f.measurement.createdAt = createdAt;
    expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).issues).toContain(
      "text.evidence.age",
    );
  },
);

it("rejects behavioral failure and per-scenario regression despite consistent receipts", async () => {
  const f = await fixture("training", 0.7, 1);
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).issues).toEqual([
    "text.scenario.regression",
    "text.safety.failed",
    "text.success_rate.failed",
    "text.impact.failed",
  ]);
});

it("does not infer impact from two successful arms", async () => {
  const f = await fixture("holdout", 1, 1);
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).issues).toEqual([
    "text.impact.failed",
  ]);
});

it("rejects weaker project policy even when copied consistently", async () => {
  const f = await fixture();
  f.prepared.config.evaluation.minimumImpactDelta = 0;
  f.measurement.config.evaluation.minimumImpactDelta = 0;
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).issues).toEqual([
    "text.measurement.inconsistent",
  ]);
});

it.each(["minimumSuccessRate", "repetitions"] as const)("rejects weakened %s", async (key) => {
  const f = await fixture("training", 1, 0.7, (p) => {
    p.config.evaluation[key] = key === "repetitions" ? 2 : 0.8;
  });
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).issues).toContain(
    "text.measurement.inconsistent",
  );
});

it.each([
  ["unexpected", true],
  ["source.unexpected", true],
  ["artifact.unexpected", true],
  ["summary.unexpected", true],
  ["records.0.unexpected", true],
  ["records.0.pair.unexpected", true],
  ["records.0.pair.selection.unexpected", true],
  ["records.0.pair.baseline.unexpected", true],
  ["records.0.pair.baseline.actor.unexpected", true],
  ["records.0.pair.baseline.actor.usage.unexpected", true],
  ["records.0.pair.baseline.criteria.0.unexpected", true],
  ["records.0.pair.selection.rationale", "x".repeat(4097)],
  ["records.0.pair.baseline.actor.usage.inputTokens", 0.5],
  ["records.0.pair.baseline.actor.text", "x".repeat(1048577)],
  ["repetitions", 21],
  ["createdAt", "2026-10-01"],
])("rejects unversioned fields or invalid wire bounds at %s", async (path, value) => {
  const f = await fixture();
  expect(isReviewedTextEvidence(f.measurement)).toBe(true);
  set(f.measurement, path, value);
  expect(isReviewedTextEvidence(f.measurement)).toBe(false);
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now)).toMatchObject({
    passed: false,
    issues: ["text.measurement.inconsistent"],
    releaseAuthorized: false,
  });
});

it("keeps structural validity distinct from quality acceptance", async () => {
  const f = await fixture("holdout", 1, 1);
  expect(isReviewedTextEvidence(f.measurement)).toBe(true);
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).passed).toBe(false);
});

it("retains the known disabled-code-mode diagnostic in valid historical receipts", async () => {
  const f = await fixture();
  set(f.measurement, "records.0.pair.baseline.actor.diagnostics", [CODE_MODE_DISABLED_DIAGNOSTIC]);
  expect(isReviewedTextEvidence(f.measurement)).toBe(true);
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).passed).toBe(true);
});

it("rejects activation-heavy rubrics with otherwise consistent measurements", async () => {
  const f = await fixture("training", 1, 0.7, (p) => {
    p.inputs.rubric.criteria[0].weight = 50;
    p.inputs.rubric.criteria[1].weight = 50;
  });
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).issues).toEqual([
    "text.rubric.judge_weight",
  ]);
});

it("rejects missing category coverage", async () => {
  const f = await fixture("training", 1, 0.7, (p) => {
    p.inputs.training.scenarios.pop();
  });
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).issues).toEqual([
    "text.scenarios.coverage",
  ]);
});

it("respects stricter readiness without accepting the runner's usual 90", async () => {
  const f = await fixture("training", 0.95, 0.7, (p) => {
    p.config.quality.readinessMinimum = 99;
  });
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).issues).toEqual([
    "text.safety.failed",
    "text.success_rate.failed",
    "text.impact.failed",
  ]);
});

it("uses native six-decimal semantics at an exact impact boundary without rewriting raw receipts", async () => {
  const f = await fixture(
    "training",
    1,
    (index) => (index % 3 === 0 ? 1 : 0.7),
    (p) => {
      p.config.evaluation.minimumImpactDelta = 0.666667;
    },
  );
  expect(f.measurement.summary?.impactDelta).toBe(2 / 3);
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).passed).toBe(true);
  f.prepared.config.evaluation.minimumImpactDelta = 0.666668;
  f.measurement.config.evaluation.minimumImpactDelta = 0.666668;
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).issues).toEqual([
    "text.impact.failed",
  ]);
});

it("rejects a replaced answer even if its output digest is recomputed", async () => {
  const f = await fixture();
  set(f.measurement, "records.0.pair.baseline.actor.text", "Different answer");
  set(f.measurement, "records.0.pair.baseline.actor.outputSha256", hash("Different answer"));
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).issues).toEqual([
    "text.measurement.inconsistent",
  ]);
});

it("rejects an actual incorrect selection even when every receipt and summary is consistent", async () => {
  const f = await fixture();
  const record = f.measurement.records[3];
  if (record?.status !== "passed") throw new Error("Expected fixture pair");
  const text = JSON.stringify({ selected: true, rationale: record.pair.selection.rationale });
  set(f.measurement, "records.3.pair.selection.text", text);
  set(f.measurement, "records.3.pair.selection.outputSha256", hash(text));
  set(f.measurement, "records.3.pair.selection.selected", true);
  set(f.measurement, "records.3.pair.withSkill.activated", true);
  set(
    f.measurement,
    "records.3.pair.withSkill.actor.inputSha256",
    createTextActorPrompt(f.prepared.inputs.training.scenarios[1], skillText).sha256,
  );
  set(f.measurement, "records.3.withSkillScore", 80);
  set(f.measurement, "summary.withSkillSuccessRate", 11 / 12);
  set(f.measurement, "summary.impactDelta", 11 / 12);
  expect(assessReviewedTextMeasurement(f.measurement, f.prepared, f.name, now).issues).toEqual([
    "text.safety.failed",
  ]);
});
