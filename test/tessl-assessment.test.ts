import { describe, expect, it } from "vitest";

import {
  tesslRubricUsageMatches,
  tesslSolutionAssessment,
  tesslSolutionRunsMatch,
} from "../src/tessl/assessment.js";

function solution(criticalScore = 40, qualityScore = 55): Record<string, unknown> {
  return {
    assessmentResults: [
      { name: "critical_release_safety", score: criticalScore, max_score: 40 },
      { name: "quality", score: qualityScore, max_score: 60 },
    ],
  };
}

describe("Tessl weighted checklist assessment", () => {
  it("returns the normalized score only with a full critical criterion", () => {
    expect(tesslSolutionAssessment(solution())).toMatchObject({
      score: 95,
      criticalPassed: true,
    });
    expect(tesslSolutionAssessment(solution(39, 60))).toMatchObject({
      score: 99,
      criticalPassed: false,
    });
  });

  it("binds a solution to the exact number of completed provider runs", () => {
    expect(
      tesslSolutionRunsMatch(
        { runs: [{ status: "completed" }, { status: "completed" }, { status: "completed" }] },
        3,
      ),
    ).toBe(true);
    expect(tesslSolutionRunsMatch({ runs: [{ status: "completed" }] }, 3)).toBe(false);
    expect(
      tesslSolutionRunsMatch(
        { runs: [{ status: "completed" }, { status: "failed" }, { status: "completed" }] },
        3,
      ),
    ).toBe(false);
  });

  it.each([
    null,
    { assessmentResults: [] },
    {
      assessmentResults: [{ name: "quality", score: 100, max_score: 100 }],
    },
    {
      assessmentResults: [
        { name: "critical_safety", score: 40, max_score: 40 },
        { name: "quality", score: 50, max_score: 50 },
      ],
    },
    {
      assessmentResults: [
        { name: "critical_safety", score: 40, max_score: 40 },
        { name: "critical_safety", score: 60, max_score: 60 },
      ],
    },
    {
      assessmentResults: [
        { score: 40, max_score: 40 },
        { name: "quality", score: 60, max_score: 60 },
      ],
    },
  ])("rejects an unsafe or malformed checklist", (value) => {
    expect(tesslSolutionAssessment(value)).toBeUndefined();
  });

  it("matches only the exact source criterion names, weights, and order", () => {
    const expected = tesslSolutionAssessment(solution())?.inventoryKey as string;
    const keys = [
      {
        name: "placeholder",
        value: {
          assessmentResults: [
            { name: "critical_placeholder", score: 1, max_score: 1 },
            { name: "quality", score: 99, max_score: 99 },
          ],
        },
      },
      {
        name: "weight drift",
        value: {
          assessmentResults: [
            { name: "critical_release_safety", score: 1, max_score: 1 },
            { name: "quality", score: 99, max_score: 99 },
          ],
        },
      },
      {
        name: "missing and extra",
        value: {
          assessmentResults: [
            { name: "critical_release_safety", score: 40, max_score: 40 },
            { name: "other", score: 60, max_score: 60 },
          ],
        },
      },
      {
        name: "reordered",
        value: {
          assessmentResults: [
            { name: "quality", score: 60, max_score: 60 },
            { name: "critical_release_safety", score: 40, max_score: 40 },
          ],
        },
      },
    ];
    for (const entry of keys) {
      const observed = tesslSolutionAssessment(entry.value)?.inventoryKey as string;
      expect(tesslRubricUsageMatches([observed], [expected]), entry.name).toBe(false);
    }
    expect(tesslRubricUsageMatches([expected, expected], [expected])).toBe(true);
    expect(tesslRubricUsageMatches([expected, expected], [expected], 2)).toBe(true);
    expect(tesslRubricUsageMatches([expected, expected], [expected], 3)).toBe(false);
    expect(tesslRubricUsageMatches([], [])).toBe(false);
    expect(tesslRubricUsageMatches([], [expected])).toBe(false);
    const second = tesslSolutionAssessment({
      assessmentResults: [{ name: "critical_other", score: 100, max_score: 100 }],
    })?.inventoryKey as string;
    expect(tesslRubricUsageMatches([expected, expected, second], [expected, second])).toBe(false);
  });
});
