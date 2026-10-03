import { TOOL_REVIEW_POLICY } from "../release/tool-policy.js";
import { randomBytes } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { CliExitCode, CliIo } from "../cli.js";
import { checkProject } from "../check/project.js";
import { createRunStorage } from "../eval/paired.js";
import {
  prepareReviewedToolProject,
  runPreparedReviewedToolSuite,
} from "../eval/reviewed-tool-project.js";
import { isSafePathInput } from "../path-safety.js";
import { runCapturedCommand } from "../process/capture.js";
import { assessReviewedToolMeasurement } from "../release/reviewed-tool-measurement.js";
import { prepareToolFilePreview } from "../eval/tool-file-preview.js";
import { runFileEvalCommand } from "./file-eval.js";

export const TOOL_EVAL_HELP = `Run one reviewed first-party tool suite through the existing isolated Python evaluator.

Usage:
  skpress eval-tool --suite <training|holdout> [--project <directory>] --dry-run [--json]
  skpress eval-tool --suite <training|holdout> [--project <directory>] --reviewed-inputs --max-model-calls <count> [--json]

Preview first, then review the skill, both suites and rubric before confirming
--reviewed-inputs. Review all skill resources and fixtures as well as instructions.
Python runs in the existing network-isolated Docker sandbox with read-only inputs;
the host model remains networked. This does not authorize unreviewed third-party inputs.
Inputs are sent to Codex using existing ChatGPT login only: gpt-6.1-sol / medium,
reviewed codex-cli 0.160.0. No Tessl, API-billing fallback or automatic retry.
The cap bounds explicit harness calls (eleven per v1 pair, seventeen per v2 file pair), not provider-internal retries.
The interpreter digest is fixed by the reviewed tool admission policy. Both arms
receive the same interpreter; only the selected skill arm receives skill resources.
Project test commands are not executed. --dry-run invokes neither models nor containers.
Suite schemaVersion 2 supports reviewed file diagnostics with private checkpoints.
V2 exit 0 means preview/execution completed, not quality passed; readiness assessment
and admission for that version are not supported yet. V2 reports are JSON.

Results and per-pair checkpoints remain private under ignored .skill-press/runs/.
Progress goes to stderr; stdout contains the final report, not prompts or answers.
SIGINT/SIGTERM requests cancellation; provider-side cancellation is not guaranteed.
For v1, exit 0 means preview ready or this suite passed advisory checks; 3 means blocked
or incomplete. Both suites, eval-check and independent curator review are still
required. No submission, publication or deployment is performed.
`;

function parse(args: readonly string[]): {
  project: string;
  suite: "training" | "holdout";
  dryRun: boolean;
  json: boolean;
  maxModelCalls: number;
} {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index] as string;
    if (["--json", "--dry-run", "--reviewed-inputs"].includes(flag)) {
      if (flags.has(flag)) throw new Error("Duplicate eval-tool option.");
      flags.add(flag);
    } else {
      if (!["--project", "--suite", "--max-model-calls"].includes(flag) || values.has(flag))
        throw new Error("Unknown or duplicate eval-tool option.");
      const value = args[++index];
      if (value === undefined || value.startsWith("--") || !isSafePathInput(value))
        throw new Error("eval-tool options require valid values.");
      values.set(flag, value);
    }
  }
  const suite = values.get("--suite");
  if (suite !== "training" && suite !== "holdout") throw new Error("Choose training or holdout.");
  const limit = values.get("--max-model-calls");
  const maxModelCalls = limit === undefined ? 0 : Number(limit);
  if (
    limit !== undefined &&
    (!/^[1-9][0-9]*$/u.test(limit) || !Number.isSafeInteger(maxModelCalls))
  )
    throw new Error("Model call cap must be a positive safe integer.");
  if (!flags.has("--dry-run") && (!flags.has("--reviewed-inputs") || limit === undefined))
    throw new Error(
      "Execution requires --reviewed-inputs and --max-model-calls; preview with --dry-run first.",
    );
  return {
    project: values.get("--project") ?? process.cwd(),
    suite,
    dryRun: flags.has("--dry-run"),
    json: flags.has("--json"),
    maxModelCalls,
  };
}

async function emit(write: CliIo["stdout"], text: string): Promise<boolean> {
  try {
    await write(text);
    return true;
  } catch {
    return false;
  }
}

async function requireIgnored(root: string, path: string): Promise<void> {
  const result = await runCapturedCommand({
    argv: ["git", "check-ignore", "--quiet", "--", path],
    cwd: root,
    timeoutSeconds: 30,
    maxOutputBytes: 1024,
  });
  if (result.status !== "passed") throw new Error("Private evaluation storage must be ignored.");
}

export async function runToolEvalCommand(args: readonly string[], io: CliIo): Promise<CliExitCode> {
  let options: ReturnType<typeof parse>;
  try {
    options = parse(args);
  } catch (error) {
    return (await emit(
      io.stderr,
      `${JSON.stringify({ ok: false, code: "usage", message: (error as Error).message })}\n`,
    ))
      ? 2
      : 1;
  }
  let checkpointPath: string | undefined;
  try {
    const root = await realpath(resolve(options.project));
    const filePreview = await prepareToolFilePreview(root, options.suite);
    if (filePreview !== null) {
      return await runFileEvalCommand(root, options, io);
    }
    const prepared = await prepareReviewedToolProject(root, TOOL_REVIEW_POLICY.image);
    const readiness = await checkProject(root);
    const plannedPairs =
      prepared.inputs[options.suite].scenarios.length * prepared.config.evaluation.repetitions;
    const plannedModelCalls = plannedPairs * 11;
    const allowed = options.dryRun || options.maxModelCalls >= plannedModelCalls;
    const plan = {
      command: "eval-tool",
      sourceCommit: prepared.source.commit,
      suite: options.suite,
      image: TOOL_REVIEW_POLICY.image,
      plannedPairs,
      plannedModelCalls,
      model: "gpt-6.1-sol",
      effort: "medium",
      authentication: "forced-chatgpt",
      execution: "host-networked-model-isolated-python",
      releaseAuthorized: false,
    };
    if (options.dryRun || !readiness.ok || !allowed) {
      const ok = readiness.ok && allowed;
      const report = {
        ...plan,
        ok,
        status: ok ? "preview" : "blocked",
        dryRun: options.dryRun,
        issues: [
          ...(!readiness.ok ? ["tool.readiness.failed"] : []),
          ...(!allowed ? ["tool.call_limit"] : []),
        ],
      };
      return (await emit(
        io.stdout,
        options.json
          ? `${JSON.stringify(report)}\n`
          : `Tool evaluation ${report.status}: ${plannedPairs} pairs, ${plannedModelCalls} model calls.\n${report.issues.join("\n")}\n`,
      ))
        ? ok
          ? 0
          : 3
        : 1;
    }
    const captureId = randomBytes(32).toString("hex");
    checkpointPath = `.skill-press/runs/${captureId}`;
    await requireIgnored(root, checkpointPath);
    const captureRoot = await createRunStorage(root, captureId);
    await writeFile(join(captureRoot, "plan.json"), `${JSON.stringify(plan)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    let measurement: Awaited<ReturnType<typeof runPreparedReviewedToolSuite>>;
    let completedPairs = 0;
    let events = 0;
    try {
      await io.stderr(
        `${JSON.stringify({ event: "eval-tool.started", ...plan, checkpointPath })}\n`,
      );
      measurement = await runPreparedReviewedToolSuite(
        root,
        prepared,
        options.suite,
        {
          onEvent: async (identity, event) => {
            await writeFile(
              join(captureRoot, `event-${++events}.json`),
              `${JSON.stringify({ identity, event })}\n`,
              { mode: 0o600, flag: "wx" },
            );
            await io.stderr(
              `${JSON.stringify({ event: "eval-tool.step", events, completedPairs, plannedPairs, phase: event.kind })}\n`,
            );
          },
          onResult: async (record) => {
            await writeFile(
              join(captureRoot, `pair-${++completedPairs}.json`),
              `${JSON.stringify(record)}\n`,
              { mode: 0o600, flag: "wx" },
            );
            await io.stderr(
              `${JSON.stringify({ event: "eval-tool.progress", completedPairs, plannedPairs, status: record.status })}\n`,
            );
          },
        },
        controller.signal,
      );
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
    const bytes = `${JSON.stringify(measurement)}\n`;
    if (Buffer.byteLength(bytes) > 1024 * 1024)
      throw new Error("Evidence exceeds the current wire limit.");
    const evidencePath = `.skill-press/runs/${measurement.runId}/evidence.json`;
    await requireIgnored(root, evidencePath);
    const evidenceRoot = await createRunStorage(root, measurement.runId);
    await writeFile(join(evidenceRoot, "evidence.json"), bytes, { mode: 0o600, flag: "wx" });
    const assessment = assessReviewedToolMeasurement(measurement, prepared, options.suite);
    const ok = measurement.complete && assessment.passed;
    const report = {
      ...plan,
      ok,
      status: ok ? "completed" : "blocked",
      complete: measurement.complete,
      evidencePath,
      checkpointPath,
      assessment,
      summary: measurement.summary,
    };
    return (await emit(
      io.stdout,
      options.json
        ? `${JSON.stringify(report)}\n`
        : `Tool evaluation ${report.status}: ${completedPairs}/${plannedPairs} pairs.\nEvidence: ${evidencePath}\n${assessment.issues.join("\n")}\nIndependent review and paired-suite admission remain required.\n`,
    ))
      ? ok
        ? 0
        : 3
      : 1;
  } catch {
    return (await emit(
      io.stderr,
      `${JSON.stringify({
        ok: false,
        code: "tool.evaluation.failed",
        message:
          "Evaluation could not finish with verified source and private evidence. Retain any checkpoints; no automatic retry was attempted.",
        ...(checkpointPath === undefined ? {} : { checkpointPath }),
      })}\n`,
    ))
      ? 3
      : 1;
  }
}
