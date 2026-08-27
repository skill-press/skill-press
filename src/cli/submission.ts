import { ProjectConfigError } from "../config/errors.js";
import {
  loadPackagedSkill,
  packageStagedSkill,
  SkillPackageError,
  type LoadedSkillPackageArtifacts,
} from "../package/archive.js";
import { SkillStagingError, stageCanonicalSkill } from "../package/stage.js";
import { isSafePathInput } from "../path-safety.js";
import {
  checkTesslReleaseGate,
  TesslReleaseGateError,
  type TesslReleaseGateOptions,
  type TesslReleaseGateReport,
} from "../release/tessl-gate.js";
import { SubmissionJournalError, type SubmissionReceipt } from "../submission/journal.js";
import { SubmissionManifestError } from "../submission/manifest.js";
import { runSkillSubmission, SubmissionRunError } from "../submission/run.js";
import type { CliExitCode, CliIo } from "../cli.js";

export const SUBMIT_HELP = `Submit one verified candidate to the canonical Skill Press review pipeline.

Usage:
  skpress submit --review-evidence <file> --eval-evidence <file> --eval-source <directory> [options]

Options:
  --project <directory>       Project root; defaults to the current directory
  --artifacts <directory>     Reuse an exact .skill-press/staging/<run>/artifacts package
  --review-evidence <file>    Private Tessl Quality evidence file
  --eval-evidence <file>      Private Tessl Impact evidence file
  --eval-source <directory>   Evaluated scenario source inside the project
  --dry-run                   Prepare and validate locally without contacting Skill Press
  --resume <receipt>          Retry or refresh the exact private submission journal
  --json                      Emit one stable JSON object
  -h, --help                  Show this help

Without --artifacts, submit creates a fresh deterministic package after the release gate passes.
The command sends only to Skill Press. A successful submission enters review; it is not a
published or trusted release until the canonical server reports that status.
`;

interface SubmissionCliIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

interface SubmitArguments {
  readonly project: string;
  readonly artifactsPath?: string;
  readonly evidence: TesslReleaseGateOptions;
  readonly dryRun: boolean;
  readonly resumeReceiptPath?: string;
  readonly json: boolean;
}

interface SubmissionCommandOperations {
  readonly checkGate: typeof checkTesslReleaseGate;
  readonly stage: typeof stageCanonicalSkill;
  readonly package: typeof packageStagedSkill;
  readonly load: typeof loadPackagedSkill;
  readonly submit: typeof runSkillSubmission;
}

class SubmitUsageError extends Error {
  readonly issues: readonly SubmissionCliIssue[];

  constructor(message: string) {
    super(message);
    this.name = "SubmitUsageError";
    this.issues = Object.freeze([{ code: "cli.usage", path: "/", message }]);
  }
}

function takeValue(args: readonly string[], index: number, flag: string): string {
  const candidate = args[index + 1];
  if (
    candidate === undefined ||
    candidate.startsWith("--") ||
    candidate.length > 4096 ||
    !isSafePathInput(candidate)
  ) {
    throw new SubmitUsageError(`${flag} requires a valid path.`);
  }
  return candidate;
}

function parse(args: readonly string[]): SubmitArguments {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const valueFlags = new Set([
    "--project",
    "--artifacts",
    "--review-evidence",
    "--eval-evidence",
    "--eval-source",
    "--resume",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--json" || argument === "--dry-run") {
      if (booleans.has(argument))
        throw new SubmitUsageError(`${argument} may be specified only once.`);
      booleans.add(argument);
      continue;
    }
    if (!valueFlags.has(argument)) throw new SubmitUsageError("Unknown submit option.");
    if (values.has(argument)) throw new SubmitUsageError(`${argument} may be specified only once.`);
    values.set(argument, takeValue(args, index, argument));
    index += 1;
  }
  const required = (flag: string): string => {
    const result = values.get(flag);
    if (result === undefined) throw new SubmitUsageError(`${flag} is required.`);
    return result;
  };
  if (booleans.has("--dry-run") && values.has("--resume")) {
    throw new SubmitUsageError("--dry-run cannot be combined with --resume.");
  }
  if (values.has("--resume") && !values.has("--artifacts")) {
    throw new SubmitUsageError("--resume requires --artifacts to bind the exact prior package.");
  }
  return Object.freeze({
    project: values.get("--project") ?? process.cwd(),
    ...(values.get("--artifacts") === undefined
      ? {}
      : { artifactsPath: values.get("--artifacts") as string }),
    evidence: {
      reviewEvidencePath: required("--review-evidence"),
      evalEvidencePath: required("--eval-evidence"),
      evalSource: required("--eval-source"),
    },
    dryRun: booleans.has("--dry-run"),
    ...(values.get("--resume") === undefined
      ? {}
      : { resumeReceiptPath: values.get("--resume") as string }),
    json: booleans.has("--json"),
  });
}

const defaultOperations: SubmissionCommandOperations = Object.freeze({
  checkGate: checkTesslReleaseGate,
  stage: stageCanonicalSkill,
  package: packageStagedSkill,
  load: loadPackagedSkill,
  submit: runSkillSubmission,
});

async function output(io: CliIo, json: boolean, value: unknown, human: string): Promise<boolean> {
  try {
    await io.stdout(json ? `${JSON.stringify(value)}\n` : human);
    return true;
  } catch {
    return false;
  }
}

async function failure(
  io: CliIo,
  json: boolean,
  code: string,
  message: string,
  issues: readonly SubmissionCliIssue[],
): Promise<boolean> {
  const detail = issues
    .map((entry) => `- ${entry.path}: ${entry.message} (${entry.code})`)
    .join("\n");
  try {
    await io.stderr(
      json
        ? `${JSON.stringify({ ok: false, code, message, issues })}\n`
        : `submit: ${message}\n${detail}${detail === "" ? "" : "\n"}`,
    );
    return true;
  } catch {
    return false;
  }
}

function knownIssues(error: unknown): readonly SubmissionCliIssue[] | undefined {
  if (
    error instanceof ProjectConfigError ||
    error instanceof TesslReleaseGateError ||
    error instanceof SkillStagingError ||
    error instanceof SkillPackageError ||
    error instanceof SubmissionManifestError ||
    error instanceof SubmissionJournalError ||
    error instanceof SubmissionRunError ||
    error instanceof SubmitUsageError
  ) {
    return error.issues;
  }
  return undefined;
}

function isUnavailableStorageError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    ["EACCES", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].includes(error.code)
  );
}

function gateHuman(gate: TesslReleaseGateReport): string {
  return `Tessl release gate: ${gate.passed ? "passed" : "blocked"}\nQuality: ${gate.scores.quality ?? "unavailable"}/${gate.thresholds.quality}\nImpact: ${gate.scores.impact ?? "unavailable"}/${gate.thresholds.impact}\n`;
}

function receiptHuman(receipt: SubmissionReceipt): string {
  const remote =
    receipt.remote === null ? "not submitted" : `${receipt.remote.status} (${receipt.remote.url})`;
  const trust = receipt.remote?.release?.trust.status ?? "not released";
  return `Submission: ${receipt.operationStatus}\nNamespace: ${receipt.registry.namespace}\nMode: ${receipt.dryRun ? "dry-run" : "submit"}\nJournal: ${receipt.storagePath ?? "not persisted"}\nRemote review: ${remote}\nObserved release trust: ${trust}\n`;
}

async function packageForSubmission(
  parsed: SubmitArguments,
  gate: TesslReleaseGateReport,
  operations: SubmissionCommandOperations,
): Promise<LoadedSkillPackageArtifacts> {
  if (parsed.artifactsPath !== undefined) {
    return operations.load(parsed.project, parsed.artifactsPath);
  }
  const staged = await operations.stage(parsed.project);
  if (staged.sourceCommit !== gate.sourceCommit) {
    throw new SubmissionRunError("Source changed after the release gate.", [
      {
        code: "submission.source.changed",
        path: "/project",
        message: "source commit must remain stable",
      },
    ]);
  }
  const packaged = await operations.package(parsed.project, staged);
  return operations.load(parsed.project, packaged.artifactsPath);
}

export async function runSubmitCommand(
  args: readonly string[],
  io: CliIo,
  operations: SubmissionCommandOperations = defaultOperations,
): Promise<CliExitCode> {
  let parsed: SubmitArguments;
  try {
    parsed = parse(args);
  } catch (error) {
    const usage = error as SubmitUsageError;
    return (await failure(io, args.includes("--json"), "usage", usage.message, usage.issues))
      ? 2
      : 1;
  }
  try {
    const gate = await operations.checkGate(parsed.project, parsed.evidence);
    if (!gate.passed) {
      return (await output(
        io,
        parsed.json,
        { command: "submit", ok: false, status: "blocked", gate },
        gateHuman(gate),
      ))
        ? 3
        : 1;
    }
    const artifacts = await packageForSubmission(parsed, gate, operations);
    if (artifacts.sourceCommit !== gate.sourceCommit) {
      throw new SubmissionRunError("Package source does not match the release gate.", [
        {
          code: "submission.package.binding",
          path: "/artifacts",
          message: "package and evidence must bind the same commit",
        },
      ]);
    }
    const finalGate = await operations.checkGate(parsed.project, parsed.evidence);
    if (!finalGate.passed || finalGate.sourceCommit !== artifacts.sourceCommit) {
      return (await output(
        io,
        parsed.json,
        { command: "submit", ok: false, status: "blocked", gate: finalGate, artifacts },
        gateHuman(finalGate),
      ))
        ? 3
        : 1;
    }
    const receipt = await operations.submit(parsed.project, artifacts, {
      evidence: parsed.evidence,
      dryRun: parsed.dryRun,
      ...(parsed.resumeReceiptPath === undefined
        ? {}
        : { resumeReceiptPath: parsed.resumeReceiptPath }),
    });
    const ok = receipt.operationStatus === "prepared" || receipt.operationStatus === "submitted";
    const report = {
      command: "submit",
      ok,
      status: receipt.operationStatus,
      gate: finalGate,
      artifacts,
      receipt,
    };
    return (await output(
      io,
      parsed.json,
      report,
      `${gateHuman(finalGate)}${receiptHuman(receipt)}`,
    ))
      ? ok
        ? 0
        : 3
      : 1;
  } catch (error) {
    if (isUnavailableStorageError(error)) {
      return (await failure(
        io,
        parsed.json,
        "submission_blocked",
        "Required private release evidence or artifacts are unavailable.",
        [
          {
            code: "submission.storage.unavailable",
            path: "/submission",
            message: "required private release evidence or artifacts are unavailable",
          },
        ],
      ))
        ? 3
        : 1;
    }
    const issues = knownIssues(error);
    if (issues !== undefined) {
      return (await failure(
        io,
        parsed.json,
        "submission_blocked",
        (error as Error).message,
        issues,
      ))
        ? 3
        : 1;
    }
    await failure(io, parsed.json, "internal", "Submission failed unexpectedly.", []);
    return 1;
  }
}
