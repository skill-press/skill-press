import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { loadProjectConfig } from "../config/load.js";
import { isSafePathInput } from "../path-safety.js";
import { runBoundedCommand } from "../process/run.js";
import type { TestCommandResult, ProjectTestReport } from "./types.js";

async function commandWorkingDirectory(
  root: string,
  relativePath: string,
): Promise<string | undefined> {
  let current = root;
  try {
    const rootPath = await realpath(root);
    const segments = relativePath === "." ? [] : relativePath.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index] as string);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) return undefined;
    }
    const candidate = await realpath(current);
    const fromRoot = relative(rootPath, candidate);
    return fromRoot === "" ||
      (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith("../"))
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function invalidCwd(name: string, cwd: string): TestCommandResult {
  const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  return Object.freeze({
    name,
    cwd,
    status: "invalid_cwd",
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutSha256: emptyDigest,
    stderrSha256: emptyDigest,
  });
}

/** Run configured deterministic project commands sequentially without invoking a shell. */
export async function runProjectTests(
  projectDirectory: string = process.cwd(),
  options: { readonly signal?: AbortSignal } = {},
): Promise<ProjectTestReport> {
  if (!isSafePathInput(projectDirectory)) {
    throw new TypeError("projectDirectory must be a bounded, unambiguous filesystem path.");
  }
  const root = resolve(projectDirectory);
  const config = await loadProjectConfig(root);
  const results: TestCommandResult[] = [];
  for (let index = 0; index < config.tests.commands.length; index += 1) {
    const command = config.tests.commands[index] as (typeof config.tests.commands)[number];
    const configuredCwd = command.cwd ?? ".";
    const cwd = await commandWorkingDirectory(root, configuredCwd);
    if (cwd === undefined) {
      results.push(invalidCwd(command.name, configuredCwd));
      continue;
    }
    results.push(
      await runBoundedCommand({
        name: command.name,
        argv: command.argv,
        cwd,
        reportCwd: configuredCwd,
        timeoutSeconds: command.timeoutSeconds,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
  }
  const frozenResults = Object.freeze(results);
  return Object.freeze({
    schemaVersion: 1 as const,
    ok: frozenResults.every((entry) => entry.status === "passed"),
    project: Object.freeze({ name: config.project.name, version: config.project.version }),
    results: frozenResults,
  });
}
