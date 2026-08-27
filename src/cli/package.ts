import { ProjectConfigError } from "../config/errors.js";
import {
  packageStagedSkill,
  SkillPackageError,
  type SkillPackageArtifacts,
} from "../package/archive.js";
import {
  SkillStagingError,
  stageCanonicalSkill,
  type StagedCanonicalSkill,
} from "../package/stage.js";
import { isSafePathInput } from "../path-safety.js";
import {
  checkTesslReleaseGate,
  TesslReleaseGateError,
  type TesslReleaseGateReport,
} from "../release/tessl-gate.js";
import type { CliExitCode, CliIo } from "../cli.js";

export const PACKAGE_HELP = `Create reproducible release artifacts after the Tessl gate passes.

Usage:
  skpress package --review-evidence <file> --eval-evidence <file> --eval-source <directory> [options]

Options:
  --project <directory>       Project root; defaults to the current directory
  --review-evidence <file>    Private Tessl Quality evidence file
  --eval-evidence <file>      Private Tessl Impact evidence file
  --eval-source <directory>   Evaluated scenario source inside the project
  --json                      Emit one stable JSON object
  -h, --help                  Show this help

Packaging fails closed unless current, source-bound official Tessl evidence satisfies every
configured release threshold. The returned private artifacts path can be passed to submit.
`;

interface ReleaseIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface GateArguments {
  readonly project: string;
  readonly reviewEvidencePath: string;
  readonly evalEvidencePath: string;
  readonly evalSource: string;
  readonly json: boolean;
}

interface PackageOperations {
  readonly checkGate: typeof checkTesslReleaseGate;
  readonly stage: (project: string) => Promise<StagedCanonicalSkill>;
  readonly package: (
    project: string,
    staged: StagedCanonicalSkill,
  ) => Promise<SkillPackageArtifacts>;
}

class PackageUsageError extends Error {
  readonly issues: readonly ReleaseIssue[];

  constructor(message: string) {
    super(message);
    this.name = "PackageUsageError";
    this.issues = Object.freeze([{ code: "cli.usage", path: "/", message }]);
  }
}

class PackageCommandError extends Error {
  readonly issues: readonly ReleaseIssue[];

  constructor(message: string, path: string) {
    super(message);
    this.name = "PackageCommandError";
    this.issues = Object.freeze([{ code: "release.configuration", path, message }]);
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
    throw new PackageUsageError(`${flag} requires a valid path.`);
  }
  return candidate;
}

function parse(args: readonly string[]): GateArguments {
  const values = new Map<string, string>();
  let json = false;
  const allowed = new Set(["--project", "--review-evidence", "--eval-evidence", "--eval-source"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--json") {
      if (json) throw new PackageUsageError("--json may be specified only once.");
      json = true;
      continue;
    }
    if (!allowed.has(argument)) throw new PackageUsageError("Unknown package option.");
    if (values.has(argument))
      throw new PackageUsageError(`${argument} may be specified only once.`);
    values.set(argument, takeValue(args, index, argument));
    index += 1;
  }
  const required = (flag: string): string => {
    const result = values.get(flag);
    if (result === undefined) throw new PackageUsageError(`${flag} is required.`);
    return result;
  };
  return Object.freeze({
    project: values.get("--project") ?? process.cwd(),
    reviewEvidencePath: required("--review-evidence"),
    evalEvidencePath: required("--eval-evidence"),
    evalSource: required("--eval-source"),
    json,
  });
}

const defaultOperations: PackageOperations = Object.freeze({
  checkGate: checkTesslReleaseGate,
  stage: stageCanonicalSkill,
  package: packageStagedSkill,
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
  issues: readonly ReleaseIssue[],
): Promise<boolean> {
  const detail = issues
    .map((entry) => `- ${entry.path}: ${entry.message} (${entry.code})`)
    .join("\n");
  try {
    await io.stderr(
      json
        ? `${JSON.stringify({ ok: false, code, message, issues })}\n`
        : `package: ${message}\n${detail}${detail === "" ? "" : "\n"}`,
    );
    return true;
  } catch {
    return false;
  }
}

function gateOptions(args: GateArguments) {
  return {
    reviewEvidencePath: args.reviewEvidencePath,
    evalEvidencePath: args.evalEvidencePath,
    evalSource: args.evalSource,
  };
}

function gateHuman(gate: TesslReleaseGateReport): string {
  return `Tessl release gate: ${gate.passed ? "passed" : "blocked"}\nQuality: ${gate.scores.quality ?? "unavailable"}/${gate.thresholds.quality}\nImpact: ${gate.scores.impact ?? "unavailable"}/${gate.thresholds.impact}\n`;
}

function knownIssues(error: unknown): readonly ReleaseIssue[] | undefined {
  if (
    error instanceof ProjectConfigError ||
    error instanceof TesslReleaseGateError ||
    error instanceof SkillStagingError ||
    error instanceof SkillPackageError ||
    error instanceof PackageUsageError ||
    error instanceof PackageCommandError
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

export async function runPackageCommand(
  args: readonly string[],
  io: CliIo,
  operations: PackageOperations = defaultOperations,
): Promise<CliExitCode> {
  let parsed: GateArguments;
  try {
    parsed = parse(args);
  } catch (error) {
    const usage = error as PackageUsageError;
    return (await failure(io, args.includes("--json"), "usage", usage.message, usage.issues))
      ? 2
      : 1;
  }
  try {
    const gate = await operations.checkGate(parsed.project, gateOptions(parsed));
    if (!gate.passed) {
      return (await output(
        io,
        parsed.json,
        { command: "package", ok: false, status: "blocked", gate },
        gateHuman(gate),
      ))
        ? 3
        : 1;
    }
    const staged = await operations.stage(parsed.project);
    if (staged.sourceCommit !== gate.sourceCommit) {
      throw new PackageCommandError("Source changed after the Tessl release gate.", "/project");
    }
    const artifacts = await operations.package(parsed.project, staged);
    const finalGate = await operations.checkGate(parsed.project, gateOptions(parsed));
    if (!finalGate.passed || finalGate.sourceCommit !== staged.sourceCommit) {
      return (await output(
        io,
        parsed.json,
        { command: "package", ok: false, status: "blocked", gate: finalGate, artifacts },
        gateHuman(finalGate),
      ))
        ? 3
        : 1;
    }
    const report = { command: "package", ok: true, status: "packaged", gate: finalGate, artifacts };
    const human = `${gateHuman(finalGate)}Artifacts: ${artifacts.artifactsPath}\nSHA-256: ${artifacts.artifactSha256}\n`;
    return (await output(io, parsed.json, report, human)) ? 0 : 1;
  } catch (error) {
    if (isUnavailableStorageError(error)) {
      return (await failure(
        io,
        parsed.json,
        "release_blocked",
        "Required private release evidence or artifacts are unavailable.",
        [
          {
            code: "release.storage.unavailable",
            path: "/release",
            message: "required private release evidence or artifacts are unavailable",
          },
        ],
      ))
        ? 3
        : 1;
    }
    const issues = knownIssues(error);
    if (issues !== undefined) {
      return (await failure(io, parsed.json, "release_blocked", (error as Error).message, issues))
        ? 3
        : 1;
    }
    await failure(io, parsed.json, "internal", "Package failed unexpectedly.", []);
    return 1;
  }
}
