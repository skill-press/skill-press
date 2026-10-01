import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Ajv } from "ajv";

import type { SkillPressProject } from "../config/generated.js";
import type { SkillPressPairedEvaluationEvidence } from "../eval/generated-evidence.js";
import type { ProjectEvaluationInputs } from "../eval/load.js";
import { evaluationInputsSha256, recomputeRubricScore } from "../eval/measurement.js";
import { improvementEvidenceMetrics } from "../improve/project-input.js";
import { NATIVE_REVIEW_POLICY } from "./native-policy.js";

const schema = JSON.parse(
  await readFile(new URL("../../schemas/eval-evidence.schema.json", import.meta.url), "utf8"),
) as object;
const validate = new Ajv({
  allErrors: true,
  strict: true,
}).compile<SkillPressPairedEvaluationEvidence>(schema);
const PINNED_IMAGE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/u;

export interface NativeMeasurementAssessment {
  readonly passed: boolean;
  readonly issues: readonly string[];
}

/**
 * Assess current, schema-validated project inputs against author-supplied results.
 * This proves consistency and policy compliance, never independent execution.
 * Historical evidence without run-time semantic binding is deliberately rejected.
 */
export function assessNativeMeasurement(
  value: unknown,
  config: SkillPressProject,
  inputs: ProjectEvaluationInputs,
  suiteName: "training" | "holdout",
  skillSha256: string,
  now: Date,
): NativeMeasurementAssessment {
  const issues: string[] = [];
  const fail = (code: string) => {
    issues.push(code);
  };
  if (!validate(value)) return { passed: false, issues: ["native.evidence.schema"] };
  const suite = inputs[suiteName];
  const rubric = inputs.rubric;
  if (value.evaluationInputsSha256 !== evaluationInputsSha256(suite, rubric))
    fail("native.inputs.binding");
  if (!value.evidenceEligible || value.ineligibilityReasons.length !== 0)
    fail("native.execution.ineligible");
  if (!PINNED_IMAGE.test(value.adapter.image)) fail("native.adapter.unpinned");
  if (value.adapter.backend !== config.evaluation.sandbox) fail("native.adapter.backend");
  if (config.evaluation.network !== "none") fail("native.execution.network");
  const time = Date.parse(value.createdAt);
  const age = now.getTime() - time;
  if (
    !Number.isFinite(age) ||
    new Date(time).toISOString() !== value.createdAt ||
    age < 0 ||
    age >=
      Math.min(config.quality.evidenceMaxAgeHours, NATIVE_REVIEW_POLICY.evidenceMaxAgeHours) *
        3_600_000
  )
    fail("native.evidence.age");
  if (
    config.quality.readinessMinimum < NATIVE_REVIEW_POLICY.readinessMinimum ||
    config.evaluation.minimumSuccessRate < NATIVE_REVIEW_POLICY.minimumSuccessRate ||
    config.evaluation.minimumImpactDelta < NATIVE_REVIEW_POLICY.minimumImpactDelta ||
    config.evaluation.repetitions < NATIVE_REVIEW_POLICY.minimumRepetitions
  )
    fail("native.policy.minimums");
  // Prevent activation-only rubrics from qualifying as behavioral quality.
  if (
    rubric.criteria
      .filter((criterion) => criterion.evaluator === "judge")
      .reduce((weight, criterion) => weight + criterion.weight, 0) < 65
  )
    fail("native.rubric.judge_weight");
  const metrics = improvementEvidenceMetrics(value, suite, suiteName, skillSha256, {
    project: { name: config.project.name, version: config.project.version },
    model: value.model,
    adapter: value.adapter,
    configSha256: createHash("sha256")
      .update(`${JSON.stringify(config)}\n`)
      .digest("hex"),
    repetitions: config.evaluation.repetitions,
    readinessMinimum: config.quality.readinessMinimum,
    minimumSuccessRate: config.evaluation.minimumSuccessRate,
    minimumImpactDelta: config.evaluation.minimumImpactDelta,
  });
  if (metrics === null) fail("native.measurement.inconsistent");
  if (!value.summary.behavioralGatePassed) fail("native.behavior.failed");
  const runIds = new Set<string>();
  for (const [index, scenario] of value.scenarioResults.entries()) {
    let baselineSuccesses = 0;
    let skillSuccesses = 0;
    for (const run of scenario.runs) {
      for (const [variant, leg] of [
        ["baseline", run.baseline],
        ["with-skill", run.withSkill],
      ] as const) {
        if (runIds.has(leg.runId)) fail("native.run.duplicate");
        runIds.add(leg.runId);
        const score =
          leg.criterionScores === undefined || leg.activated === null
            ? null
            : recomputeRubricScore(
                leg.activated,
                variant === "baseline" ? false : scenario.expectedActivation,
                rubric.criteria,
                leg.criterionScores,
              );
        if (score === null || score !== leg.rubricScore) fail("native.rubric.score");
      }
      if (run.baseline.successful) baselineSuccesses += 1;
      if (run.withSkill.successful) skillSuccesses += 1;
      const category = suite.scenarios[index]?.category;
      if (
        (category === "near-miss" || category === "adversarial" || category === "failure") &&
        (!run.withSkill.successful || run.withSkill.activated !== scenario.expectedActivation)
      )
        fail("native.safety.failed");
    }
    if (skillSuccesses < baselineSuccesses) fail("native.scenario.regression");
  }
  return Object.freeze({
    passed: issues.length === 0,
    issues: Object.freeze([...new Set(issues)]),
  });
}
