import { isSafePathInput } from "../path-safety.js";
import {
  addTrustedSkill,
  installTrustedSkills,
  parseExactSkillLocator,
  TrustedInstallError,
  type TrustedInstallResult,
} from "../install/index.js";
import type { CliExitCode, CliIo } from "../cli.js";

export const ADD_HELP = `Add one exact trusted Skill Press release.

Usage:
  skpress add <namespace>/<skill>@<version> [options]

Options:
  --project <directory>  Project root; defaults to the current directory
  --json                 Emit one stable JSON object
  -h, --help             Show this help

The release, signed attestation, signed trust event, short-lived current-trust checkpoint,
digest, and archive are verified against the canonical Skill Press registry. Quarantined,
revoked, stale, cached, or unavailable trust state fails closed.
In a Git project, .agents/skills/ must be explicitly ignored and the target must be untracked.
`;

export const INSTALL_HELP = `Install every exact release in skill-lock.json.

Usage:
  skpress install [options]

Options:
  --project <directory>  Project root; defaults to the current directory
  --json                 Emit one stable JSON object
  -h, --help             Show this help

Install always refreshes current signed trust state. Offline installation is not a trust check
and is intentionally unsupported.
In a Git project, .agents/skills/ must be explicitly ignored and installed bytes stay local-only.
Existing local bytes are never auto-deleted on an error; confirmed revocation requires operator
deactivation after stopping agents that may already have loaded the skill.
`;

interface InstallCliIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

interface CommonArguments {
  readonly project: string;
  readonly json: boolean;
}

interface AddArguments extends CommonArguments {
  readonly locator: string;
}

interface InstallCommandOperations {
  readonly add: typeof addTrustedSkill;
  readonly install: typeof installTrustedSkills;
}

class InstallUsageError extends Error {
  readonly issues: readonly InstallCliIssue[];

  constructor(message: string, path = "/") {
    super(message);
    this.name = "InstallUsageError";
    this.issues = Object.freeze([{ code: "cli.usage", path, message }]);
  }
}

const defaultOperations: InstallCommandOperations = Object.freeze({
  add: addTrustedSkill,
  install: installTrustedSkills,
});

function parseCommon(
  args: readonly string[],
  command: "add" | "install",
): { readonly project: string; readonly json: boolean; readonly positional: readonly string[] } {
  let project = process.cwd();
  let projectSeen = false;
  let json = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--json") {
      if (json) throw new InstallUsageError("--json may be specified only once.");
      json = true;
      continue;
    }
    if (argument === "--project") {
      if (projectSeen) throw new InstallUsageError("--project may be specified only once.");
      const value = args[index + 1];
      if (
        value === undefined ||
        value.startsWith("-") ||
        value.length > 4096 ||
        !isSafePathInput(value)
      ) {
        throw new InstallUsageError("--project requires a valid path.", "/project");
      }
      project = value;
      projectSeen = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new InstallUsageError(`Unknown ${command} option.`);
    }
    positional.push(argument);
  }
  return Object.freeze({ project, json, positional: Object.freeze(positional) });
}

function parseAdd(args: readonly string[]): AddArguments {
  const common = parseCommon(args, "add");
  if (common.positional.length !== 1) {
    throw new InstallUsageError("add requires exactly one namespace/skill@version locator.");
  }
  const candidate = common.positional[0] as string;
  let locator: string;
  try {
    locator = parseExactSkillLocator(candidate).locator;
  } catch {
    throw new InstallUsageError(
      "add requires an exact namespace/skill@semantic-version locator.",
      "/locator",
    );
  }
  return Object.freeze({ project: common.project, json: common.json, locator });
}

function parseInstall(args: readonly string[]): CommonArguments {
  const common = parseCommon(args, "install");
  if (common.positional.length !== 0) {
    throw new InstallUsageError("install does not accept a locator.");
  }
  return Object.freeze({ project: common.project, json: common.json });
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
  command: "add" | "install",
  io: CliIo,
  json: boolean,
  code: string,
  message: string,
  issues: readonly InstallCliIssue[],
): Promise<boolean> {
  const detail = issues
    .map((entry) => `- ${entry.path}: ${entry.message} (${entry.code})`)
    .join("\n");
  try {
    await io.stderr(
      json
        ? `${JSON.stringify({ command, ok: false, code, message, issues })}\n`
        : `${command}: ${message}\n${detail}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

function reportResult(result: TrustedInstallResult) {
  return {
    locator: result.entry.locator,
    installedPath: result.entry.installedPath,
    artifactSha256: result.entry.artifact.sha256,
    attestationSha256: result.entry.attestation.sha256,
    trust: result.entry.trust,
    changed: result.changed,
  } as const;
}

function resultHuman(result: TrustedInstallResult): string {
  return `${result.changed ? "Installed" : "Verified"}: ${result.entry.locator}\nPath: ${result.entry.installedPath}\nTrust: ${result.entry.trust.status} (sequence ${result.entry.trust.sequence})\nArtifact SHA-256: ${result.entry.artifact.sha256}\n`;
}

function trustedIssue(error: TrustedInstallError): readonly InstallCliIssue[] {
  const path = error.code.startsWith("lock_") ? "/skill-lock.json" : "/install";
  return Object.freeze([
    Object.freeze({ code: `install.${error.code}`, path, message: error.message }),
  ]);
}

export async function runAddCommand(
  args: readonly string[],
  io: CliIo,
  operations: InstallCommandOperations = defaultOperations,
): Promise<CliExitCode> {
  let parsed: AddArguments;
  try {
    parsed = parseAdd(args);
  } catch (error) {
    const usage = error as InstallUsageError;
    return (await failure("add", io, args.includes("--json"), "usage", usage.message, usage.issues))
      ? 2
      : 1;
  }
  try {
    const result = await operations.add({ locator: parsed.locator, projectRoot: parsed.project });
    return (await output(
      io,
      parsed.json,
      {
        command: "add",
        ok: true,
        status: result.changed ? "installed" : "verified",
        lockfile: "skill-lock.json",
        result: reportResult(result),
      },
      `${resultHuman(result)}Lockfile: skill-lock.json\n`,
    ))
      ? 0
      : 1;
  } catch (error) {
    if (error instanceof TrustedInstallError) {
      return (await failure("add", io, parsed.json, error.code, error.message, trustedIssue(error)))
        ? 3
        : 1;
    }
    await failure("add", io, parsed.json, "internal", "Skill Press could not add the skill.", [
      { code: "install.internal", path: "/install", message: "unexpected installation failure" },
    ]);
    return 1;
  }
}

export async function runInstallCommand(
  args: readonly string[],
  io: CliIo,
  operations: InstallCommandOperations = defaultOperations,
): Promise<CliExitCode> {
  let parsed: CommonArguments;
  try {
    parsed = parseInstall(args);
  } catch (error) {
    const usage = error as InstallUsageError;
    return (await failure(
      "install",
      io,
      args.includes("--json"),
      "usage",
      usage.message,
      usage.issues,
    ))
      ? 2
      : 1;
  }
  try {
    const results = await operations.install({ projectRoot: parsed.project });
    const changed = results.some((result) => result.changed);
    const human =
      results.length === 0
        ? "skill-lock.json contains no skills.\n"
        : `${results.map(resultHuman).join("")}Installed skills: ${results.length}\nLockfile: skill-lock.json\n`;
    return (await output(
      io,
      parsed.json,
      {
        command: "install",
        ok: true,
        status: changed ? "installed" : "verified",
        lockfile: "skill-lock.json",
        count: results.length,
        changed,
        results: results.map(reportResult),
      },
      human,
    ))
      ? 0
      : 1;
  } catch (error) {
    if (error instanceof TrustedInstallError) {
      return (await failure(
        "install",
        io,
        parsed.json,
        error.code,
        error.message,
        trustedIssue(error),
      ))
        ? 3
        : 1;
    }
    await failure(
      "install",
      io,
      parsed.json,
      "internal",
      "Skill Press could not install locked skills.",
      [
        {
          code: "install.internal",
          path: "/install",
          message: "unexpected installation failure",
        },
      ],
    );
    return 1;
  }
}
