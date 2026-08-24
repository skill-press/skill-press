import { describe, expect, it, vi } from "vitest";

import type { Metrics } from "../src/improve/generated-report.js";
import {
  ImprovementLoopError,
  type ImprovementAuthorContext,
  type ImprovementCallbacks,
  type ImprovementEvaluation,
  type ImprovementInitialState,
  type ImprovementLoopOptions,
  type ImprovementProposal,
  runBoundedImprovement,
} from "../src/improve/state-machine.js";

const candidateDigest = "a".repeat(64);
const trainingDigest = "b".repeat(64);
const holdoutDigest = "c".repeat(64);

function metrics(value: number): Metrics {
  return { successRate: value, activationPrecision: value, safetyRate: value };
}

function proposal(
  baseCandidateSha256: string,
  skill = "---\nname: bounded-candidate\n---\n# Candidate\n",
): ImprovementProposal {
  return {
    baseCandidateSha256,
    files: [
      { path: "SKILL.md", content: skill },
      { path: "LICENSE", content: "MIT\n" },
      { path: "scripts/check.mjs", content: "export {};\n", executable: true },
    ],
    rationale: "Improve the observed training failures.",
    tokensUsed: 100,
    costUsd: 0.25,
  };
}

function initial(overrides: Partial<ImprovementInitialState> = {}): ImprovementInitialState {
  return {
    candidateSha256: candidateDigest,
    trainingScenarioSetSha256: trainingDigest,
    holdoutScenarioSetSha256: holdoutDigest,
    trainingMetrics: metrics(0.4),
    holdoutMetrics: metrics(0.5),
    trainingScenarios: [
      {
        id: "training-one",
        prompt: "TRAINING_SENTINEL: repair this public fixture",
        expectedBehavior: ["Produce a bounded repair"],
        forbiddenBehavior: ["Guess private data"],
      },
    ],
    failureIds: ["training-one/task-success"],
    feedback: [{ source: "paired-eval", text: "The training task did not complete." }],
    ...overrides,
  };
}

function evaluation(digest: string, value: number): ImprovementEvaluation {
  return { scenarioSetSha256: digest, metrics: metrics(value) };
}

function callbacks(overrides: Partial<ImprovementCallbacks> = {}): ImprovementCallbacks {
  return {
    author: async (context) =>
      proposal(context.candidateSha256, `# Candidate ${context.iteration}`),
    review: async () => ({ approved: true, issueCodes: [] }),
    deterministic: async () => ({ passed: true }),
    evaluateTraining: async () => evaluation(trainingDigest, 0.9),
    evaluateHoldout: async () => evaluation(holdoutDigest, 0.9),
    accept: async () => undefined,
    ...overrides,
  };
}

function options(
  callbackOverrides: Partial<ImprovementCallbacks> = {},
  overrides: Partial<Omit<ImprovementLoopOptions, "callbacks" | "initial" | "budgets">> & {
    readonly initial?: ImprovementInitialState;
    readonly budgets?: Partial<ImprovementLoopOptions["budgets"]>;
  } = {},
): ImprovementLoopOptions {
  return {
    budgets: {
      maxIterations: 3,
      maxNoImprovement: 2,
      maxTokens: 1000,
      maxCostUsd: 10,
      maxWallMinutes: 1,
      ...overrides.budgets,
    },
    minimumSuccessRate: overrides.minimumSuccessRate ?? 0.8,
    initial: overrides.initial ?? initial(),
    callbacks: callbacks(callbackOverrides),
    now: overrides.now ?? (() => 0),
  };
}

describe("bounded improvement state machine", () => {
  it("keeps holdout cases out of author context and accepts only after every gate", async () => {
    const order: string[] = [];
    let observed: ImprovementAuthorContext | undefined;
    const report = await runBoundedImprovement(
      options({
        author: async (context) => {
          order.push("author");
          observed = context;
          return proposal(context.candidateSha256);
        },
        review: async () => {
          order.push("review");
          return { approved: true, issueCodes: [] };
        },
        deterministic: async () => {
          order.push("deterministic");
          return { passed: true };
        },
        evaluateTraining: async () => {
          order.push("training");
          return evaluation(trainingDigest, 0.9);
        },
        evaluateHoldout: async () => {
          order.push("holdout");
          return evaluation(holdoutDigest, 0.9);
        },
        accept: async () => {
          order.push("accept");
        },
      }),
    );

    expect(order).toEqual(["author", "review", "deterministic", "training", "holdout", "accept"]);
    expect(observed).toBeDefined();
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed?.trainingScenarios)).toBe(true);
    expect(JSON.stringify(observed)).toContain("TRAINING_SENTINEL");
    expect(Object.keys(observed ?? {})).not.toContain("holdoutScenarios");
    expect(report).toMatchObject({
      success: true,
      stopReason: "target_reached",
      budget: { iterationsUsed: 1, tokensUsed: 100, costUsd: 0.25 },
      iterations: [{ decision: "accepted" }],
    });
    expect(report.finalCandidateSha256).not.toBe(candidateDigest);
    expect(Object.isFrozen(report)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("Candidate\n");
    expect(JSON.stringify(report)).not.toContain("rationale");
  });

  it("returns immediately when the frozen initial metrics already meet the target", async () => {
    const author = vi.fn<ImprovementCallbacks["author"]>();
    const report = await runBoundedImprovement(
      options(
        { author },
        { initial: initial({ trainingMetrics: metrics(0.9), holdoutMetrics: metrics(0.9) }) },
      ),
    );

    expect(report).toMatchObject({
      success: true,
      stopReason: "target_reached",
      finalCandidateSha256: candidateDigest,
      iterations: [],
    });
    expect(author).not.toHaveBeenCalled();
  });

  it.each([
    [
      "review rejection",
      { review: async () => ({ approved: false, issueCodes: ["scope"] }) },
      "review_rejected",
    ],
    [
      "malformed review",
      { review: async () => ({ approved: true, issueCodes: [1] }) },
      "review_rejected",
    ],
    [
      "approved review with unresolved issues",
      { review: async () => ({ approved: true, issueCodes: ["scope"] }) },
      "review_rejected",
    ],
    [
      "review exception",
      { review: async () => Promise.reject(new Error("review")) },
      "review_rejected",
    ],
    [
      "deterministic rejection",
      { deterministic: async () => ({ passed: false }) },
      "deterministic_failed",
    ],
    [
      "deterministic exception",
      { deterministic: async () => Promise.reject(new Error("check")) },
      "deterministic_failed",
    ],
  ] as const)("fails closed on %s", async (_name, changed, decision) => {
    const holdout = vi.fn<ImprovementCallbacks["evaluateHoldout"]>();
    const report = await runBoundedImprovement(
      options({ ...changed, evaluateHoldout: holdout }, { budgets: { maxNoImprovement: 1 } }),
    );

    expect(report.stopReason).toBe("no_improvement");
    expect(report.iterations[0]?.decision).toBe(decision);
    expect(holdout).not.toHaveBeenCalled();
  });

  it.each([
    ["training regression", metrics(0.3)],
    ["no measurable training change", metrics(0.4)],
  ] as const)("does not disclose or run holdout after %s", async (_name, nextMetrics) => {
    const holdout = vi.fn<ImprovementCallbacks["evaluateHoldout"]>();
    const report = await runBoundedImprovement(
      options(
        {
          evaluateTraining: async () => ({
            scenarioSetSha256: trainingDigest,
            metrics: nextMetrics,
          }),
          evaluateHoldout: holdout,
        },
        { budgets: { maxNoImprovement: 1 } },
      ),
    );

    expect(report.iterations[0]?.decision).toBe("training_regression");
    expect(holdout).not.toHaveBeenCalled();
  });

  it("rejects a holdout regression without accepting the candidate", async () => {
    const accept = vi.fn<ImprovementCallbacks["accept"]>();
    const report = await runBoundedImprovement(
      options(
        { evaluateHoldout: async () => evaluation(holdoutDigest, 0.4), accept },
        { budgets: { maxNoImprovement: 1 } },
      ),
    );

    expect(report.iterations[0]).toMatchObject({
      decision: "holdout_regression",
      training: metrics(0.9),
      holdout: metrics(0.4),
    });
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([
    ["training digest", { evaluateTraining: async () => evaluation("d".repeat(64), 0.9) }],
    ["training metrics", { evaluateTraining: async () => evaluation(trainingDigest, Number.NaN) }],
    ["holdout digest", { evaluateHoldout: async () => evaluation("d".repeat(64), 0.9) }],
    ["holdout metrics", { evaluateHoldout: async () => evaluation(holdoutDigest, 2) }],
  ] as const)("stops on frozen scenario-set violation: %s", async (_name, changed) => {
    const accept = vi.fn<ImprovementCallbacks["accept"]>();
    const report = await runBoundedImprovement(options({ ...changed, accept }));

    expect(report.stopReason).toBe("scenario_set_changed");
    expect(report.iterations[0]?.decision).toBe("scenario_set_changed");
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([
    [
      "training evaluator",
      { evaluateTraining: async () => Promise.reject(new Error("train")) },
      "training_regression",
    ],
    [
      "holdout evaluator",
      { evaluateHoldout: async () => Promise.reject(new Error("holdout")) },
      "holdout_regression",
    ],
  ] as const)("treats a %s exception as a non-improvement", async (_name, changed, decision) => {
    const report = await runBoundedImprovement(
      options(changed, { budgets: { maxNoImprovement: 1 } }),
    );
    expect(report).toMatchObject({ stopReason: "no_improvement" });
    expect(report.iterations[0]?.decision).toBe(decision);
  });

  it("reports author and accept exceptions as terminal failures", async () => {
    const authorFailure = await runBoundedImprovement(
      options({ author: async () => Promise.reject(new Error("author")) }),
    );
    expect(authorFailure).toMatchObject({
      stopReason: "author_failed",
      iterations: [{ decision: "author_failed" }],
    });

    const acceptFailure = await runBoundedImprovement(
      options({ accept: async () => Promise.reject(new Error("accept")) }),
    );
    expect(acceptFailure).toMatchObject({
      stopReason: "accept_failed",
      iterations: [{ decision: "accept_failed" }],
    });
  });

  it.each([
    ["token", { tokensUsed: 1001, costUsd: 0.25 }, "token_budget"],
    ["cost", { tokensUsed: 100, costUsd: 10.01 }, "cost_budget"],
  ] as const)(
    "stops before review when the %s budget is exceeded",
    async (_name, usage, reason) => {
      const review = vi.fn<ImprovementCallbacks["review"]>();
      const report = await runBoundedImprovement(
        options({
          author: async (context) => ({ ...proposal(context.candidateSha256), ...usage }),
          review,
        }),
      );

      expect(report.stopReason).toBe(reason);
      expect(report.iterations[0]?.decision).toBe("budget_exceeded");
      expect(review).not.toHaveBeenCalled();
    },
  );

  it("accounts for valid usage even when candidate files are invalid", async () => {
    const report = await runBoundedImprovement(
      options({
        author: async (context) => ({
          ...proposal(context.candidateSha256),
          tokensUsed: 1001,
          files: [{ path: "evals/holdout.yaml", content: "private" }],
        }),
      }),
    );

    expect(report).toMatchObject({ stopReason: "token_budget", budget: { tokensUsed: 1001 } });
    expect(report.iterations[0]?.decision).toBe("invalid_proposal");
  });

  it("enforces wall time both after authoring and immediately before acceptance", async () => {
    let clock = 0;
    const afterAuthor = await runBoundedImprovement(
      options(
        {
          author: async (context) => {
            clock = 60_001;
            return proposal(context.candidateSha256);
          },
        },
        { now: () => clock },
      ),
    );
    expect(afterAuthor).toMatchObject({
      stopReason: "wall_time_budget",
      iterations: [{ decision: "budget_exceeded" }],
    });

    clock = 0;
    const accept = vi.fn<ImprovementCallbacks["accept"]>();
    const beforeAccept = await runBoundedImprovement(
      options(
        {
          evaluateHoldout: async () => {
            clock = 60_001;
            return evaluation(holdoutDigest, 0.9);
          },
          accept,
        },
        { now: () => clock },
      ),
    );
    expect(beforeAccept.stopReason).toBe("wall_time_budget");
    expect(accept).not.toHaveBeenCalled();
  });

  it("aborts a callback and waits for its cancellation at the wall deadline", async () => {
    let clockReads = 0;
    let aborted = false;
    const report = await runBoundedImprovement(
      options(
        {
          author: async (_context, signal) => {
            return new Promise<ImprovementProposal>((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                aborted = true;
                reject(signal.reason);
              });
            });
          },
        },
        {
          now: () => {
            clockReads += 1;
            return clockReads === 1 ? 0 : 59_999;
          },
        },
      ),
    );

    expect(report).toMatchObject({
      stopReason: "wall_time_budget",
      iterations: [{ decision: "budget_exceeded" }],
    });
    expect(aborted).toBe(true);
  });

  it.each(["review", "deterministic", "training", "holdout", "accept"] as const)(
    "enforces the same aborting deadline at the %s boundary",
    async (stage) => {
      let late = false;
      const hang = async (signal: AbortSignal): Promise<never> => {
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      };
      const changed: Partial<ImprovementCallbacks> = {};
      if (stage === "review") {
        changed.author = async (context) => {
          late = true;
          return proposal(context.candidateSha256);
        };
        changed.review = async (_value, signal) => hang(signal);
      } else if (stage === "deterministic") {
        changed.review = async () => {
          late = true;
          return { approved: true, issueCodes: [] };
        };
        changed.deterministic = async (_value, signal) => hang(signal);
      } else if (stage === "training") {
        changed.deterministic = async () => {
          late = true;
          return { passed: true };
        };
        changed.evaluateTraining = async (_value, signal) => hang(signal);
      } else if (stage === "holdout") {
        changed.evaluateTraining = async () => {
          late = true;
          return evaluation(trainingDigest, 0.9);
        };
        changed.evaluateHoldout = async (_value, signal) => hang(signal);
      } else {
        changed.evaluateHoldout = async () => {
          late = true;
          return evaluation(holdoutDigest, 0.9);
        };
        changed.accept = async (_value, signal) => hang(signal);
      }

      const report = await runBoundedImprovement(
        options(changed, { now: () => (late ? 59_999 : 0) }),
      );
      expect(report.stopReason).toBe("wall_time_budget");
      expect(report.iterations[0]?.decision).toBe("budget_exceeded");
    },
  );

  it("waits for an atomic accept to settle before reporting an exceeded deadline", async () => {
    let clockReads = 0;
    let accepted = false;
    const report = await runBoundedImprovement(
      options(
        {
          accept: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            accepted = true;
          },
        },
        {
          now: () => {
            clockReads += 1;
            return clockReads === 1 ? 0 : 59_999;
          },
        },
      ),
    );

    expect(accepted).toBe(true);
    expect(report).toMatchObject({
      success: false,
      stopReason: "wall_time_budget",
      iterations: [{ decision: "accepted" }],
    });
    expect(report.finalCandidateSha256).not.toBe(report.initialCandidateSha256);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(accepted).toBe(true);
  });

  it("stops at the iteration limit while retaining the last accepted digest", async () => {
    const report = await runBoundedImprovement(
      options({}, { minimumSuccessRate: 0.95, budgets: { maxIterations: 1 } }),
    );

    expect(report).toMatchObject({
      success: false,
      stopReason: "iteration_limit",
      budget: { iterationsUsed: 1 },
      iterations: [{ decision: "accepted" }],
    });
    expect(report.finalCandidateSha256).not.toBe(candidateDigest);
  });

  it("rejects a candidate snapshot that has already been evaluated", async () => {
    const sharedFiles = proposal(candidateDigest).files;
    const report = await runBoundedImprovement(
      options(
        {
          author: async (context) => ({
            ...proposal(context.candidateSha256),
            files: sharedFiles,
          }),
          evaluateTraining: async () => evaluation(trainingDigest, 0.8),
          evaluateHoldout: async () => evaluation(holdoutDigest, 0.8),
        },
        { minimumSuccessRate: 0.9, budgets: { maxNoImprovement: 1 } },
      ),
    );

    expect(report.iterations.map((entry) => entry.decision)).toEqual([
      "accepted",
      "invalid_proposal",
    ]);
    expect(report.stopReason).toBe("no_improvement");
  });

  it.each([
    [
      "wrong base",
      (value: ImprovementProposal) => ({ ...value, baseCandidateSha256: "f".repeat(64) }),
    ],
    ["empty rationale", (value: ImprovementProposal) => ({ ...value, rationale: "" })],
    [
      "unsafe path",
      (value: ImprovementProposal) => ({
        ...value,
        files: [{ path: "../SKILL.md", content: "x" }, ...value.files],
      }),
    ],
    [
      "missing license",
      (value: ImprovementProposal) => ({
        ...value,
        files: value.files.filter((file) => file.path !== "LICENSE"),
      }),
    ],
    [
      "case duplicate",
      (value: ImprovementProposal) => ({
        ...value,
        files: [
          ...value.files,
          { path: "assets/A", content: "a" },
          { path: "assets/a", content: "b" },
        ],
      }),
    ],
    [
      "executable document",
      (value: ImprovementProposal) => ({
        ...value,
        files: value.files.map((file) =>
          file.path === "LICENSE" ? { ...file, executable: true } : file,
        ),
      }),
    ],
    [
      "oversized file",
      (value: ImprovementProposal) => ({
        ...value,
        files: value.files.map((file) =>
          file.path === "SKILL.md" ? { ...file, content: "x".repeat(2 * 1024 * 1024 + 1) } : file,
        ),
      }),
    ],
    [
      "too many files",
      (value: ImprovementProposal) => ({
        ...value,
        files: [
          ...value.files,
          ...Array.from({ length: 62 }, (_, index) => ({ path: `assets/${index}`, content: "x" })),
        ],
      }),
    ],
    [
      "unsafe token count",
      (value: ImprovementProposal) => ({ ...value, tokensUsed: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    ["invalid cost", (value: ImprovementProposal) => ({ ...value, costUsd: Number.NaN })],
  ] as const)("rejects an out-of-scope proposal: %s", async (_name, mutate) => {
    const review = vi.fn<ImprovementCallbacks["review"]>();
    const report = await runBoundedImprovement(
      options(
        {
          author: async (context) => mutate(proposal(context.candidateSha256)),
          review,
        },
        { budgets: { maxNoImprovement: 1 } },
      ),
    );

    expect(report.iterations[0]?.decision).toBe("invalid_proposal");
    expect(review).not.toHaveBeenCalled();
  });

  it("fails closed when a typed author returns a malformed runtime value", async () => {
    const report = await runBoundedImprovement(
      options(
        { author: async () => null as unknown as ImprovementProposal },
        { budgets: { maxNoImprovement: 1 } },
      ),
    );
    expect(report.iterations[0]?.decision).toBe("invalid_proposal");
  });

  it.each([
    ["iteration budget", { budgets: { maxIterations: 0 } }],
    ["no-improvement budget", { budgets: { maxNoImprovement: 6 } }],
    ["token budget", { budgets: { maxTokens: 999 } }],
    ["cost budget", { budgets: { maxCostUsd: 0 } }],
    ["wall budget", { budgets: { maxWallMinutes: 1441 } }],
    ["minimum rate", { minimumSuccessRate: Number.NaN }],
    ["candidate digest", { initial: initial({ candidateSha256: "bad" }) }],
    ["training digest", { initial: initial({ trainingScenarioSetSha256: "bad" }) }],
    ["holdout digest", { initial: initial({ holdoutScenarioSetSha256: "bad" }) }],
    ["metrics", { initial: initial({ trainingMetrics: metrics(-1) }) }],
    ["training cases", { initial: initial({ trainingScenarios: [] }) }],
  ] as const)("rejects invalid initial input: %s", async (_name, changed) => {
    await expect(
      runBoundedImprovement(options({}, changed as Parameters<typeof options>[1])),
    ).rejects.toBeInstanceOf(ImprovementLoopError);
  });
});
