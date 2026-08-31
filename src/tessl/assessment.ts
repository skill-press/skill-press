const CRITICAL_PREFIX = "critical_";
const CRITERION_NAME = /^[a-z][a-z0-9_]{0,99}$/u;

/** Exact solution variants returned by the pinned official Tessl 0.101.0 eval protocol. */
export const TESSL_BASELINE_VARIANT = "baseline";
export const TESSL_CONTEXT_VARIANT = "usage-spec";

export interface TesslSolutionAssessment {
  readonly score: number;
  readonly criticalPassed: boolean;
  readonly inventoryKey: string;
}

/** Bind a provider solution to the exact requested set of completed Tessl repetitions. */
export function tesslSolutionRunsMatch(value: unknown, expectedRepetitions: number): boolean {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(expectedRepetitions) ||
    expectedRepetitions < 1 ||
    !Array.isArray(value.runs) ||
    value.runs.length !== expectedRepetitions
  ) {
    return false;
  }
  return value.runs.every((run) => isRecord(run) && run.status === "completed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate and score Tessl's returned weighted checklist.
 *
 * Release evaluation checklists are normalized to 100 points and must contain at least one
 * explicitly named `critical_*` criterion. Critical criteria are conjunctive release invariants:
 * every one must receive full credit in the contextual usage-spec solution.
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
  const inventory: Array<readonly [string, number]> = [];
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
    const score = Number(criterion.score);
    const maxScore = Number(criterion.max_score);
    inventory.push([criterion.name, maxScore]);
    earned += score;
    maximum += maxScore;
    if (criterion.name.startsWith(CRITICAL_PREFIX)) {
      criticalCount += 1;
      if (score !== maxScore) criticalPassed = false;
    }
  }
  if (maximum !== 100 || criticalCount === 0) return undefined;
  return Object.freeze({
    score: Math.round(earned),
    criticalPassed,
    inventoryKey: JSON.stringify(inventory),
  });
}

/** Match returned scenario rubric inventories to the exact source inventories and repeat count. */
export function tesslRubricUsageMatches(
  observed: readonly string[],
  expected: readonly string[],
  expectedRepetitions?: number,
): boolean {
  if (
    expectedRepetitions !== undefined &&
    (!Number.isSafeInteger(expectedRepetitions) || expectedRepetitions < 1)
  ) {
    return false;
  }
  if (expected.length === 0 || observed.length < expected.length) return false;
  const expectedCounts = new Map<string, number>();
  const observedCounts = new Map<string, number>();
  for (const inventory of expected)
    expectedCounts.set(inventory, (expectedCounts.get(inventory) ?? 0) + 1);
  for (const inventory of observed) {
    if (!expectedCounts.has(inventory)) return false;
    observedCounts.set(inventory, (observedCounts.get(inventory) ?? 0) + 1);
  }
  let repetition: number | undefined;
  for (const [inventory, expectedCount] of expectedCounts) {
    const observedCount = observedCounts.get(inventory) ?? 0;
    if (observedCount === 0 || observedCount % expectedCount !== 0) return false;
    const current = observedCount / expectedCount;
    if (repetition === undefined) repetition = current;
    else if (repetition !== current) return false;
  }
  return (
    repetition !== undefined &&
    (expectedRepetitions === undefined || repetition === expectedRepetitions)
  );
}
