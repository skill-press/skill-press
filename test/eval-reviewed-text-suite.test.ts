import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/eval/codex-text.js", () => ({ runReviewedSelectedTextPair: vi.fn() }));
import { runReviewedSelectedTextPair } from "../src/eval/codex-text.js";
import {
  runReviewedTextSuite,
  type ReviewedTextSuiteOptions,
} from "../src/eval/reviewed-text-suite.js";

const run = vi.mocked(runReviewedSelectedTextPair);
const skillText =
  "---\nname: notes\ndescription: Draft release notes.\n---\nUse source references.";
const options = (): ReviewedTextSuiteOptions => ({
  suite: {
    schemaVersion: 1,
    suite: "training",
    skill: "notes",
    scenarios: [
      {
        id: "positive",
        category: "positive",
        shouldActivate: true,
        prompt: "Draft release notes from these changes.",
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
        description: "Correct skill selection",
        evaluator: "deterministic",
        weight: 20,
      },
      { id: "accuracy", description: "Accurate factual claims", evaluator: "judge", weight: 80 },
    ],
  },
  skillText,
  repetitions: 3,
  onResult: vi.fn().mockResolvedValue(undefined),
});
const pair = () =>
  ({
    baseline: { criteria: [{ id: "accuracy", score: 0.8, rationale: "Partial." }] },
    withSkill: {
      activated: true,
      criteria: [{ id: "accuracy", score: 1, rationale: "Accurate." }],
    },
    releaseEligible: false,
  }) as Awaited<ReturnType<typeof runReviewedSelectedTextPair>>;
afterEach(() => vi.resetAllMocks());

it("runs every repetition, checkpoints serially and recomputes canonical 0–100 scores", async () => {
  const input = options();
  const order: string[] = [];
  run.mockImplementation(async () => {
    order.push("pair");
    return pair();
  });
  const result = await runReviewedTextSuite({
    ...input,
    onResult: async () => {
      order.push("saved");
    },
  });
  expect(order).toEqual(["pair", "saved", "pair", "saved", "pair", "saved"]);
  expect(new Set(result.records.map((r) => r.runId)).size).toBe(3);
  expect(result.records[0]).toMatchObject({ baselineScore: 84, withSkillScore: 100 });
  expect(result).toMatchObject({
    complete: true,
    plannedPairs: 3,
    unattemptedPairs: 0,
    execution: "host-networked-text",
    releaseEligible: false,
    summary: {
      readinessMinimum: 90,
      baselineSuccessRate: 0,
      withSkillSuccessRate: 1,
      impactDelta: 1,
    },
  });
  expect(result).not.toHaveProperty("image");
  expect(result.evaluationInputsSha256).toMatch(/^[a-f0-9]{64}$/);
});

it.each([89, 101, 95.5])("rejects invalid readiness %s", async (readinessMinimum) => {
  await expect(runReviewedTextSuite({ ...options(), readinessMinimum })).rejects.toThrow(
    /readiness/,
  );
  expect(run).not.toHaveBeenCalled();
});

it("honors stricter project readiness", async () => {
  const response = pair();
  run.mockResolvedValue({
    ...response,
    withSkill: {
      ...response.withSkill,
      criteria: response.withSkill.criteria.map((c) => ({ ...c, score: 0.95 })),
    },
  });
  const result = await runReviewedTextSuite({ ...options(), readinessMinimum: 99 });
  expect(result.records[0]).toMatchObject({ withSkillScore: 96 });
  expect(result.summary).toMatchObject({ readinessMinimum: 99, withSkillSuccessRate: 0 });
});

it("retains a failed pair, stops without retries, and suppresses incomplete aggregates", async () => {
  const input = options();
  run.mockResolvedValueOnce(pair()).mockRejectedValueOnce(new Error("private-provider-detail"));
  const result = await runReviewedTextSuite(input);
  expect(run).toHaveBeenCalledTimes(2);
  expect(input.onResult).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ complete: false, unattemptedPairs: 1, summary: null });
  expect(result.records[1]).toMatchObject({ status: "failed", reason: "pair_execution_failed" });
  expect(JSON.stringify(result)).not.toContain("private-provider-detail");
});

it("stops if persistence fails, before another model call", async () => {
  run.mockResolvedValue(pair());
  await expect(
    runReviewedTextSuite({
      ...options(),
      onResult: async () => {
        throw Error("storage failed");
      },
    }),
  ).rejects.toThrow("storage failed");
  expect(run).toHaveBeenCalledTimes(1);
});

it("records a pre-aborted attempt without invoking the model", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runReviewedTextSuite({ ...options(), signal: controller.signal });
  expect(run).not.toHaveBeenCalled();
  expect(result.records[0]?.status).toBe("failed");
  expect(result.summary).toBeNull();
});

it.each([0, 21, 1.5, NaN])(
  "rejects invalid repetitions %s before invocation",
  async (repetitions) => {
    await expect(runReviewedTextSuite({ ...options(), repetitions })).rejects.toThrow(
      /repetitions/,
    );
    expect(run).not.toHaveBeenCalled();
  },
);

it("validates all input scenarios and skill identity before spending calls", async () => {
  const input = options();
  input.suite.skill = "wrong";
  await expect(runReviewedTextSuite(input)).rejects.toThrow(/skill name/);
  input.suite.skill = "notes";
  input.suite.scenarios[0].fixture = { environment: { TOKEN: "never-read" } };
  await expect(runReviewedTextSuite(input)).rejects.toThrow(/environment/);
  expect(run).not.toHaveBeenCalled();
});

it("uses a snapshot when caller edits inputs during an awaited checkpoint", async () => {
  const input = options();
  run.mockResolvedValue(pair());
  const result = await runReviewedTextSuite({
    ...input,
    onResult: async () => {
      input.suite.scenarios[0].prompt = "Changed later";
      input.rubric.criteria[1].weight = 1;
    },
  });
  expect(result.suite.scenarios[0].prompt).not.toBe("Changed later");
  expect(result.rubric.criteria[1].weight).toBe(80);
});
