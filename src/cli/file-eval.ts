import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliExitCode, CliIo } from "../cli.js";
import { createRunStorage } from "../eval/paired.js";
import { FILE_PAIR_MODEL_CALLS } from "../eval/reviewed-file-pair.js";
import {
  prepareReviewedFileProject,
  runPreparedReviewedFileSuite,
} from "../eval/reviewed-file-project.js";
import { TOOL_REVIEW_POLICY } from "../release/tool-policy.js";
import { runCapturedCommand } from "../process/capture.js";

async function emit(write: CliIo["stdout"], value: unknown) {
  try {
    await write(`${JSON.stringify(value)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Reviewed first-party file diagnostics. No v1 admission or readiness substitution. */
export async function runFileEvalCommand(
  root: string,
  options: {
    suite: "training" | "holdout";
    dryRun: boolean;
    maxModelCalls: number;
  },
  io: CliIo,
): Promise<CliExitCode> {
  let checkpointPath: string | undefined;
  try {
    const prepared = await prepareReviewedFileProject(root, TOOL_REVIEW_POLICY.image);
    const definition = prepared[options.suite].definition;
    const plannedPairs = definition.scenarios.length * prepared.config.evaluation.repetitions;
    const plannedModelCalls = plannedPairs * FILE_PAIR_MODEL_CALLS;
    const plan = {
      command: "eval-tool",
      schemaVersion: 2,
      suite: options.suite,
      sourceCommit: prepared.source.commit,
      image: prepared.image,
      plannedPairs,
      plannedModelCalls,
      model: "gpt-6.1-sol",
      effort: "medium",
      authentication: "forced-chatgpt",
      executionSupported: true,
      readinessAssessed: false,
      releaseAuthorized: false,
      scenarios: definition.scenarios.map((scenario) => ({
        id: scenario.id,
        files: (scenario.fixture?.files ?? []).map((file) => ({
          ...file,
          mount: `/input/${file.path}`,
        })),
      })),
    };
    if (options.dryRun || options.maxModelCalls < plannedModelCalls) {
      const written = await emit(io.stdout, {
        ...plan,
        ok: options.dryRun,
        status: options.dryRun ? "input-preview" : "blocked",
        modelCalls: 0,
        issues: options.dryRun ? [] : ["tool.call_limit"],
      });
      return written ? (options.dryRun ? 0 : 3) : 1;
    }
    const captureId = randomBytes(32).toString("hex");
    checkpointPath = `.skill-press/runs/${captureId}`;
    const ignored = await runCapturedCommand({
      argv: ["git", "check-ignore", "--quiet", "--", checkpointPath],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
    });
    if (ignored.status !== "passed") throw new Error("Private run storage must be ignored.");
    const captureRoot = await createRunStorage(root, captureId);
    const save = async (name: string, value: unknown) =>
      writeFile(join(captureRoot, name), `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await save("plan.json", plan);
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    let events = 0;
    let completedPairs = 0;
    let result: Awaited<ReturnType<typeof runPreparedReviewedFileSuite>>;
    try {
      await io.stderr(
        `${JSON.stringify({ event: "eval-tool.started", ...plan, checkpointPath })}\n`,
      );
      result = await runPreparedReviewedFileSuite(
        root,
        prepared,
        options.suite,
        options.maxModelCalls,
        {
          onEvent: async (identity, event) => {
            await save(`event-${++events}.json`, { identity, event });
            await io.stderr(
              `${JSON.stringify({ event: "eval-tool.step", events, completedPairs, plannedPairs, phase: event.phase })}\n`,
            );
          },
          onResult: async (record) => {
            await save(`pair-${++completedPairs}.json`, record);
            await io.stderr(
              `${JSON.stringify({ event: "eval-tool.progress", completedPairs, plannedPairs, status: record.status })}\n`,
            );
          },
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
    await save("diagnostic.json", result);
    // Complete execution is useful diagnostic data, not an admission assessment.
    const written = await emit(io.stdout, {
      ...plan,
      ok: result.complete,
      status: result.complete ? "diagnostic-completed" : "incomplete",
      complete: result.complete,
      checkpointPath,
      diagnosticPath: `${checkpointPath}/diagnostic.json`,
      summary: result.summary,
      releaseEligible: false,
      issues: ["tool.file_fixtures.admission_not_supported"],
    });
    return written ? (result.complete ? 0 : 3) : 1;
  } catch {
    try {
      await io.stderr(
        `${JSON.stringify({
          ok: false,
          code: "tool.file_evaluation.failed",
          message:
            "File evaluation did not finish with verified source and private checkpoints. No automatic retry was attempted.",
          ...(checkpointPath === undefined ? {} : { checkpointPath }),
        })}\n`,
      );
      return 3;
    } catch {
      return 1;
    }
  }
}
