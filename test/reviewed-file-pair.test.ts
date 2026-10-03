import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/eval/codex-text.js", () => ({ runReviewedCodexText: vi.fn() }));
vi.mock("../src/eval/reviewed-python-tool.js", async (original) => ({
  ...(await original<typeof import("../src/eval/reviewed-python-tool.js")>()),
  runReviewedPythonFileTool: vi.fn(),
}));
import { runReviewedCodexText } from "../src/eval/codex-text.js";
import { runReviewedPythonFileTool } from "../src/eval/reviewed-python-tool.js";
import {
  FILE_PAIR_MODEL_CALLS,
  runReviewedFilePair,
  validateReviewedFilePairInput,
  type FilePairEvent,
} from "../src/eval/reviewed-file-pair.js";

const model = vi.mocked(runReviewedCodexText);
const tool = vi.mocked(runReviewedPythonFileTool);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const bytes = Uint8Array.from([0, 255, 1]);
const skillText =
  "---\nname: file-brief\ndescription: Explain delivered changes.\n---\nSKILL_ONLY_SECRET";
const scores = JSON.stringify({
  criteria: [{ id: "accuracy", score: 1, rationale: "Read original bytes." }],
});
const input = () => ({
  suite: "training" as const,
  scenario: {
    id: "delivery",
    category: "positive" as const,
    shouldActivate: true,
    prompt: "Explain the delivered changes in Chinese.",
    expectedBehavior: ["EXPECTED_ONLY_JUDGE"],
    forbiddenBehavior: ["FORBIDDEN_ONLY_JUDGE"],
    fixture: {
      files: [
        {
          path: "artifact.bin",
          source: "fixtures/training/artifact.bin",
          bytes: bytes.length,
          sha256: hash(bytes),
        },
      ],
    },
  },
  files: [{ path: "artifact.bin", content: bytes }],
  image: `python@sha256:${"a".repeat(64)}`,
  skillText,
  skillFiles: [{ path: "SKILL.md", content: skillText }],
  rubric: {
    schemaVersion: 1 as const,
    name: "quality",
    criteria: [
      {
        id: "accuracy",
        evaluator: "judge" as const,
        description: "Correct delivered meaning",
        weight: 100,
      },
    ],
  },
});
const receipt = (text: string) => ({ text }) as Awaited<ReturnType<typeof runReviewedCodexText>>;
const answer = (text: string) => receipt(JSON.stringify({ action: { kind: "answer", text } }));
const python = () =>
  receipt(
    JSON.stringify({
      action: { kind: "python", code: "print('inspect originals')" },
    }),
  );
const execution = () => ({
  status: "passed" as const,
  exitCode: 0,
  signal: null,
  stdoutText: "original bytes observed",
  stdoutBytes: Buffer.byteLength("original bytes observed"),
  stdoutSha256: hash("original bytes observed"),
  stderrText: "",
  stderrBytes: 0,
  stderrSha256: hash(""),
  cleanupAttempted: false,
  cleanupOk: false,
});
function setup(selected = true) {
  model
    .mockResolvedValueOnce(receipt(JSON.stringify({ selected, rationale: "Task applies" })))
    .mockResolvedValueOnce(answer("BASELINE_ONLY_ANSWER"))
    .mockResolvedValueOnce(python())
    .mockResolvedValueOnce(answer(scores))
    .mockResolvedValueOnce(answer("SKILL_ONLY_ANSWER"))
    .mockResolvedValueOnce(python())
    .mockResolvedValueOnce(answer(scores));
  tool.mockResolvedValue({
    kind: "skillpress.reviewed-python-tool.v2",
    execution: execution(),
  } as Awaited<ReturnType<typeof runReviewedPythonFileTool>>);
}
afterEach(() => vi.resetAllMocks());

it.each([true, false])(
  "keeps original bytes and independent judges while selection=%s",
  async (selected) => {
    setup(selected);
    const events: FilePairEvent[] = [];
    const result = await runReviewedFilePair(input(), (event) => {
      events.push(event);
    });
    expect(result).toMatchObject({
      kind: "skillpress.reviewed-file-pair.v1",
      modelInvocations: 7,
      maximumModelCalls: FILE_PAIR_MODEL_CALLS,
      releaseEligible: false,
      withSkill: { activated: selected },
    });
    expect(events).toHaveLength(9);
    for (const event of events) {
      expect(event.prompt.sha256).toBe(hash(event.prompt.text));
      if (event.phase !== "judge") {
        expect(event.prompt.text).not.toContain("EXPECTED_ONLY_JUDGE");
        expect(event.prompt.text).not.toContain("FORBIDDEN_ONLY_JUDGE");
      } else {
        expect(event.prompt.text).toContain("EXPECTED_ONLY_JUDGE");
        expect(event.prompt.text).not.toContain("SKILL_ONLY_SECRET");
        expect(event.prompt.text).not.toContain(
          event.arm === "baseline" ? "SKILL_ONLY_ANSWER" : "BASELINE_ONLY_ANSWER",
        );
      }
    }
    for (const call of tool.mock.calls) {
      expect(call[0].inputs[0].content).toEqual(bytes);
      expect(call[0].skillFiles).toEqual([]);
    }
  },
);

it("requires independent tool observations before a file judge can score", async () => {
  model
    .mockResolvedValueOnce(receipt('{"selected":true,"rationale":"yes"}'))
    .mockResolvedValueOnce(answer("actor"))
    .mockResolvedValueOnce(answer(scores));
  const events: FilePairEvent[] = [];
  await expect(
    runReviewedFilePair(input(), (event) => {
      events.push(event);
    }),
  ).rejects.toThrow(/independently/);
  expect(events.at(-1)?.failure).toBe("judge_no_independent_tool_read");
  expect(model).toHaveBeenCalledTimes(3);
});

it.each(["model", "invalid", "throw-tool", "bad-output", "tool-limit", "cancel", "persistence"])(
  "retains %s failure and stops without retry",
  async (kind) => {
    const controller = new AbortController();
    const events: FilePairEvent[] = [];
    model.mockResolvedValueOnce(receipt('{"selected":true,"rationale":"yes"}'));
    if (kind === "model") model.mockRejectedValueOnce(new Error("synthetic"));
    else if (kind === "invalid") model.mockResolvedValueOnce(receipt("not json"));
    else model.mockResolvedValue(python());
    const output = execution();
    if (kind === "bad-output") output.stdoutSha256 = "0".repeat(64);
    if (kind === "throw-tool") tool.mockRejectedValue(new Error("synthetic"));
    else
      tool.mockResolvedValue({ execution: output } as Awaited<
        ReturnType<typeof runReviewedPythonFileTool>
      >);
    await expect(
      runReviewedFilePair(
        input(),
        (event) => {
          events.push(event);
          if (kind === "cancel") controller.abort();
          if (kind === "persistence") throw new Error("Cannot retain event");
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(model.mock.calls.length).toBeLessThanOrEqual(5);
    expect(tool.mock.calls.length).toBeLessThanOrEqual(3);
    if (!["cancel", "persistence"].includes(kind)) expect(events.at(-1)?.failure).toBeDefined();
  },
);

it("gives skill resources only to selected actors and respects all seventeen calls", async () => {
  model.mockResolvedValueOnce(receipt('{"selected":true,"rationale":"yes"}'));
  for (const text of ["base", scores, "skill", scores]) {
    for (let i = 0; i < 3; i++) model.mockResolvedValueOnce(python());
    model.mockResolvedValueOnce(answer(text));
  }
  tool.mockResolvedValue({ execution: execution() } as Awaited<
    ReturnType<typeof runReviewedPythonFileTool>
  >);
  const result = await runReviewedFilePair(input(), () => {});
  expect(result.modelInvocations).toBe(17);
  expect(tool).toHaveBeenCalledTimes(12);
  expect(tool.mock.calls.map((call) => call[0].skillFiles.length)).toEqual([
    0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0,
  ]);
});

it("protects caller inputs and private transcript from persistence callbacks", async () => {
  setup();
  const options = input();
  const result = await runReviewedFilePair(options, (event) => {
    options.files[0].content = new Uint8Array([5]);
    (event.prompt as { text: string }).text = "callback mutation";
  });
  expect(result.selection.prompt.text).not.toBe("callback mutation");
  expect(result.baseline.actor.steps[0].prompt.text).not.toBe("callback mutation");
  expect(tool.mock.calls[0][0].inputs[0].content).toEqual(bytes);
});

it("rejects unbound bytes, unexpected source and oversized instructions before inference", async () => {
  for (const field of ["bytes", "source", "skill", "large", "missing"]) {
    const options = input();
    if (field === "bytes") options.scenario.fixture.files[0].sha256 = "0".repeat(64);
    if (field === "source")
      options.scenario.fixture.files[0].source = "fixtures/holdout/artifact.bin";
    if (field === "skill") options.skillFiles = [];
    if (field === "large") options.skillText += "x".repeat(1024 * 1024);
    if (field === "missing") options.files = [];
    expect(() => validateReviewedFilePairInput(options)).toThrow();
  }
  await expect(runReviewedFilePair(input(), undefined as never)).rejects.toThrow();
  expect(model).not.toHaveBeenCalled();
});

it("does not execute an action whose persistence failed", async () => {
  model
    .mockResolvedValueOnce(receipt('{"selected":true,"rationale":"yes"}'))
    .mockResolvedValueOnce(python());
  await expect(
    runReviewedFilePair(input(), (event) => {
      if (event.stage === "action-ready") throw new Error("Storage unavailable");
    }),
  ).rejects.toThrow("Storage unavailable");
  expect(model).toHaveBeenCalledTimes(2);
  expect(tool).not.toHaveBeenCalled();
});

it("retains a response received during cancellation without executing it", async () => {
  const controller = new AbortController();
  model
    .mockResolvedValueOnce(receipt('{"selected":true,"rationale":"yes"}'))
    .mockImplementationOnce(async () => {
      controller.abort();
      return python();
    });
  const events: FilePairEvent[] = [];
  await expect(
    runReviewedFilePair(
      input(),
      (event) => {
        events.push(event);
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(events.at(-1)).toMatchObject({
    failure: "aborted",
    action: { kind: "python" },
  });
  expect(tool).not.toHaveBeenCalled();
});

it.each([1, 2])(
  "allows Python exit %s observations but requires a later successful judge read",
  async (exitCode) => {
    model.mockResolvedValueOnce(receipt('{"selected":true,"rationale":"yes"}'));
    for (const text of ["base", scores, "skill", scores]) {
      model
        .mockResolvedValueOnce(python())
        .mockResolvedValueOnce(python())
        .mockResolvedValueOnce(answer(text));
    }
    for (let index = 0; index < 4; index++) {
      tool.mockResolvedValueOnce({
        execution: { ...execution(), status: "failed", exitCode },
      } as Awaited<ReturnType<typeof runReviewedPythonFileTool>>);
      tool.mockResolvedValueOnce({
        execution: { ...execution(), cleanupAttempted: true, cleanupOk: true },
      } as Awaited<ReturnType<typeof runReviewedPythonFileTool>>);
    }
    const result = await runReviewedFilePair(input(), () => {});
    expect(result.modelInvocations).toBe(13);
    expect(result.baseline.judge.steps[0].tool?.execution.status).toBe("failed");
  },
);

it("allows genuinely file-free scenarios without pretending an independent read occurred", async () => {
  const options = input();
  options.files = [];
  delete (options.scenario as { fixture?: unknown }).fixture;
  delete (options.scenario as { forbiddenBehavior?: unknown }).forbiddenBehavior;
  model
    .mockResolvedValueOnce(receipt('{"selected":false,"rationale":"not needed"}'))
    .mockResolvedValueOnce(answer("base"))
    .mockResolvedValueOnce(answer(scores))
    .mockResolvedValueOnce(answer("skill"))
    .mockResolvedValueOnce(answer(scores));
  expect((await runReviewedFilePair(options, () => {})).modelInvocations).toBe(5);
  expect(tool).not.toHaveBeenCalled();
});
