import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import type { SkillPressProject } from "../src/config/generated.js";
import { MAX_TEST_OUTPUT_BYTES, runBoundedCommand } from "../src/process/run.js";
import { runProjectTests } from "../src/test/project.js";

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function testProject(commands: SkillPressProject["tests"]["commands"]): Promise<string> {
  const root = await mkdtemp(join(temporaryRoot, "skillpress-runner-test-"));
  temporaryDirectories.push(root);
  const source = await readFile(new URL("fixtures/config/valid.yaml", import.meta.url), "utf8");
  const config = parse(source) as SkillPressProject;
  config.tests.commands = commands;
  await writeFile(join(root, "skillpress.yaml"), stringify(config));
  return root;
}

function command(
  name: string,
  source: string,
  extra: readonly string[] = [],
): SkillPressProject["tests"]["commands"][number] {
  return {
    name,
    argv: [process.execPath, "-e", source, ...extra],
    timeoutSeconds: 2,
  };
}

describe("bounded process runner", () => {
  it("runs explicit argv with a minimal environment and retains only output digests", async () => {
    const stdout = "public output\n";
    const stderr = "fixed warning\n";
    const result = await runBoundedCommand({
      name: "digest",
      argv: [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)})`,
      ],
      cwd: temporaryRoot,
      timeoutSeconds: 2,
    });

    expect(result).toMatchObject({
      name: "digest",
      status: "passed",
      exitCode: 0,
      signal: null,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
      stderrSha256: createHash("sha256").update(stderr).digest("hex"),
    });
    expect(JSON.stringify(result)).not.toContain("public output");
    expect(JSON.stringify(result)).not.toContain("fixed warning");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("classifies nonzero exit, startup failure, timeout, and output overflow", async () => {
    const failed = await runBoundedCommand({
      name: "failed",
      argv: [process.execPath, "-e", "process.exit(7)"],
      cwd: temporaryRoot,
      timeoutSeconds: 2,
    });
    expect(failed).toMatchObject({ status: "failed", exitCode: 7, signal: null });

    const missing = await runBoundedCommand({
      name: "missing",
      argv: ["skillpress-command-that-does-not-exist"],
      cwd: temporaryRoot,
      timeoutSeconds: 2,
    });
    expect(missing.status).toBe("spawn_error");

    const invalidExecutable = await runBoundedCommand({
      name: "invalid executable",
      argv: ["invalid\u0000executable"],
      cwd: temporaryRoot,
      timeoutSeconds: 2,
    });
    expect(invalidExecutable.status).toBe("spawn_error");

    const timedOut = await runBoundedCommand({
      name: "timeout",
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: temporaryRoot,
      timeoutSeconds: 1,
    });
    expect(timedOut.status).toBe("timed_out");

    const stdoutOverflow = await runBoundedCommand({
      name: "stdout overflow",
      argv: [
        process.execPath,
        "-e",
        `process.stdout.write(Buffer.alloc(${MAX_TEST_OUTPUT_BYTES + 1}, 97))`,
      ],
      cwd: temporaryRoot,
      timeoutSeconds: 2,
    });
    expect(stdoutOverflow.status).toBe("output_limit");
    expect(stdoutOverflow.stdoutBytes).toBeGreaterThan(MAX_TEST_OUTPUT_BYTES);

    const stderrOverflow = await runBoundedCommand({
      name: "stderr overflow",
      argv: [
        process.execPath,
        "-e",
        `process.stderr.write(Buffer.alloc(${MAX_TEST_OUTPUT_BYTES + 1}, 98))`,
      ],
      cwd: temporaryRoot,
      timeoutSeconds: 2,
    });
    expect(stderrOverflow.status).toBe("output_limit");
    expect(stderrOverflow.stderrBytes).toBeGreaterThan(MAX_TEST_OUTPUT_BYTES);

    const bothOverflow = await runBoundedCommand({
      name: "both overflow",
      argv: [
        process.execPath,
        "-e",
        `process.stdout.write(Buffer.alloc(${MAX_TEST_OUTPUT_BYTES + 1}, 97));process.stderr.write(Buffer.alloc(${MAX_TEST_OUTPUT_BYTES + 1}, 98))`,
      ],
      cwd: temporaryRoot,
      timeoutSeconds: 2,
    });
    expect(bothOverflow.status).toBe("output_limit");
  });
});

describe("project test report", () => {
  it("runs all commands sequentially and reports stable success or failure", async () => {
    const root = await testProject([
      command("first", "process.exit(0)"),
      command("second", "process.exit(3)"),
      command("third", "process.exit(0)"),
    ]);

    const report = await runProjectTests(root);

    expect(report.ok).toBe(false);
    expect(report.results.map((entry) => [entry.name, entry.status])).toEqual([
      ["first", "passed"],
      ["second", "failed"],
      ["third", "passed"],
    ]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.project)).toBe(true);
    expect(Object.isFrozen(report.results)).toBe(true);
    expect(report.results.every((entry) => entry.cwd === ".")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(root);
  });

  it("does not invoke a shell for metacharacter arguments", async () => {
    const root = await testProject([
      command("literal argv", "if (process.argv[1] !== '; touch SHELL-RAN') process.exit(9)", [
        "; touch SHELL-RAN",
      ]),
    ]);

    const report = await runProjectTests(root);

    expect(report.ok).toBe(true);
    await expect(readFile(join(root, "SHELL-RAN"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not forward arbitrary parent environment or credential variables", async () => {
    const root = await testProject([
      command(
        "environment",
        "const safe=process.env.SKILLPRESS==='1'&&process.env.HOME===undefined&&process.env.AWS_SECRET_ACCESS_KEY===undefined&&process.env.NODE_OPTIONS===undefined;process.exit(safe?0:8)",
      ),
    ]);

    await expect(runProjectTests(root)).resolves.toMatchObject({ ok: true });
  });

  it("rejects missing, non-directory, and symbolic-link working directories", async () => {
    const outside = await mkdtemp(join(temporaryRoot, "skillpress-runner-outside-"));
    temporaryDirectories.push(outside);
    const cases = ["missing", "plain-file", "linked"] as const;
    for (const cwd of cases) {
      const root = await testProject([{ ...command(cwd, "process.exit(0)"), cwd }]);
      if (cwd === "plain-file") await writeFile(join(root, cwd), "not a directory\n");
      if (cwd === "linked") await symlink(outside, join(root, cwd), "dir");

      const report = await runProjectTests(root);

      expect(report).toMatchObject({
        ok: false,
        results: [{ name: cwd, cwd, status: "invalid_cwd", exitCode: null }],
      });
    }
  });

  it("runs a command inside a real configured subdirectory", async () => {
    const root = await testProject([{ ...command("subdir", "process.exit(0)"), cwd: "nested" }]);
    await mkdir(join(root, "nested"));

    const report = await runProjectTests(root);

    expect(report).toMatchObject({ ok: true, results: [{ name: "subdir", status: "passed" }] });
  });

  it("rejects ambiguous project paths before loading configuration", async () => {
    await expect(runProjectTests("bad\u200bpath")).rejects.toThrow(TypeError);
  });
});
