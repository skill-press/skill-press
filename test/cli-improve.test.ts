import { afterEach, describe, expect, it, vi } from "vitest";

import { runImproveCommand } from "../src/cli/improve.js";
import { ProjectConfigError } from "../src/config/errors.js";
import { EvaluationInputError } from "../src/eval/errors.js";
import type { CommandImprovementResult } from "../src/improve/command-workflow.js";
import { ImprovementLoopError } from "../src/improve/state-machine.js";
import { ImprovementWorkflowError } from "../src/improve/workflow-error.js";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

function result(success: boolean): CommandImprovementResult {
  return {
    schemaVersion: 1,
    resultType: "skillpress.improve-command",
    changed: success,
    storagePath: `.skill-press/improvements/${"1".repeat(64)}/report.json`,
    report: {
      schemaVersion: 1,
      reportType: "skillpress.improve",
      startedAt: "2026-08-24T12:00:00.000Z",
      finishedAt: "2026-08-24T12:00:01.000Z",
      success,
      stopReason: success ? "target_reached" : "no_improvement",
      initialCandidateSha256: "2".repeat(64),
      finalCandidateSha256: (success ? "3" : "2").repeat(64),
      trainingScenarioSetSha256: "4".repeat(64),
      holdoutScenarioSetSha256: "5".repeat(64),
      budget: { iterationsUsed: 1, tokensUsed: 10, costUsd: 0.01, wallMilliseconds: 1000 },
      iterations: [],
    },
  };
}

function operations() {
  return {
    improve: vi.fn(async () => result(true)),
  } satisfies NonNullable<Parameters<typeof runImproveCommand>[2]>;
}

const training = `.skill-press/runs/${"6".repeat(64)}/evidence.json`;
const holdout = `.skill-press/runs/${"7".repeat(64)}/evidence.json`;
const required = [
  "--training-evidence",
  training,
  "--holdout-evidence",
  holdout,
  "--author-command",
  "author",
  "--reviewer-command",
  "reviewer",
  "--evaluator-command",
  "evaluator",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("improve CLI orchestration", () => {
  it("requires measured evidence and all three role commands", async () => {
    const output = capture();
    await expect(runImproveCommand(["--json"], output.io)).resolves.toBe(2);
    expect(JSON.parse(output.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "usage",
      issues: [{ code: "cli.usage" }],
    });
  });

  it("passes explicit argv, environment allowlists, and timeout without exposing values", async () => {
    vi.stubEnv("SKILLPRESS_TEST_ROLE_TOKEN", "role-secret");
    const ops = operations();
    const output = capture();
    await expect(
      runImproveCommand(
        [
          "--project",
          ".",
          ...required,
          "--author-arg",
          "--model",
          "--author-arg",
          "model-name",
          "--author-env",
          "SKILLPRESS_TEST_ROLE_TOKEN",
          "--command-timeout",
          "30",
          "--json",
        ],
        output.io,
        ops,
      ),
    ).resolves.toBe(0);
    expect(ops.improve).toHaveBeenCalledWith(".", {
      trainingEvidencePath: training,
      holdoutEvidencePath: holdout,
      author: {
        argv: ["author", "--model", "model-name"],
        env: { SKILLPRESS_TEST_ROLE_TOKEN: "role-secret" },
      },
      reviewer: { argv: ["reviewer"] },
      evaluator: { argv: ["evaluator"] },
      commandTimeoutSeconds: 30,
    });
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      command: "improve",
      ok: true,
      changed: true,
      report: { stopReason: "target_reached" },
    });
    expect(output.stdout.join("")).not.toContain("role-secret");
  });

  it("returns exit 3 with the complete bounded report when the target is not reached", async () => {
    const ops = operations();
    ops.improve.mockResolvedValue(result(false));
    const output = capture();

    await expect(runImproveCommand([...required, "--json"], output.io, ops)).resolves.toBe(3);
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      command: "improve",
      ok: false,
      changed: false,
      report: { success: false, stopReason: "no_improvement" },
    });
  });

  it("does not reflect hostile unknown options", async () => {
    const output = capture();
    await expect(runImproveCommand(["FORGED\u001b[31m"], output.io)).resolves.toBe(2);
    expect(output.stderr.join("")).not.toContain("FORGED");
  });

  it.each([
    ["duplicate json", [...required, "--json", "--json"]],
    ["duplicate singleton", [...required, "--project", ".", "--project", "."]],
    ["missing path value", ["--training-evidence"]],
    ["unsafe path", ["--training-evidence", "bad\0path"]],
    ["empty argument", [...required, "--author-arg", ""]],
    ["non-integer timeout", [...required, "--command-timeout", "1.5"]],
    ["oversized timeout", [...required, "--command-timeout", "7201"]],
    ["invalid environment", [...required, "--author-env", "lowercase"]],
  ])("rejects %s", async (_name, args) => {
    const output = capture();
    await expect(runImproveCommand(args, output.io)).resolves.toBe(2);
    expect(output.stderr.join("")).toContain("cli.usage");
  });

  it("bounds repeated argv and rejects duplicate or unavailable environment names", async () => {
    const tooMany = capture();
    const repeated = Array.from({ length: 32 }, () => ["--author-arg", "x"]).flat();
    await expect(runImproveCommand([...required, ...repeated], tooMany.io)).resolves.toBe(2);

    vi.stubEnv("SKILLPRESS_DUPLICATE_ENV", "set");
    const duplicate = capture();
    await expect(
      runImproveCommand(
        [
          ...required,
          "--author-env",
          "SKILLPRESS_DUPLICATE_ENV",
          "--author-env",
          "SKILLPRESS_DUPLICATE_ENV",
        ],
        duplicate.io,
      ),
    ).resolves.toBe(2);

    delete process.env.SKILLPRESS_TEST_UNAVAILABLE_9F21;
    const unavailable = capture();
    await expect(
      runImproveCommand(
        [...required, "--reviewer-env", "SKILLPRESS_TEST_UNAVAILABLE_9F21"],
        unavailable.io,
      ),
    ).resolves.toBe(2);
  });

  it("passes repeated arguments and all role environments in human mode", async () => {
    vi.stubEnv("SKILLPRESS_REVIEW_ENV", "review-secret");
    vi.stubEnv("SKILLPRESS_EVAL_ENV", "eval-secret");
    const ops = operations();
    const output = capture();
    await expect(
      runImproveCommand(
        [
          ...required,
          "--reviewer-arg",
          "review-arg",
          "--evaluator-arg",
          "eval-arg",
          "--reviewer-env",
          "SKILLPRESS_REVIEW_ENV",
          "--evaluator-env",
          "SKILLPRESS_EVAL_ENV",
        ],
        output.io,
        ops,
      ),
    ).resolves.toBe(0);
    expect(output.stdout.join("")).toContain("Improvement: target reached");
    expect(ops.improve.mock.calls[0]?.[1]).toMatchObject({
      reviewer: {
        argv: ["reviewer", "review-arg"],
        env: { SKILLPRESS_REVIEW_ENV: "review-secret" },
      },
      evaluator: { argv: ["evaluator", "eval-arg"], env: { SKILLPRESS_EVAL_ENV: "eval-secret" } },
    });
  });

  it.each([
    new ProjectConfigError("config", [{ code: "config", path: "/", message: "bad" }]),
    new EvaluationInputError("eval", [{ code: "eval", path: "/", message: "bad" }]),
    new ImprovementLoopError("loop", [{ code: "loop", path: "/", message: "bad" }]),
    new ImprovementWorkflowError("workflow", [{ code: "workflow", path: "/", message: "bad" }]),
    Object.assign(new Error("missing"), { code: "ENOENT" }),
  ])("reports an expected improvement failure without an internal trace", async (error) => {
    const ops = operations();
    ops.improve.mockRejectedValue(error);
    const output = capture();
    await expect(runImproveCommand([...required, "--json"], output.io, ops)).resolves.toBe(3);
    expect(JSON.parse(output.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "improve_blocked",
    });
  });

  it("handles unknown failures and closed output sinks", async () => {
    const unexpected = operations();
    unexpected.improve.mockRejectedValue(new Error("secret internal detail"));
    const output = capture();
    await expect(runImproveCommand(required, output.io, unexpected)).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("failed unexpectedly");
    expect(output.stderr.join("")).not.toContain("secret internal detail");

    const success = operations();
    await expect(
      runImproveCommand(
        required,
        { stdout: () => Promise.reject(new Error("closed")), stderr: () => {} },
        success,
      ),
    ).resolves.toBe(1);
    await expect(
      runImproveCommand(
        [],
        { stdout: () => {}, stderr: () => Promise.reject(new Error("closed")) },
        success,
      ),
    ).resolves.toBe(1);
  });
});
