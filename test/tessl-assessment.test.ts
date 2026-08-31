import { describe, expect, it } from "vitest";

import { tesslSolutionAssessment } from "../src/tessl/assessment.js";

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
    expect(tesslSolutionAssessment(solution())).toEqual({ score: 95, criticalPassed: true });
    expect(tesslSolutionAssessment(solution(39, 60))).toEqual({
      score: 99,
      criticalPassed: false,
    });
  });

  it.each([
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
});
