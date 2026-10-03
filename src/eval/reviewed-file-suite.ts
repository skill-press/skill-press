import { createHash, randomBytes } from "node:crypto";
import type { SkillPressToolFileSuite } from "./generated-tool-file-suite.js";
import { parseToolFileSuite } from "./tool-file-preview.js";
import {
  FILE_PAIR_MODEL_CALLS,
  runReviewedFilePair,
  validateReviewedFilePairInput,
  type FilePairEvent,
  type ReviewedFilePairInput,
} from "./reviewed-file-pair.js";
import { textSkillMetadata } from "./text-evaluation.js";

type Identity = { runId: string; scenarioId: string; repetition: number };
export type FileSuiteRecord = Identity &
  (
    | { status: "passed"; pair: Awaited<ReturnType<typeof runReviewedFilePair>> }
    | { status: "failed"; reason: "pair_execution_failed" }
  );
export interface ReviewedFileSuiteOptions {
  readonly suite: SkillPressToolFileSuite;
  readonly files: readonly { id: string; files: ReviewedFilePairInput["files"] }[];
  readonly rubric: ReviewedFilePairInput["rubric"];
  readonly skillText: string;
  readonly skillFiles: ReviewedFilePairInput["skillFiles"];
  readonly image: string;
  readonly repetitions: number;
  readonly readinessMinimum: number;
  readonly maxModelCalls: number;
  readonly onEvent: (identity: Identity, event: FilePairEvent) => Promise<void>;
  readonly onResult: (record: FileSuiteRecord) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** Serial, fully preflighted file pairs. Callbacks persist private checkpoints, not admission. */
export async function runReviewedFileSuite(options: ReviewedFileSuiteOptions) {
  const { onEvent, onResult, signal } = options;
  const {
    suite: rawSuite,
    files,
    rubric,
    skillText,
    skillFiles,
    image,
    repetitions,
    readinessMinimum,
    maxModelCalls,
  } = structuredClone({
    suite: options.suite,
    files: options.files,
    rubric: options.rubric,
    skillText: options.skillText,
    skillFiles: options.skillFiles,
    image: options.image,
    repetitions: options.repetitions,
    readinessMinimum: options.readinessMinimum,
    maxModelCalls: options.maxModelCalls,
  });
  if (typeof onEvent !== "function" || typeof onResult !== "function")
    throw new Error("File suite requires checkpoint persistence.");
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
    throw new Error("Invalid file suite repetitions.");
  if (!Number.isInteger(readinessMinimum) || readinessMinimum < 90 || readinessMinimum > 100)
    throw new Error("Invalid file suite readiness minimum.");
  const suite = parseToolFileSuite(rawSuite);
  if (textSkillMetadata(skillText).name !== suite.skill)
    throw new Error("File suite skill identity differs.");
  const plannedPairs = suite.scenarios.length * repetitions;
  const maximumModelCalls = plannedPairs * FILE_PAIR_MODEL_CALLS;
  if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < maximumModelCalls)
    throw new Error("File suite model call cap is insufficient.");
  if (
    files.length !== suite.scenarios.length ||
    files.some((entry, index) => entry.id !== suite.scenarios[index]?.id)
  )
    throw new Error("File suite scenario bytes differ.");
  const pairs = suite.scenarios.map((scenario, index) => ({
    scenario,
    suite: suite.suite,
    files: (files[index] as (typeof files)[number]).files,
    rubric,
    skillText,
    skillFiles,
    image,
  }));
  for (const pair of pairs) validateReviewedFilePairInput(pair);
  const runId = randomBytes(32).toString("hex");
  const createdAt = new Date().toISOString();
  const records: FileSuiteRecord[] = [];
  let stopped = false;
  for (const [index, input] of pairs.entries()) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const identity = {
        runId: createHash("sha256").update(`${runId}:${index}:${repetition}`).digest("hex"),
        scenarioId: input.scenario.id,
        repetition,
      };
      let record: FileSuiteRecord;
      let persistenceFailed = false;
      try {
        signal?.throwIfAborted();
        const pair = await runReviewedFilePair(
          input,
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
  return {
    schemaVersion: 1 as const,
    evidenceType: "skillpress.reviewed-file-suite" as const,
    runId,
    createdAt,
    suite,
    rubric,
    repetitions,
    image,
    plannedPairs,
    maximumModelCalls,
    skillTextSha256: createHash("sha256").update(skillText).digest("hex"),
    skillFiles: skillFiles.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.content).digest("hex"),
    })),
    unattemptedPairs: plannedPairs - records.length,
    complete,
    records,
    summary: complete
      ? {
          readinessMinimum,
          baselineSuccessRate: successes("baseline") / plannedPairs,
          withSkillSuccessRate: successes("withSkill") / plannedPairs,
          impactDelta: (successes("withSkill") - successes("baseline")) / plannedPairs,
        }
      : null,
    releaseEligible: false as const,
    ineligibilityReasons: ["file_profile_not_admitted", "artifact_binding_not_established"],
  };
}
