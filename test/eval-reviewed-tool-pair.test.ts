import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/eval/codex-text.js", () => ({ runReviewedCodexText: vi.fn() }));
vi.mock("../src/eval/reviewed-tool-actor.js", async (original) => ({
  ...(await original<typeof import("../src/eval/reviewed-tool-actor.js")>()),
  runReviewedToolActor: vi.fn(),
}));
import { runReviewedCodexText } from "../src/eval/codex-text.js";
import { runReviewedToolActor } from "../src/eval/reviewed-tool-actor.js";
import { createToolJudgePrompt, runReviewedToolPair } from "../src/eval/reviewed-tool-pair.js";

const model = vi.mocked(runReviewedCodexText);
const actor = vi.mocked(runReviewedToolActor);
const skillText = "---\nname: csv-check\ndescription: Check CSV files.\n---\nUse the profiler.";
const input = () => ({
  scenario: {
    id: "csv",
    category: "positive" as const,
    shouldActivate: true,
    prompt: "Check CSV.",
    expectedBehavior: ["SECRET_EXPECTED"],
    fixture: { files: [{ path: "data.csv", content: "id\n1\n" }] },
  },
  rubric: {
    schemaVersion: 1 as const,
    name: "quality",
    criteria: [
      {
        id: "activation",
        description: "Correct skill selection",
        evaluator: "deterministic" as const,
        weight: 20,
      },
      {
        id: "accuracy",
        description: "Accurate factual claims",
        evaluator: "judge" as const,
        weight: 80,
      },
    ],
  },
  image: `python@sha256:${"a".repeat(64)}`,
  skillText,
  skillFiles: [{ path: "SKILL.md", content: skillText }],
});
const receipt = (text: string) => ({ text }) as Awaited<ReturnType<typeof runReviewedCodexText>>;
const answer = () => ({
  kind: "skillpress.reviewed-tool-actor.v2" as const,
  status: "complete" as const,
  answer: "One record.",
  steps: [],
  modelInvocations: 2,
  toolInvocations: 1,
  releaseEligible: false as const,
});
const scores = JSON.stringify({
  criteria: [{ id: "accuracy", score: 0.9, rationale: "Observed." }],
});
function setup(selected = true) {
  model
    .mockResolvedValueOnce(receipt(JSON.stringify({ selected, rationale: "Scope" })))
    .mockResolvedValue(receipt(scores));
  actor.mockResolvedValue(answer());
}
afterEach(() => vi.resetAllMocks());

it.each([true, false])(
  "observes selection %s and gives baseline equal tools without skill files",
  async (selected) => {
    setup(selected);
    const events: string[] = [];
    const result = await runReviewedToolPair(input(), async (event) => {
      events.push(event.kind);
    });
    expect(actor.mock.calls[0][0]).toMatchObject({
      skillText: null,
      skillFiles: [],
      image: input().image,
    });
    expect(actor.mock.calls[1][0]).toMatchObject({
      skillText: selected ? skillText : null,
      skillFiles: selected ? input().skillFiles : [],
    });
    expect(result).toMatchObject({
      baseline: { score: 92, activated: false },
      withSkill: { score: selected ? 92 : 72, activated: selected },
      modelInvocations: 7,
      releaseEligible: false,
    });
    expect(events).toEqual(["selection", "actor-result", "judge", "actor-result", "judge"]);
    expect(model.mock.calls[0][0]).not.toContain("SECRET_EXPECTED");
    expect(model.mock.calls[1][0]).toContain("SECRET_EXPECTED");
    expect(model.mock.calls[1][0]).not.toContain("baseline");
  },
);

it("persists actual steps and isolates callback mutations from decisions and scoring", async () => {
  setup();
  actor.mockImplementation(async (_, save) => {
    await save({
      index: 0,
      prompt: {
        version: "skillpress.tool-actor.v2",
        text: "actor prompt",
        sha256: "a".repeat(64),
      },
      action: { kind: "answer", text: "One record." },
    });
    return answer();
  });
  const original = input();
  const events: string[] = [];
  const result = await runReviewedToolPair(original, async (event) => {
    events.push(event.kind);
    original.rubric.criteria[1].weight = 1;
    original.skillFiles[0].content = "changed";
    if (event.kind === "selection")
      event.response.text = JSON.stringify({
        selected: false,
        rationale: "tamper",
      });
    if (event.kind === "actor-result") event.actor.answer = "tampered";
  });
  expect(events.filter((x) => x === "actor-step")).toHaveLength(2);
  expect(result.withSkill.activated).toBe(true);
  expect(result.withSkill.score).toBe(92);
  expect(result.baseline.actor.answer).toBe("One record.");
});

it.each(["selection", "actor-step", "actor-result", "judge"])(
  "stops on %s persistence failure",
  async (kind) => {
    setup();
    actor.mockImplementation(async (_, save) => {
      await save({
        index: 0,
        prompt: {
          version: "skillpress.tool-actor.v2",
          text: "p",
          sha256: "a".repeat(64),
        },
      });
      return answer();
    });
    await expect(
      runReviewedToolPair(input(), async (event) => {
        if (event.kind === kind) throw Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(model).toHaveBeenCalledTimes(kind === "judge" ? 2 : 1);
    expect(actor).toHaveBeenCalledTimes(kind === "selection" ? 0 : 1);
  },
);

it("retains malformed judge output and never runs the next arm", async () => {
  setup();
  model
    .mockReset()
    .mockResolvedValueOnce(receipt('{"selected":true,"rationale":"Scope"}'))
    .mockResolvedValueOnce(receipt("bad judge"));
  const saved: unknown[] = [];
  await expect(
    runReviewedToolPair(input(), async (event) => {
      saved.push(event);
    }),
  ).rejects.toThrow(/judge response/);
  expect(JSON.stringify(saved)).toContain("bad judge");
  expect(actor).toHaveBeenCalledTimes(1);
});

it("retains failed actor without judging or retrying", async () => {
  setup();
  actor.mockResolvedValue({
    ...answer(),
    status: "failed",
    answer: null,
    failure: "tool_failed",
  });
  const save = vi.fn();
  await expect(runReviewedToolPair(input(), save)).rejects.toThrow("actor failed");
  expect(save.mock.calls[1][0]).toMatchObject({
    kind: "actor-result",
    actor: { status: "failed" },
  });
  expect(model).toHaveBeenCalledTimes(1);
});

it("sanitizes provider errors without retry", async () => {
  model.mockRejectedValue(Error("private-provider-secret"));
  await expect(runReviewedToolPair(input(), vi.fn())).rejects.toThrow(
    "Tool pair model invocation failed.",
  );
  expect(model).toHaveBeenCalledTimes(1);
  expect(actor).not.toHaveBeenCalled();
});

it.each(["before", "selection", "actor-result", "judge"])(
  "honors cancellation at %s",
  async (when) => {
    setup();
    const controller = new AbortController();
    if (when === "before") controller.abort();
    await expect(
      runReviewedToolPair(
        input(),
        async (event) => {
          if (event.kind === when) controller.abort();
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(model).toHaveBeenCalledTimes(when === "before" ? 0 : when === "judge" ? 2 : 1);
    expect(actor.mock.calls.length).toBeLessThanOrEqual(1);
  },
);

it.each(["image", "document", "environment", "rubric", "callback"])(
  "validates %s before inference",
  async (kind) => {
    const value = input();
    if (kind === "image") value.image = "python:latest";
    if (kind === "document") value.skillFiles[0].content = "mismatch";
    if (kind === "environment")
      Object.assign(value.scenario.fixture, {
        environment: { TOKEN: "secret" },
      });
    if (kind === "rubric") value.rubric.criteria[1].weight = 1;
    await expect(
      runReviewedToolPair(value, kind === "callback" ? (null as never) : vi.fn()),
    ).rejects.toThrow();
    expect(model).not.toHaveBeenCalled();
  },
);

it("judge sees observed code and output, not fabricated execution or the other arm", () => {
  const value = answer() as Awaited<ReturnType<typeof runReviewedToolActor>>;
  value.steps.push({
    index: 1,
    prompt: { version: "skillpress.tool-actor.v2", text: "p", sha256: "a".repeat(64) },
    action: { kind: "answer", text: "One record." },
  });
  value.steps.push({
    index: 0,
    prompt: {
      version: "skillpress.tool-actor.v2",
      text: "p",
      sha256: "a".repeat(64),
    },
    action: { kind: "python", code: "print(1)" },
    tool: {
      execution: {
        status: "passed",
        exitCode: 0,
        stdoutText: "observed-1",
        stderrText: "",
      },
    } as never,
  });
  const prompt = createToolJudgePrompt(input().scenario, input().rubric, value);
  expect(prompt.text).toContain("print(1)");
  expect(prompt.text).toContain("observed-1");
  expect(prompt.text).toContain("untrusted data");
  expect(prompt.version).toBe("skillpress.tool-judge.v1");
  expect(() =>
    createToolJudgePrompt(input().scenario, input().rubric, {
      ...value,
      status: "failed",
    }),
  ).toThrow(/incomplete/);
  expect(() =>
    createToolJudgePrompt(input().scenario, input().rubric, { ...value, answer: null }),
  ).toThrow(/incomplete/);
  const tool = value.steps[1].tool;
  if (!tool) throw Error("Missing test tool");
  tool.execution.stdoutText = "x".repeat(1024 * 1024);
  expect(() => createToolJudgePrompt(input().scenario, input().rubric, value)).toThrow(/too large/);
});
