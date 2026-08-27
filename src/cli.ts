import { join } from "node:path";

import { checkProject } from "./check/project.js";
import type { SkillPressCheckReport } from "./check/types.js";
import { DOCTOR_HELP, runDoctorCommand, runStatusCommand, STATUS_HELP } from "./cli/inspect.js";
import { IMPROVE_HELP, runImproveCommand } from "./cli/improve.js";
import { PACKAGE_HELP, runPackageCommand } from "./cli/package.js";
import { runSubmitCommand, SUBMIT_HELP } from "./cli/submission.js";
import { ProjectConfigError } from "./config/errors.js";
import { CapabilityBriefError, ProjectCreationError } from "./create/errors.js";
import { loadCapabilityBrief } from "./create/load.js";
import { renderCapabilityProject } from "./create/render.js";
import { writeRenderedProject } from "./create/write.js";
import { EvaluationInputError } from "./eval/errors.js";
import { EvaluationRunError, runPairedEvaluation } from "./eval/paired.js";
import type { SkillPressPairedEvaluationEvidence } from "./eval/generated-evidence.js";
import { SandboxPolicyError } from "./eval/sandbox.js";
import { isSafePathInput } from "./path-safety.js";
import {
  captureTesslEvalEvidence,
  captureTesslReviewEvidence,
  TesslEvidenceError,
} from "./tessl/evidence.js";
import type { SkillPressTesslEvalEvidence } from "./tessl/generated-eval-evidence.js";
import type { SkillPressTesslReviewEvidence } from "./tessl/generated-review-evidence.js";
import { runProjectTests } from "./test/project.js";
import type { ProjectTestReport } from "./test/types.js";
import { VERSION } from "./version.js";

export interface CliIo {
  readonly stdout: (text: string) => void | Promise<void>;
  readonly stderr: (text: string) => void | Promise<void>;
}
export type CliExitCode = 0 | 1 | 2 | 3 | 4;
const MAX_CLI_ARGUMENTS = 64;
const MAX_CLI_ARGUMENT_BYTES = 64 * 1024;
const HELP = `Skill Press CLI ${VERSION}

Build, verify, submit, and install trusted agent skills.

Usage:
  skpress [options]
  skpress <command> [options]

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version

Commands:
  init               Create a complete canonical skill project from a strict brief
  check              Validate a project and report local readiness
  test               Run deterministic project test commands without a shell
  eval               Run paired baseline/with-skill evaluation in a sandbox
  tessl              Capture official Tessl Quality and Impact evidence
  package            Create reproducible, provenance-bound release artifacts
  submit             Submit one verified candidate to the canonical Skill Press review pipeline
  status             Summarize gates, evidence, package, and submission state
  doctor             Diagnose environment and release prerequisites
  improve            Run the bounded author/review/evaluation loop
`;

const TESSL_HELP = `Capture release evidence using the official Tessl CLI.

Usage:
  skpress tessl review [options]
  skpress tessl eval --source <directory> [options]

Common options:
  --project <directory>     Project root; defaults to the current directory
  --executable <path>       Versioned official Tessl CLI; PATH launchers may be untrusted
  --timeout <seconds>       Bounded provider timeout; defaults to 2700
  --json                    Emit one stable JSON object
  -h, --help                Show this help

Review options:
  --workspace <name>        Tessl workspace passed to the quality review

Eval options:
  --source <directory>      Tessl eval source inside the project
  --agent <agent>           Optional exact Tessl agent; omit for the provider default
  --model <model>           Optional exact Tessl model; omit for the provider default
  --runs <count>            Repetitions from 1 to 10; defaults to 1
  --poll-interval-ms <ms>   Poll interval from 1 to 60000; defaults to 30000

Only evidence from a pinned, trusted Tessl CLI and unchanged committed inputs can satisfy a
release gate. Quality and Impact capture force fresh provider results instead of reusing caches.
Provider authentication and scores are never inferred or entered manually.
`;

const INIT_HELP = `Create a canonical Skill Press project from a complete capability brief.

Usage:
  skpress init --brief <file> --output <new-directory> [--json]

Options:
  --brief <file>             Read the strict capability brief from this regular YAML file
  --output <new-directory>  Create this directory; it must not already exist
  --json                     Emit one stable JSON object
  -h, --help                 Show this help
`;

const CHECK_HELP = `Validate a Skill Press project and report local readiness.

Usage:
  skpress check [--project <directory>] [--json]

Options:
  --project <directory>  Project root containing skill-press.yaml; defaults to the current directory
  --json                 Emit one stable JSON object
  -h, --help             Show this help
`;

const TEST_HELP = `Run deterministic Skill Press project test commands without a shell.

Usage:
  skpress test [--project <directory>] [--json]

Options:
  --project <directory>  Project root containing skill-press.yaml; defaults to the current directory
  --json                 Emit one stable JSON object
  -h, --help             Show this help
`;

const EVAL_HELP = `Run paired baseline and with-skill scenarios in Docker or Podman.

Usage:
  skpress eval --image <digest-pinned-image> --model <model> [options] -- <adapter-argv...>

Options:
  --project <directory>      Project root; defaults to the current directory
  --suite <training|holdout> Scenario suite; defaults to training
  --scenario <id>            Run only this scenario; may be repeated
  --allow-unpinned-image     Permit a local mutable image and mark evidence ineligible
  --json                     Emit one stable JSON object
  -h, --help                 Show this help

The adapter must implement the SkillPress request/result protocol. Submission credentials and
host execution are never implied by this command.
`;

interface CliIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

interface CreateArguments {
  readonly brief: string;
  readonly output: string;
  readonly json: boolean;
}

interface ProjectCommandArguments {
  readonly project: string;
  readonly json: boolean;
}

interface EvalArguments {
  readonly project: string;
  readonly image: string;
  readonly model: string;
  readonly suite: "training" | "holdout";
  readonly scenarioIds?: readonly string[];
  readonly allowUnpinnedImage: boolean;
  readonly command: readonly [string, ...string[]];
  readonly json: boolean;
}

interface ArgumentSnapshot {
  readonly args?: readonly string[];
  readonly jsonRequested: boolean;
}

interface TesslCommonArguments {
  readonly project: string;
  readonly executable?: string;
  readonly timeoutSeconds?: number;
  readonly json: boolean;
}

interface TesslReviewArguments extends TesslCommonArguments {
  readonly operation: "review";
  readonly workspace?: string;
}

interface TesslEvalArguments extends TesslCommonArguments {
  readonly operation: "eval";
  readonly source: string;
  readonly agent?: string;
  readonly model?: string;
  readonly runs?: number;
  readonly pollIntervalMs?: number;
}

type TesslArguments = TesslReviewArguments | TesslEvalArguments;

class CliUsageError extends Error {
  readonly issues: readonly CliIssue[];

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
    this.issues = [{ code: "cli.usage", path: "/", message }];
  }
}

const defaultIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export function renderHelp(): string {
  return HELP;
}

export function renderInitHelp(): string {
  return INIT_HELP;
}

export function renderCheckHelp(): string {
  return CHECK_HELP;
}

export function renderTestHelp(): string {
  return TEST_HELP;
}

export function renderEvalHelp(): string {
  return EVAL_HELP;
}

export function renderTesslHelp(): string {
  return TESSL_HELP;
}

export function renderPackageHelp(): string {
  return PACKAGE_HELP;
}

export function renderSubmitHelp(): string {
  return SUBMIT_HELP;
}

export function renderStatusHelp(): string {
  return STATUS_HELP;
}

export function renderDoctorHelp(): string {
  return DOCTOR_HELP;
}

export function renderImproveHelp(): string {
  return IMPROVE_HELP;
}

function assertPathArgument(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${flag} requires a path value.`);
  }
  if (!isSafePathInput(value)) {
    throw new CliUsageError(`${flag} must be a non-empty, unambiguous Unicode path.`);
  }
  return value;
}

function parseCreateArguments(args: readonly string[]): CreateArguments {
  let brief: string | undefined;
  let output: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      if (json) {
        throw new CliUsageError("--json may be specified only once.");
      }
      json = true;
    } else if (argument === "--brief") {
      if (brief !== undefined) {
        throw new CliUsageError("--brief may be specified only once.");
      }
      brief = assertPathArgument("--brief", args[index + 1]);
      index += 1;
    } else if (argument === "--output") {
      if (output !== undefined) {
        throw new CliUsageError("--output may be specified only once.");
      }
      output = assertPathArgument("--output", args[index + 1]);
      index += 1;
    } else {
      throw new CliUsageError("Unknown init argument.");
    }
  }

  if (brief === undefined || output === undefined) {
    throw new CliUsageError("init requires both --brief and --output.");
  }
  return { brief, output, json };
}

function parseProjectCommandArguments(
  args: readonly string[],
  command: "check" | "test",
): ProjectCommandArguments {
  let project = ".";
  let projectProvided = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      if (json) throw new CliUsageError("--json may be specified only once.");
      json = true;
    } else if (argument === "--project") {
      if (projectProvided) throw new CliUsageError("--project may be specified only once.");
      project = assertPathArgument("--project", args[index + 1]);
      projectProvided = true;
      index += 1;
    } else {
      throw new CliUsageError(`Unknown ${command} argument.`);
    }
  }
  return { project, json };
}

function argumentValue(flag: string, value: string | undefined): string {
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new CliUsageError(`${flag} requires a value.`);
  }
  return value;
}

function integerArgument(flag: string, value: string | undefined): number {
  const text = argumentValue(flag, value);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) {
    throw new CliUsageError(`${flag} requires a decimal integer.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliUsageError(`${flag} requires a safe decimal integer.`);
  }
  return parsed;
}

function parseTesslArguments(args: readonly string[]): TesslArguments {
  const operation = args[0];
  if (operation !== "review" && operation !== "eval") {
    throw new CliUsageError("tessl requires review or eval.");
  }
  let project = ".";
  let projectProvided = false;
  let executable: string | undefined;
  let timeoutSeconds: number | undefined;
  let workspace: string | undefined;
  let source: string | undefined;
  let agent: string | undefined;
  let model: string | undefined;
  let runs: number | undefined;
  let pollIntervalMs: number | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      if (json) throw new CliUsageError("--json may be specified only once.");
      json = true;
    } else if (argument === "--project") {
      if (projectProvided) throw new CliUsageError("--project may be specified only once.");
      project = assertPathArgument("--project", args[index + 1]);
      projectProvided = true;
      index += 1;
    } else if (argument === "--executable") {
      if (executable !== undefined) {
        throw new CliUsageError("--executable may be specified only once.");
      }
      executable = assertPathArgument("--executable", args[index + 1]);
      index += 1;
    } else if (argument === "--timeout") {
      if (timeoutSeconds !== undefined) {
        throw new CliUsageError("--timeout may be specified only once.");
      }
      timeoutSeconds = integerArgument("--timeout", args[index + 1]);
      index += 1;
    } else if (operation === "review" && argument === "--workspace") {
      if (workspace !== undefined) {
        throw new CliUsageError("--workspace may be specified only once.");
      }
      workspace = argumentValue("--workspace", args[index + 1]);
      index += 1;
    } else if (operation === "eval" && argument === "--source") {
      if (source !== undefined) throw new CliUsageError("--source may be specified only once.");
      source = assertPathArgument("--source", args[index + 1]);
      index += 1;
    } else if (operation === "eval" && argument === "--agent") {
      if (agent !== undefined) throw new CliUsageError("--agent may be specified only once.");
      agent = argumentValue("--agent", args[index + 1]);
      index += 1;
    } else if (operation === "eval" && argument === "--model") {
      if (model !== undefined) throw new CliUsageError("--model may be specified only once.");
      model = argumentValue("--model", args[index + 1]);
      index += 1;
    } else if (operation === "eval" && argument === "--runs") {
      if (runs !== undefined) throw new CliUsageError("--runs may be specified only once.");
      runs = integerArgument("--runs", args[index + 1]);
      index += 1;
    } else if (operation === "eval" && argument === "--poll-interval-ms") {
      if (pollIntervalMs !== undefined) {
        throw new CliUsageError("--poll-interval-ms may be specified only once.");
      }
      pollIntervalMs = integerArgument("--poll-interval-ms", args[index + 1]);
      index += 1;
    } else {
      throw new CliUsageError(`Unknown tessl ${operation} argument.`);
    }
  }
  const common = {
    project,
    ...(executable === undefined ? {} : { executable }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    json,
  };
  if (operation === "review") {
    return {
      operation,
      ...common,
      ...(workspace === undefined ? {} : { workspace }),
    };
  }
  if (source === undefined) {
    throw new CliUsageError("tessl eval requires --source.");
  }
  return {
    operation,
    ...common,
    source,
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(runs === undefined ? {} : { runs }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  };
}

function parseEvalArguments(args: readonly string[]): EvalArguments {
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) {
    throw new CliUsageError("eval requires adapter argv after --.");
  }
  const flags = args.slice(0, separator);
  const command = args.slice(separator + 1) as unknown as readonly [string, ...string[]];
  let project = ".";
  let projectProvided = false;
  let image: string | undefined;
  let model: string | undefined;
  let suite: "training" | "holdout" = "training";
  let suiteProvided = false;
  const scenarioIds: string[] = [];
  let allowUnpinnedImage = false;
  let json = false;
  for (let index = 0; index < flags.length; index += 1) {
    const argument = flags[index];
    if (argument === "--json") {
      if (json) throw new CliUsageError("--json may be specified only once.");
      json = true;
    } else if (argument === "--allow-unpinned-image") {
      if (allowUnpinnedImage) {
        throw new CliUsageError("--allow-unpinned-image may be specified only once.");
      }
      allowUnpinnedImage = true;
    } else if (argument === "--project") {
      if (projectProvided) throw new CliUsageError("--project may be specified only once.");
      project = assertPathArgument("--project", flags[index + 1]);
      projectProvided = true;
      index += 1;
    } else if (argument === "--image") {
      if (image !== undefined) throw new CliUsageError("--image may be specified only once.");
      image = argumentValue("--image", flags[index + 1]);
      index += 1;
    } else if (argument === "--model") {
      if (model !== undefined) throw new CliUsageError("--model may be specified only once.");
      model = argumentValue("--model", flags[index + 1]);
      index += 1;
    } else if (argument === "--suite") {
      if (suiteProvided) throw new CliUsageError("--suite may be specified only once.");
      const value = argumentValue("--suite", flags[index + 1]);
      if (value !== "training" && value !== "holdout") {
        throw new CliUsageError("--suite must be training or holdout.");
      }
      suite = value;
      suiteProvided = true;
      index += 1;
    } else if (argument === "--scenario") {
      scenarioIds.push(argumentValue("--scenario", flags[index + 1]));
      index += 1;
    } else {
      throw new CliUsageError("Unknown eval argument.");
    }
  }
  if (image === undefined || model === undefined) {
    throw new CliUsageError("eval requires --image and --model.");
  }
  return {
    project,
    image,
    model,
    suite,
    ...(scenarioIds.length === 0 ? {} : { scenarioIds: Object.freeze(scenarioIds) }),
    allowUnpinnedImage,
    command: Object.freeze([...command]) as unknown as readonly [string, ...string[]],
    json,
  };
}

function wantsJson(args: readonly string[]): boolean {
  const separator = args.indexOf("--");
  return args.slice(0, separator < 0 ? args.length : separator).includes("--json");
}

async function writeStdout(io: CliIo, text: string): Promise<boolean> {
  try {
    await io.stdout(text);
    return true;
  } catch {
    return false;
  }
}

async function writeError(
  io: CliIo,
  json: boolean,
  code: string,
  message: string,
  issues: readonly CliIssue[],
): Promise<boolean> {
  try {
    if (json) {
      await io.stderr(`${JSON.stringify({ ok: false, code, message, issues })}\n`);
      return true;
    }

    const details = issues
      .map((entry) => `- ${entry.path}: ${entry.message} [${entry.code}]`)
      .join("\n");
    await io.stderr(`${message}\n${details === "" ? "" : `${details}\n`}`);
    return true;
  } catch {
    return false;
  }
}

async function writeInternalFailure(
  io: CliIo,
  json: boolean,
  command: string,
): Promise<CliExitCode> {
  await writeError(io, json, "internal", "SkillPress could not complete the command.", [
    {
      code: `${command}.internal`,
      path: "/",
      message: "unexpected internal failure",
    },
  ]);
  return 1;
}

function snapshotArguments(value: unknown): ArgumentSnapshot {
  let jsonRequested = false;
  try {
    if (!Array.isArray(value)) {
      return { jsonRequested };
    }
    const count = value.length;
    if (!Number.isSafeInteger(count) || count < 0) {
      return { jsonRequested };
    }
    const result: string[] = [];
    let bytes = 0;
    let valid = count <= MAX_CLI_ARGUMENTS;
    const capturedCount = Math.min(count, MAX_CLI_ARGUMENTS);
    for (let index = 0; index < capturedCount; index += 1) {
      const argument: unknown = value[index];
      if (typeof argument !== "string") {
        valid = false;
        continue;
      }
      jsonRequested ||= argument === "--json";
      if (argument.length > MAX_CLI_ARGUMENT_BYTES) {
        valid = false;
        continue;
      }
      bytes += Buffer.byteLength(argument, "utf8");
      if (bytes > MAX_CLI_ARGUMENT_BYTES) {
        valid = false;
      }
      result.push(argument);
    }
    return valid && result.length === count
      ? { args: Object.freeze(result), jsonRequested }
      : { jsonRequested };
  } catch {
    return { jsonRequested };
  }
}

function snapshotIo(value: unknown): CliIo | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const stdout: unknown = (value as { readonly stdout?: unknown }).stdout;
    const stderr: unknown = (value as { readonly stderr?: unknown }).stderr;
    if (typeof stdout !== "function" || typeof stderr !== "function") {
      return undefined;
    }
    return Object.freeze({
      stdout: (text: string) => Reflect.apply(stdout, value, [text]) as void | Promise<void>,
      stderr: (text: string) => Reflect.apply(stderr, value, [text]) as void | Promise<void>,
    });
  } catch {
    return undefined;
  }
}

async function runInit(args: readonly string[], io: CliIo): Promise<CliExitCode> {
  const json = wantsJson(args);
  let parsed: CreateArguments;
  try {
    parsed = parseCreateArguments(args);
    const brief = await loadCapabilityBrief(parsed.brief);
    const result = await writeRenderedProject(renderCapabilityProject(brief), parsed.output);
    if (parsed.json) {
      if (
        !(await writeStdout(io, `${JSON.stringify({ ok: true, command: "init", ...result })}\n`))
      ) {
        return 1;
      }
    } else {
      if (
        !(await writeStdout(
          io,
          `Created ${result.root}\nCanonical skill: ${join(result.root, result.skillPath)}\nFiles: ${result.files.length}\n`,
        ))
      ) {
        return 1;
      }
    }
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      await writeError(io, json, "usage", error.message, error.issues);
      return 2;
    }
    if (error instanceof CapabilityBriefError) {
      await writeError(io, json, "brief.invalid", error.message, error.issues);
      return 3;
    }
    if (error instanceof ProjectCreationError) {
      const unsafe = error.kind === "unsafe-output";
      await writeError(
        io,
        json,
        unsafe ? "init.unsafe_output" : "init.io",
        error.message,
        error.issues,
      );
      return unsafe ? 4 : 1;
    }
    return writeInternalFailure(io, json, "init");
  }
}

function humanCheckReport(report: SkillPressCheckReport): string {
  const errors = report.diagnostics.filter((entry) => entry.severity === "error").length;
  const warnings = report.diagnostics.length - errors;
  const details = report.diagnostics
    .map((entry) => `- ${entry.path}: ${entry.message} [${entry.code}]`)
    .join("\n");
  return [
    `Readiness: ${report.score}/100 (minimum ${report.minimum})`,
    `Eligible: ${report.eligible ? "yes" : "no"}`,
    `Status: ${report.ok ? "pass" : "fail"}`,
    `Diagnostics: ${errors} error(s), ${warnings} warning(s)`,
    ...(details === "" ? [] : [details]),
    "",
  ].join("\n");
}

async function runCheck(args: readonly string[], io: CliIo): Promise<CliExitCode> {
  const json = wantsJson(args);
  try {
    const parsed = parseProjectCommandArguments(args, "check");
    const report = await checkProject(parsed.project);
    const output = parsed.json
      ? `${JSON.stringify({ command: "check", ...report })}\n`
      : humanCheckReport(report);
    if (!(await writeStdout(io, output))) return 1;
    return report.ok ? 0 : 3;
  } catch (error) {
    if (error instanceof CliUsageError) {
      await writeError(io, json, "usage", error.message, error.issues);
      return 2;
    }
    if (error instanceof ProjectConfigError) {
      await writeError(io, json, "project.invalid", error.message, error.issues);
      return 3;
    }
    return writeInternalFailure(io, json, "check");
  }
}

function humanTestReport(report: ProjectTestReport): string {
  return [
    `Project tests: ${report.ok ? "pass" : "fail"}`,
    `Commands: ${report.results.length}`,
    ...report.results.map(
      (entry) =>
        `- ${entry.name}: ${entry.status} (${entry.durationMs} ms, stdout ${entry.stdoutBytes} bytes, stderr ${entry.stderrBytes} bytes)`,
    ),
    "",
  ].join("\n");
}

async function runTests(args: readonly string[], io: CliIo): Promise<CliExitCode> {
  const json = wantsJson(args);
  try {
    const parsed = parseProjectCommandArguments(args, "test");
    const report = await runProjectTests(parsed.project);
    const output = parsed.json
      ? `${JSON.stringify({ command: "test", ...report })}\n`
      : humanTestReport(report);
    if (!(await writeStdout(io, output))) return 1;
    return report.ok ? 0 : 3;
  } catch (error) {
    if (error instanceof CliUsageError) {
      await writeError(io, json, "usage", error.message, error.issues);
      return 2;
    }
    if (error instanceof ProjectConfigError) {
      await writeError(io, json, "project.invalid", error.message, error.issues);
      return 3;
    }
    return writeInternalFailure(io, json, "test");
  }
}

export function renderHumanEvalReport(evidence: SkillPressPairedEvaluationEvidence): string {
  return [
    `Paired evaluation: ${evidence.summary.behavioralGatePassed ? "pass" : "fail"}`,
    `Evidence eligible: ${evidence.evidenceEligible ? "yes" : "no"}`,
    `Baseline success: ${(evidence.summary.baselineSuccessRate * 100).toFixed(1)}%`,
    `With-skill success: ${(evidence.summary.withSkillSuccessRate * 100).toFixed(1)}%`,
    `Impact delta: ${(evidence.summary.impactDelta * 100).toFixed(1)} percentage points`,
    `Evidence: ${evidence.storagePath}/evidence.json`,
    ...(evidence.ineligibilityReasons.length === 0
      ? []
      : [`Ineligible: ${evidence.ineligibilityReasons.join(", ")}`]),
    "",
  ].join("\n");
}

async function runEval(args: readonly string[], io: CliIo): Promise<CliExitCode> {
  const json = wantsJson(args);
  try {
    const parsed = parseEvalArguments(args);
    const evidence = await runPairedEvaluation(parsed.project, {
      image: parsed.image,
      model: parsed.model,
      suite: parsed.suite,
      command: parsed.command,
      allowUnpinnedImage: parsed.allowUnpinnedImage,
      ...(parsed.scenarioIds === undefined ? {} : { scenarioIds: parsed.scenarioIds }),
    });
    const output = parsed.json
      ? `${JSON.stringify({ command: "eval", ...evidence })}\n`
      : renderHumanEvalReport(evidence);
    if (!(await writeStdout(io, output))) return 1;
    return evidence.evidenceEligible ? 0 : 3;
  } catch (error) {
    if (error instanceof CliUsageError) {
      await writeError(io, json, "usage", error.message, error.issues);
      return 2;
    }
    if (error instanceof ProjectConfigError || error instanceof EvaluationInputError) {
      await writeError(io, json, "project.invalid", error.message, error.issues);
      return 3;
    }
    if (error instanceof EvaluationRunError || error instanceof SandboxPolicyError) {
      await writeError(io, json, "eval.invalid", error.message, error.issues);
      return 3;
    }
    return writeInternalFailure(io, json, "eval");
  }
}

export function renderHumanTesslReport(
  evidence: SkillPressTesslReviewEvidence | SkillPressTesslEvalEvidence,
): string {
  const scoreLines =
    evidence.evidenceType === "skillpress.tessl-review"
      ? [
          `Tessl Quality: ${evidence.review.qualityScore}/100`,
          `Official validation: ${evidence.review.validationPassed ? "pass" : "fail"}`,
        ]
      : [
          `Tessl Impact: ${evidence.impactScore}/100`,
          `Baseline: ${evidence.baselineScore}/100`,
          `Delta: ${evidence.impactDelta} points`,
        ];
  return [
    ...scoreLines,
    `Evidence eligible: ${evidence.evidenceEligible ? "yes" : "no"}`,
    `Evidence: ${evidence.storagePath}/evidence.json`,
    ...(evidence.ineligibilityReasons.length === 0
      ? []
      : [`Ineligible: ${evidence.ineligibilityReasons.join(", ")}`]),
    "",
  ].join("\n");
}

async function runTessl(args: readonly string[], io: CliIo): Promise<CliExitCode> {
  const json = wantsJson(args);
  try {
    const parsed = parseTesslArguments(args);
    const evidence =
      parsed.operation === "review"
        ? await captureTesslReviewEvidence(parsed.project, {
            ...(parsed.executable === undefined ? {} : { executable: parsed.executable }),
            ...(parsed.timeoutSeconds === undefined
              ? {}
              : { timeoutSeconds: parsed.timeoutSeconds }),
            ...(parsed.workspace === undefined ? {} : { workspace: parsed.workspace }),
          })
        : await captureTesslEvalEvidence(parsed.project, {
            source: parsed.source,
            ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
            ...(parsed.model === undefined ? {} : { model: parsed.model }),
            ...(parsed.executable === undefined ? {} : { executable: parsed.executable }),
            ...(parsed.timeoutSeconds === undefined
              ? {}
              : { timeoutSeconds: parsed.timeoutSeconds }),
            ...(parsed.runs === undefined ? {} : { runs: parsed.runs }),
            ...(parsed.pollIntervalMs === undefined
              ? {}
              : { pollIntervalMs: parsed.pollIntervalMs }),
          });
    const output = parsed.json
      ? `${JSON.stringify({ command: `tessl.${parsed.operation}`, ...evidence })}\n`
      : renderHumanTesslReport(evidence);
    if (!(await writeStdout(io, output))) return 1;
    return evidence.evidenceEligible ? 0 : 3;
  } catch (error) {
    if (error instanceof CliUsageError) {
      await writeError(io, json, "usage", error.message, error.issues);
      return 2;
    }
    if (error instanceof ProjectConfigError || error instanceof TesslEvidenceError) {
      await writeError(io, json, "tessl.invalid", error.message, error.issues);
      return 3;
    }
    return writeInternalFailure(io, json, "tessl");
  }
}

async function usageFailure(
  args: readonly string[],
  io: CliIo,
  message: string,
): Promise<CliExitCode> {
  const error = new CliUsageError(message);
  await writeError(io, wantsJson(args), "usage", error.message, error.issues);
  return 2;
}

export async function runCli(args: readonly string[], io: CliIo = defaultIo): Promise<CliExitCode> {
  const capturedIo = snapshotIo(io);
  if (capturedIo === undefined) {
    return 1;
  }
  const argumentSnapshot = snapshotArguments(args);
  if (argumentSnapshot.args === undefined) {
    const error = new CliUsageError("CLI arguments must be a bounded array of strings.");
    await writeError(
      capturedIo,
      argumentSnapshot.jsonRequested,
      "usage",
      error.message,
      error.issues,
    );
    return 2;
  }
  const capturedArgs = argumentSnapshot.args;

  if (capturedArgs.length === 0) {
    return (await writeStdout(capturedIo, renderHelp())) ? 0 : 1;
  }

  if (capturedArgs[0] === "--help" || capturedArgs[0] === "-h" || capturedArgs[0] === "help") {
    if (capturedArgs.length !== 1) {
      return usageFailure(capturedArgs, capturedIo, "Help does not accept additional arguments.");
    }
    return (await writeStdout(capturedIo, renderHelp())) ? 0 : 1;
  }

  if (capturedArgs[0] === "--version" || capturedArgs[0] === "-v") {
    if (capturedArgs.length !== 1) {
      return usageFailure(
        capturedArgs,
        capturedIo,
        "Version does not accept additional arguments.",
      );
    }
    return (await writeStdout(capturedIo, `${VERSION}\n`)) ? 0 : 1;
  }

  if (capturedArgs[0] === "init") {
    if ((capturedArgs[1] === "--help" || capturedArgs[1] === "-h") && capturedArgs.length === 2) {
      return (await writeStdout(capturedIo, renderInitHelp())) ? 0 : 1;
    }
    return runInit(capturedArgs.slice(1), capturedIo);
  }

  if (capturedArgs[0] === "check") {
    if ((capturedArgs[1] === "--help" || capturedArgs[1] === "-h") && capturedArgs.length === 2) {
      return (await writeStdout(capturedIo, renderCheckHelp())) ? 0 : 1;
    }
    return runCheck(capturedArgs.slice(1), capturedIo);
  }

  if (capturedArgs[0] === "test") {
    if ((capturedArgs[1] === "--help" || capturedArgs[1] === "-h") && capturedArgs.length === 2) {
      return (await writeStdout(capturedIo, renderTestHelp())) ? 0 : 1;
    }
    return runTests(capturedArgs.slice(1), capturedIo);
  }

  if (capturedArgs[0] === "eval") {
    if ((capturedArgs[1] === "--help" || capturedArgs[1] === "-h") && capturedArgs.length === 2) {
      return (await writeStdout(capturedIo, renderEvalHelp())) ? 0 : 1;
    }
    return runEval(capturedArgs.slice(1), capturedIo);
  }

  if (capturedArgs[0] === "tessl") {
    if ((capturedArgs[1] === "--help" || capturedArgs[1] === "-h") && capturedArgs.length === 2) {
      return (await writeStdout(capturedIo, renderTesslHelp())) ? 0 : 1;
    }
    return runTessl(capturedArgs.slice(1), capturedIo);
  }

  if (capturedArgs[0] === "package") {
    if ((capturedArgs[1] === "--help" || capturedArgs[1] === "-h") && capturedArgs.length === 2) {
      return (await writeStdout(capturedIo, renderPackageHelp())) ? 0 : 1;
    }
    return runPackageCommand(capturedArgs.slice(1), capturedIo);
  }

  if (capturedArgs[0] === "submit") {
    if ((capturedArgs[1] === "--help" || capturedArgs[1] === "-h") && capturedArgs.length === 2) {
      return (await writeStdout(capturedIo, renderSubmitHelp())) ? 0 : 1;
    }
    return runSubmitCommand(capturedArgs.slice(1), capturedIo);
  }

  if (capturedArgs[0] === "status") {
    if ((capturedArgs[1] === "--help" || capturedArgs[1] === "-h") && capturedArgs.length === 2) {
      return (await writeStdout(capturedIo, renderStatusHelp())) ? 0 : 1;
    }
    return runStatusCommand(capturedArgs.slice(1), capturedIo);
  }

  if (capturedArgs[0] === "doctor") {
    if ((capturedArgs[1] === "--help" || capturedArgs[1] === "-h") && capturedArgs.length === 2) {
      return (await writeStdout(capturedIo, renderDoctorHelp())) ? 0 : 1;
    }
    return runDoctorCommand(capturedArgs.slice(1), capturedIo);
  }

  if (capturedArgs[0] === "improve") {
    if ((capturedArgs[1] === "--help" || capturedArgs[1] === "-h") && capturedArgs.length === 2) {
      return (await writeStdout(capturedIo, renderImproveHelp())) ? 0 : 1;
    }
    return runImproveCommand(capturedArgs.slice(1), capturedIo);
  }

  return usageFailure(capturedArgs, capturedIo, "Unknown command. Run 'skpress --help' for usage.");
}
