import { createHash } from "node:crypto";

import type { SkillPressEvaluationRubric } from "./generated-rubric.js";
import type { SkillPressEvaluationSuite } from "./generated-suite.js";

/** Bind all evaluation semantics, not only the adapter's prompt and fixture. */
export function evaluationInputsSha256(
  suite: SkillPressEvaluationSuite,
  rubric: SkillPressEvaluationRubric,
): string {
  return createHash("sha256")
    .update(`${JSON.stringify({ suite, rubric })}\n`)
    .digest("hex");
}

/**
 * Recompute a weighted score from exact judge inputs. Deterministic criteria in
 * this protocol measure activation only; they do not assess transcript quality.
 * Callers must validate the rubric schema/weights before using this function.
 */
export function recomputeRubricScore(
  activated: boolean,
  expectedActivation: boolean,
  criteria: SkillPressEvaluationRubric["criteria"],
  scores: readonly { readonly id: string; readonly score: number }[],
): number | null {
  const judgeIds = new Set(
    criteria
      .filter((criterion) => criterion.evaluator === "judge")
      .map((criterion) => criterion.id),
  );
  const byId = new Map<string, number>();
  for (const entry of scores) {
    if (
      !judgeIds.has(entry.id) ||
      byId.has(entry.id) ||
      !Number.isFinite(entry.score) ||
      entry.score < 0 ||
      entry.score > 1
    ) {
      return null;
    }
    byId.set(entry.id, entry.score);
  }
  if (byId.size !== judgeIds.size) return null;
  const total = criteria.reduce((value, criterion) => {
    const score =
      criterion.evaluator === "deterministic"
        ? activated === expectedActivation
          ? 1
          : 0
        : (byId.get(criterion.id) as number);
    return value + criterion.weight * score;
  }, 0);
  return Math.round(total * 1_000_000) / 1_000_000;
}
