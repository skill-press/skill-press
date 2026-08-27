import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { checkProject } from "../check/project.js";
import { loadProjectConfig } from "../config/load.js";
import {
  runCapturedCommand,
  type CapturedCommand,
  type CapturedCommandResult,
} from "../process/capture.js";
import {
  checkTesslReleaseGate,
  type TesslReleaseGateOptions,
  type TesslReleaseGateReport,
} from "../release/tessl-gate.js";

export interface DoctorCheck {
  readonly id: string;
  readonly status: "pass" | "warning" | "error";
  readonly message: string;
}

export interface DoctorOptions {
  readonly evidence?: TesslReleaseGateOptions;
  readonly tesslExecutable?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executor?: (command: CapturedCommand) => Promise<CapturedCommandResult>;
  readonly homeDirectory?: string;
  readonly nodeVersion?: string;
}

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly reportType: "skillpress.doctor";
  readonly ready: boolean;
  readonly gate: TesslReleaseGateReport | null;
  readonly checks: readonly DoctorCheck[];
}

interface DoctorOperations {
  readonly loadConfig: typeof loadProjectConfig;
  readonly checkLocal: typeof checkProject;
  readonly checkGate: typeof checkTesslReleaseGate;
}

const defaultOperations: DoctorOperations = Object.freeze({
  loadConfig: loadProjectConfig,
  checkLocal: checkProject,
  checkGate: checkTesslReleaseGate,
});

interface CommandProbe {
  readonly id: string;
  readonly argv: readonly [string, ...string[]];
  readonly message: string;
}

function check(id: string, status: DoctorCheck["status"], message: string): DoctorCheck {
  return Object.freeze({ id, status, message });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function supportedNode(version: string): boolean {
  const match = /^v?(\d+)[.](\d+)[.](\d+)(?:[-+].*)?$/u.exec(version);
  return match !== null && Number(match[1]) >= 22;
}

function commandProbes(
  sandbox: "docker" | "podman",
  options: DoctorOptions,
): readonly CommandProbe[] {
  return Object.freeze([
    { id: "command.git", argv: ["git", "--version"], message: "Git executable is available" },
    {
      id: `command.${sandbox}`,
      argv: [sandbox, "--version"],
      message: `${sandbox} sandbox executable is available`,
    },
    {
      id: "command.tessl",
      argv: [options.tesslExecutable ?? "tessl", "--version"],
      message: "Tessl CLI is available; trust is rechecked by the release gate",
    },
  ] satisfies readonly CommandProbe[]);
}

async function runProbe(
  root: string,
  probe: CommandProbe,
  probeHome: string,
  executor: (command: CapturedCommand) => Promise<CapturedCommandResult>,
): Promise<DoctorCheck> {
  const result = await executor({
    argv: probe.argv,
    cwd: root,
    timeoutSeconds: 15,
    maxOutputBytes: 1024 * 1024,
    env: {
      HOME: probeHome,
      USERPROFILE: probeHome,
      XDG_CACHE_HOME: join(probeHome, "cache"),
      XDG_CONFIG_HOME: join(probeHome, "config"),
      XDG_STATE_HOME: join(probeHome, "state"),
    },
  });
  return result.status === "passed" && result.exitCode === 0 && result.signal === null
    ? check(probe.id, "pass", probe.message)
    : check(probe.id, "error", `${probe.id.slice("command.".length)} executable is unavailable`);
}

function credentialChecks(
  environment: Readonly<Record<string, string | undefined>>,
): DoctorCheck[] {
  const available = (name: string) => {
    const value = environment[name];
    return value !== undefined && value.length > 0 && value.trim() === value;
  };
  return [
    available("TESSL_TOKEN")
      ? check("credential.tessl", "pass", "Tessl non-interactive credential context is present")
      : check(
          "credential.tessl",
          "warning",
          "Tessl environment credential is absent; the official CLI login store may still work",
        ),
    available("SKILL_PRESS_TOKEN")
      ? check(
          "credential.skill_press",
          "pass",
          "Skill Press submission credential context is present",
        )
      : check(
          "credential.skill_press",
          "warning",
          "SKILL_PRESS_TOKEN is absent; local dry-runs still work but submit cannot authenticate",
        ),
  ];
}

async function collisionChecks(
  projectRoot: string,
  skillPath: string,
  skillName: string,
  homeDirectory: string,
): Promise<DoctorCheck[]> {
  const canonical = await realpath(join(projectRoot, skillPath));
  const checks: DoctorCheck[] = [];
  for (const [id, candidate] of [
    ["collision.agents", join(homeDirectory, ".agents", "skills", skillName)],
    ["collision.codex", join(homeDirectory, ".codex", "skills", skillName)],
  ] as const) {
    try {
      const metadata = await lstat(candidate);
      let same = false;
      try {
        same = (await realpath(candidate)) === canonical;
      } catch {
        same = false;
      }
      checks.push(
        same
          ? check(id, "pass", "installed skill resolves to the canonical project skill")
          : check(
              id,
              "warning",
              metadata.isDirectory()
                ? "another installed skill with the configured name may shadow this project"
                : "a non-directory entry collides with the configured skill name",
            ),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        checks.push(check(id, "pass", "no local installed-skill collision was found"));
      } else {
        checks.push(check(id, "warning", "local installed-skill collision could not be inspected"));
      }
    }
  }
  return checks;
}

/** Diagnose local tools, evidence freshness, local name collisions, and credential context. */
export async function diagnoseProject(
  projectDirectory: string,
  options: DoctorOptions = {},
  operations: Partial<DoctorOperations> = {},
): Promise<DoctorReport> {
  const dependencies = { ...defaultOperations, ...operations };
  const config = await dependencies.loadConfig(projectDirectory);
  const root = await realpath(projectDirectory);
  const local = await dependencies.checkLocal(root);
  const executor = options.executor ?? runCapturedCommand;
  const temporaryParent = await realpath(tmpdir());
  const probeHome = await mkdtemp(join(temporaryParent, "skill-press-doctor-"));
  await chmod(probeHome, 0o700);
  let probes: readonly DoctorCheck[];
  try {
    probes = await Promise.all(
      commandProbes(config.evaluation.sandbox, options).map((probe) =>
        runProbe(root, probe, probeHome, executor),
      ),
    );
  } finally {
    await rm(probeHome, { recursive: true, force: true });
  }
  const checks: DoctorCheck[] = [
    supportedNode(options.nodeVersion ?? process.version)
      ? check("runtime.node", "pass", "Node.js satisfies the supported major version")
      : check("runtime.node", "error", "Node.js 22 or newer is required"),
    local.eligible
      ? check("project.readiness", "pass", "local project readiness passes")
      : check("project.readiness", "error", "local project readiness is blocked"),
    ...probes,
    ...(await collisionChecks(
      root,
      config.skill.path,
      config.skill.name,
      options.homeDirectory ?? homedir(),
    )),
    ...credentialChecks(options.environment ?? process.env),
  ];
  const gate =
    options.evidence === undefined ? null : await dependencies.checkGate(root, options.evidence);
  checks.push(
    gate === null
      ? check(
          "evidence.tessl",
          "error",
          "Tessl release evidence was not supplied for freshness checks",
        )
      : gate.passed
        ? check("evidence.tessl", "pass", "Tessl release evidence is current and passes")
        : check(
            "evidence.tessl",
            "error",
            "Tessl release evidence is stale, invalid, or below threshold",
          ),
  );
  return freeze({
    schemaVersion: 1,
    reportType: "skillpress.doctor",
    ready: checks.every((entry) => entry.status !== "error"),
    gate,
    checks,
  });
}
