import { stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TOOL_ACTION_SCHEMA_JSON } from "../src/eval/tool-action-schema.js";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/process/capture.js", () => ({ runCapturedCommand: vi.fn() }));
import {
  runReviewedCodexText,
  runReviewedTextPair,
  runReviewedSelectedTextPair,
} from "../src/eval/codex-text.js";
import type { SkillPressEvaluationRubric } from "../src/eval/generated-rubric.js";
import type { Scenario } from "../src/eval/generated-suite.js";
import { type CapturedCommandResult, runCapturedCommand } from "../src/process/capture.js";

const run = vi.mocked(runCapturedCommand);
function result(
  stdout: string,
  status: CapturedCommandResult["status"] = "passed",
): CapturedCommandResult {
  return {
    status,
    exitCode: status === "passed" ? 0 : 1,
    signal: null,
    durationMs: 5,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from("private-provider-diagnostic"),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 27,
    stdoutSha256: "a".repeat(64),
    stderrSha256: "b".repeat(64),
  };
}
const events = [
  { type: "thread.started", thread_id: "private-id" },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: "Reviewed draft." } },
  { type: "turn.completed", usage: { input_tokens: 4, cached_input_tokens: 0, output_tokens: 3 } },
]
  .map((event) => JSON.stringify(event))
  .join("\n");
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("reviewed Codex text pilot transport (no live calls)", () => {
  it("passes only a private fixed output schema and retains its hash", async () => {
    let schemaPath = "";
    run.mockImplementation(async (command) => {
      if (command.argv[1] === "--version") return result("codex-cli 0.160.0\n");
      schemaPath = command.argv[command.argv.indexOf("--output-schema") + 1];
      expect(schemaPath.startsWith(command.cwd)).toBe(true);
      expect((await stat(schemaPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(schemaPath, "utf8")).toBe(TOOL_ACTION_SCHEMA_JSON);
      expect(command.argv).toContain('forced_login_method="chatgpt"');
      return result(events);
    });
    const response = await runReviewedCodexText(
      "Synthetic tool protocol.",
      undefined,
      "tool-action-v1",
    );
    expect(response.outputSchemaSha256).toBe(
      createHash("sha256").update(TOOL_ACTION_SCHEMA_JSON).digest("hex"),
    );
    await expect(stat(schemaPath)).rejects.toThrow();
  });

  it("rejects unknown output schema modes before provider calls", async () => {
    await expect(
      runReviewedCodexText("Synthetic.", undefined, "other" as "tool-action-v1"),
    ).rejects.toThrow("Unknown reviewed output schema");
    expect(run).not.toHaveBeenCalled();
  });

  const scenario: Scenario = {
    id: "notes",
    category: "positive",
    shouldActivate: true,
    prompt: "Write notes.",
    expectedBehavior: ["Accurate."],
  };
  const rubric: SkillPressEvaluationRubric = {
    schemaVersion: 1,
    name: "quality",
    criteria: [
      { id: "accuracy", description: "Factual accuracy", weight: 100, evaluator: "judge" },
    ],
  };

  it("rejects non-schema pilot weights and categories before any invocation", async () => {
    const invalidRubric = {
      ...rubric,
      criteria: rubric.criteria.map((c) => ({ ...c, weight: 0.5 })),
    };
    await expect(runReviewedTextPair(scenario, invalidRubric, "skill")).rejects.toThrow(/rubric/);
    await expect(runReviewedSelectedTextPair(scenario, invalidRubric, "skill")).rejects.toThrow(
      /rubric/,
    );
    await expect(
      runReviewedTextPair(
        { ...scenario, category: "negative" } as unknown as Scenario,
        rubric,
        "skill",
      ),
    ).rejects.toThrow(/suite/);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([true, false])("loads the body only after observed selection %s", async (selected) => {
    const skill = "---\nname: notes\ndescription: Draft notes.\n---\nPRIVATE INSTRUCTIONS";
    const judge = JSON.stringify({ criteria: [{ id: "accuracy", score: 1, rationale: "Good." }] });
    for (const text of [
      JSON.stringify({ selected, rationale: "Decision." }),
      "Answer",
      judge,
      "Answer",
      judge,
    ]) {
      const stream = events.replace("Reviewed draft.", text.replaceAll('"', '\\"'));
      run.mockResolvedValueOnce(result("codex-cli 0.160.0")).mockResolvedValueOnce(result(stream));
    }
    // Deliberately opposite ground truth: the harness must not copy the label.
    const pair = await runReviewedSelectedTextPair(
      {
        ...scenario,
        category: selected ? "near-miss" : "positive",
        shouldActivate: !selected,
        forbiddenBehavior: ["Invent facts."],
      },
      rubric,
      skill,
    );
    expect(pair).toMatchObject({
      modelInvocations: 5,
      releaseEligible: false,
      activationMeasurement: "harness-metadata-selection",
      baseline: { activated: false },
      withSkill: { activated: selected },
    });
    const prompts = run.mock.calls.map(([c]) => c.stdin).filter((s) => s !== undefined);
    expect(prompts).toHaveLength(5);
    for (const index of [0, 1, 2, 4]) expect(prompts[index]).not.toContain("PRIVATE INSTRUCTIONS");
    expect(prompts[3]?.includes("PRIVATE INSTRUCTIONS")).toBe(selected);
    expect(prompts[3]).not.toContain("Decision.");
  });

  it("stops on invalid selection before actors and judges", async () => {
    run.mockResolvedValueOnce(result("codex-cli 0.160.0")).mockResolvedValueOnce(result(events));
    await expect(
      runReviewedSelectedTextPair(
        scenario,
        rubric,
        "---\nname: notes\ndescription: Draft notes.\n---\nbody",
      ),
    ).rejects.toThrow(/selection response/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("connects four serial fresh invocations without mixing arms or exposing answers to the actor", async () => {
    const judgeText = JSON.stringify({
      criteria: [{ id: "accuracy", score: 0.5, rationale: "Partial." }],
    });
    for (const output of [
      events,
      events.replace("Reviewed draft.", judgeText.replaceAll('"', '\\"')),
      events,
      events.replace("Reviewed draft.", judgeText.replaceAll('"', '\\"')),
    ]) {
      run.mockResolvedValueOnce(result("codex-cli 0.160.0")).mockResolvedValueOnce(result(output));
    }
    const pair = await runReviewedTextPair(scenario, rubric, "Reviewed skill instructions.");
    expect(pair).toMatchObject({
      modelInvocations: 4,
      releaseEligible: false,
      baseline: { criteria: [{ id: "accuracy", score: 0.5 }] },
      withSkill: { criteria: [{ id: "accuracy", score: 0.5 }] },
    });
    const commands = run.mock.calls
      .map(([command]) => command)
      .filter((command) => command.stdin !== undefined);
    expect(commands).toHaveLength(4);
    expect(new Set(commands.map(({ cwd }) => cwd)).size).toBe(4);
    expect(commands[0]?.stdin).not.toContain("Reviewed skill instructions.");
    expect(commands[0]?.stdin).not.toContain("Factual accuracy");
    expect(commands[1]?.stdin).toContain("Factual accuracy");
    expect(commands[2]?.stdin).toContain("Reviewed skill instructions.");
    expect(commands[3]?.stdin).not.toContain("Reviewed skill instructions.");
  });

  it("stops the experiment on a failed actor or invalid judge without starting another arm", async () => {
    run
      .mockResolvedValueOnce(result("codex-cli 0.160.0"))
      .mockResolvedValueOnce(result("", "failed"));
    await expect(runReviewedTextPair(scenario, rubric, "skill")).rejects.toThrow(/stopped/);
    expect(run).toHaveBeenCalledTimes(2);
    run.mockReset();
    for (let index = 0; index < 2; index++) {
      run.mockResolvedValueOnce(result("codex-cli 0.160.0")).mockResolvedValueOnce(result(events));
    }
    await expect(runReviewedTextPair(scenario, rubric, "skill")).rejects.toThrow(/judge response/);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("uses fixed ChatGPT/model/effort, isolated temporary cwd and stdin without API credentials", async () => {
    vi.stubEnv("OPENAI_API_KEY", "never-inherit");
    vi.stubEnv("CODEX_API_KEY", "never-inherit-either");
    vi.stubEnv("LANG", undefined);
    run.mockResolvedValueOnce(result("codex-cli 0.160.0\n")).mockResolvedValueOnce(result(events));
    const signal = new AbortController().signal;
    const response = await runReviewedCodexText("reviewed prompt", signal);
    expect(response).toMatchObject({
      text: "Reviewed draft.",
      requestedModel: "gpt-6.1-sol",
      effort: "medium",
      authentication: "forced-chatgpt",
      cliVersion: "0.160.0",
      execution: "reviewed-host-text-pilot",
      releaseEligible: false,
    });
    expect(response.inputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(response.outputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(response)).not.toContain("private-provider");
    const command = run.mock.calls[1]?.[0];
    expect(command).toMatchObject({
      stdin: "reviewed prompt",
      timeoutSeconds: 120,
      maxOutputBytes: 1048576,
      signal,
    });
    expect(command?.argv).not.toContain("reviewed prompt");
    expect(command?.argv).toEqual(
      expect.arrayContaining([
        "--ignore-user-config",
        "--strict-config",
        "--ephemeral",
        "read-only",
        'forced_login_method="chatgpt"',
        'model_reasoning_effort="medium"',
        'approval_policy="never"',
        'web_search="disabled"',
        "mcp_servers={}",
        "agents.enabled=false",
      ]),
    );
    for (const feature of [
      "shell_tool",
      "unified_exec",
      "apps",
      "plugins",
      "hooks",
      "multi_agent",
      "browser_use",
      "computer_use",
      "image_generation",
      "view_image",
      "code_mode_host",
      "goals",
    ]) {
      const index = command?.argv.indexOf(feature) ?? -1;
      expect(index).toBeGreaterThan(0);
      expect(command?.argv[index - 1]).toBe("--disable");
    }
    expect(command?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(command?.env).not.toHaveProperty("CODEX_API_KEY");
    expect(command?.env).not.toHaveProperty("LANG");
    await expect(stat(command?.cwd as string)).rejects.toMatchObject({ code: "ENOENT" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(["", " ", "界".repeat(400000)])(
    "rejects invalid input before any subprocess",
    async (input) => {
      await expect(runReviewedCodexText(input)).rejects.toThrow(/input/);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each([result("codex-cli 0.159.3"), result("", "spawn_error")])(
    "stops at failed version preflight",
    async (value) => {
      run.mockResolvedValueOnce(value);
      await expect(runReviewedCodexText("prompt")).rejects.toThrow(/version 0.160.0/);
      expect(run).toHaveBeenCalledTimes(1);
      await expect(stat(run.mock.calls[0]?.[0].cwd as string)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each(["failed", "timed_out", "aborted", "output_limit", "spawn_error"] as const)(
    "stops on %s without retry/fallback or raw diagnostics",
    async (status) => {
      run
        .mockResolvedValueOnce(result("codex-cli 0.160.0"))
        .mockResolvedValueOnce(result("secret", status));
      await expect(runReviewedCodexText("prompt")).rejects.toThrow(
        `Codex pilot stopped: ${status}.`,
      );
      expect(run).toHaveBeenCalledTimes(2);
      await expect(stat(run.mock.calls[1]?.[0].cwd as string)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects malformed/tool output even on exit zero", async () => {
    run
      .mockResolvedValueOnce(result("codex-cli 0.160.0"))
      .mockResolvedValueOnce(result(events.replace("agent_message", "command_execution")));
    await expect(runReviewedCodexText("prompt")).rejects.toThrow(/Invalid/);
  });
});
