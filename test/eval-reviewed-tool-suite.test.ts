import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/eval/reviewed-tool-pair.js", () => ({ runReviewedToolPair: vi.fn() }));
import { runReviewedToolPair } from "../src/eval/reviewed-tool-pair.js";
import {
  runReviewedToolSuite,
  type ReviewedToolSuiteOptions,
} from "../src/eval/reviewed-tool-suite.js";
const run = vi.mocked(runReviewedToolPair);
const skillText = "---\nname: notes\ndescription: Draft release notes.\n---\nUse references.";
const options = (): ReviewedToolSuiteOptions => ({
  suite: {
    schemaVersion: 1,
    suite: "training",
    skill: "notes",
    scenarios: [
      {
        id: "positive",
        category: "positive",
        shouldActivate: true,
        prompt: "Draft notes from these changes.",
        expectedBehavior: ["Use references."],
      },
    ],
  },
  rubric: {
    schemaVersion: 1,
    name: "quality",
    criteria: [
      {
        id: "activation",
        description: "Correct selection",
        evaluator: "deterministic",
        weight: 20,
      },
      { id: "accuracy", description: "Accurate claims", evaluator: "judge", weight: 80 },
    ],
  },
  skillText,
  skillFiles: [{ path: "SKILL.md", content: skillText }],
  image: `python@sha256:${"a".repeat(64)}`,
  repetitions: 3,
  onEvent: vi.fn(),
  onResult: vi.fn(),
});
const pair = () =>
  ({ baseline: { score: 84 }, withSkill: { score: 96 } }) as Awaited<
    ReturnType<typeof runReviewedToolPair>
  >;
afterEach(() => vi.resetAllMocks());
it("serially checkpoints all repetitions and reports complete rates", async () => {
  const order: string[] = [];
  run.mockImplementation(async () => {
    order.push("pair");
    return pair();
  });
  const result = await runReviewedToolSuite({
    ...options(),
    onResult: async () => {
      order.push("saved");
    },
  });
  expect(order).toEqual(["pair", "saved", "pair", "saved", "pair", "saved"]);
  expect(result).toMatchObject({
    complete: true,
    plannedPairs: 3,
    maximumModelCalls: 33,
    unattemptedPairs: 0,
    summary: { baselineSuccessRate: 0, withSkillSuccessRate: 1, impactDelta: 1 },
    releaseEligible: false,
  });
  expect(new Set(result.records.map((r) => r.runId)).size).toBe(3);
  expect(result.skillFiles[0].sha256).toMatch(/^[a-f0-9]{64}$/);
});
it("uses stricter readiness without changing scores", async () => {
  run.mockResolvedValue(pair());
  const result = await runReviewedToolSuite({ ...options(), readinessMinimum: 99 });
  expect(result.summary?.withSkillSuccessRate).toBe(0);
});
it("stops on provider failure, retains failed attempt, no partial success summary", async () => {
  run.mockResolvedValueOnce(pair()).mockRejectedValueOnce(Error("private detail"));
  const result = await runReviewedToolSuite(options());
  expect(result).toMatchObject({ complete: false, unattemptedPairs: 1, summary: null });
  expect(result.records[1]).toMatchObject({ status: "failed", reason: "pair_execution_failed" });
  expect(JSON.stringify(result)).not.toContain("private detail");
  expect(run).toHaveBeenCalledTimes(2);
});
it.each(["event", "result"])(
  "propagates %s persistence failure before any later pair",
  async (where) => {
    run.mockImplementation(async (_, save) => {
      await save({ kind: "actor-result", arm: "baseline", actor: {} } as never);
      return pair();
    });
    const fail = async () => {
      throw Error("disk full");
    };
    await expect(
      runReviewedToolSuite({
        ...options(),
        ...(where === "event" ? { onEvent: fail } : { onResult: fail }),
      }),
    ).rejects.toThrow("disk full");
    expect(run).toHaveBeenCalledTimes(1);
  },
);
it("snapshots caller inputs and isolates both persistence callbacks", async () => {
  const input = options();
  run.mockImplementation(async (_, save) => {
    await save({ kind: "actor-result", arm: "baseline", actor: {} } as never);
    return pair();
  });
  const result = await runReviewedToolSuite({
    ...input,
    onEvent: async (identity) => {
      identity.scenarioId = "tamper";
      input.suite.scenarios[0].prompt = "changed";
    },
    onResult: async (record) => {
      record.scenarioId = "tamper";
      if (record.status === "passed") record.pair.baseline.score = 100;
    },
  });
  expect(result.records.every((r) => r.scenarioId === "positive")).toBe(true);
  expect(result.summary?.baselineSuccessRate).toBe(0);
  expect(result.suite.scenarios[0].prompt).not.toBe("changed");
});
it("pre-aborted runs spend no inference", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runReviewedToolSuite({ ...options(), signal: controller.signal });
  expect(result.complete).toBe(false);
  expect(run).not.toHaveBeenCalled();
});
it.each([0, 21, 1.5])("rejects repetitions %s", async (repetitions) => {
  await expect(runReviewedToolSuite({ ...options(), repetitions })).rejects.toThrow(/repetitions/);
  expect(run).not.toHaveBeenCalled();
});
it.each([89, 101, 95.5])("rejects readiness %s", async (readinessMinimum) => {
  await expect(runReviewedToolSuite({ ...options(), readinessMinimum })).rejects.toThrow(
    /readiness/,
  );
});
it.each(["callback", "name", "environment", "resource"])(
  "preflights %s before any pair",
  async (kind) => {
    const input = options();
    if (kind === "callback") Object.assign(input, { onEvent: null });
    if (kind === "name") input.suite.skill = "other";
    if (kind === "environment") input.suite.scenarios[0].fixture = { environment: { TOKEN: "no" } };
    if (kind === "resource")
      Object.assign(input, { skillFiles: [{ path: "../no", content: "no" }] });
    await expect(runReviewedToolSuite(input)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  },
);
