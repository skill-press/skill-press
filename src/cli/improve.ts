import { ProjectConfigError } from "../config/errors.js";
import { EvaluationInputError } from "../eval/errors.js";
import {
  runCommandImprovement,
  type CommandImprovementOptions,
  type CommandImprovementResult,
  type ImprovementRoleCommand,
} from "../improve/command-workflow.js";
import { ImprovementLoopError } from "../improve/state-machine.js";
import { ImprovementWorkflowError } from "../improve/workflow-error.js";
import { isSafePathInput } from "../path-safety.js";
import type { CliExitCode, CliIo } from "../cli.js";

export const IMPROVE_HELP = `Run a bounded author/reviewer/evaluator loop from measured paired-eval failures.

Usage:
  skillpress improve --training-evidence <file> --holdout-evidence <file>
    --author-command <executable> --reviewer-command <executable>
    --evaluator-command <executable> [options]

Options:
  --project <directory>       Project root; defaults to the current directory
  --training-evidence <file>  Complete current training paired-eval evidence
  --holdout-evidence <file>   Complete current holdout paired-eval evidence
  --author-command <command>  Author role executable or PATH command
  --author-arg <value>        Author argv item; may be repeated
  --author-env <NAME>         Explicit environment name forwarded to author; may be repeated
  --reviewer-command <cmd>    Reviewer role executable or PATH command
  --reviewer-arg <value>      Reviewer argv item; may be repeated
  --reviewer-env <NAME>       Explicit environment name forwarded to reviewer; may be repeated
  --evaluator-command <cmd>   Evaluator role executable or PATH command
  --evaluator-arg <value>     Evaluator argv item; may be repeated
  --evaluator-env <NAME>      Explicit environment name forwarded to evaluator; may be repeated
  --command-timeout <seconds> Per-role timeout from 1 to 7200; defaults to 900
  --json                      Emit one stable JSON object
  -h, --help                  Show this help

Each role is executed without a shell in a fresh private temporary directory. SkillPress appends
--skillpress-operation, --request, and --response arguments. The adapter must overwrite the
pre-created response file with schemas/improve-adapter-response.schema.json. Author requests carry
the current candidate and training context only; holdout suites are sent only to the evaluator.
Accepted candidates replace the canonical skill with a private rollback backup after validation.
`;

interface ImproveIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

interface ImproveArguments {
  readonly project: string;
  readonly options: CommandImprovementOptions;
  readonly json: boolean;
}

interface ImproveCommandOperations {
  readonly improve: (
    project: string,
    options: CommandImprovementOptions,
  ) => Promise<CommandImprovementResult>;
}

class ImproveUsageError extends Error {
  readonly issues: readonly ImproveIssue[];

  constructor(message: string) {
    super(message);
    this.name = "ImproveUsageError";
    this.issues = Object.freeze([{ code: "cli.usage", path: "/", message }]);
  }
}

const defaultOperations: ImproveCommandOperations = Object.freeze({
  improve: runCommandImprovement,
});
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

function pathValue(args: readonly string[], index: number, flag: string): string {
  const candidate = args[index + 1];
  if (
    candidate === undefined ||
    candidate.startsWith("--") ||
    candidate.length > 4096 ||
    !isSafePathInput(candidate)
  ) {
    throw new ImproveUsageError(`${flag} requires a valid path or command.`);
  }
  return candidate;
}

function rawValue(args: readonly string[], index: number, flag: string): string {
  const candidate = args[index + 1];
  if (
    candidate === undefined ||
    candidate.length === 0 ||
    candidate.length > 4096 ||
    candidate.includes("\0")
  ) {
    throw new ImproveUsageError(`${flag} requires a bounded argument value.`);
  }
  return candidate;
}

function integer(value: string, flag: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new ImproveUsageError(`${flag} requires an integer.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 7200) {
    throw new ImproveUsageError(`${flag} must be from 1 to 7200.`);
  }
  return result;
}

function parse(args: readonly string[]): ImproveArguments {
  const singles = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  let json = false;
  const pathFlags = new Set([
    "--project",
    "--training-evidence",
    "--holdout-evidence",
    "--author-command",
    "--reviewer-command",
    "--evaluator-command",
  ]);
  const singleFlags = new Set([...pathFlags, "--command-timeout"]);
  const repeatedFlags = new Set([
    "--author-arg",
    "--reviewer-arg",
    "--evaluator-arg",
    "--author-env",
    "--reviewer-env",
    "--evaluator-env",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--json") {
      if (json) throw new ImproveUsageError("--json may be specified only once.");
      json = true;
      continue;
    }
    if (singleFlags.has(argument)) {
      if (singles.has(argument))
        throw new ImproveUsageError(`${argument} may be specified only once.`);
      singles.set(
        argument,
        pathFlags.has(argument)
          ? pathValue(args, index, argument)
          : rawValue(args, index, argument),
      );
      index += 1;
      continue;
    }
    if (repeatedFlags.has(argument)) {
      const values = repeated.get(argument) ?? [];
      if (values.length >= 31) throw new ImproveUsageError("Improvement role argv is too large.");
      values.push(rawValue(args, index, argument));
      repeated.set(argument, values);
      index += 1;
      continue;
    }
    throw new ImproveUsageError("Unknown improve option.");
  }
  const required = (flag: string) => {
    const value = singles.get(flag);
    if (value === undefined) throw new ImproveUsageError(`${flag} is required.`);
    return value;
  };
  const environment = (flag: string): Readonly<Record<string, string>> => {
    const result: Record<string, string> = {};
    for (const name of repeated.get(flag) ?? []) {
      if (!ENVIRONMENT_NAME.test(name) || result[name] !== undefined) {
        throw new ImproveUsageError("Role environment names must be unique canonical names.");
      }
      const value = process.env[name];
      if (value === undefined)
        throw new ImproveUsageError("A requested role environment value is unavailable.");
      result[name] = value;
    }
    return Object.freeze(result);
  };
  const command = (
    commandFlag: string,
    argumentFlag: string,
    environmentFlag: string,
  ): ImprovementRoleCommand => {
    const executable = required(commandFlag);
    const argv = [executable, ...(repeated.get(argumentFlag) ?? [])] as [string, ...string[]];
    const env = environment(environmentFlag);
    return Object.freeze({
      argv: Object.freeze(argv),
      ...(Object.keys(env).length === 0 ? {} : { env }),
    });
  };
  const timeout = singles.get("--command-timeout");
  return Object.freeze({
    project: singles.get("--project") ?? process.cwd(),
    options: Object.freeze({
      trainingEvidencePath: required("--training-evidence"),
      holdoutEvidencePath: required("--holdout-evidence"),
      author: command("--author-command", "--author-arg", "--author-env"),
      reviewer: command("--reviewer-command", "--reviewer-arg", "--reviewer-env"),
      evaluator: command("--evaluator-command", "--evaluator-arg", "--evaluator-env"),
      ...(timeout === undefined
        ? {}
        : { commandTimeoutSeconds: integer(timeout, "--command-timeout") }),
    }),
    json,
  });
}

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
  issues: readonly ImproveIssue[],
): Promise<boolean> {
  try {
    if (json) {
      await io.stderr(`${JSON.stringify({ ok: false, code, message, issues })}\n`);
    } else {
      const detail = issues
        .map((entry) => `- ${entry.path}: ${entry.message} [${entry.code}]`)
        .join("\n");
      await io.stderr(`${message}\n${detail === "" ? "" : `${detail}\n`}`);
    }
    return true;
  } catch {
    return false;
  }
}

function knownIssues(error: unknown): readonly ImproveIssue[] | undefined {
  if (
    error instanceof ProjectConfigError ||
    error instanceof EvaluationInputError ||
    error instanceof ImprovementLoopError ||
    error instanceof ImprovementWorkflowError ||
    error instanceof ImproveUsageError
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
        code: "improve.storage.unavailable",
        path: "/",
        message: "required improvement input or storage is unavailable",
      },
    ];
  }
  return undefined;
}

function human(result: CommandImprovementResult): string {
  return `Improvement: ${result.report.success ? "target reached" : "stopped"}\nChanged: ${result.changed ? "yes" : "no"}\nStop reason: ${result.report.stopReason}\nIterations: ${result.report.budget.iterationsUsed}\nReport: ${result.storagePath}\n`;
}

export async function runImproveCommand(
  args: readonly string[],
  io: CliIo,
  operations: ImproveCommandOperations = defaultOperations,
): Promise<CliExitCode> {
  let parsed: ImproveArguments;
  try {
    parsed = parse(args);
  } catch (error) {
    const usage = error as ImproveUsageError;
    return (await failure(io, args.includes("--json"), "usage", usage.message, usage.issues))
      ? 2
      : 1;
  }
  try {
    const result = await operations.improve(parsed.project, parsed.options);
    const value = { command: "improve", ok: result.report.success, ...result };
    return (await output(io, parsed.json, value, human(result)))
      ? result.report.success
        ? 0
        : 3
      : 1;
  } catch (error) {
    const issues = knownIssues(error);
    if (issues !== undefined) {
      return (await failure(io, parsed.json, "improve_blocked", (error as Error).message, issues))
        ? 3
        : 1;
    }
    await failure(io, parsed.json, "internal", "Improvement failed unexpectedly.", []);
    return 1;
  }
}
