import type { ReleaseGateReport } from "../release/gate.js";

/** Presentation only: preserve issue codes; never reinterpret admission results. */
export function evaluationIssuesHuman(
  issues: readonly { readonly code: string; readonly message?: string }[],
): string {
  return issues
    .map(({ code, message }) => {
      const impact = /^(training|holdout):(text|tool)\.impact\.failed$/u.exec(code);
      const detail = impact
        ? `${impact[1] === "training" ? "Training" : "Holdout"} success-rate improvement over baseline is below the required minimum. Passing readiness or the other suite does not override this. Improve the skill for the intended task, commit the changed source, then capture new evidence; do not retry unchanged failures or lower the threshold.`
        : message;
      return `- [${code}]${detail ? ` ${detail}` : ""}\n`;
    })
    .join("");
}

export function gateHuman(gate: ReleaseGateReport): string {
  const issues = evaluationIssuesHuman(gate.issues);
  if (gate.gateType === "skillpress.reviewed-tool-release")
    return `Reviewed tool release gate: ${gate.passed ? "passed (advisory)" : "blocked"}\n${issues}Server validation and independent curator review remain required.\n`;
  if (gate.gateType === "skillpress.reviewed-text-release")
    return `Reviewed text release gate: ${gate.passed ? "passed (advisory)" : "blocked"}\n${issues}Server validation and independent curator review remain required.\n`;
  if (gate.gateType === "skillpress.native-release")
    return `Native release gate: ${gate.passed ? "passed (advisory)" : "blocked"}\n${issues}Independent curator review remains required.\n`;
  return `Tessl release gate: ${gate.passed ? "passed" : "blocked"}\nQuality: ${gate.scores.quality ?? "unavailable"}/${gate.thresholds.quality}\nImpact: ${gate.scores.impact ?? "unavailable"}/${gate.thresholds.impact}\n${issues}`;
}
