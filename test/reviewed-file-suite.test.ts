import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/eval/reviewed-file-pair.js", async (original) => ({
  ...(await original<typeof import("../src/eval/reviewed-file-pair.js")>()),
  runReviewedFilePair: vi.fn(),
}));
import { runReviewedFilePair } from "../src/eval/reviewed-file-pair.js";
import {
  runReviewedFileSuite,
  type ReviewedFileSuiteOptions,
} from "../src/eval/reviewed-file-suite.js";
const run = vi.mocked(runReviewedFilePair);
const skillText = "---\nname: notes\ndescription: Draft release notes.\n---\nUse references.";
const options = (): ReviewedFileSuiteOptions => ({
  suite: {
    schemaVersion: 2,
    suite: "training",
    skill: "notes",
    scenarios: [
      {
        id: "positive",
        category: "positive",
        shouldActivate: true,
        prompt: "Draft notes from changes.",
        expectedBehavior: ["Use references."],
      },
    ],
  },
  files: [{ id: "positive", files: [] }],
  rubric: {
    schemaVersion: 1,
    name: "quality",
    criteria: [{ id: "accuracy", description: "Accurate claims", evaluator: "judge", weight: 100 }],
  },
  skillText,
  skillFiles: [{ path: "SKILL.md", content: skillText }],
  image: `python@sha256:${"a".repeat(64)}`,
  repetitions: 3,
  readinessMinimum: 90,
  maxModelCalls: 51,
  onEvent: vi.fn(),
  onResult: vi.fn(),
});
const pair = () =>
  ({ baseline: { score: 84 }, withSkill: { score: 96 } }) as Awaited<
    ReturnType<typeof runReviewedFilePair>
  >;
afterEach(() => vi.resetAllMocks());
it("runs serially with distinct identities and durable results before the next pair", async () => {
  const order: string[] = [];
  run.mockImplementation(async () => {
    order.push("pair");
    return pair();
  });
  const result = await runReviewedFileSuite({
    ...options(),
    onResult: async () => {
      order.push("saved");
    },
  });
  expect(order).toEqual(["pair", "saved", "pair", "saved", "pair", "saved"]);
  expect(result).toMatchObject({
    complete: true,
    plannedPairs: 3,
    maximumModelCalls: 51,
    unattemptedPairs: 0,
    summary: { baselineSuccessRate: 0, withSkillSuccessRate: 1, impactDelta: 1 },
    releaseEligible: false,
  });
  expect(new Set(result.records.map((record) => record.runId)).size).toBe(3);
});
it("honors stricter readiness", async () => {
  run.mockResolvedValue(pair());
  expect(
    (await runReviewedFileSuite({ ...options(), readinessMinimum: 99 })).summary
      ?.withSkillSuccessRate,
  ).toBe(0);
});
it.each(["failure", "cancel"])("retains %s without retry or partial success", async (kind) => {
  const controller = new AbortController();
  run
    .mockImplementationOnce(async () => {
      if (kind === "cancel") controller.abort();
      return pair();
    })
    .mockRejectedValueOnce(new Error("private provider detail"));
  const result = await runReviewedFileSuite({ ...options(), signal: controller.signal });
  expect(result).toMatchObject({ complete: false, unattemptedPairs: 1, summary: null });
  expect(result.records[1]).toMatchObject({ status: "failed", reason: "pair_execution_failed" });
  expect(JSON.stringify(result)).not.toContain("private provider detail");
  expect(run).toHaveBeenCalledTimes(kind === "cancel" ? 1 : 2);
});
it.each(["event", "result"])("stops immediately on %s storage failure", async (where) => {
  run.mockImplementation(async (_, save) => {
    await save({ phase: "actor" } as never);
    return pair();
  });
  const fail = async () => {
    throw new Error("disk full");
  };
  await expect(
    runReviewedFileSuite({
      ...options(),
      ...(where === "event" ? { onEvent: fail } : { onResult: fail }),
    }),
  ).rejects.toThrow("disk full");
  expect(run).toHaveBeenCalledTimes(1);
});
it("isolates snapshots and callback mutations", async () => {
  const input = options();
  run.mockImplementation(async (_, save) => {
    await save({ phase: "actor" } as never);
    return pair();
  });
  const result = await runReviewedFileSuite({
    ...input,
    onEvent: async (identity, event) => {
      identity.scenarioId = "changed";
      (event as { phase: string }).phase = "changed";
      (input.suite.scenarios[0] as (typeof input.suite.scenarios)[number]).prompt = "changed";
    },
    onResult: async (record) => {
      record.scenarioId = "changed";
    },
  });
  expect(result.records.every((record) => record.scenarioId === "positive")).toBe(true);
  expect(result.suite.scenarios[0]?.prompt).toBe("Draft notes from changes.");
});
it.each([
  "repetitions",
  "readiness",
  "cap",
  "identity",
  "files",
  "file-id",
  "event",
  "result",
  "later-input",
])("rejects %s before any model work", async (field) => {
  const input = options();
  const bad = {
    ...input,
    ...(field === "repetitions" ? { repetitions: 0 } : {}),
    ...(field === "readiness" ? { readinessMinimum: 89 } : {}),
    ...(field === "cap" ? { maxModelCalls: 50 } : {}),
    ...(field === "files" ? { files: [] } : {}),
    ...(field === "file-id" ? { files: [{ id: "wrong", files: [] }] } : {}),
    ...(field === "event" ? { onEvent: undefined as never } : {}),
    ...(field === "result" ? { onResult: undefined as never } : {}),
  };
  if (field === "identity") bad.suite.skill = "other";
  if (field === "later-input") {
    bad.suite.scenarios.push({
      ...(bad.suite.scenarios[0] as (typeof bad.suite.scenarios)[number]),
      id: "second",
      fixture: {
        files: [
          { path: "file", source: "fixtures/training/file", bytes: 1, sha256: "a".repeat(64) },
        ],
      },
    });
    bad.files = [...bad.files, { id: "second", files: [] }];
    bad.maxModelCalls = 102;
  }
  await expect(runReviewedFileSuite(bad)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
