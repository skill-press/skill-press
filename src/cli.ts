import { join } from "node:path";

import { checkProject } from "./check/project.js";
import type { SkillPressCheckReport } from "./check/types.js";
import { ProjectConfigError } from "./config/errors.js";
import { CapabilityBriefError, ProjectCreationError } from "./create/errors.js";
import { loadCapabilityBrief } from "./create/load.js";
import { renderCapabilityProject } from "./create/render.js";
import { writeRenderedProject } from "./create/write.js";
import { isSafePathInput } from "./path-safety.js";
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
const HELP = `SkillPress ${VERSION}

Build, evaluate, package, and publish production-grade Agent Skills.

Usage:
  skillpress [options]
  skillpress <command> [options]

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version

Commands:
  create             Create a complete canonical skill project from a strict brief
  check              Validate a project and report local readiness
  test               Run deterministic project test commands without a shell

The eval, package, publish, status, and doctor commands will be
enabled as their independently reviewed implementation slices land.
`;

const CREATE_HELP = `Create a canonical SkillPress project from a complete capability brief.

Usage:
  skillpress create --brief <file> --output <new-directory> [--json]

Options:
  --brief <file>             Read the strict capability brief from this regular YAML file
  --output <new-directory>  Create this directory; it must not already exist
  --json                     Emit one stable JSON object
  -h, --help                 Show this help
`;

const CHECK_HELP = `Validate a SkillPress project and report local readiness.

Usage:
  skillpress check [--project <directory>] [--json]

Options:
  --project <directory>  Project root containing skillpress.yaml; defaults to the current directory
  --json                 Emit one stable JSON object
  -h, --help             Show this help
`;

const TEST_HELP = `Run deterministic SkillPress project test commands without a shell.

Usage:
  skillpress test [--project <directory>] [--json]

Options:
  --project <directory>  Project root containing skillpress.yaml; defaults to the current directory
  --json                 Emit one stable JSON object
  -h, --help             Show this help
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

interface ArgumentSnapshot {
  readonly args?: readonly string[];
  readonly jsonRequested: boolean;
}

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

export function renderCreateHelp(): string {
  return CREATE_HELP;
}

export function renderCheckHelp(): string {
  return CHECK_HELP;
}

export function renderTestHelp(): string {
  return TEST_HELP;
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
      throw new CliUsageError("Unknown create argument.");
    }
  }

  if (brief === undefined || output === undefined) {
    throw new CliUsageError("create requires both --brief and --output.");
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

function wantsJson(args: readonly string[]): boolean {
  return args.includes("--json");
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
    { code: `${command}.internal`, path: "/", message: "unexpected internal failure" },
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

async function runCreate(args: readonly string[], io: CliIo): Promise<CliExitCode> {
  const json = wantsJson(args);
  let parsed: CreateArguments;
  try {
    parsed = parseCreateArguments(args);
    const brief = await loadCapabilityBrief(parsed.brief);
    const result = await writeRenderedProject(renderCapabilityProject(brief), parsed.output);
    if (parsed.json) {
      if (
        !(await writeStdout(io, `${JSON.stringify({ ok: true, command: "create", ...result })}\n`))
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
        unsafe ? "create.unsafe_output" : "create.io",
        error.message,
        error.issues,
      );
      return unsafe ? 4 : 1;
    }
    return writeInternalFailure(io, json, "create");
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

  if (capturedArgs[0] === "create") {
    if ((capturedArgs[1] === "--help" || capturedArgs[1] === "-h") && capturedArgs.length === 2) {
      return (await writeStdout(capturedIo, renderCreateHelp())) ? 0 : 1;
    }
    return runCreate(capturedArgs.slice(1), capturedIo);
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

  return usageFailure(
    capturedArgs,
    capturedIo,
    "Unknown command. Run 'skillpress --help' for usage.",
  );
}
