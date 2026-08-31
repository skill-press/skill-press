const CRITICAL_PREFIX = "critical_";
const CRITERION_NAME = /^[a-z][a-z0-9_]{0,99}$/u;

export interface TesslSolutionAssessment {
  readonly score: number;
  readonly criticalPassed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate and score Tessl's returned weighted checklist.
 *
 * Release evaluation checklists are normalized to 100 points and must contain at least one
 * explicitly named `critical_*` criterion. Critical criteria are conjunctive release invariants:
 * every one must receive full credit in the with-context solution.
 */
export function tesslSolutionAssessment(value: unknown): TesslSolutionAssessment | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.assessmentResults) ||
    value.assessmentResults.length === 0
  ) {
    return undefined;
  }
  let earned = 0;
  let maximum = 0;
  let criticalCount = 0;
  let criticalPassed = true;
  const names = new Set<string>();
  for (const criterion of value.assessmentResults) {
    if (
      !isRecord(criterion) ||
      typeof criterion.name !== "string" ||
      !CRITERION_NAME.test(criterion.name) ||
      names.has(criterion.name) ||
      !Number.isFinite(criterion.score) ||
      !Number.isFinite(criterion.max_score) ||
      Number(criterion.score) < 0 ||
      Number(criterion.max_score) <= 0 ||
      Number(criterion.score) > Number(criterion.max_score)
    ) {
      return undefined;
    }
    names.add(criterion.name);
    earned += Number(criterion.score);
    maximum += Number(criterion.max_score);
    if (criterion.name.startsWith(CRITICAL_PREFIX)) {
      criticalCount += 1;
      if (Number(criterion.score) !== Number(criterion.max_score)) criticalPassed = false;
    }
  }
  if (maximum !== 100 || criticalCount === 0) return undefined;
  return Object.freeze({ score: Math.round(earned), criticalPassed });
}
