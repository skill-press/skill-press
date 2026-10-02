import type { CliExitCode, CliIo } from "../cli.js";
import { isSafePathInput } from "../path-safety.js";
import { checkNativeEvaluation } from "../release/native-check.js";
import { checkReviewedTextEvaluation } from "../release/reviewed-text-check.js";

export const NATIVE_CHECK_HELP = `Assess native training/holdout evidence without Tessl.

Usage:
  skpress eval-check --training-evidence <file> --holdout-evidence <file> [--project <directory>] [--reviewed-text] [--json]

Evidence must come from complete digest-pinned paired runs of the current project.
The report checks readiness, source/input bindings, per-criterion scores, success
rates, impact, safety and freshness. Author results remain advisory. This command
does not execute models, authorize release or replace independent curator review.
Historical runs missing semantic binding or criterion scores must be rerun.

--reviewed-text checks source-bound, reviewed first-party text measurements instead
of container runs. Store each suite at .skill-press/runs/<run-id>/evidence.json
with private file/directory permissions. It rebuilds a private package and verifies
the current committed source at entry/exit, without invoking models or project
commands. This check does not grant release eligibility. Use package/submit with
--reviewed-text for the separate submission gate; never relabel these receipts as
container-native evidence. This is not an untrusted-skill sandbox.
`;

export async function runNativeCheckCommand(
  args: readonly string[],
  io: CliIo,
): Promise<CliExitCode> {
  const values = new Map<string, string>();
  let json = false;
  let reviewedText = false;
  try {
    for (let index = 0; index < args.length; index += 1) {
      const flag = args[index] as string;
      if (flag === "--reviewed-text" && !reviewedText) {
        reviewedText = true;
        continue;
      }
      if (flag === "--json" && !json) {
        json = true;
        continue;
      }
      if (
        !["--project", "--training-evidence", "--holdout-evidence"].includes(flag) ||
        values.has(flag)
      )
        throw new Error("Unknown or duplicate eval-check option.");
      const value = args[++index];
      if (value === undefined || value.startsWith("--") || !isSafePathInput(value))
        throw new Error("eval-check options require valid paths.");
      values.set(flag, value);
    }
    if (!values.has("--training-evidence") || !values.has("--holdout-evidence"))
      throw new Error("Both training and holdout evidence paths are required.");
  } catch (error) {
    try {
      await io.stderr(
        `${JSON.stringify({ ok: false, code: "usage", message: (error as Error).message })}\n`,
      );
      return 2;
    } catch {
      return 1;
    }
  }
  let report: Awaited<
    ReturnType<typeof checkNativeEvaluation | typeof checkReviewedTextEvaluation>
  >;
  try {
    const check = reviewedText ? checkReviewedTextEvaluation : checkNativeEvaluation;
    report = await check(values.get("--project") ?? process.cwd(), {
      trainingEvidencePath: values.get("--training-evidence") as string,
      holdoutEvidencePath: values.get("--holdout-evidence") as string,
    });
  } catch {
    try {
      await io.stderr(
        `${JSON.stringify({ ok: false, code: reviewedText ? "text.evidence.unavailable" : "native.evidence.unavailable", message: "Current project inputs and complete private evaluation evidence are required." })}\n`,
      );
      return 3;
    } catch {
      return 1;
    }
  }
  try {
    await io.stdout(
      json
        ? `${JSON.stringify(report)}\n`
        : `${reviewedText ? "Reviewed text" : "Native"} evaluation: ${report.passed ? "passed (advisory)" : "blocked"}\n${report.issues.join("\n")}${report.issues.length === 0 ? "" : "\n"}${reviewedText ? "Use --reviewed-text for the separate submission gate. " : ""}Independent review and release admission remain required.\n`,
    );
    return report.passed ? 0 : 3;
  } catch {
    return 1;
  }
}
