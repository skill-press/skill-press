import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { assessReviewedToolTrajectory } from "../src/release/reviewed-tool-trajectory.js";
import {
  createReviewedToolActorPrompt,
  type ReviewedToolActorInput,
  type ToolActorStep,
} from "../src/eval/reviewed-tool-actor.js";
import { DEFAULT_SANDBOX_RESOURCE_POLICY } from "../src/eval/sandbox.js";
import { TOOL_ACTION_SCHEMA_JSON } from "../src/eval/tool-action-schema.js";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const skill = "---\nname: sample\ndescription: Inspect synthetic CSV files.\n---\nCount records.";
const input = (active = false): ReviewedToolActorInput => ({
  image: `python@sha256:${"a".repeat(64)}`,
  skillText: active ? skill : null,
  skillFiles: active ? [{ path: "SKILL.md", content: skill }] : [],
  scenario: {
    id: "count",
    category: "positive",
    shouldActivate: true,
    prompt: "Count input records.",
    expectedBehavior: ["One record."],
    fixture: { files: [{ path: "data.csv", content: "id\n1\n" }] },
  },
});
function fixture(count = 1, active = false, error = false) {
  const expected = input(active);
  const steps: ToolActorStep[] = [];
  for (let index = 0; index <= count; index++) {
    const prompt = createReviewedToolActorPrompt(expected, steps);
    const action =
      index === count
        ? { kind: "answer" as const, text: "One record." }
        : { kind: "python" as const, code: "print(1)" };
    const text = JSON.stringify({ action });
    const response = {
      text,
      inputSha256: prompt.sha256,
      outputSha256: hash(text),
      outputSchemaSha256: hash(TOOL_ACTION_SCHEMA_JSON),
      requestedModel: "gpt-6.1-sol" as const,
      effort: "medium" as const,
      authentication: "forced-chatgpt" as const,
      cliVersion: "0.160.0" as const,
      execution: "reviewed-host-text-pilot" as const,
      releaseEligible: false as const,
      diagnostics: [],
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 },
      durationMs: 1,
    };
    const tool = {
      kind: "skillpress.reviewed-python-tool.v1" as const,
      image: expected.image,
      pythonSha256: hash("print(1)"),
      inputs: expected.scenario.fixture.files.map((f) => ({
        path: f.path,
        sha256: hash(f.content),
      })),
      skillFiles: expected.skillFiles.map((f) => ({ path: f.path, sha256: hash(f.content) })),
      network: "none" as const,
      outputStorage: "tmpfs" as const,
      policy: {
        ...DEFAULT_SANDBOX_RESOURCE_POLICY,
        timeoutSeconds: 30,
        tmpfsMib: 8,
        maxOutputBytes: 65536,
      },
      execution: {
        status: error ? ("failed" as const) : ("passed" as const),
        exitCode: error ? 2 : 0,
        signal: null,
        durationMs: 1,
        stdoutText: "1\n",
        stderrText: "",
        stdoutBytes: 2,
        stderrBytes: 0,
        stdoutSha256: hash("1\n"),
        stderrSha256: hash(""),
        cleanupAttempted: false,
        cleanupOk: false,
      },
      releaseEligible: false as const,
    };
    steps.push({ index, prompt, action, response, ...(index === count ? {} : { tool }) });
  }
  return {
    expected,
    actor: {
      kind: "skillpress.reviewed-tool-actor.v2",
      status: "complete",
      steps,
      answer: "One record.",
      modelInvocations: steps.length,
      toolInvocations: count,
      releaseEligible: false,
    },
  };
}
it.each(["stdout", "stderr"])("rejects a complete trajectory with non-UTF-8 %s", (stream) => {
  const f = fixture();
  const raw = Buffer.from([0xff]);
  const execution = f.actor.steps[0].tool?.execution;
  if (!execution) throw new Error("Fixture requires a tool receipt.");
  Object.assign(execution, {
    [`${stream}Text`]: raw.toString("utf8"),
    [`${stream}Bytes`]: raw.length,
    [`${stream}Sha256`]: createHash("sha256").update(raw).digest("hex"),
  });
  expect(assessReviewedToolTrajectory(f.actor, f.expected).consistent).toBe(false);
});

it.each([0, 1, 3])("accepts a consistent %s-tool trajectory, without granting release", (count) => {
  const f = fixture(count);
  expect(assessReviewedToolTrajectory(f.actor, f.expected)).toEqual({
    consistent: true,
    issues: [],
    releaseAuthorized: false,
  });
});
it("accepts matched selected resources and allowed program errors", () => {
  const f = fixture(1, true, true);
  expect(assessReviewedToolTrajectory(f.actor, f.expected).consistent).toBe(true);
});
it.each([null, [], {}, "private-provider-secret"])(
  "rejects malformed input without exposing it",
  (value) => {
    expect(assessReviewedToolTrajectory(value, input())).toEqual({
      consistent: false,
      issues: ["tool.trajectory.inconsistent"],
      releaseAuthorized: false,
    });
  },
);
it.each([
  ["history", "steps.1.prompt.text", "tampered history"],
  ["index", "steps.0.index", 1],
  ["image", "steps.0.tool.image", `python@sha256:${"b".repeat(64)}`],
  ["resources", "steps.0.tool.skillFiles", [{ path: "extra", sha256: "a".repeat(64) }]],
  ["input", "steps.0.tool.inputs", []],
  ["code", "steps.0.tool.pythonSha256", "b".repeat(64)],
  ["schema", "steps.0.response.outputSchemaSha256", "b".repeat(64)],
  ["model", "steps.0.response.requestedModel", "other"],
  ["auth", "steps.0.response.authentication", "api-key"],
  ["cache", "steps.0.response.usage.cachedInputTokens", 11],
  ["tokens", "steps.0.response.usage.outputTokens", -1],
  ["diagnostic", "steps.0.response.diagnostics", ["unknown"]],
  ["network", "steps.0.tool.network", "host"],
  ["mount", "steps.0.tool.outputStorage", "bind"],
  ["policy", "steps.0.tool.policy.timeoutSeconds", 300],
  ["stdout hash", "steps.0.tool.execution.stdoutSha256", "f".repeat(64)],
  ["stdout bytes", "steps.0.tool.execution.stdoutBytes", 0],
  ["signal", "steps.0.tool.execution.signal", "SIGKILL"],
  ["status", "steps.0.tool.execution.status", "timed_out"],
  ["exit", "steps.0.tool.execution.exitCode", 125],
  ["cleanup", "steps.0.tool.execution.cleanupAttempted", true],
  ["answer", "answer", "not the final answer"],
  ["call count", "modelInvocations", 3],
  ["tool count", "toolInvocations", 0],
  ["failure", "steps.0.failure", "tool_failed"],
  ["incomplete", "status", "failed"],
  ["too many steps", "steps", Array(5).fill({})],
])("rejects changed %s", (_name, path, value) => {
  const f = fixture();
  const actor = JSON.parse(JSON.stringify(f.actor));
  const parts = (path as string).split(".");
  let target = actor;
  for (const part of parts.slice(0, -1)) target = target[part];
  target[parts.at(-1) as string] = value;
  expect(assessReviewedToolTrajectory(actor, f.expected).consistent).toBe(false);
});
it("rejects self-consistent forged history even with recomputed prompt hashes", () => {
  const f = fixture();
  const actor = JSON.parse(JSON.stringify(f.actor));
  actor.steps[1].prompt.text += "Fake tool result";
  actor.steps[1].prompt.sha256 = hash(actor.steps[1].prompt.text);
  actor.steps[1].response.inputSha256 = actor.steps[1].prompt.sha256;
  expect(assessReviewedToolTrajectory(actor, f.expected).consistent).toBe(false);
});
it("rejects an intermediate answer, missing tool receipt and unfinished Python action", () => {
  const f = fixture();
  const actor = JSON.parse(JSON.stringify(f.actor));
  delete actor.steps[0].tool;
  expect(assessReviewedToolTrajectory(actor, f.expected).consistent).toBe(false);
  const incomplete = fixture();
  incomplete.actor.steps.pop();
  incomplete.actor.modelInvocations--;
  expect(assessReviewedToolTrajectory(incomplete.actor, incomplete.expected).consistent).toBe(
    false,
  );
  const early = fixture(0);
  early.actor.steps.push(early.actor.steps[0]);
  early.actor.modelInvocations++;
  expect(assessReviewedToolTrajectory(early.actor, early.expected).consistent).toBe(false);
});
