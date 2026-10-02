import { createHash, randomBytes } from "node:crypto";

import type { SkillPressEvaluationSuite } from "./generated-suite.js";
import { parseEvaluationRubric, parseEvaluationSuite } from "./load.js";
import { evaluationInputsSha256 } from "./measurement.js";
import { validateReviewedToolActorInput } from "./reviewed-tool-actor.js";
import { runReviewedToolPair, type ToolPairEvent } from "./reviewed-tool-pair.js";
import {
  createTextJudgePrompt,
  createTextSelectionPrompt,
  textSkillMetadata,
} from "./text-evaluation.js";

type PairInput = Parameters<typeof runReviewedToolPair>[0];
type Pair = Awaited<ReturnType<typeof runReviewedToolPair>>;
type Identity = { runId: string; scenarioId: string; repetition: number };
export type ToolSuiteRecord = Identity &
  ({ status: "passed"; pair: Pair } | { status: "failed"; reason: "pair_execution_failed" });
export interface ReviewedToolSuiteOptions {
  readonly suite: SkillPressEvaluationSuite;
  readonly rubric: PairInput["rubric"];
  readonly skillText: string;
  readonly skillFiles: PairInput["skillFiles"];
  readonly image: string;
  readonly repetitions: number;
  readonly readinessMinimum?: number;
  readonly onEvent: (identity: Identity, event: ToolPairEvent) => Promise<void>;
  readonly onResult: (result: ToolSuiteRecord) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** Uses the existing schemas, selector, rubric scoring and tool pair. No admission authority. */
export async function runReviewedToolSuite(options: ReviewedToolSuiteOptions) {
  const { onEvent, onResult, signal } = options;
  const suite = parseEvaluationSuite(structuredClone(options.suite));
  const rubric = parseEvaluationRubric(structuredClone(options.rubric));
  const skillFiles = structuredClone(options.skillFiles);
  const { skillText, image, repetitions } = options;
  const readinessMinimum = options.readinessMinimum ?? 90;
  if (typeof onEvent !== "function" || typeof onResult !== "function")
    throw new Error("Tool suite requires event and result persistence.");
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
    throw new Error("Tool suite repetitions must be an integer from 1 to 20.");
  if (!Number.isInteger(readinessMinimum) || readinessMinimum < 90 || readinessMinimum > 100)
    throw new Error("Tool suite readiness must be an integer from 90 to 100.");
  if (textSkillMetadata(skillText).name !== suite.skill)
    throw new Error("Tool suite skill name does not match the reviewed document.");
  for (const scenario of suite.scenarios) {
    validateReviewedToolActorInput({ scenario, image, skillText, skillFiles });
    createTextSelectionPrompt(scenario, skillText);
    createTextJudgePrompt(scenario, rubric, "Preflight", "task");
  }
  const runId = randomBytes(32).toString("hex");
  const createdAt = new Date().toISOString();
  const records: ToolSuiteRecord[] = [];
  const plannedPairs = suite.scenarios.length * repetitions;
  let stopped = false;
  for (const [index, scenario] of suite.scenarios.entries()) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const identity = {
        runId: createHash("sha256").update(`${runId}:${index}:${repetition}`).digest("hex"),
        scenarioId: scenario.id,
        repetition,
      };
      let record: ToolSuiteRecord;
      let persistenceFailed = false;
      try {
        signal?.throwIfAborted();
        const pair = await runReviewedToolPair(
          { scenario, rubric, image, skillText, skillFiles },
          async (event) => {
            try {
              await onEvent({ ...identity }, structuredClone(event));
            } catch (error) {
              persistenceFailed = true;
              throw error;
            }
          },
          signal,
        );
        record = { ...identity, status: "passed", pair };
      } catch (error) {
        if (persistenceFailed) throw error;
        record = { ...identity, status: "failed", reason: "pair_execution_failed" };
        stopped = true;
      }
      records.push(record);
      await onResult(structuredClone(record));
      if (stopped) break;
    }
    if (stopped) break;
  }
  const complete = !stopped && records.length === plannedPairs;
  const successes = (arm: "baseline" | "withSkill") =>
    records.filter(
      (record) => record.status === "passed" && record.pair[arm].score >= readinessMinimum,
    ).length;
  return Object.freeze({
    schemaVersion: 1 as const,
    evidenceType: "skillpress.reviewed-tool-suite" as const,
    execution: "host-networked-model-isolated-python" as const,
    activationMeasurement: "harness-metadata-selection" as const,
    runId,
    createdAt,
    suite,
    rubric,
    repetitions,
    image,
    evaluationInputsSha256: evaluationInputsSha256(suite, rubric),
    skillTextSha256: createHash("sha256").update(skillText).digest("hex"),
    skillFiles: skillFiles.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.content).digest("hex"),
    })),
    plannedPairs,
    maximumModelCalls: plannedPairs * 11,
    unattemptedPairs: plannedPairs - records.length,
    complete,
    records: Object.freeze(records),
    summary: complete
      ? Object.freeze({
          readinessMinimum,
          baselineSuccessRate: successes("baseline") / plannedPairs,
          withSkillSuccessRate: successes("withSkill") / plannedPairs,
          impactDelta: (successes("withSkill") - successes("baseline")) / plannedPairs,
        })
      : null,
    releaseEligible: false as const,
    ineligibilityReasons: Object.freeze([
      "tool_profile_not_admitted",
      "artifact_binding_not_established",
    ]),
  });
}
