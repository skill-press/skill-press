import { ProjectConfigError } from "../config/errors.js";
import { diagnoseProject, type DoctorOptions, type DoctorReport } from "../doctor/project.js";
import { SkillPackageError } from "../package/archive.js";
import { isSafePathInput } from "../path-safety.js";
import { TesslReleaseGateError, type TesslReleaseGateOptions } from "../release/tessl-gate.js";
import {
  inspectProjectStatus,
  type ProjectStatusOptions,
  type ProjectStatusReport,
} from "../status/project.js";
import { SubmissionJournalError } from "../submission/journal.js";
import { SubmissionManifestError } from "../submission/manifest.js";
import type { CliExitCode, CliIo } from "../cli.js";

export const STATUS_HELP = `Summarize local readiness, Tessl evidence, package, and submission state.

Usage:
  skpress status [options]

Options:
  --project <directory>       Project root; defaults to the current directory
  --review-evidence <file>    Private Tessl Quality evidence file
  --eval-evidence <file>      Private Tessl Impact evidence file
  --eval-source <directory>   Evaluated scenario source inside the project
  --artifacts <directory>     Optional private packaged-artifacts directory
  --submission <file>         Optional private submission journal; requires --artifacts to bind
  --json                      Emit one stable JSON object
  -h, --help                  Show this help

The three evidence options are all-or-none. Status is read-only and returns exit 3 when current
release inputs or an explicitly supplied submission journal are blocked.
`;

export const DOCTOR_HELP = `Diagnose release tools, evidence, local collisions, and credential context.

Usage:
  skpress doctor [options]

Options:
  --project <directory>       Project root; defaults to the current directory
  --review-evidence <file>    Private Tessl Quality evidence file
  --eval-evidence <file>      Private Tessl Impact evidence file
  --eval-source <directory>   Evaluated scenario source inside the project
  --tessl-executable <path>   Tessl CLI; defaults to tessl on PATH
  --json                      Emit one stable JSON object
  -h, --help                  Show this help

Doctor never prints credential values or mutates remote state. Canonical Skill Press session
validation remains authoritative only when submit connects to the service.
`;

interface InspectIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

interface CommonArguments {
  readonly project: string;
  readonly evidence?: TesslReleaseGateOptions;
  readonly json: boolean;
}

interface StatusArguments extends CommonArguments {
  readonly artifactsPath?: string;
  readonly submissionReceiptPath?: string;
}

interface DoctorArguments extends CommonArguments {
  readonly tesslExecutable?: string;
}

interface InspectCommandOperations {
  readonly status: (project: string, options: ProjectStatusOptions) => Promise<ProjectStatusReport>;
  readonly doctor: (project: string, options: DoctorOptions) => Promise<DoctorReport>;
}

class InspectUsageError extends Error {
  readonly issues: readonly InspectIssue[];

  constructor(message: string) {
    super(message);
    this.name = "InspectUsageError";
    this.issues = Object.freeze([{ code: "cli.usage", path: "/", message }]);
  }
}

const defaultOperations: InspectCommandOperations = Object.freeze({
  status: inspectProjectStatus,
  doctor: diagnoseProject,
});

function takeValue(args: readonly string[], index: number, flag: string): string {
  const candidate = args[index + 1];
  if (
    candidate === undefined ||
    candidate.startsWith("--") ||
    candidate.length > 4096 ||
    !isSafePathInput(candidate)
  ) {
    throw new InspectUsageError(`${flag} requires a valid path.`);
  }
  return candidate;
}

function parse(args: readonly string[], doctor: boolean): StatusArguments | DoctorArguments {
  const values = new Map<string, string>();
  let json = false;
  const allowed = new Set([
    "--project",
    "--review-evidence",
    "--eval-evidence",
    "--eval-source",
    ...(doctor ? ["--tessl-executable"] : ["--artifacts", "--submission"]),
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--json") {
      if (json) throw new InspectUsageError("--json may be specified only once.");
      json = true;
      continue;
    }
    if (!allowed.has(argument)) throw new InspectUsageError("Unknown inspection option.");
    if (values.has(argument))
      throw new InspectUsageError(`${argument} may be specified only once.`);
    values.set(argument, takeValue(args, index, argument));
    index += 1;
  }
  const reviewEvidencePath = values.get("--review-evidence");
  const evalEvidencePath = values.get("--eval-evidence");
  const evalSource = values.get("--eval-source");
  const evidenceCount = [reviewEvidencePath, evalEvidencePath, evalSource].filter(
    (entry) => entry !== undefined,
  ).length;
  if (evidenceCount !== 0 && evidenceCount !== 3) {
    throw new InspectUsageError(
      "Tessl review evidence, eval evidence, and eval source are all-or-none.",
    );
  }
  const common: CommonArguments = {
    project: values.get("--project") ?? process.cwd(),
    ...(reviewEvidencePath === undefined ||
    evalEvidencePath === undefined ||
    evalSource === undefined
      ? {}
      : { evidence: { reviewEvidencePath, evalEvidencePath, evalSource } }),
    json,
  };
  if (!doctor) {
    if (values.has("--submission") && !values.has("--artifacts")) {
      throw new InspectUsageError("--submission requires --artifacts for binding verification.");
    }
    return {
      ...common,
      ...(values.get("--artifacts") === undefined
        ? {}
        : { artifactsPath: values.get("--artifacts") as string }),
      ...(values.get("--submission") === undefined
        ? {}
        : { submissionReceiptPath: values.get("--submission") as string }),
    };
  }
  return {
    ...common,
    ...(values.get("--tessl-executable") === undefined
      ? {}
      : { tesslExecutable: values.get("--tessl-executable") as string }),
  };
}

async function output(io: CliIo, json: boolean, report: unknown, human: string): Promise<boolean> {
  try {
    await io.stdout(json ? `${JSON.stringify(report)}\n` : human);
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
  issues: readonly InspectIssue[],
): Promise<boolean> {
  try {
    if (json) {
      await io.stderr(`${JSON.stringify({ ok: false, code, message, issues })}\n`);
    } else {
      const details = issues
        .map((entry) => `- ${entry.path}: ${entry.message} [${entry.code}]`)
        .join("\n");
      await io.stderr(`${message}\n${details === "" ? "" : `${details}\n`}`);
    }
    return true;
  } catch {
    return false;
  }
}

function knownIssues(error: unknown): readonly InspectIssue[] | undefined {
  if (
    error instanceof ProjectConfigError ||
    error instanceof TesslReleaseGateError ||
    error instanceof SkillPackageError ||
    error instanceof SubmissionJournalError ||
    error instanceof SubmissionManifestError ||
    error instanceof InspectUsageError
  ) {
    return error.issues;
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    ["EACCES", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].includes(error.code)
  ) {
    return [
      {
        code: "inspect.storage.unavailable",
        path: "/",
        message: "required project state is unavailable",
      },
    ];
  }
  return undefined;
}

function statusHuman(report: ProjectStatusReport): string {
  const gate = report.gate === null ? "missing" : report.gate.passed ? "passed" : "blocked";
  const packaged = report.package?.artifactsPath ?? "not supplied";
  const submission = report.submission?.operationStatus ?? "not supplied";
  const trust = report.submission?.remote?.release?.trust.status ?? "not released";
  const issues = report.issues.map((entry) => `- ${entry.message} [${entry.code}]`).join("\n");
  return `Local release-input readiness: ${report.ready ? "ready" : "blocked"}\nLocal: ${report.local.score}/${report.local.minimum}\nTessl gate: ${gate}\nPackage: ${packaged}\nSubmission: ${submission}\nSubmission namespace: ${report.submission?.namespace ?? "not supplied"}\nCurrent trust verified: no\nLast observed release trust: ${trust} (cached, not authoritative)\n${issues === "" ? "" : `${issues}\n`}`;
}

function doctorHuman(report: DoctorReport): string {
  const checks = report.checks
    .map((entry) => `- ${entry.id}: ${entry.status} — ${entry.message}`)
    .join("\n");
  return `Doctor: ${report.ready ? "ready" : "blocked"}\n${checks}\n`;
}

export async function runStatusCommand(
  args: readonly string[],
  io: CliIo,
  operations: InspectCommandOperations = defaultOperations,
): Promise<CliExitCode> {
  let parsed: StatusArguments;
  try {
    parsed = parse(args, false) as StatusArguments;
  } catch (error) {
    const usage = error as InspectUsageError;
    return (await failure(io, args.includes("--json"), "usage", usage.message, usage.issues))
      ? 2
      : 1;
  }
  try {
    const report = await operations.status(parsed.project, {
      ...(parsed.evidence === undefined ? {} : { evidence: parsed.evidence }),
      ...(parsed.artifactsPath === undefined ? {} : { artifactsPath: parsed.artifactsPath }),
      ...(parsed.submissionReceiptPath === undefined
        ? {}
        : { submissionReceiptPath: parsed.submissionReceiptPath }),
    });
    const value = { command: "status", ok: report.ready, ...report };
    return (await output(io, parsed.json, value, statusHuman(report))) ? (report.ready ? 0 : 3) : 1;
  } catch (error) {
    const issues = knownIssues(error);
    if (issues !== undefined) {
      return (await failure(io, parsed.json, "status_invalid", (error as Error).message, issues))
        ? 3
        : 1;
    }
    await failure(io, parsed.json, "internal", "Status inspection failed unexpectedly.", []);
    return 1;
  }
}

export async function runDoctorCommand(
  args: readonly string[],
  io: CliIo,
  operations: InspectCommandOperations = defaultOperations,
): Promise<CliExitCode> {
  let parsed: DoctorArguments;
  try {
    parsed = parse(args, true) as DoctorArguments;
  } catch (error) {
    const usage = error as InspectUsageError;
    return (await failure(io, args.includes("--json"), "usage", usage.message, usage.issues))
      ? 2
      : 1;
  }
  try {
    const report = await operations.doctor(parsed.project, {
      ...(parsed.evidence === undefined ? {} : { evidence: parsed.evidence }),
      ...(parsed.tesslExecutable === undefined ? {} : { tesslExecutable: parsed.tesslExecutable }),
    });
    const value = { command: "doctor", ok: report.ready, ...report };
    return (await output(io, parsed.json, value, doctorHuman(report))) ? (report.ready ? 0 : 3) : 1;
  } catch (error) {
    const issues = knownIssues(error);
    if (issues !== undefined) {
      return (await failure(io, parsed.json, "doctor_invalid", (error as Error).message, issues))
        ? 3
        : 1;
    }
    await failure(io, parsed.json, "internal", "Doctor inspection failed unexpectedly.", []);
    return 1;
  }
}
