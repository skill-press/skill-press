import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CODE_MODE_DISABLED_DIAGNOSTIC,
  MAX_CODEX_TRANSCRIPT_BYTES,
} from "../eval/codex-transcript.js";
import { evaluationInputsSha256, recomputeRubricScore } from "../eval/measurement.js";
import type {
  prepareReviewedToolProject,
  runPreparedReviewedToolSuite,
} from "../eval/reviewed-tool-project.js";
import { createToolJudgePrompt } from "../eval/reviewed-tool-pair.js";
import {
  createTextSelectionPrompt,
  parseTextSelection,
  parseTextJudgeScores,
} from "../eval/text-evaluation.js";
import { NATIVE_REVIEW_POLICY } from "./native-policy.js";
import { assessReviewedToolTrajectory } from "./reviewed-tool-trajectory.js";
import { isReviewedToolEvidence } from "../eval/reviewed-tool-schema.js";

type Prepared = Awaited<ReturnType<typeof prepareReviewedToolProject>>;
type Measurement = Awaited<ReturnType<typeof runPreparedReviewedToolSuite>>;
type Pair = Extract<Measurement["records"][number], { status: "passed" }>["pair"];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function receipt(value: Pair["baseline"]["judge"], prompt: { sha256: string }) {
  assert.equal(typeof value.text, "string");
  assert.ok(value.text.trim() && Buffer.byteLength(value.text) <= MAX_CODEX_TRANSCRIPT_BYTES);
  assert.equal(value.inputSha256, prompt.sha256);
  assert.equal(value.outputSha256, hash(value.text));
  assert.equal(value.outputSchemaSha256, undefined);
  assert.equal(value.requestedModel, "gpt-6.1-sol");
  assert.equal(value.effort, "medium");
  assert.equal(value.authentication, "forced-chatgpt");
  assert.equal(value.cliVersion, "0.160.0");
  assert.equal(value.execution, "reviewed-host-text-pilot");
  assert.equal(value.releaseEligible, false);
  assert.ok(Array.isArray(value.diagnostics) && value.diagnostics.length <= 1);
  assert.ok(value.diagnostics.every((d) => d === CODE_MODE_DISABLED_DIAGNOSTIC));
  for (const count of [
    value.usage.inputTokens,
    value.usage.cachedInputTokens,
    value.usage.outputTokens,
  ])
    assert.ok(Number.isSafeInteger(count) && count >= 0);
  assert.ok(value.usage.cachedInputTokens <= value.usage.inputTokens);
  assert.ok(Number.isFinite(value.durationMs) && value.durationMs >= 0);
}

/** Advisory recomputation against freshly verified prepared bytes. No I/O or admission.
 * Caller must size-bound JSON ingestion and verify source at entry/exit. This is
 * checked-field consistency, not exhaustive wire validation or execution attestation.
 */
export function assessReviewedToolMeasurement(
  input: unknown,
  prepared: Prepared,
  suiteName: "training" | "holdout",
  now = new Date(),
) {
  const issues = new Set<string>();
  try {
    assert.ok(isReviewedToolEvidence(input));
    const value = input as Measurement;
    const { config, inputs, skillText, skillFiles, image } = prepared;
    const suite = inputs[suiteName];
    const rubric = inputs.rubric;
    const resources = skillFiles.map((f) => ({ path: f.path, sha256: hash(f.content) }));
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.evidenceType, "skillpress.reviewed-tool-suite");
    assert.equal(value.execution, "host-networked-model-isolated-python");
    assert.equal(value.activationMeasurement, "harness-metadata-selection");
    assert.equal(value.releaseEligible, false);
    assert.deepEqual(value.ineligibilityReasons, ["tool_profile_not_admitted"]);
    assert.deepEqual(value.source, prepared.source);
    assert.deepEqual(value.config, config);
    assert.deepEqual(value.suite, suite);
    assert.deepEqual(value.rubric, rubric);
    assert.deepEqual(value.artifact, {
      sha256: prepared.artifacts.artifactSha256,
      bytes: prepared.artifacts.artifactBytes,
      provenanceSha256: prepared.artifacts.provenanceSha256,
    });
    assert.equal(value.image, image);
    assert.deepEqual(value.skillFiles, resources);
    assert.equal(value.skillTextSha256, hash(skillText));
    assert.equal(value.evaluationInputsSha256, evaluationInputsSha256(suite, rubric));
    assert.match(value.runId, /^[a-f0-9]{64}$/u);
    assert.equal(value.complete, true);
    assert.equal(value.unattemptedPairs, 0);
    assert.equal(value.repetitions, config.evaluation.repetitions);
    assert.ok(
      Number.isInteger(value.repetitions) && value.repetitions >= 1 && value.repetitions <= 20,
    );
    assert.equal(value.plannedPairs, suite.scenarios.length * value.repetitions);
    assert.ok(value.plannedPairs > 0);
    assert.equal(value.maximumModelCalls, value.plannedPairs * 11);
    assert.ok(Array.isArray(value.records));
    assert.equal(value.records.length, value.plannedPairs);
    const time = Date.parse(value.createdAt);
    const age = now.getTime() - time;
    assert.ok(Number.isFinite(age));
    assert.equal(new Date(time).toISOString(), value.createdAt);
    if (
      age < 0 ||
      age >=
        Math.min(config.quality.evidenceMaxAgeHours, NATIVE_REVIEW_POLICY.evidenceMaxAgeHours) *
          3_600_000
    )
      issues.add("tool.evidence.age");
    if (
      config.quality.readinessMinimum < NATIVE_REVIEW_POLICY.readinessMinimum ||
      config.evaluation.minimumSuccessRate < NATIVE_REVIEW_POLICY.minimumSuccessRate ||
      config.evaluation.minimumImpactDelta < NATIVE_REVIEW_POLICY.minimumImpactDelta ||
      config.evaluation.repetitions < NATIVE_REVIEW_POLICY.minimumRepetitions
    )
      issues.add("tool.policy.minimums");
    if (
      rubric.criteria.filter((c) => c.evaluator === "judge").reduce((sum, c) => sum + c.weight, 0) <
      65
    )
      issues.add("tool.rubric.judge_weight");
    const categories = new Set(suite.scenarios.map((s) => s.category));
    for (const category of suiteName === "training"
      ? (["positive", "near-miss", "failure", "adversarial"] as const)
      : (["positive", "near-miss"] as const))
      if (!categories.has(category)) issues.add("tool.scenarios.coverage");
    let baseline = 0;
    let withSkill = 0;
    for (const [index, scenario] of suite.scenarios.entries()) {
      let before = 0;
      let after = 0;
      for (let repetition = 1; repetition <= value.repetitions; repetition++) {
        const record: Measurement["records"][number] | undefined =
          value.records[index * value.repetitions + repetition - 1];
        assert.ok(record?.status === "passed");
        assert.equal(record.runId, hash(`${value.runId}:${index}:${repetition}`));
        assert.equal(record.scenarioId, scenario.id);
        assert.equal(record.repetition, repetition);
        const pair: Pair = record.pair;
        assert.equal(pair.kind, "skillpress.reviewed-tool-pair.v1");
        assert.equal(pair.execution, value.execution);
        assert.equal(pair.activationMeasurement, value.activationMeasurement);
        assert.equal(pair.releaseEligible, false);
        assert.equal(pair.image, image);
        assert.equal(pair.skillTextSha256, value.skillTextSha256);
        assert.deepEqual(pair.skillFiles, resources);
        const selectionPrompt = createTextSelectionPrompt(scenario, skillText);
        assert.deepEqual(pair.selection.prompt, selectionPrompt);
        receipt(pair.selection.response, selectionPrompt);
        assert.deepEqual(parseTextSelection(pair.selection.response.text), {
          selected: pair.selection.selected,
          rationale: pair.selection.rationale,
        });
        let calls = 3; // Selector and two fresh judges, plus both actors below.
        for (const arm of ["baseline", "withSkill"] as const) {
          const leg = pair[arm];
          const active = arm === "withSkill" && pair.selection.selected;
          assert.equal(leg.activated, active);
          assert.ok(
            assessReviewedToolTrajectory(leg.actor, {
              scenario,
              image,
              skillText: active ? skillText : null,
              skillFiles: active ? skillFiles : [],
            }).consistent,
          );
          calls += leg.actor.modelInvocations;
          const judgePrompt = createToolJudgePrompt(scenario, rubric, leg.actor);
          assert.deepEqual(leg.judgePrompt, judgePrompt);
          receipt(leg.judge, judgePrompt);
          assert.deepEqual(leg.criteria, parseTextJudgeScores(leg.judge.text, rubric));
          const score = recomputeRubricScore(
            active,
            arm === "baseline" ? false : scenario.shouldActivate,
            rubric.criteria,
            leg.criteria,
          );
          assert.notEqual(score, null);
          assert.equal(leg.score, score);
        }
        assert.equal(pair.modelInvocations, calls);
        const passed = pair.withSkill.score >= config.quality.readinessMinimum;
        before += Number(pair.baseline.score >= config.quality.readinessMinimum);
        after += Number(passed);
        if (
          scenario.category !== "positive" &&
          (!passed || pair.withSkill.activated !== scenario.shouldActivate)
        )
          issues.add("tool.safety.failed");
      }
      if (after < before) issues.add("tool.scenario.regression");
      baseline += before;
      withSkill += after;
    }
    const summary = {
      readinessMinimum: config.quality.readinessMinimum,
      baselineSuccessRate: baseline / value.plannedPairs,
      withSkillSuccessRate: withSkill / value.plannedPairs,
      impactDelta: (withSkill - baseline) / value.plannedPairs,
    };
    assert.deepEqual(value.summary, summary);
    const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
    const rate = round(summary.withSkillSuccessRate);
    if (rate < config.evaluation.minimumSuccessRate) issues.add("tool.success_rate.failed");
    if (round(rate - round(summary.baselineSuccessRate)) < config.evaluation.minimumImpactDelta)
      issues.add("tool.impact.failed");
  } catch {
    issues.add("tool.measurement.inconsistent");
  }
  return Object.freeze({
    passed: issues.size === 0,
    issues: Object.freeze([...issues]),
    advisory: true as const,
    independentVerificationRequired: true as const,
    releaseAuthorized: false as const,
  });
}
