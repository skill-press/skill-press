import { createHash, randomBytes } from "node:crypto";

import { runReviewedSelectedTextPair } from "./codex-text.js";
import type { SkillPressEvaluationRubric } from "./generated-rubric.js";
import type { SkillPressEvaluationSuite } from "./generated-suite.js";
import { parseEvaluationRubric, parseEvaluationSuite } from "./load.js";
import { evaluationInputsSha256, recomputeRubricScore } from "./measurement.js";
import {
  createTextActorPrompt,
  createTextSelectionPrompt,
  textSkillMetadata,
} from "./text-evaluation.js";

type Pair = Awaited<ReturnType<typeof runReviewedSelectedTextPair>>;
type PairRecord = Readonly<
  {
    runId: string;
    scenarioId: string;
    repetition: number;
  } & (
    | { status: "passed"; pair: Pair; baselineScore: number; withSkillScore: number }
    | { status: "failed"; reason: "pair_execution_failed" }
  )
>;

export interface ReviewedTextSuiteOptions {
  readonly suite: SkillPressEvaluationSuite;
  readonly rubric: SkillPressEvaluationRubric;
  readonly skillText: string;
  readonly repetitions: number;
  /** Persist each completed/failed pair before the next inference. Failure stops the run. */
  readonly onResult: (result: PairRecord) => Promise<void>;
  readonly signal?: AbortSignal;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Reviewed first-party synthetic text only. No tools, script execution or release admission.
 * This profile names host inference honestly; it is not network-none container evidence.
 * Callers review all inputs before invocation and persist the final returned manifest.
 */
export async function runReviewedTextSuite(options: ReviewedTextSuiteOptions) {
  // Snapshot before awaiting, so caller edits cannot change the reviewed batch mid-run.
  const suite = parseEvaluationSuite(structuredClone(options.suite));
  const rubric = parseEvaluationRubric(structuredClone(options.rubric));
  const { skillText, repetitions, onResult, signal } = options;
  if (typeof onResult !== "function")
    throw new Error("Text suite requires a result persistence callback.");
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
    throw new Error("Text suite repetitions must be an integer from 1 to 20.");
  if (textSkillMetadata(skillText).name !== suite.skill)
    throw new Error("Text suite skill name does not match the reviewed document.");
  for (const scenario of suite.scenarios) {
    if (scenario.fixture?.environment !== undefined)
      throw new Error("Text suites cannot apply fixture environment variables.");
    createTextSelectionPrompt(scenario, skillText);
    createTextActorPrompt(scenario, skillText);
    createTextActorPrompt(scenario, null);
  }
  const runId = randomBytes(32).toString("hex");
  const createdAt = new Date().toISOString();
  const records: PairRecord[] = [];
  const plannedPairs = suite.scenarios.length * repetitions;
  let stopped = false;
  for (const [index, scenario] of suite.scenarios.entries()) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const identity = {
        runId: hash(`${runId}:${index}:${repetition}`),
        scenarioId: scenario.id,
        repetition,
      };
      let record: PairRecord;
      try {
        signal?.throwIfAborted();
        const pair = await runReviewedSelectedTextPair(scenario, rubric, skillText, signal);
        const baselineScore = recomputeRubricScore(
          false,
          false,
          rubric.criteria,
          pair.baseline.criteria,
        );
        const withSkillScore = recomputeRubricScore(
          pair.withSkill.activated,
          scenario.shouldActivate,
          rubric.criteria,
          pair.withSkill.criteria,
        );
        if (baselineScore === null || withSkillScore === null)
          throw new Error("Invalid pair scores.");
        record = Object.freeze({
          ...identity,
          status: "passed",
          pair,
          baselineScore,
          withSkillScore,
        });
      } catch {
        // Never persist raw provider errors; failed/aborted pairs are not silently retried.
        record = Object.freeze({ ...identity, status: "failed", reason: "pair_execution_failed" });
        stopped = true;
      }
      records.push(record);
      await onResult(record);
      if (stopped) break;
    }
    if (stopped) break;
  }
  const complete = !stopped && records.length === plannedPairs;
  const successes = (arm: "baselineScore" | "withSkillScore") =>
    records.filter((record) => record.status === "passed" && record[arm] >= 90).length;
  return Object.freeze({
    schemaVersion: 1 as const,
    evidenceType: "skillpress.reviewed-text-suite" as const,
    execution: "host-networked-text" as const,
    activationMeasurement: "harness-metadata-selection" as const,
    runId,
    createdAt,
    suite,
    rubric,
    repetitions,
    evaluationInputsSha256: evaluationInputsSha256(suite, rubric),
    skillTextSha256: hash(skillText),
    plannedPairs,
    unattemptedPairs: plannedPairs - records.length,
    complete,
    records: Object.freeze(records),
    // Do not report partial success rates as if the missing/failed runs passed.
    summary: complete
      ? Object.freeze({
          readinessMinimum: 90,
          baselineSuccessRate: successes("baselineScore") / plannedPairs,
          withSkillSuccessRate: successes("withSkillScore") / plannedPairs,
          impactDelta: (successes("withSkillScore") - successes("baselineScore")) / plannedPairs,
        })
      : null,
    releaseEligible: false as const,
    ineligibilityReasons: Object.freeze([
      "text_profile_not_admitted",
      "artifact_binding_not_established",
    ]),
  });
}
