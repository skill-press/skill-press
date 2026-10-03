import { describe, expect, it } from "vitest";
import { evaluationIssuesHuman } from "../src/cli/release-output.js";

describe("human evaluation failure guidance", () => {
  it.each([
    ["training", "text"],
    ["holdout", "text"],
    ["training", "tool"],
    ["holdout", "tool"],
  ])("explains %s %s impact without inventing a numeric score", (suite, profile) => {
    const code = `${suite}:${profile}.impact.failed`;
    const issues = Object.freeze([Object.freeze({ code, message: "Policy failed." })]);
    const output = evaluationIssuesHuman(issues);
    expect(output).toContain(`[${code}]`);
    expect(output).toContain(`${suite === "training" ? "Training" : "Holdout"} success-rate`);
    expect(output).toContain("below the required minimum");
    expect(output).toContain("commit the changed source");
    expect(output).toContain("do not retry unchanged failures or lower the threshold");
    expect(output).not.toMatch(/\d/u);
    expect(issues[0]).toEqual({ code, message: "Policy failed." });
  });

  it("preserves other codes/messages without guessing their cause", () => {
    expect(
      evaluationIssuesHuman([
        { code: "training:tool.measurement.inconsistent", message: "Check receipt bindings." },
        { code: "future.unknown" },
        { code: "training:tool.impact.failed.extra" },
      ]),
    ).toBe(
      "- [training:tool.measurement.inconsistent] Check receipt bindings.\n" +
        "- [future.unknown]\n- [training:tool.impact.failed.extra]\n",
    );
    expect(evaluationIssuesHuman([])).toBe("");
  });
});
