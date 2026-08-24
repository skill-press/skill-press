import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SkillPressProject } from "../src/config/generated.js";
import {
  renderCheckHelp,
  renderCreateHelp,
  renderDoctorHelp,
  renderEvalHelp,
  renderHelp,
  renderHumanEvalReport,
  renderHumanTesslReport,
  renderImproveHelp,
  renderPackageHelp,
  renderPublishHelp,
  renderStatusHelp,
  renderTestHelp,
  renderTesslHelp,
  runCli,
} from "../src/cli.js";
import { ProjectCreationError } from "../src/create/errors.js";
import type { SkillPressPairedEvaluationEvidence } from "../src/eval/generated-evidence.js";
import { VERSION } from "../src/version.js";

const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

function captureIo(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly io: {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

describe("SkillPress CLI scaffold", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });

  async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(temporaryRoot, "skillpress-cli-test-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  it.each([{ args: [] }, { args: ["--help"] }, { args: ["-h"] }, { args: ["help"] }])(
    "renders help for $args",
    async ({ args }) => {
      const capture = captureIo();

      await expect(runCli(args, capture.io)).resolves.toBe(0);
      expect(capture.stdout).toEqual([renderHelp()]);
      expect(capture.stderr).toEqual([]);
      expect(renderHelp()).toContain("SkillPress");
    },
  );

  it.each([{ args: ["--version"] }, { args: ["-v"] }])(
    "renders the package version for $args",
    async ({ args }) => {
      const capture = captureIo();

      await expect(runCli(args, capture.io)).resolves.toBe(0);
      expect(capture.stdout).toEqual([`${VERSION}\n`]);
      expect(capture.stderr).toEqual([]);
    },
  );

  it.each([["--help"], ["-h"]])("renders create help for %s", async (flag) => {
    const capture = captureIo();

    await expect(runCli(["create", flag as string], capture.io)).resolves.toBe(0);
    expect(capture.stdout).toEqual([renderCreateHelp()]);
    expect(capture.stderr).toEqual([]);
  });

  it.each([["--help"], ["-h"]])("renders check help for %s", async (flag) => {
    const capture = captureIo();

    await expect(runCli(["check", flag as string], capture.io)).resolves.toBe(0);
    expect(capture.stdout).toEqual([renderCheckHelp()]);
    expect(capture.stderr).toEqual([]);
  });

  it.each([["--help"], ["-h"]])("renders test help for %s", async (flag) => {
    const capture = captureIo();

    await expect(runCli(["test", flag as string], capture.io)).resolves.toBe(0);
    expect(capture.stdout).toEqual([renderTestHelp()]);
    expect(capture.stderr).toEqual([]);
  });

  it.each([["--help"], ["-h"]])("renders eval help for %s", async (flag) => {
    const capture = captureIo();

    await expect(runCli(["eval", flag as string], capture.io)).resolves.toBe(0);
    expect(capture.stdout).toEqual([renderEvalHelp()]);
    expect(capture.stderr).toEqual([]);
  });

  it.each([["--help"], ["-h"]])("renders tessl help for %s", async (flag) => {
    const capture = captureIo();

    await expect(runCli(["tessl", flag as string], capture.io)).resolves.toBe(0);
    expect(capture.stdout).toEqual([renderTesslHelp()]);
    expect(capture.stderr).toEqual([]);
  });

  it.each([
    { command: "package", help: renderPackageHelp },
    { command: "publish", help: renderPublishHelp },
    { command: "status", help: renderStatusHelp },
    { command: "doctor", help: renderDoctorHelp },
    { command: "improve", help: renderImproveHelp },
  ])("renders $command release help", async ({ command, help }) => {
    for (const flag of ["--help", "-h"]) {
      const capture = captureIo();
      await expect(runCli([command, flag], capture.io)).resolves.toBe(0);
      expect(capture.stdout).toEqual([help()]);
      expect(capture.stderr).toEqual([]);
    }
  });

  it.each([
    { args: ["package"], message: "--review-evidence is required" },
    {
      args: [
        "package",
        "--review-evidence",
        "review",
        "--eval-evidence",
        "eval",
        "--eval-source",
        "source",
        "--json",
        "--json",
      ],
      message: "--json may be specified only once",
    },
    {
      args: [
        "publish",
        "--artifacts",
        "artifacts",
        "--review-evidence",
        "review",
        "--eval-evidence",
        "eval",
        "--eval-source",
        "source",
        "--resume",
        "receipt",
      ],
      message: "--resume requires --execute",
    },
    {
      args: ["publish", "FORGED\u001b[31m"],
      message: "Unknown release option",
    },
  ])("rejects invalid release arguments: $message", async ({ args, message }) => {
    const capture = captureIo();
    await expect(runCli(args, capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(capture.stderr[0]).toContain(message);
    expect(capture.stderr[0]).not.toContain("FORGED");
  });

  it("fails package closed before staging when official release evidence is unavailable", async () => {
    const parent = await temporaryDirectory();
    const project = join(parent, "release-project");
    await expect(
      runCli(["create", "--brief", briefPath, "--output", project], captureIo().io),
    ).resolves.toBe(0);
    const capture = captureIo();
    await expect(
      runCli(
        [
          "package",
          "--project",
          project,
          "--review-evidence",
          `.skillpress/tessl/${"1".repeat(64)}/evidence.json`,
          "--eval-evidence",
          `.skillpress/tessl/${"2".repeat(64)}/evidence.json`,
          "--eval-source",
          "evals/tessl",
          "--json",
        ],
        capture.io,
      ),
    ).resolves.toBe(3);
    expect(capture.stdout).toEqual([]);
    expect(JSON.parse(capture.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "release_blocked",
      issues: [{ code: "release.storage.unavailable" }],
    });
    await expect(lstat(join(project, ".skillpress/staging"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["missing operation", ["tessl"]],
    ["unknown operation", ["tessl", "score"]],
    ["missing eval fields", ["tessl", "eval", "--source", "evals"]],
    [
      "invalid integer",
      ["tessl", "eval", "--source", "evals", "--agent", "a", "--model", "m", "--runs", "1.5"],
    ],
    [
      "review-only option",
      ["tessl", "eval", "--workspace", "w", "--source", "evals", "--agent", "a", "--model", "m"],
    ],
    ["duplicate project", ["tessl", "review", "--project", ".", "--project", "."]],
    ["duplicate JSON", ["tessl", "review", "--json", "--json"]],
    ["duplicate executable", ["tessl", "review", "--executable", "one", "--executable", "two"]],
    ["duplicate timeout", ["tessl", "review", "--timeout", "1", "--timeout", "2"]],
    ["duplicate workspace", ["tessl", "review", "--workspace", "one", "--workspace", "two"]],
    [
      "duplicate source",
      ["tessl", "eval", "--source", "one", "--source", "two", "--agent", "a", "--model", "m"],
    ],
    [
      "duplicate agent",
      ["tessl", "eval", "--source", "evals", "--agent", "a", "--agent", "b", "--model", "m"],
    ],
    [
      "duplicate model",
      ["tessl", "eval", "--source", "evals", "--agent", "a", "--model", "m", "--model", "n"],
    ],
    [
      "duplicate runs",
      [
        "tessl",
        "eval",
        "--source",
        "evals",
        "--agent",
        "a",
        "--model",
        "m",
        "--runs",
        "1",
        "--runs",
        "2",
      ],
    ],
    [
      "duplicate poll interval",
      [
        "tessl",
        "eval",
        "--source",
        "evals",
        "--agent",
        "a",
        "--model",
        "m",
        "--poll-interval-ms",
        "1",
        "--poll-interval-ms",
        "2",
      ],
    ],
    [
      "unsafe integer",
      [
        "tessl",
        "eval",
        "--source",
        "evals",
        "--agent",
        "a",
        "--model",
        "m",
        "--runs",
        "999999999999999999999999999999",
      ],
    ],
    ["unknown review option", ["tessl", "review", "--other"]],
  ] as const)("returns usage exit 2 for tessl %s", async (_name, args) => {
    const capture = captureIo();
    await expect(runCli(args, capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
  });

  it("captures Tessl review and eval CLI evidence without accepting an untrusted executable", async () => {
    const parent = await temporaryDirectory();
    const project = join(parent, "project");
    await expect(
      runCli(["create", "--brief", briefPath, "--output", project], captureIo().io),
    ).resolves.toBe(0);
    await mkdir(join(project, "tessl-evals"));
    await writeFile(join(project, "tessl-evals/scenario.json"), "{}\n");
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["add", "."], { cwd: project });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=SkillPress Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: project },
    );
    const executable = join(parent, "tessl-fake");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("0.99.0");
else if (args[0] === "skill") console.log("lint passed");
else if (args[0] === "review") console.log(JSON.stringify({reviewRunId:"review-1",validation:{overallPassed:true},review:{reviewScore:93}}));
else if (args[0] === "eval" && args[1] === "run") console.log(JSON.stringify({evalRunId:"eval-1",agent:"codex",model:"model",scenariosCount:1}));
else if (args[0] === "eval" && args[1] === "view") console.log(JSON.stringify({data:{id:"eval-1",attributes:{status:"completed",scenarios:[{fingerprint:"case",solutions:[{variant:"baseline",assessmentResults:[{score:2,max_score:10}]},{variant:"with-context",assessmentResults:[{score:9,max_score:10}]}]}]}}}));
else process.exit(2);
`,
    );
    await chmod(executable, 0o755);

    const review = captureIo();
    await expect(
      runCli(
        [
          "tessl",
          "review",
          "--project",
          project,
          "--executable",
          executable,
          "--workspace",
          "workspace",
          "--timeout",
          "2",
          "--json",
        ],
        review.io,
      ),
    ).resolves.toBe(3);
    expect(review.stderr).toEqual([]);
    const reviewEvidence = JSON.parse(review.stdout[0] as string);
    expect(reviewEvidence).toMatchObject({
      command: "tessl.review",
      review: { qualityScore: 93 },
      evidenceEligible: false,
      ineligibilityReasons: ["untrusted_cli"],
    });
    expect(renderHumanTesslReport(reviewEvidence)).toContain("Tessl Quality: 93/100");
    expect(
      renderHumanTesslReport({
        ...reviewEvidence,
        evidenceEligible: true,
        ineligibilityReasons: [],
        review: { ...reviewEvidence.review, validationPassed: false },
      }),
    ).toContain("Evidence eligible: yes");

    const evaluation = captureIo();
    await expect(
      runCli(
        [
          "tessl",
          "eval",
          "--project",
          project,
          "--source",
          "tessl-evals",
          "--agent",
          "codex",
          "--model",
          "model",
          "--runs",
          "1",
          "--poll-interval-ms",
          "1",
          "--executable",
          executable,
          "--timeout",
          "2",
          "--json",
        ],
        evaluation.io,
      ),
    ).resolves.toBe(3);
    expect(evaluation.stderr).toEqual([]);
    const evalEvidence = JSON.parse(evaluation.stdout[0] as string);
    expect(evalEvidence).toMatchObject({
      command: "tessl.eval",
      impactScore: 90,
      baselineScore: 20,
      impactDelta: 70,
      evidenceEligible: false,
      ineligibilityReasons: ["untrusted_cli"],
    });
    expect(renderHumanTesslReport(evalEvidence)).toContain("Tessl Impact: 90/100");

    await expect(
      runCli(["tessl", "review", "--project", project, "--executable", executable], {
        stdout: () => {
          throw new Error("closed output");
        },
        stderr: () => undefined,
      }),
    ).resolves.toBe(1);
  });

  it("classifies Tessl project, executable, and default eval failures", async () => {
    const missing = await temporaryDirectory();
    const projectFailure = captureIo();
    await expect(
      runCli(["tessl", "review", "--project", missing, "--json"], projectFailure.io),
    ).resolves.toBe(3);
    expect(JSON.parse(projectFailure.stderr[0] as string)).toMatchObject({
      code: "tessl.invalid",
    });

    const parent = await temporaryDirectory();
    const project = join(parent, "project");
    await runCli(["create", "--brief", briefPath, "--output", project], captureIo().io);
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["add", "."], { cwd: project });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=SkillPress Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: project },
    );
    const cliFailure = captureIo();
    await expect(
      runCli(["tessl", "review", "--project", project, "--json"], cliFailure.io),
    ).resolves.toBe(3);
    expect(JSON.parse(cliFailure.stderr[0] as string)).toMatchObject({
      code: "tessl.invalid",
      issues: [expect.objectContaining({ code: "tessl.cli.missing" })],
    });

    const evalDefaults = captureIo();
    await expect(
      runCli(
        [
          "tessl",
          "eval",
          "--project",
          project,
          "--source",
          "skills/incident-summary",
          "--agent",
          "codex",
          "--model",
          "model",
          "--json",
        ],
        evalDefaults.io,
      ),
    ).resolves.toBe(3);
  });

  it.each([
    ["missing separator", ["eval", "--image", "image", "--model", "model"]],
    ["missing adapter", ["eval", "--image", "image", "--model", "model", "--"]],
    ["missing required option", ["eval", "--image", "image", "--", "adapter"]],
    [
      "invalid suite",
      ["eval", "--image", "image", "--model", "model", "--suite", "other", "--", "adapter"],
    ],
    [
      "duplicate JSON",
      ["eval", "--json", "--json", "--image", "image", "--model", "model", "--", "adapter"],
    ],
    [
      "duplicate image",
      ["eval", "--image", "one", "--image", "two", "--model", "model", "--", "adapter"],
    ],
    [
      "duplicate model",
      ["eval", "--image", "image", "--model", "one", "--model", "two", "--", "adapter"],
    ],
    [
      "duplicate suite",
      [
        "eval",
        "--image",
        "image",
        "--model",
        "model",
        "--suite",
        "training",
        "--suite",
        "holdout",
        "--",
        "adapter",
      ],
    ],
    [
      "duplicate project",
      [
        "eval",
        "--project",
        ".",
        "--project",
        ".",
        "--image",
        "image",
        "--model",
        "model",
        "--",
        "adapter",
      ],
    ],
    [
      "duplicate unsafe override",
      [
        "eval",
        "--allow-unpinned-image",
        "--allow-unpinned-image",
        "--image",
        "image",
        "--model",
        "model",
        "--",
        "adapter",
      ],
    ],
    [
      "unknown flag",
      ["eval", "--unknown", "--image", "image", "--model", "model", "--", "adapter"],
    ],
  ] as const)("returns usage exit 2 for eval %s", async (_name, args) => {
    const capture = captureIo();

    await expect(runCli(args, capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
  });

  it("does not mistake an adapter --json argument for CLI JSON mode", async () => {
    const capture = captureIo();

    await expect(runCli(["eval", "--", "adapter", "--json"], capture.io)).resolves.toBe(2);

    expect(capture.stderr[0]).toContain("eval requires --image and --model");
    expect(() => JSON.parse(capture.stderr[0] as string)).toThrow();
  });

  it.each([
    ["missing value", ["eval", "--image", "--", "adapter"]],
    ["empty value", ["eval", "--image", "", "--model", "model", "--", "adapter"]],
    ["flag value", ["eval", "--image", "--invalid", "--model", "model", "--", "adapter"]],
  ] as const)("rejects an eval %s", async (_name, args) => {
    const capture = captureIo();
    await expect(runCli(args, capture.io)).resolves.toBe(2);
  });

  it("renders passing and ineligible paired evidence without external-score language", () => {
    const evidence = {
      schemaVersion: 1,
      evidenceType: "skillpress.paired-eval",
      runId: "a".repeat(64),
      createdAt: "2026-08-24T00:00:00.000Z",
      project: { name: "example", version: "1.0.0" },
      suite: "training",
      model: "model",
      adapter: {
        backend: "docker",
        image: "image",
        commandSha256: "b".repeat(64),
      },
      skillSha256: "c".repeat(64),
      configSha256: "d".repeat(64),
      repetitions: 3,
      scenarioResults: [{ id: "case", expectedActivation: true, runs: [] }],
      summary: {
        baselineSuccessRate: 0,
        withSkillSuccessRate: 1,
        impactDelta: 1,
        minimumSuccessRate: 0.9,
        minimumImpactDelta: 0.1,
        behavioralGatePassed: true,
      },
      evidenceEligible: true,
      ineligibilityReasons: [],
      storagePath: `.skillpress/runs/${"a".repeat(64)}`,
    } as unknown as SkillPressPairedEvaluationEvidence;

    const passing = renderHumanEvalReport(evidence);
    const failing = renderHumanEvalReport({
      ...evidence,
      summary: { ...evidence.summary, behavioralGatePassed: false },
      evidenceEligible: false,
      ineligibilityReasons: ["behavioral_gate_failed"],
    });

    expect(passing).toContain("Paired evaluation: pass");
    expect(passing).toContain("Evidence eligible: yes");
    expect(passing).not.toContain("Ineligible:");
    expect(failing).toContain("Paired evaluation: fail");
    expect(failing).toContain("Evidence eligible: no");
    expect(failing).toContain("Ineligible: behavioral_gate_failed");
    expect(`${passing}${failing}`).not.toContain("Tessl Quality");
  });

  it("reports invalid eval projects and sandbox policy failures", async () => {
    const missing = await temporaryDirectory();
    const missingCapture = captureIo();
    await expect(
      runCli(
        [
          "eval",
          "--project",
          missing,
          "--image",
          `example/agent@sha256:${"a".repeat(64)}`,
          "--model",
          "model",
          "--",
          "adapter",
        ],
        missingCapture.io,
      ),
    ).resolves.toBe(3);
    expect(missingCapture.stderr[0]).toContain("evaluation input");

    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    await expect(
      runCli(["create", "--brief", briefPath, "--output", output], captureIo().io),
    ).resolves.toBe(0);
    const policyCapture = captureIo();
    await expect(
      runCli(
        [
          "eval",
          "--project",
          output,
          "--image",
          "mutable:latest",
          "--model",
          "model",
          "--scenario",
          "positive-shift-handoff",
          "--",
          "adapter",
        ],
        policyCapture.io,
      ),
    ).resolves.toBe(3);
    expect(policyCapture.stderr[0]).toContain("immutable sha256 digest");
  });

  it("rejects an unknown command", async () => {
    const capture = captureIo();

    await expect(runCli(["not-a-command"], capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toContain("Unknown command.");
    expect(capture.stderr.join("")).not.toContain("not-a-command");
  });

  it.each([
    ["--help", "extra"],
    ["-h", "extra"],
    ["help", "extra"],
    ["--version", "extra"],
    ["-v", "extra"],
  ])("rejects trailing arguments for the top-level shortcut %s", async (shortcut, extra) => {
    const capture = captureIo();

    await expect(runCli([shortcut as string, extra as string], capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(capture.stderr[0]).toContain("does not accept additional arguments");
  });

  it.each([
    { args: ["bad\nFORGED"] },
    { args: ["\u001b[31mFORGED\u001b[0m"] },
    { args: ["bad\u202eFORGED"] },
    { args: ["create", "bad\nFORGED"] },
    { args: ["create", "\u001b[31mFORGED\u001b[0m"] },
  ])("never reflects untrusted command tokens from $args", async ({ args }) => {
    const capture = captureIo();

    await expect(runCli(args, capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(capture.stderr[0]).not.toContain("FORGED");
    expect(capture.stderr[0]).not.toContain("\u001b");
    expect(capture.stderr[0]).not.toContain("\u202e");
  });

  it.each([
    { args: ["create"], message: "requires both" },
    { args: ["create", "--brief"], message: "requires a path" },
    {
      args: ["create", "--brief", briefPath, "--brief", briefPath, "--output", "out"],
      message: "only once",
    },
    {
      args: ["create", "--brief", briefPath, "--output", "out", "--output", "other"],
      message: "only once",
    },
    {
      args: ["create", "--brief", briefPath, "--output", "out", "--json", "--json"],
      message: "only once",
    },
    {
      args: ["create", "--brief", briefPath, "--output", "out", "positional"],
      message: "Unknown create argument.",
    },
    {
      args: ["create", "--brief", "bad\npath", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", "bad\u0085path", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", "bad\u2028path", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", "bad\u202epath", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", "bad\u200bpath", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", `bad${String.fromCodePoint(0x10ffff)}path`, "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", "bad\ufdd0path", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", "bad\ufffepath", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", `bad${String.fromCodePoint(0x10fffe)}path`, "--output", "out"],
      message: "unambiguous Unicode path",
    },
  ])("returns usage exit 2 for $message", async ({ args, message }) => {
    const capture = captureIo();

    await expect(runCli(args, capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(capture.stderr[0]).toContain(message);
  });

  it("creates a project and reports only rendered facts", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const capture = captureIo();

    await expect(
      runCli(["create", "--brief", briefPath, "--output", output], capture.io),
    ).resolves.toBe(0);

    expect(capture.stderr).toEqual([]);
    expect(capture.stdout).toEqual([
      `Created ${output}\nCanonical skill: ${join(output, "skills/incident-summary")}\nFiles: 8\n`,
    ]);
    await expect(
      readFile(join(output, "skills/incident-summary/SKILL.md"), "utf8"),
    ).resolves.toContain("name: incident-summary");
  });

  it("rejects an unpaired-surrogate output path before creating an alias on disk", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "bad\ud800name");
    const capture = captureIo();

    await expect(
      runCli(["create", "--brief", briefPath, "--output", output], capture.io),
    ).resolves.toBe(2);

    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(capture.stderr[0]).toContain("unambiguous Unicode path");
    expect(await readdir(parent)).toEqual([]);
  });

  it("emits one stable JSON success object", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const capture = captureIo();

    await expect(
      runCli(["create", "--json", "--output", output, "--brief", briefPath], capture.io),
    ).resolves.toBe(0);

    expect(capture.stderr).toEqual([]);
    expect(capture.stdout).toHaveLength(1);
    expect(JSON.parse(capture.stdout[0] as string)).toMatchObject({
      ok: true,
      command: "create",
      root: output,
      skillPath: "skills/incident-summary",
      files: expect.arrayContaining([
        expect.objectContaining({ path: "skills/incident-summary/SKILL.md" }),
      ]),
    });
  });

  it("checks a generated project in human and JSON modes", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const creation = captureIo();
    await expect(
      runCli(["create", "--brief", briefPath, "--output", output], creation.io),
    ).resolves.toBe(0);

    const human = captureIo();
    await expect(runCli(["check", "--project", output], human.io)).resolves.toBe(0);
    expect(human.stderr).toEqual([]);
    expect(human.stdout).toHaveLength(1);
    expect(human.stdout[0]).toContain("Readiness: 100/100");
    expect(human.stdout[0]).toContain("Status: pass");

    const json = captureIo();
    await expect(runCli(["check", "--json", "--project", output], json.io)).resolves.toBe(0);
    expect(json.stderr).toEqual([]);
    expect(JSON.parse(json.stdout[0] as string)).toMatchObject({
      command: "check",
      schemaVersion: 1,
      ok: true,
      eligible: true,
      score: 100,
      minimum: 90,
    });
  });

  it("returns the complete failed check report with exit 3", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    await runCli(["create", "--brief", briefPath, "--output", output], captureIo().io);
    const skillPath = join(output, "skills/incident-summary/SKILL.md");
    const skill = await readFile(skillPath, "utf8");
    await writeFile(skillPath, skill.replace("# Incident Summary", "# TODO: finish title"));
    const capture = captureIo();

    await expect(runCli(["check", "--project", output, "--json"], capture.io)).resolves.toBe(3);

    expect(capture.stderr).toEqual([]);
    const report = JSON.parse(capture.stdout[0] as string) as Record<string, unknown>;
    expect(report).toMatchObject({
      command: "check",
      ok: false,
      eligible: false,
      score: 40,
    });
    expect(JSON.stringify(report)).not.toContain(skillPath);

    const human = captureIo();
    await expect(runCli(["check", "--project", output], human.io)).resolves.toBe(3);
    expect(human.stderr).toEqual([]);
    expect(human.stdout[0]).toContain("Eligible: no");
    expect(human.stdout[0]).toContain("Status: fail");
  });

  it("reports an invalid project configuration as a stable command error", async () => {
    const project = await temporaryDirectory();
    const capture = captureIo();

    await expect(runCli(["check", "--project", project, "--json"], capture.io)).resolves.toBe(3);

    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(JSON.parse(capture.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "project.invalid",
      issues: [expect.objectContaining({ code: "config.read" })],
    });
  });

  it("does not render terminal-unsafe diagnostic paths in human output", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    await runCli(["create", "--brief", briefPath, "--output", output], captureIo().io);
    await writeFile(join(output, "skills/incident-summary/bad\nFORGED.env"), "secret=false\n");
    const capture = captureIo();

    await expect(runCli(["check", "--project", output], capture.io)).resolves.toBe(3);

    expect(capture.stderr).toEqual([]);
    expect(capture.stdout.join("")).toContain("skill resource tree cannot be validated safely");
    expect(capture.stdout.join("")).toContain("skills/incident-summary/.");
    expect(capture.stdout.join("")).not.toContain("FORGED");
    expect(capture.stdout.join("")).not.toContain("\nFORGED");
  });

  it.each([
    { args: ["check", "--project"], message: "requires a path" },
    {
      args: ["check", "--project", ".", "--project", "."],
      message: "only once",
    },
    { args: ["check", "--json", "--json"], message: "only once" },
    { args: ["check", "extra"], message: "Unknown check argument" },
  ])("rejects invalid check arguments: $message", async ({ args, message }) => {
    const capture = captureIo();

    await expect(runCli(args, capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toContain(message);
  });

  it("runs configured project tests in human and JSON modes", async () => {
    const project = await temporaryDirectory();
    const source = await readFile(new URL("fixtures/config/valid.yaml", import.meta.url), "utf8");
    const config = parse(source) as SkillPressProject;
    config.tests.commands = [
      {
        name: "passing command",
        argv: [process.execPath, "-e", "process.stdout.write('ok');process.exit(0)"],
        timeoutSeconds: 2,
      },
    ];
    await writeFile(join(project, "skillpress.yaml"), stringify(config));

    const human = captureIo();
    await expect(runCli(["test", "--project", project], human.io)).resolves.toBe(0);
    expect(human.stderr).toEqual([]);
    expect(human.stdout[0]).toContain("Project tests: pass");
    expect(human.stdout[0]).toContain("passing command: passed");
    expect(human.stdout[0]).not.toContain("ok");

    const json = captureIo();
    await expect(runCli(["test", "--project", project, "--json"], json.io)).resolves.toBe(0);
    expect(json.stderr).toEqual([]);
    expect(JSON.parse(json.stdout[0] as string)).toMatchObject({
      command: "test",
      schemaVersion: 1,
      ok: true,
      results: [{ name: "passing command", status: "passed", stdoutBytes: 2 }],
    });
  });

  it("returns a failed test report on stdout with exit 3", async () => {
    const project = await temporaryDirectory();
    const source = await readFile(new URL("fixtures/config/valid.yaml", import.meta.url), "utf8");
    const config = parse(source) as SkillPressProject;
    config.tests.commands = [
      {
        name: "failing command",
        argv: [process.execPath, "-e", "process.exit(6)"],
        timeoutSeconds: 2,
      },
    ];
    await writeFile(join(project, "skillpress.yaml"), stringify(config));
    const capture = captureIo();

    await expect(runCli(["test", "--project", project, "--json"], capture.io)).resolves.toBe(3);

    expect(capture.stderr).toEqual([]);
    expect(JSON.parse(capture.stdout[0] as string)).toMatchObject({
      command: "test",
      ok: false,
      results: [{ name: "failing command", status: "failed", exitCode: 6 }],
    });

    const human = captureIo();
    await expect(runCli(["test", "--project", project], human.io)).resolves.toBe(3);
    expect(human.stderr).toEqual([]);
    expect(human.stdout[0]).toContain("Project tests: fail");
  });

  it("reports test configuration failures and output failures deterministically", async () => {
    const invalidProject = await temporaryDirectory();
    const invalid = captureIo();
    await expect(runCli(["test", "--project", invalidProject, "--json"], invalid.io)).resolves.toBe(
      3,
    );
    expect(JSON.parse(invalid.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "project.invalid",
    });

    const project = await temporaryDirectory();
    const source = await readFile(new URL("fixtures/config/valid.yaml", import.meta.url), "utf8");
    const config = parse(source) as SkillPressProject;
    config.tests.commands = [
      {
        name: "passing command",
        argv: [process.execPath, "-e", "process.exit(0)"],
        timeoutSeconds: 2,
      },
    ];
    await writeFile(join(project, "skillpress.yaml"), stringify(config));

    await expect(
      runCli(["test", "--project", project], {
        stdout: () => {
          throw new Error("closed output");
        },
        stderr: () => undefined,
      }),
    ).resolves.toBe(1);
  });

  it.each([
    { args: ["test", "--project"], message: "requires a path" },
    {
      args: ["test", "--project", ".", "--project", "."],
      message: "only once",
    },
    { args: ["test", "--json", "--json"], message: "only once" },
    { args: ["test", "extra"], message: "Unknown test argument" },
  ])("rejects invalid test arguments: $message", async ({ args, message }) => {
    const capture = captureIo();

    await expect(runCli(args, capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toContain(message);
  });

  it("classifies invalid briefs as exit 3", async () => {
    const parent = await temporaryDirectory();
    const invalidBrief = join(parent, "invalid.yaml");
    const output = join(parent, "project");
    await writeFile(invalidBrief, "schemaVersion: 1\nname: partial\n", {
      mode: 0o600,
    });
    const capture = captureIo();

    await expect(
      runCli(["create", "--brief", invalidBrief, "--output", output, "--json"], capture.io),
    ).resolves.toBe(3);

    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(JSON.parse(capture.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "brief.invalid",
      issues: expect.arrayContaining([expect.objectContaining({ code: "brief.schema.required" })]),
    });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies existing outputs as exit 4 without changing them", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    await writeFile(output, "sentinel", { mode: 0o600 });
    const capture = captureIo();

    await expect(
      runCli(["create", "--brief", briefPath, "--output", output, "--json"], capture.io),
    ).resolves.toBe(4);

    expect(capture.stdout).toEqual([]);
    expect(JSON.parse(capture.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "create.unsafe_output",
      issues: [expect.objectContaining({ code: "create.output_exists" })],
    });
    await expect(readFile(output, "utf8")).resolves.toBe("sentinel");
  });

  it.runIf(process.platform !== "win32")("classifies staging I/O failures as exit 1", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "x".repeat(240));
    const capture = captureIo();

    await expect(
      runCli(["create", "--brief", briefPath, "--output", output, "--json"], capture.io),
    ).resolves.toBe(1);

    expect(capture.stdout).toEqual([]);
    expect(JSON.parse(capture.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "create.io",
      issues: [expect.objectContaining({ code: "create.io" })],
    });
  });

  it("does not attempt a second emission when success output itself fails", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const stderr: string[] = [];

    await expect(
      runCli(["create", "--brief", briefPath, "--output", output, "--json"], {
        stdout: () => {
          throw new Error("sensitive adapter detail");
        },
        stderr: (text) => stderr.push(text),
      }),
    ).resolves.toBe(1);

    expect(stderr).toEqual([]);
    await expect(lstat(output)).resolves.toMatchObject({});
  });

  it("does not classify a forged output-adapter error as a SkillPress domain error", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const stderr: string[] = [];
    const forged = new ProjectCreationError("attacker-controlled message", "unsafe-output", [
      {
        code: "attacker.issue",
        path: "/secret",
        message: "attacker-controlled detail",
      },
    ]);

    await expect(
      runCli(["create", "--brief", briefPath, "--output", output, "--json"], {
        stdout: () => {
          throw forged;
        },
        stderr: (text) => stderr.push(text),
      }),
    ).resolves.toBe(1);

    expect(stderr).toEqual([]);
    await expect(lstat(output)).resolves.toMatchObject({});
  });

  it("snapshots runtime arguments without using their iterator", async () => {
    const capture = captureIo();
    const args = new Proxy(["--version"], {
      get: (target, property, receiver) => {
        if (property === Symbol.iterator) {
          throw new Error("iterator must not be used");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(runCli(args, capture.io)).resolves.toBe(0);
    expect(capture.stdout).toEqual([`${VERSION}\n`]);
    expect(capture.stderr).toEqual([]);
  });

  it("uses an immutable argument snapshot across create awaits", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const args = ["create", "--brief", briefPath, "--output", output, "--json"];
    const capture = captureIo();

    const operation = runCli(args, capture.io);
    args.splice(0, args.length, "--version");

    await expect(operation).resolves.toBe(0);
    expect(JSON.parse(capture.stdout[0] as string)).toMatchObject({
      ok: true,
      command: "create",
      root: output,
    });
    await expect(lstat(output)).resolves.toMatchObject({});
  });

  it("normalizes malformed or hostile public runtime inputs", async () => {
    const capture = captureIo();
    let poison: object;
    poison = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw poison;
        },
      },
    );
    const hostileArgs = new Proxy(["--version"], {
      get: (target, property, receiver) => {
        if (property === "0") {
          throw poison;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const invalidArgs = [null, 42, ["--version", 42], new Array(65).fill("x"), hostileArgs];

    for (const args of invalidArgs) {
      await expect(runCli(args as unknown as readonly string[], capture.io)).resolves.toBe(2);
    }
    expect(capture.stderr).toHaveLength(invalidArgs.length);
    expect(capture.stderr.join("")).not.toContain("poison");

    await expect(
      runCli(
        ["--version"],
        new Proxy(
          {},
          {
            get: () => {
              throw poison;
            },
          },
        ) as typeof capture.io,
      ),
    ).resolves.toBe(1);
    await expect(
      runCli(["--version"], {
        stdout: "invalid",
        stderr: "invalid",
      } as unknown as typeof capture.io),
    ).resolves.toBe(1);
  });

  it("preserves explicit JSON mode when the argument snapshot exceeds a bound", async () => {
    for (const args of [
      ["create", "--json", ...new Array(63).fill("unknown")],
      ["create", "--json", "x".repeat(64 * 1024 + 1)],
    ]) {
      const capture = captureIo();

      await expect(runCli(args, capture.io)).resolves.toBe(2);
      expect(capture.stdout).toEqual([]);
      expect(capture.stderr).toHaveLength(1);
      expect(JSON.parse(capture.stderr[0] as string)).toMatchObject({
        ok: false,
        code: "usage",
        issues: [{ code: "cli.usage" }],
      });
    }
  });

  it.each(["throw", "reject"])(
    "never emits a second record after a success sink accepts data then %s",
    async (failureMode) => {
      const parent = await temporaryDirectory();
      const cases = [
        { args: ["--help"], output: undefined },
        { args: ["--version"], output: undefined },
        {
          args: ["create", "--brief", briefPath, "--output", join(parent, `${failureMode}-human`)],
          output: join(parent, `${failureMode}-human`),
        },
        {
          args: [
            "create",
            "--brief",
            briefPath,
            "--output",
            join(parent, `${failureMode}-json`),
            "--json",
          ],
          output: join(parent, `${failureMode}-json`),
        },
      ];

      for (const entry of cases) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const failure = new Error("late output failure");
        const exitCode = await runCli(entry.args, {
          stdout: (text) => {
            stdout.push(text);
            if (failureMode === "throw") {
              throw failure;
            }
            return Promise.reject(failure);
          },
          stderr: (text) => {
            stderr.push(text);
          },
        });

        expect(exitCode).toBe(1);
        expect(stdout).toHaveLength(1);
        expect(stderr).toEqual([]);
        if (entry.output !== undefined) {
          await expect(lstat(entry.output)).resolves.toMatchObject({});
        }
      }
    },
  );

  it("returns a stable code when an output sink itself throws", async () => {
    const forged = new ProjectCreationError("attacker-controlled", "unsafe-output", [
      { code: "attacker.issue", path: "/", message: "attacker-controlled" },
    ]);
    const errors: string[] = [];

    await expect(
      runCli(["--version"], {
        stdout: () => {
          throw forged;
        },
        stderr: (text) => errors.push(text),
      }),
    ).resolves.toBe(1);
    expect(errors).toEqual([]);
    await expect(
      runCli(["unknown"], {
        stdout: () => undefined,
        stderr: () => {
          throw forged;
        },
      }),
    ).resolves.toBe(2);
  });

  it("uses process stdout when no IO adapter is supplied", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli(["--version"])).resolves.toBe(0);
    expect(write).toHaveBeenCalledWith(`${VERSION}\n`);
  });

  it("uses process stderr when no IO adapter is supplied", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runCli(["not-a-command"])).resolves.toBe(2);
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Unknown command."));
  });
});
