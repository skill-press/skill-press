import { execFile, type ExecFileException } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { TrustedInstallError } from "./errors.js";

const GIT_TIMEOUT_MS = 5_000;
const GIT_TOTAL_BUDGET_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;

interface GitResult {
  readonly code: number;
  readonly stdout: Buffer;
}

export interface GitPolicyBudget {
  remainingMs: number;
}

export function createGitPolicyBudget(): GitPolicyBudget {
  return { remainingMs: GIT_TOTAL_BUDGET_MS };
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_WORK_TREE",
  ]) {
    delete environment[name];
  }
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_CONFIG_KEY_") || name.startsWith("GIT_CONFIG_VALUE_")) {
      delete environment[name];
    }
  }
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.LC_ALL = "C";
  return environment;
}

function runGit(
  projectRoot: string,
  arguments_: readonly string[],
  budget: GitPolicyBudget,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(budget.remainingMs) || budget.remainingMs <= 0) {
      reject(new Error("Git policy verification exceeded its total time budget."));
      return;
    }
    const started = performance.now();
    const finish = (): void => {
      budget.remainingMs = Math.max(0, budget.remainingMs - (performance.now() - started));
    };
    try {
      execFile(
        "git",
        [
          "--no-pager",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "-C",
          projectRoot,
          ...arguments_,
        ],
        {
          encoding: "buffer",
          env: gitEnvironment(),
          maxBuffer: GIT_MAX_OUTPUT_BYTES,
          timeout: Math.max(1, Math.min(GIT_TIMEOUT_MS, Math.floor(budget.remainingMs))),
          windowsHide: true,
        },
        (error: ExecFileException | null, stdout: Buffer) => {
          finish();
          if (error === null) {
            resolve(Object.freeze({ code: 0, stdout: Buffer.from(stdout) }));
            return;
          }
          if (error.code === "ENOENT") {
            reject(error);
            return;
          }
          if (
            error.killed ||
            error.signal != null ||
            error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ) {
            reject(error);
            return;
          }
          const code = typeof error.code === "number" ? error.code : Number(error.code);
          if (!Number.isSafeInteger(code) || code < 1) {
            reject(error);
            return;
          }
          resolve(Object.freeze({ code, stdout: Buffer.from(stdout) }));
        },
      );
    } catch (error) {
      finish();
      reject(error);
    }
  });
}

async function hasGitMarker(projectRoot: string): Promise<boolean> {
  let current = projectRoot;
  for (;;) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function gitPolicyError(message: string, cause?: unknown): TrustedInstallError {
  return new TrustedInstallError(
    "install_path_unsafe",
    message,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Prevent a locally installed skill from becoming active merely because a repository was cloned.
 * Git projects must ignore every concrete target and must not already track any target content.
 */
export async function assertGitLocalInstallPolicy(
  projectRoot: string,
  skills: readonly string[],
  budget: GitPolicyBudget = createGitPolicyBudget(),
): Promise<void> {
  if (skills.length === 0) return;
  const targets = [...new Set(skills)].map((skill) => {
    if (skill.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill)) {
      throw gitPolicyError("The Git installation target is invalid.");
    }
    return `.agents/skills/${skill}`;
  });
  let tracked: GitResult;
  try {
    tracked = await runGit(projectRoot, ["ls-files", "-z", "--cached", "--", ...targets], budget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !(await hasGitMarker(projectRoot))) {
      return;
    }
    throw gitPolicyError("The Git installation policy could not be verified.", error);
  }
  if (tracked.code !== 0) {
    // Exit 128 is Git's ordinary "not a repository" result. A nearby .git marker with an
    // unreadable or malformed repository is not safely distinguishable and therefore fails shut.
    if (tracked.code === 128 && !(await hasGitMarker(projectRoot))) return;
    throw gitPolicyError("The project Git worktree could not be verified.");
  }
  if (tracked.stdout.byteLength !== 0) {
    throw gitPolicyError(
      "A trusted skill target is Git-tracked; installed skills must remain local-only.",
    );
  }

  const directoryTargets = targets.map((target) => `${target}/`);
  let ignored: GitResult;
  try {
    ignored = await runGit(
      projectRoot,
      ["check-ignore", "--no-index", "--", ...directoryTargets],
      budget,
    );
  } catch (error) {
    throw gitPolicyError("The Git installation policy could not be verified.", error);
  }
  if (ignored.code !== 0 && ignored.code !== 1) {
    throw gitPolicyError("Git ignore rules could not be verified.");
  }
  const text = ignored.stdout.toString("utf8");
  const lines = text === "" ? [] : text.replace(/\r?\n$/u, "").split(/\r?\n/u);
  const observed = new Set(lines);
  if (
    ignored.code !== 0 ||
    lines.length !== observed.size ||
    observed.size !== directoryTargets.length ||
    directoryTargets.some((target) => !observed.has(target))
  ) {
    throw gitPolicyError(
      "A trusted skill target is not ignored by Git; add an explicit directory ignore rule before installing.",
    );
  }
}
