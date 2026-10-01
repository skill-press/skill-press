import type { CliExitCode, CliIo } from "../cli.js";
import { isSafePathInput } from "../path-safety.js";
import { checkNativeEvaluation } from "../release/native-check.js";

export const NATIVE_CHECK_HELP = `Assess native training/holdout evidence without Tessl.

Usage:
  skpress eval-check --training-evidence <file> --holdout-evidence <file> [--project <directory>] [--json]

Evidence must come from complete digest-pinned paired runs of the current project.
The report checks readiness, source/input bindings, per-criterion scores, success
rates, impact, safety and freshness. Author results remain advisory. This command
does not execute models, authorize release or replace independent curator review.
Historical runs missing semantic binding or criterion scores must be rerun.
`;

export async function runNativeCheckCommand(
  args: readonly string[],
  io: CliIo,
): Promise<CliExitCode> {
  const values = new Map<string, string>();
  let json = false;
  try {
    for (let index = 0; index < args.length; index += 1) {
      const flag = args[index] as string;
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
  let report: Awaited<ReturnType<typeof checkNativeEvaluation>>;
  try {
    report = await checkNativeEvaluation(values.get("--project") ?? process.cwd(), {
      trainingEvidencePath: values.get("--training-evidence") as string,
      holdoutEvidencePath: values.get("--holdout-evidence") as string,
    });
  } catch {
    try {
      await io.stderr(
        `${JSON.stringify({ ok: false, code: "native.evidence.unavailable", message: "Current project inputs and complete private evaluation evidence are required." })}\n`,
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
        : `Native evaluation: ${report.passed ? "passed (advisory)" : "blocked"}\n${report.issues.join("\n")}${report.issues.length === 0 ? "" : "\n"}Independent review and release admission remain required.\n`,
    );
    return report.passed ? 0 : 3;
  } catch {
    return 1;
  }
}
