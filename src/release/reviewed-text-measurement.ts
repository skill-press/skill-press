import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  CODE_MODE_DISABLED_DIAGNOSTIC,
  MAX_CODEX_TRANSCRIPT_BYTES,
} from "../eval/codex-transcript.js";
import { evaluationInputsSha256, recomputeRubricScore } from "../eval/measurement.js";
import type {
  prepareReviewedTextProject,
  runPreparedReviewedTextSuite,
} from "../eval/reviewed-text-project.js";
import {
  createTextActorPrompt,
  createTextJudgePrompt,
  createTextSelectionPrompt,
  parseTextJudgeScores,
  parseTextSelection,
  type TextEvaluationPrompt,
} from "../eval/text-evaluation.js";
import { NATIVE_REVIEW_POLICY } from "./native-policy.js";

type Prepared = Awaited<ReturnType<typeof prepareReviewedTextProject>>;
type Measurement = Awaited<ReturnType<typeof runPreparedReviewedTextSuite>>;
type PassedRecord = Extract<Measurement["records"][number], { status: "passed" }>;
type Receipt = PassedRecord["pair"]["baseline"]["actor"];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function receipt(value: Receipt, prompt: TextEvaluationPrompt): void {
  assert.equal(typeof value.text, "string");
  assert.ok(value.text.trim() && Buffer.byteLength(value.text) <= MAX_CODEX_TRANSCRIPT_BYTES);
  assert.equal(value.inputSha256, prompt.sha256);
  assert.equal(value.outputSha256, hash(value.text));
  assert.equal(value.requestedModel, "gpt-6.1-sol");
  assert.equal(value.effort, "medium");
  assert.equal(value.authentication, "forced-chatgpt");
  assert.equal(value.cliVersion, "0.160.0");
  assert.equal(value.execution, "reviewed-host-text-pilot");
  assert.equal(value.releaseEligible, false);
  assert.ok(Array.isArray(value.diagnostics));
  assert.ok(value.diagnostics.length <= 1);
  assert.ok(value.diagnostics.every((entry) => entry === CODE_MODE_DISABLED_DIAGNOSTIC));
  for (const count of [
    value.usage.inputTokens,
    value.usage.cachedInputTokens,
    value.usage.outputTokens,
  ])
    assert.ok(Number.isSafeInteger(count) && count >= 0);
  assert.ok(value.usage.cachedInputTokens <= value.usage.inputTokens);
  assert.ok(Number.isFinite(value.durationMs) && value.durationMs >= 0);
}

/**
 * Recompute parsed JSON receipts against a freshly prepared, trusted project.
 * Consistency and behavioral quality only, never execution attestation or release
 * admission. File ingestion must enforce its size limit before parsing JSON.
 * The caller owns entry/exit source verification; this function does no I/O.
 */
export function assessReviewedTextMeasurement(
  input: unknown,
  prepared: Prepared,
  suiteName: "training" | "holdout",
  now: Date = new Date(),
) {
  const issues = new Set<string>();
  try {
    // All fields consumed below are checked at runtime; malformed JSON fails closed.
    const value = input as Measurement;
    const { config, inputs, skillText } = prepared;
    const suite = inputs[suiteName];
    const rubric = inputs.rubric;
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.evidenceType, "skillpress.reviewed-text-suite");
    assert.equal(value.execution, "host-networked-text");
    assert.equal(value.activationMeasurement, "harness-metadata-selection");
    assert.equal(value.releaseEligible, false);
    assert.deepEqual(value.ineligibilityReasons, ["text_profile_not_admitted"]);
    assert.deepEqual(value.source, prepared.source);
    assert.deepEqual(value.config, config);
    assert.deepEqual(value.suite, suite);
    assert.deepEqual(value.rubric, rubric);
    assert.deepEqual(value.artifact, {
      sha256: prepared.artifacts.artifactSha256,
      bytes: prepared.artifacts.artifactBytes,
      provenanceSha256: prepared.artifacts.provenanceSha256,
    });
    assert.equal(value.skillTextSha256, hash(skillText));
    assert.equal(value.evaluationInputsSha256, evaluationInputsSha256(suite, rubric));
    assert.equal(typeof value.runId, "string");
    assert.match(value.runId, /^[a-f0-9]{64}$/u);
    assert.equal(value.complete, true);
    assert.equal(value.unattemptedPairs, 0);
    assert.equal(value.repetitions, config.evaluation.repetitions);
    assert.ok(
      Number.isInteger(value.repetitions) && value.repetitions >= 1 && value.repetitions <= 20,
    );
    assert.equal(value.plannedPairs, suite.scenarios.length * value.repetitions);
    assert.ok(Array.isArray(value.records));
    assert.equal(value.records.length, value.plannedPairs);

    assert.equal(typeof value.createdAt, "string");
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
      issues.add("text.evidence.age");
    if (
      config.quality.readinessMinimum < NATIVE_REVIEW_POLICY.readinessMinimum ||
      config.evaluation.minimumSuccessRate < NATIVE_REVIEW_POLICY.minimumSuccessRate ||
      config.evaluation.minimumImpactDelta < NATIVE_REVIEW_POLICY.minimumImpactDelta ||
      config.evaluation.repetitions < NATIVE_REVIEW_POLICY.minimumRepetitions
    )
      issues.add("text.policy.minimums");
    if (
      rubric.criteria
        .filter((entry) => entry.evaluator === "judge")
        .reduce((sum, entry) => sum + entry.weight, 0) < 65
    )
      issues.add("text.rubric.judge_weight");
    const categories = new Set(suite.scenarios.map((scenario) => scenario.category));
    for (const category of suiteName === "training"
      ? ["positive", "near-miss", "failure", "adversarial"]
      : ["positive", "near-miss"])
      if (!categories.has(category as (typeof suite.scenarios)[number]["category"]))
        issues.add("text.scenarios.coverage");

    let baselineSuccesses = 0;
    let withSkillSuccesses = 0;
    for (const [index, scenario] of suite.scenarios.entries()) {
      assert.equal(scenario.fixture?.environment, undefined);
      let before = 0;
      let after = 0;
      for (let repetition = 1; repetition <= value.repetitions; repetition++) {
        const record: Measurement["records"][number] | undefined =
          value.records[index * value.repetitions + repetition - 1];
        assert.ok(record?.status === "passed");
        assert.equal(record.runId, hash(`${value.runId}:${index}:${repetition}`));
        assert.equal(record.scenarioId, scenario.id);
        assert.equal(record.repetition, repetition);
        const pair: PassedRecord["pair"] = record.pair;
        assert.equal(pair.kind, "skillpress.reviewed-selected-text-pair-pilot");
        assert.equal(pair.modelInvocations, 5);
        assert.equal(pair.releaseEligible, false);
        assert.equal(pair.activationMeasurement, "harness-metadata-selection");
        assert.equal(pair.skillTextSha256, value.skillTextSha256);
        receipt(pair.selection, createTextSelectionPrompt(scenario, skillText));
        assert.deepEqual(parseTextSelection(pair.selection.text), {
          selected: pair.selection.selected,
          rationale: pair.selection.rationale,
        });
        assert.equal(pair.baseline.activated, false);
        assert.equal(pair.withSkill.activated, pair.selection.selected);
        for (const arm of ["baseline", "withSkill"] as const) {
          const leg = pair[arm];
          receipt(
            leg.actor,
            createTextActorPrompt(
              scenario,
              arm === "withSkill" && pair.selection.selected ? skillText : null,
            ),
          );
          receipt(leg.judge, createTextJudgePrompt(scenario, rubric, leg.actor.text));
          assert.deepEqual(leg.criteria, parseTextJudgeScores(leg.judge.text, rubric));
          const score = recomputeRubricScore(
            leg.activated,
            arm === "baseline" ? false : scenario.shouldActivate,
            rubric.criteria,
            leg.criteria,
          );
          assert.notEqual(score, null);
          assert.equal(record[`${arm}Score`], score);
        }
        const baselinePassed = record.baselineScore >= config.quality.readinessMinimum;
        const skillPassed = record.withSkillScore >= config.quality.readinessMinimum;
        before += Number(baselinePassed);
        after += Number(skillPassed);
        if (
          scenario.category !== "positive" &&
          (!skillPassed || pair.withSkill.activated !== scenario.shouldActivate)
        )
          issues.add("text.safety.failed");
      }
      if (after < before) issues.add("text.scenario.regression");
      baselineSuccesses += before;
      withSkillSuccesses += after;
    }
    const summary = {
      readinessMinimum: config.quality.readinessMinimum,
      baselineSuccessRate: baselineSuccesses / value.plannedPairs,
      withSkillSuccessRate: withSkillSuccesses / value.plannedPairs,
      impactDelta: (withSkillSuccesses - baselineSuccesses) / value.plannedPairs,
    };
    assert.deepEqual(value.summary, summary);
    // Preserve raw historical text summaries, but apply the existing native
    // six-decimal rate-then-difference semantics at the policy boundary.
    const rounded = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
    const baselineRate = rounded(summary.baselineSuccessRate);
    const skillRate = rounded(summary.withSkillSuccessRate);
    const impact = rounded(skillRate - baselineRate);
    if (skillRate < config.evaluation.minimumSuccessRate) issues.add("text.success_rate.failed");
    if (impact < config.evaluation.minimumImpactDelta) issues.add("text.impact.failed");
  } catch {
    // Never echo author-supplied/provider data from assertion or parser failures.
    issues.add("text.measurement.inconsistent");
  }
  return Object.freeze({
    passed: issues.size === 0,
    issues: Object.freeze([...issues]),
    advisory: true as const,
    independentVerificationRequired: true as const,
    releaseAuthorized: false as const,
  });
}
