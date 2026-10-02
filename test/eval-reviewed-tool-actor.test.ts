import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/eval/codex-text.js", () => ({ runReviewedCodexText: vi.fn() }));
vi.mock("../src/eval/reviewed-python-tool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/eval/reviewed-python-tool.js")>()),
  runReviewedPythonTool: vi.fn(),
}));
import { runReviewedCodexText } from "../src/eval/codex-text.js";
import { runReviewedPythonTool } from "../src/eval/reviewed-python-tool.js";
import {
  parseToolActorAction,
  runReviewedToolActor,
  type ReviewedToolActorInput,
} from "../src/eval/reviewed-tool-actor.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const skill =
  "---\nname: csv-quality-check\ndescription: Inspect CSV files.\n---\nRead scripts/profile.py.\n";
const input = (withSkill = false): ReviewedToolActorInput => ({
  image: `python@sha256:${"a".repeat(64)}`,
  skillText: withSkill ? skill : null,
  skillFiles: withSkill
    ? [
        { path: "SKILL.md", content: skill },
        { path: "scripts/profile.py", content: "print('synthetic')" },
      ]
    : [],
  scenario: {
    id: "csv",
    category: "positive",
    shouldActivate: true,
    prompt: "Inspect input.csv.",
    fixture: { files: [{ path: "input.csv", content: "id\n001\n" }] },
    expectedBehavior: ["SECRET_EXPECTED"],
    forbiddenBehavior: ["SECRET_FORBIDDEN"],
  },
});
const model = vi.mocked(runReviewedCodexText);
const tool = vi.mocked(runReviewedPythonTool);
const receipt = (text: string) =>
  ({ text, inputSha256: "a".repeat(64), outputSha256: hash(text) }) as Awaited<
    ReturnType<typeof runReviewedCodexText>
  >;
const outcome = (status = "passed", extra: Record<string, unknown> = {}) => {
  const stdoutText = (extra.stdoutText ?? '{"rows":1}') as string;
  const stderrText = (extra.stderrText ?? "") as string;
  return {
    execution: {
      status,
      exitCode: status === "passed" ? 0 : 2,
      signal: null,
      stdoutText,
      stderrText,
      stdoutBytes: Buffer.byteLength(stdoutText),
      stderrBytes: Buffer.byteLength(stderrText),
      stdoutSha256: hash(stdoutText),
      stderrSha256: hash(stderrText),
      cleanupAttempted: false,
      cleanupOk: false,
      ...extra,
    },
    releaseEligible: false,
  } as Awaited<ReturnType<typeof runReviewedPythonTool>>;
};
const wire = (action: unknown) => JSON.stringify({ action });
const python = wire({ kind: "python", code: "print('observed')" });
const answer = wire({ kind: "answer", text: "One data record." });
afterEach(() => vi.resetAllMocks());

it.each(["stdout", "stderr"])(
  "retains non-UTF-8 %s output and stops before another model call",
  async (stream) => {
    const raw = Buffer.from([0xff]);
    model.mockResolvedValue(receipt(python));
    const observed = outcome("passed", {
      [`${stream}Text`]: raw.toString("utf8"),
      [`${stream}Bytes`]: raw.length,
      [`${stream}Sha256`]: createHash("sha256").update(raw).digest("hex"),
    });
    tool.mockResolvedValue(observed);
    const checkpoint = vi.fn();
    const result = await runReviewedToolActor(input(), checkpoint);
    expect(result).toMatchObject({
      status: "failed",
      failure: "tool_failed",
      modelInvocations: 1,
      toolInvocations: 1,
    });
    expect(result.steps[0].tool).toEqual(observed);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(model).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  "records actual requested tool transitions without expected-answer leakage (skill=%s)",
  async (withSkill) => {
    model.mockResolvedValueOnce(receipt(python)).mockResolvedValueOnce(receipt(answer));
    tool.mockResolvedValue(outcome());
    const checkpoint = vi.fn();
    const result = await runReviewedToolActor(input(withSkill), checkpoint);
    expect(result).toMatchObject({
      status: "complete",
      answer: "One data record.",
      modelInvocations: 2,
      toolInvocations: 1,
      releaseEligible: false,
    });
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(tool).toHaveBeenCalledWith({
      python: "print('observed')",
      image: input().image,
      inputs: input().scenario.fixture?.files,
      skillFiles: input(withSkill).skillFiles,
    });
    const first = model.mock.calls[0][0];
    expect(model.mock.calls.every((call) => call[2] === "tool-action-v1")).toBe(true);
    expect(first).not.toContain("SECRET_EXPECTED");
    expect(first).not.toContain("SECRET_FORBIDDEN");
    expect(first).not.toContain("id\\n001");
    expect(first.includes("Read scripts/profile.py")).toBe(withSkill);
    expect(first.includes("print('synthetic')")).toBe(false);
    expect(model.mock.calls[1][0]).toContain("rows");
    for (const step of result.steps) expect(step.prompt.sha256).toBe(hash(step.prompt.text));
  },
);

it("answers unrelated tasks without forcing tool use", async () => {
  model.mockResolvedValue(receipt(answer));
  const options = input();
  const result = await runReviewedToolActor(
    { ...options, scenario: { ...options.scenario, fixture: undefined } },
    async () => {},
  );
  expect(result.status).toBe("complete");
  expect(tool).not.toHaveBeenCalled();
});

it.each([
  "garbage",
  "null",
  "[]",
  "{}",
  wire(null),
  wire([]),
  wire({}),
  wire({ kind: "answer", text: "", extra: true }),
  wire({ kind: "python", code: " " }),
  wire({ kind: "python", code: "x".repeat(65537) }),
  wire({ kind: "answer", text: "x".repeat(24577) }),
  "x".repeat(131073),
  wire({ kind: "shell", code: "whoami" }),
])("rejects malformed action without execution", (text) => {
  expect(() => parseToolActorAction(text)).toThrow();
});

it.each(["model", "parse", "tool", "timeout", "output", "cleanup"])(
  "stops and preserves failed %s attempts without automatic retry",
  async (kind) => {
    model.mockResolvedValue(receipt(kind === "parse" ? "invalid" : python));
    tool.mockResolvedValue(outcome());
    if (kind === "model") model.mockRejectedValue(new Error("PRIVATE_PROVIDER_ERROR"));
    if (kind === "tool") tool.mockRejectedValue(new Error("PRIVATE_HOST_ERROR"));
    if (kind === "timeout")
      tool.mockResolvedValue(outcome("timed_out", { cleanupAttempted: true, cleanupOk: true }));
    if (kind === "output")
      tool.mockResolvedValue(outcome("output_limit", { cleanupAttempted: true, cleanupOk: true }));
    if (kind === "cleanup")
      tool.mockResolvedValue(outcome("failed", { cleanupAttempted: true, cleanupOk: false }));
    const result = await runReviewedToolActor(input(), async () => {});
    expect(result.status).toBe("failed");
    expect(model).toHaveBeenCalledTimes(1);
    expect(result.steps).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  },
);

it("lets the actor interpret normal Python input errors", async () => {
  model.mockResolvedValueOnce(receipt(python)).mockResolvedValueOnce(receipt(answer));
  tool.mockResolvedValue(outcome("failed", { stderrText: "invalid CSV" }));
  expect((await runReviewedToolActor(input(), async () => {})).status).toBe("complete");
  expect(model.mock.calls[1][0]).toContain("invalid CSV");
});

it.each([125, 126, 127, 137, 3, null])(
  "stops on infrastructure or unsupported exit %s",
  async (exitCode) => {
    model.mockResolvedValue(receipt(python));
    tool.mockResolvedValue(outcome("failed", { exitCode, stderrText: "PRIVATE_ENGINE_DETAIL" }));
    expect(await runReviewedToolActor(input(), async () => {})).toMatchObject({
      status: "failed",
      failure: "tool_failed",
    });
    expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0][0]).not.toContain("PRIVATE_ENGINE_DETAIL");
  },
);

it("stops on signal termination even when an exit code is also present", async () => {
  model.mockResolvedValue(receipt(python));
  tool.mockResolvedValue(outcome("failed", { exitCode: 1, signal: "SIGKILL" }));
  expect((await runReviewedToolActor(input(), async () => {})).status).toBe("failed");
  expect(model).toHaveBeenCalledTimes(1);
});

it("caps tool requests at three and model attempts at four", async () => {
  model.mockResolvedValue(receipt(python));
  tool.mockResolvedValue(outcome());
  expect(await runReviewedToolActor(input(), async () => {})).toMatchObject({
    status: "failed",
    failure: "tool_limit",
    modelInvocations: 4,
    toolInvocations: 3,
  });
  expect(tool).toHaveBeenCalledTimes(3);
});

it.each(["before", "model", "tool"])("stops subsequent actions when aborted %s", async (when) => {
  const controller = new AbortController();
  if (when === "before") controller.abort();
  model.mockImplementation(async (_prompt, signal) => {
    expect(signal).toBe(controller.signal);
    if (when === "model") controller.abort();
    return receipt(python);
  });
  tool.mockImplementation(async () => {
    controller.abort();
    return outcome();
  });
  const result = await runReviewedToolActor(input(), async () => {}, controller.signal);
  expect(result).toMatchObject({ status: "failed", failure: "aborted" });
  expect(model).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
  expect(tool).toHaveBeenCalledTimes(when === "tool" ? 1 : 0);
});

it("isolates checkpoints from active transcript and stops on persistence failure", async () => {
  model.mockResolvedValueOnce(receipt(python)).mockResolvedValueOnce(receipt(answer));
  tool.mockResolvedValue(outcome());
  const result = await runReviewedToolActor(input(), (step) => {
    (step as { action?: unknown }).action = { kind: "answer", text: "INJECTED_CHECKPOINT" };
  });
  expect(JSON.stringify(result)).not.toContain("INJECTED_CHECKPOINT");
  expect(model.mock.calls[1][0]).not.toContain("INJECTED_CHECKPOINT");
  model.mockReset().mockResolvedValue(receipt(python));
  await expect(
    runReviewedToolActor(input(), () => {
      throw new Error("storage unavailable");
    }),
  ).rejects.toThrow("storage unavailable");
  expect(model).toHaveBeenCalledTimes(1);
});

it("bounds accumulated tool observations before the next model call", async () => {
  model.mockResolvedValue(receipt(python));
  tool.mockResolvedValue(outcome("passed", { stdoutText: "x".repeat(1024 * 1024) }));
  await expect(runReviewedToolActor(input(), async () => {})).rejects.toThrow("input limit");
  expect(model).toHaveBeenCalledTimes(1);
});

it.each(["baseline-files", "mismatch", "metadata", "env", "image", "path", "schema"])(
  "rejects %s before model calls",
  async (kind) => {
    const options = input(kind === "mismatch" || kind === "metadata");
    const change = structuredClone(options);
    if (kind === "baseline-files")
      Object.assign(change, { skillFiles: [{ path: "file", content: "hidden skill" }] });
    if (kind === "mismatch") Object.assign(change, { skillText: `${skill}changed` });
    if (kind === "metadata") Object.assign(change, { skillText: "invalid" });
    if (kind === "env")
      Object.assign(change.scenario.fixture ?? {}, { environment: { SECRET: "value" } });
    if (kind === "image") Object.assign(change, { image: "python:latest" });
    if (kind === "path")
      Object.assign(change.scenario, { fixture: { files: [{ path: "../escape", content: "x" }] } });
    if (kind === "schema") Object.assign(change.scenario, { category: "invalid" });
    await expect(runReviewedToolActor(change, async () => {})).rejects.toThrow();
    expect(model).not.toHaveBeenCalled();
    expect(tool).not.toHaveBeenCalled();
  },
);
