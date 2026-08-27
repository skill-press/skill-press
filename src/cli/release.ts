import { loadProjectConfig } from "../config/load.js";
import { ProjectConfigError } from "../config/errors.js";
import {
  loadPackagedSkill,
  packageStagedSkill,
  SkillPackageError,
  type LoadedSkillPackageArtifacts,
  type SkillPackageArtifacts,
} from "../package/archive.js";
import {
  SkillStagingError,
  stageCanonicalSkill,
  type StagedCanonicalSkill,
} from "../package/stage.js";
import { isSafePathInput } from "../path-safety.js";
import { createAgentSkillsHubCatalogAdapter } from "../publish/adapters/agent-skills-hub-catalog.js";
import { createAgentSkillHubPublicationAdapter } from "../publish/adapters/agentskillhub.js";
import { createAskillPublicationAdapter } from "../publish/adapters/askill.js";
import { createClawHubPublicationAdapter } from "../publish/adapters/clawhub.js";
import { createGitHubPublicationAdapter } from "../publish/adapters/github.js";
import { createNpmPublicationAdapter } from "../publish/adapters/npm.js";
import { createSkillsShDerivedAdapter } from "../publish/adapters/skills-sh.js";
import { createTesslPublicationAdapter } from "../publish/adapters/tessl.js";
import {
  PublicationSagaError,
  runPublicationSaga,
  type PublicationAdapter,
  type PublicationReceipt,
} from "../publish/saga.js";
import {
  checkTesslReleaseGate,
  TesslReleaseGateError,
  type TesslReleaseGateReport,
} from "../release/tessl-gate.js";
import type { CliExitCode, CliIo } from "../cli.js";

export const PACKAGE_HELP = `Create reproducible release artifacts after the Tessl gate passes.

Usage:
  skillpress package --review-evidence <file> --eval-evidence <file> --eval-source <directory> [options]

Options:
  --project <directory>       Project root; defaults to the current directory
  --review-evidence <file>    Private Tessl Quality evidence file
  --eval-evidence <file>      Private Tessl Impact evidence file
  --eval-source <directory>   Evaluated scenario source inside the project
  --json                      Emit one stable JSON object
  -h, --help                  Show this help

Packaging fails closed unless current, source-bound official Tessl evidence satisfies every
configured release threshold. The returned private artifacts path can be passed to publish.
`;

export const PUBLISH_HELP = `Plan, execute, or resume publication from a verified private package.

Usage:
  skillpress publish --artifacts <directory> --review-evidence <file> --eval-evidence <file>
    --eval-source <directory> [options]

Options:
  --project <directory>       Project root; defaults to the current directory
  --artifacts <directory>     Exact .skillpress/staging/<run>/artifacts path from package
  --review-evidence <file>    Private Tessl Quality evidence file
  --eval-evidence <file>      Private Tessl Impact evidence file
  --eval-source <directory>   Evaluated scenario source inside the project
  --execute                   Permit configured remote mutations; default is dry-run
  --resume <receipt>          Resume an executed private publication receipt; requires --execute
  --tessl-workspace <name>    Required when tessl is a configured target
  --tessl-executable <path>   Versioned official Tessl CLI; PATH launchers may be untrusted
  --askill-author <name>      askill.sh author; defaults to project.author.github
  --askill-executable <path>  askill CLI; defaults to askill on PATH
  --catalog-contributor <id>  Catalog fork owner; defaults to project.author.github
  --clawhub-owner <name>      ClawHub owner; defaults to project.author.github
  --clawhub-executable <path> ClawHub CLI; defaults to clawhub on PATH
  --accept-clawhub-mit0       Explicitly accept the ClawHub MIT-0 projection when configured
  --json                      Emit one stable JSON object
  -h, --help                  Show this help

Every invocation rechecks the Tessl release gate and the complete artifact inventory. Execution
is explicit, journaled after each mutating step, remotely verified, and resumable by receipt.
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

export interface PublishArguments extends GateArguments {
  readonly artifactsPath: string;
  readonly execute: boolean;
  readonly resumeReceiptPath?: string;
  readonly tesslWorkspace?: string;
  readonly tesslExecutable?: string;
  readonly askillAuthor?: string;
  readonly askillExecutable?: string;
  readonly catalogContributor?: string;
  readonly clawHubOwner?: string;
  readonly clawHubExecutable?: string;
  readonly acceptClawHubMit0: boolean;
}

interface ReleaseCommandOperations {
  readonly checkGate: (
    project: string,
    options: {
      readonly reviewEvidencePath: string;
      readonly evalEvidencePath: string;
      readonly evalSource: string;
    },
  ) => Promise<TesslReleaseGateReport>;
  readonly stage: (project: string) => Promise<StagedCanonicalSkill>;
  readonly package: (
    project: string,
    staged: StagedCanonicalSkill,
  ) => Promise<SkillPackageArtifacts>;
  readonly load: (project: string, artifactsPath: string) => Promise<LoadedSkillPackageArtifacts>;
  readonly adapters: (args: PublishArguments) => Promise<readonly PublicationAdapter[]>;
  readonly publish: typeof runPublicationSaga;
}

class ReleaseUsageError extends Error {
  readonly issues: readonly ReleaseIssue[];

  constructor(message: string) {
    super(message);
    this.name = "ReleaseUsageError";
    this.issues = Object.freeze([{ code: "cli.usage", path: "/", message }]);
  }
}

class ReleaseCommandError extends Error {
  readonly issues: readonly ReleaseIssue[];

  constructor(message: string, path: string) {
    super(message);
    this.name = "ReleaseCommandError";
    this.issues = Object.freeze([{ code: "release.configuration", path, message }]);
  }
}

function value(args: readonly string[], index: number, flag: string, path: boolean): string {
  const candidate = args[index + 1];
  if (
    candidate === undefined ||
    candidate.startsWith("--") ||
    candidate.length > 4096 ||
    (path && !isSafePathInput(candidate))
  ) {
    throw new ReleaseUsageError(`${flag} requires a valid ${path ? "path" : "value"}.`);
  }
  return candidate;
}

function parse(args: readonly string[], publish: boolean): GateArguments | PublishArguments {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const pathFlags = new Set([
    "--project",
    "--review-evidence",
    "--eval-evidence",
    "--eval-source",
    "--artifacts",
    "--resume",
    "--tessl-executable",
    "--askill-executable",
    "--clawhub-executable",
  ]);
  const valueFlags = new Set([
    "--project",
    "--review-evidence",
    "--eval-evidence",
    "--eval-source",
    ...(publish
      ? [
          "--artifacts",
          "--resume",
          "--tessl-workspace",
          "--tessl-executable",
          "--askill-author",
          "--askill-executable",
          "--catalog-contributor",
          "--clawhub-owner",
          "--clawhub-executable",
        ]
      : []),
  ]);
  const booleanFlags = new Set([
    "--json",
    ...(publish ? ["--execute", "--accept-clawhub-mit0"] : []),
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (booleanFlags.has(argument)) {
      if (booleans.has(argument))
        throw new ReleaseUsageError(`${argument} may be specified only once.`);
      booleans.add(argument);
      continue;
    }
    if (!valueFlags.has(argument)) throw new ReleaseUsageError("Unknown release option.");
    if (values.has(argument))
      throw new ReleaseUsageError(`${argument} may be specified only once.`);
    values.set(argument, value(args, index, argument, pathFlags.has(argument)));
    index += 1;
  }
  const required = (flag: string): string => {
    const result = values.get(flag);
    if (result === undefined) throw new ReleaseUsageError(`${flag} is required.`);
    return result;
  };
  const common: GateArguments = Object.freeze({
    project: values.get("--project") ?? process.cwd(),
    reviewEvidencePath: required("--review-evidence"),
    evalEvidencePath: required("--eval-evidence"),
    evalSource: required("--eval-source"),
    json: booleans.has("--json"),
  });
  if (!publish) return common;
  const resumeReceiptPath = values.get("--resume");
  if (resumeReceiptPath !== undefined && !booleans.has("--execute")) {
    throw new ReleaseUsageError("--resume requires --execute.");
  }
  return Object.freeze({
    ...common,
    artifactsPath: required("--artifacts"),
    execute: booleans.has("--execute"),
    ...(resumeReceiptPath === undefined ? {} : { resumeReceiptPath }),
    ...(values.get("--tessl-workspace") === undefined
      ? {}
      : { tesslWorkspace: values.get("--tessl-workspace") as string }),
    ...(values.get("--tessl-executable") === undefined
      ? {}
      : { tesslExecutable: values.get("--tessl-executable") as string }),
    ...(values.get("--askill-author") === undefined
      ? {}
      : { askillAuthor: values.get("--askill-author") as string }),
    ...(values.get("--askill-executable") === undefined
      ? {}
      : { askillExecutable: values.get("--askill-executable") as string }),
    ...(values.get("--catalog-contributor") === undefined
      ? {}
      : { catalogContributor: values.get("--catalog-contributor") as string }),
    ...(values.get("--clawhub-owner") === undefined
      ? {}
      : { clawHubOwner: values.get("--clawhub-owner") as string }),
    ...(values.get("--clawhub-executable") === undefined
      ? {}
      : { clawHubExecutable: values.get("--clawhub-executable") as string }),
    acceptClawHubMit0: booleans.has("--accept-clawhub-mit0"),
  });
}

function githubSource(repository: string): string {
  const url = new URL(repository);
  const parts = url.pathname
    .replace(/[.]git$/u, "")
    .split("/")
    .filter(Boolean);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || parts.length !== 2) {
    throw new ReleaseCommandError(
      "Configured repository must be a canonical GitHub URL.",
      "/project/repository",
    );
  }
  return `${parts[0]}/${parts[1]}`;
}

export async function createConfiguredPublicationAdapters(
  args: PublishArguments,
): Promise<readonly PublicationAdapter[]> {
  const config = await loadProjectConfig(args.project);
  const source = githubSource(config.project.repository);
  return Object.freeze(
    config.publish.targets.map((target): PublicationAdapter => {
      switch (target) {
        case "github":
          return createGitHubPublicationAdapter();
        case "npm":
          return createNpmPublicationAdapter();
        case "tessl":
          if (args.tesslWorkspace === undefined) {
            throw new ReleaseCommandError(
              "--tessl-workspace is required for the configured Tessl target.",
              "/publish/tessl",
            );
          }
          return createTesslPublicationAdapter({
            workspace: args.tesslWorkspace,
            ...(args.tesslExecutable === undefined ? {} : { executable: args.tesslExecutable }),
          });
        case "skills-sh":
          return createSkillsShDerivedAdapter({ source });
        case "askill-sh":
          return createAskillPublicationAdapter({
            author: args.askillAuthor ?? config.project.author.github,
            ...(args.askillExecutable === undefined ? {} : { executable: args.askillExecutable }),
          });
        case "agentskillhub-dev":
          return createAgentSkillHubPublicationAdapter();
        case "agent-skills-hub-catalog":
          return createAgentSkillsHubCatalogAdapter({
            contributor: args.catalogContributor ?? config.project.author.github,
          });
        case "clawhub":
          if (!args.acceptClawHubMit0) {
            throw new ReleaseCommandError(
              "--accept-clawhub-mit0 is required for the configured ClawHub projection.",
              "/publish/clawhub",
            );
          }
          return createClawHubPublicationAdapter({
            owner: args.clawHubOwner ?? config.project.author.github,
            licenseConsent: "MIT-0",
            ...(args.clawHubExecutable === undefined ? {} : { executable: args.clawHubExecutable }),
          });
        default:
          throw new ReleaseCommandError(
            "Configured publication target is unsupported.",
            "/publish/targets",
          );
      }
    }),
  );
}

const defaultOperations: ReleaseCommandOperations = Object.freeze({
  checkGate: checkTesslReleaseGate,
  stage: stageCanonicalSkill,
  package: packageStagedSkill,
  load: loadPackagedSkill,
  adapters: createConfiguredPublicationAdapters,
  publish: runPublicationSaga,
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
  command: string,
  code: string,
  message: string,
  issues: readonly ReleaseIssue[],
): Promise<boolean> {
  const report = { ok: false, code, message, issues };
  const detail = issues
    .map((entry) => `- ${entry.path}: ${entry.message} (${entry.code})`)
    .join("\n");
  try {
    await io.stderr(
      json
        ? `${JSON.stringify(report)}\n`
        : `${command}: ${message}\n${detail}${detail === "" ? "" : "\n"}`,
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

function receiptHuman(receipt: PublicationReceipt): string {
  const targets = receipt.targets
    .map((target) => `- ${target.id}: ${target.status} (${target.preflight.code})`)
    .join("\n");
  return `Publication: ${receipt.status}\nMode: ${receipt.execute ? "execute" : "dry-run"}\nReceipt: ${receipt.storagePath ?? "not persisted"}\n${targets}\n`;
}

function knownIssues(error: unknown): readonly ReleaseIssue[] | undefined {
  if (
    error instanceof ProjectConfigError ||
    error instanceof TesslReleaseGateError ||
    error instanceof SkillStagingError ||
    error instanceof SkillPackageError ||
    error instanceof PublicationSagaError ||
    error instanceof ReleaseUsageError ||
    error instanceof ReleaseCommandError
  ) {
    return error.issues;
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    ["EACCES", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].includes(error.code)
  ) {
    return Object.freeze([
      {
        code: "release.storage.unavailable",
        path: "/release",
        message: "required private release evidence or artifacts are unavailable",
      },
    ]);
  }
  return undefined;
}

export async function runPackageCommand(
  args: readonly string[],
  io: CliIo,
  operations: ReleaseCommandOperations = defaultOperations,
): Promise<CliExitCode> {
  let parsed: GateArguments;
  try {
    parsed = parse(args, false) as GateArguments;
  } catch (error) {
    const usage = error as ReleaseUsageError;
    return (await failure(
      io,
      args.includes("--json"),
      "package",
      "usage",
      usage.message,
      usage.issues,
    ))
      ? 2
      : 1;
  }
  try {
    const gate = await operations.checkGate(parsed.project, gateOptions(parsed));
    if (!gate.passed) {
      const report = { command: "package", ok: false, status: "blocked", gate };
      return (await output(io, parsed.json, report, gateHuman(gate))) ? 3 : 1;
    }
    const staged = await operations.stage(parsed.project);
    if (staged.sourceCommit !== gate.sourceCommit) {
      throw new ReleaseCommandError("Source changed after the Tessl release gate.", "/project");
    }
    const artifacts = await operations.package(parsed.project, staged);
    const finalGate = await operations.checkGate(parsed.project, gateOptions(parsed));
    if (!finalGate.passed || finalGate.sourceCommit !== staged.sourceCommit) {
      const report = {
        command: "package",
        ok: false,
        status: "blocked",
        gate: finalGate,
        artifacts,
      };
      return (await output(io, parsed.json, report, gateHuman(finalGate))) ? 3 : 1;
    }
    const report = {
      command: "package",
      ok: true,
      status: "packaged",
      gate: finalGate,
      artifacts,
    };
    const human = `${gateHuman(finalGate)}Artifacts: ${artifacts.artifactsPath}\nSHA-256: ${artifacts.artifactSha256}\n`;
    return (await output(io, parsed.json, report, human)) ? 0 : 1;
  } catch (error) {
    const issues = knownIssues(error);
    if (issues !== undefined) {
      return (await failure(
        io,
        parsed.json,
        "package",
        "release_blocked",
        (error as Error).message,
        issues,
      ))
        ? 3
        : 1;
    }
    await failure(io, parsed.json, "package", "internal", "Package failed unexpectedly.", []);
    return 1;
  }
}

export async function runPublishCommand(
  args: readonly string[],
  io: CliIo,
  operations: ReleaseCommandOperations = defaultOperations,
): Promise<CliExitCode> {
  let parsed: PublishArguments;
  try {
    parsed = parse(args, true) as PublishArguments;
  } catch (error) {
    const usage = error as ReleaseUsageError;
    return (await failure(
      io,
      args.includes("--json"),
      "publish",
      "usage",
      usage.message,
      usage.issues,
    ))
      ? 2
      : 1;
  }
  try {
    const gate = await operations.checkGate(parsed.project, gateOptions(parsed));
    if (!gate.passed) {
      const report = { command: "publish", ok: false, status: "blocked", gate };
      return (await output(io, parsed.json, report, gateHuman(gate))) ? 3 : 1;
    }
    const artifacts = await operations.load(parsed.project, parsed.artifactsPath);
    if (artifacts.sourceCommit !== gate.sourceCommit) {
      throw new ReleaseCommandError(
        "Package source does not match the current Tessl gate.",
        "/artifacts",
      );
    }
    const receipt = await operations.publish(
      parsed.project,
      artifacts,
      await operations.adapters(parsed),
      {
        execute: parsed.execute,
        ...(parsed.resumeReceiptPath === undefined
          ? {}
          : { resumeReceiptPath: parsed.resumeReceiptPath }),
      },
    );
    const ok =
      receipt.status === "completed" ||
      (receipt.status === "dry_run" && receipt.targets.every((target) => target.preflight.ok));
    const report = {
      command: "publish",
      ok,
      status: receipt.status,
      gate,
      receipt,
    };
    return (await output(io, parsed.json, report, `${gateHuman(gate)}${receiptHuman(receipt)}`))
      ? ok
        ? 0
        : 3
      : 1;
  } catch (error) {
    const issues = knownIssues(error);
    if (issues !== undefined || error instanceof TypeError) {
      return (await failure(
        io,
        parsed.json,
        "publish",
        "release_blocked",
        (error as Error).message,
        issues ?? [
          {
            code: "release.configuration",
            path: "/publish",
            message: (error as Error).message,
          },
        ],
      ))
        ? 3
        : 1;
    }
    await failure(io, parsed.json, "publish", "internal", "Publication failed unexpectedly.", []);
    return 1;
  }
}
