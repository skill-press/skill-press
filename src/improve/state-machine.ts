import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Ajv, type ValidateFunction } from "ajv";

import type { Iteration, Metrics, SkillPressImprovementReport } from "./generated-report.js";

export interface ImprovementLoopIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class ImprovementLoopError extends Error {
  readonly issues: readonly ImprovementLoopIssue[];

  constructor(message: string, issues: readonly ImprovementLoopIssue[]) {
    super(message);
    this.name = "ImprovementLoopError";
    this.issues = Object.freeze([...issues]);
  }
}

export interface ImprovementBudgets {
  readonly maxIterations: number;
  readonly maxNoImprovement: number;
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  readonly maxWallMinutes: number;
}

export interface TrainingScenarioContext {
  readonly id: string;
  readonly prompt: string;
  readonly expectedBehavior: readonly string[];
  readonly forbiddenBehavior?: readonly string[];
}

export interface ImprovementFeedback {
  readonly source: "deterministic" | "paired-eval" | "tessl";
  readonly text: string;
}

export interface ImprovementAuthorContext {
  readonly iteration: number;
  readonly candidateSha256: string;
  readonly trainingScenarioSetSha256: string;
  readonly trainingScenarios: readonly TrainingScenarioContext[];
  readonly failureIds: readonly string[];
  readonly feedback: readonly ImprovementFeedback[];
  readonly remaining: {
    readonly iterations: number;
    readonly tokens: number;
    readonly costUsd: number;
    readonly wallMilliseconds: number;
  };
}

export interface ImprovementCandidateFile {
  readonly path: string;
  readonly content: string;
  readonly executable?: boolean;
}

export interface ImprovementProposal {
  readonly baseCandidateSha256: string;
  readonly files: readonly ImprovementCandidateFile[];
  readonly rationale: string;
  readonly tokensUsed: number;
  readonly costUsd: number;
}

export interface ImprovementReview {
  readonly approved: boolean;
  readonly issueCodes: readonly string[];
}

export interface ImprovementEvaluation {
  readonly scenarioSetSha256: string;
  readonly metrics: Metrics;
}

export interface ImprovementInitialState {
  readonly candidateSha256: string;
  readonly trainingScenarioSetSha256: string;
  readonly holdoutScenarioSetSha256: string;
  readonly trainingMetrics: Metrics;
  readonly holdoutMetrics: Metrics;
  readonly trainingScenarios: readonly TrainingScenarioContext[];
  readonly failureIds: readonly string[];
  readonly feedback: readonly ImprovementFeedback[];
}

export interface ImprovementCallbacks {
  readonly author: (
    context: ImprovementAuthorContext,
    signal: AbortSignal,
  ) => Promise<ImprovementProposal>;
  readonly review: (
    proposal: ImprovementProposal,
    signal: AbortSignal,
  ) => Promise<ImprovementReview>;
  readonly deterministic: (
    proposal: ImprovementProposal,
    signal: AbortSignal,
  ) => Promise<{ readonly passed: boolean }>;
  readonly evaluateTraining: (
    proposal: ImprovementProposal,
    signal: AbortSignal,
  ) => Promise<ImprovementEvaluation>;
  readonly evaluateHoldout: (
    proposal: ImprovementProposal,
    signal: AbortSignal,
  ) => Promise<ImprovementEvaluation>;
  readonly accept: (proposal: ImprovementProposal, signal: AbortSignal) => Promise<void>;
}

export interface ImprovementLoopOptions {
  readonly budgets: ImprovementBudgets;
  readonly minimumSuccessRate: number;
  readonly initial: ImprovementInitialState;
  readonly callbacks: ImprovementCallbacks;
  readonly now?: () => number;
}

interface ValidProposal {
  readonly proposalSha256: string;
  readonly candidateSha256: string;
}

class ImprovementDeadlineError extends Error {
  constructor() {
    super("Improvement callback exceeded the wall-time budget.");
    this.name = "ImprovementDeadlineError";
  }
}

const MAX_PROPOSAL_FILES = 64;
const MAX_PROPOSAL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PROPOSAL_BYTES = 8 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const CANDIDATE_PATH = /^(?:SKILL\.md|LICENSE|(?:assets|references|scripts)\/[A-Za-z0-9._/-]+)$/u;
const PORTABLE_SEGMENT = /^[A-Za-z0-9._-]+$/u;

const reportSchema = JSON.parse(
  await readFile(new URL("../../schemas/improve-report.schema.json", import.meta.url), "utf8"),
) as object;
const ajv = new Ajv({ allErrors: true, strict: true });
const validateReport = ajv.compile<SkillPressImprovementReport>(
  reportSchema,
) as ValidateFunction<SkillPressImprovementReport>;

function issue(code: string, path: string, message: string): ImprovementLoopIssue {
  return Object.freeze({ code, path, message });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function validRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validMetrics(metrics: Metrics): boolean {
  return (
    validRate(metrics.successRate) &&
    validRate(metrics.activationPrecision) &&
    validRate(metrics.safetyRate)
  );
}

function allAtTarget(metrics: Metrics, minimum: number): boolean {
  return (
    metrics.successRate >= minimum &&
    metrics.activationPrecision >= minimum &&
    metrics.safetyRate >= minimum
  );
}

function nonRegressing(next: Metrics, current: Metrics): boolean {
  return (
    next.successRate >= current.successRate &&
    next.activationPrecision >= current.activationPrecision &&
    next.safetyRate >= current.safetyRate
  );
}

function measurablyImproved(next: Metrics, current: Metrics): boolean {
  return (
    next.successRate > current.successRate ||
    next.activationPrecision > current.activationPrecision ||
    next.safetyRate > current.safetyRate
  );
}

function validCandidatePath(path: string): boolean {
  if (!CANDIDATE_PATH.test(path) || path.includes("//") || path.includes("/../")) return false;
  const segments = path.split("/");
  return segments.every(
    (segment) => segment !== "." && segment !== ".." && PORTABLE_SEGMENT.test(segment),
  );
}

function validateProposal(
  proposal: ImprovementProposal,
  currentCandidateSha256: string,
): ValidProposal | undefined {
  if (
    proposal.baseCandidateSha256 !== currentCandidateSha256 ||
    !Number.isSafeInteger(proposal.tokensUsed) ||
    proposal.tokensUsed < 0 ||
    !Number.isFinite(proposal.costUsd) ||
    proposal.costUsd < 0 ||
    proposal.rationale.length === 0 ||
    proposal.rationale.length > 8192 ||
    proposal.files.length < 2 ||
    proposal.files.length > MAX_PROPOSAL_FILES
  ) {
    return undefined;
  }
  const normalizedPaths = new Set<string>();
  const files: ImprovementCandidateFile[] = [];
  let bytes = 0;
  for (const file of proposal.files) {
    if (!validCandidatePath(file.path)) return undefined;
    if (file.executable === true && !file.path.startsWith("scripts/")) return undefined;
    const key = file.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (normalizedPaths.has(key)) return undefined;
    normalizedPaths.add(key);
    const fileBytes = Buffer.byteLength(file.content, "utf8");
    if (fileBytes > MAX_PROPOSAL_FILE_BYTES) return undefined;
    bytes += fileBytes;
    if (bytes > MAX_PROPOSAL_BYTES) return undefined;
    files.push({ path: file.path, content: file.content, executable: file.executable === true });
  }
  if (!normalizedPaths.has("skill.md") || !normalizedPaths.has("license")) return undefined;
  files.sort((left, right) => (left.path < right.path ? -1 : 1));
  const candidateSha256 = digest(canonicalJson(files));
  return {
    candidateSha256,
    proposalSha256: digest(canonicalJson(proposal)),
  };
}

function validateInitial(options: ImprovementLoopOptions): void {
  const issues: ImprovementLoopIssue[] = [];
  const { budgets, initial } = options;
  const integerBounds = [
    ["maxIterations", budgets.maxIterations, 1, 20],
    ["maxNoImprovement", budgets.maxNoImprovement, 1, 5],
    ["maxTokens", budgets.maxTokens, 1000, 10_000_000],
    ["maxWallMinutes", budgets.maxWallMinutes, 1, 1440],
  ] as const;
  for (const [name, value, minimum, maximum] of integerBounds) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      issues.push(
        issue(
          "improve.config.bound",
          `/budgets/${name}`,
          "improvement budget is outside its supported range",
        ),
      );
    }
  }
  if (
    !Number.isFinite(budgets.maxCostUsd) ||
    budgets.maxCostUsd <= 0 ||
    budgets.maxCostUsd > 10_000
  ) {
    issues.push(
      issue(
        "improve.config.bound",
        "/budgets/maxCostUsd",
        "cost budget is outside its supported range",
      ),
    );
  }
  if (!validRate(options.minimumSuccessRate)) {
    issues.push(
      issue(
        "improve.config.minimum",
        "/minimumSuccessRate",
        "minimum success rate must be between zero and one",
      ),
    );
  }
  for (const [name, value] of [
    ["candidateSha256", initial.candidateSha256],
    ["trainingScenarioSetSha256", initial.trainingScenarioSetSha256],
    ["holdoutScenarioSetSha256", initial.holdoutScenarioSetSha256],
  ] as const) {
    if (!DIGEST.test(value))
      issues.push(issue("improve.input.digest", `/initial/${name}`, "initial digest is invalid"));
  }
  if (!validMetrics(initial.trainingMetrics) || !validMetrics(initial.holdoutMetrics)) {
    issues.push(issue("improve.input.metrics", "/initial", "initial metrics must be finite rates"));
  }
  if (initial.trainingScenarios.length === 0) {
    issues.push(
      issue(
        "improve.input.training",
        "/initial/trainingScenarios",
        "at least one training scenario is required",
      ),
    );
  }
  if (issues.length > 0)
    throw new ImprovementLoopError("Improvement loop input is invalid.", issues);
}

function immutableAuthorContext(
  options: ImprovementLoopOptions,
  iteration: number,
  candidateSha256: string,
  tokensUsed: number,
  costUsd: number,
  elapsedMs: number,
): ImprovementAuthorContext {
  const scenarios = options.initial.trainingScenarios.map((scenario) =>
    Object.freeze({
      id: scenario.id,
      prompt: scenario.prompt,
      expectedBehavior: Object.freeze([...scenario.expectedBehavior]),
      ...(scenario.forbiddenBehavior === undefined
        ? {}
        : { forbiddenBehavior: Object.freeze([...scenario.forbiddenBehavior]) }),
    }),
  );
  return Object.freeze({
    iteration,
    candidateSha256,
    trainingScenarioSetSha256: options.initial.trainingScenarioSetSha256,
    trainingScenarios: Object.freeze(scenarios),
    failureIds: Object.freeze([...options.initial.failureIds]),
    feedback: Object.freeze(
      options.initial.feedback.map((entry) =>
        Object.freeze({ source: entry.source, text: entry.text }),
      ),
    ),
    remaining: Object.freeze({
      iterations: options.budgets.maxIterations - iteration + 1,
      tokens: options.budgets.maxTokens - tokensUsed,
      costUsd: Math.max(0, options.budgets.maxCostUsd - costUsd),
      wallMilliseconds: Math.max(0, options.budgets.maxWallMinutes * 60_000 - elapsedMs),
    }),
  });
}

function fixedIteration(
  iteration: number,
  baseCandidateSha256: string,
  decision: Iteration["decision"],
  tokensUsed: number,
  costUsd: number,
  valid: ValidProposal | undefined,
  training: Metrics | null = null,
  holdout: Metrics | null = null,
): Iteration {
  return {
    iteration,
    baseCandidateSha256,
    proposalSha256: valid?.proposalSha256 ?? null,
    candidateSha256: valid?.candidateSha256 ?? null,
    decision,
    tokensUsed,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    training,
    holdout,
  };
}

function finish(
  options: ImprovementLoopOptions,
  startedMs: number,
  finishedMs: number,
  success: boolean,
  stopReason: SkillPressImprovementReport["stopReason"],
  candidateSha256: string,
  tokensUsed: number,
  costUsd: number,
  iterations: readonly Iteration[],
): SkillPressImprovementReport {
  const report: SkillPressImprovementReport = {
    schemaVersion: 1,
    reportType: "skillpress.improve",
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
    success,
    stopReason,
    initialCandidateSha256: options.initial.candidateSha256,
    finalCandidateSha256: candidateSha256,
    trainingScenarioSetSha256: options.initial.trainingScenarioSetSha256,
    holdoutScenarioSetSha256: options.initial.holdoutScenarioSetSha256,
    budget: {
      iterationsUsed: iterations.length,
      tokensUsed,
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
      wallMilliseconds: Math.max(0, Math.round(finishedMs - startedMs)),
    },
    iterations: [...iterations],
  };
  if (!validateReport(report)) {
    throw new ImprovementLoopError("Improvement report violated its schema.", [
      issue("improve.report.schema", "/report", "internal improvement report is invalid"),
    ]);
  }
  return deepFreeze(report);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function reasonForBudget(
  budgets: ImprovementBudgets,
  tokensUsed: number,
  costUsd: number,
  elapsedMs: number,
): "token_budget" | "cost_budget" | "wall_time_budget" | undefined {
  if (tokensUsed > budgets.maxTokens) return "token_budget";
  if (costUsd > budgets.maxCostUsd) return "cost_budget";
  if (elapsedMs > budgets.maxWallMinutes * 60_000) return "wall_time_budget";
  return undefined;
}

async function withinWallBudget<T>(
  options: ImprovementLoopOptions,
  startedMs: number,
  now: () => number,
  callback: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const remainingMs = Math.max(
    0,
    options.budgets.maxWallMinutes * 60_000 - Math.max(0, now() - startedMs),
  );
  if (remainingMs === 0) throw new ImprovementDeadlineError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new ImprovementDeadlineError());
      reject(new ImprovementDeadlineError());
    }, remainingMs);
  });
  try {
    return await Promise.race([callback(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Run an author/review/eval state machine that never discloses holdout cases to the author. */
export async function runBoundedImprovement(
  options: ImprovementLoopOptions,
): Promise<SkillPressImprovementReport> {
  validateInitial(options);
  const now = options.now ?? Date.now;
  const startedMs = now();
  let currentCandidate = options.initial.candidateSha256;
  let currentTraining = options.initial.trainingMetrics;
  let currentHoldout = options.initial.holdoutMetrics;
  let tokensUsed = 0;
  let costUsd = 0;
  let noImprovement = 0;
  const seenCandidates = new Set([currentCandidate]);
  const iterations: Iteration[] = [];
  if (
    allAtTarget(currentTraining, options.minimumSuccessRate) &&
    allAtTarget(currentHoldout, options.minimumSuccessRate)
  ) {
    return finish(options, startedMs, now(), true, "target_reached", currentCandidate, 0, 0, []);
  }

  const reject = (
    iteration: number,
    decision: Iteration["decision"],
    valid: ValidProposal | undefined,
    training: Metrics | null = null,
    holdout: Metrics | null = null,
  ): boolean => {
    iterations.push(
      fixedIteration(
        iteration,
        currentCandidate,
        decision,
        tokensUsed,
        costUsd,
        valid,
        training,
        holdout,
      ),
    );
    noImprovement += 1;
    return noImprovement >= options.budgets.maxNoImprovement;
  };

  const wallFailure = (
    iteration: number,
    valid: ValidProposal | undefined,
    training: Metrics | null = null,
    holdout: Metrics | null = null,
  ): SkillPressImprovementReport => {
    iterations.push(
      fixedIteration(
        iteration,
        currentCandidate,
        "budget_exceeded",
        tokensUsed,
        costUsd,
        valid,
        training,
        holdout,
      ),
    );
    return finish(
      options,
      startedMs,
      now(),
      false,
      "wall_time_budget",
      currentCandidate,
      tokensUsed,
      costUsd,
      iterations,
    );
  };

  for (let iteration = 1; iteration <= options.budgets.maxIterations; iteration += 1) {
    const beforeReason = reasonForBudget(options.budgets, tokensUsed, costUsd, now() - startedMs);
    if (beforeReason !== undefined) {
      return finish(
        options,
        startedMs,
        now(),
        false,
        beforeReason,
        currentCandidate,
        tokensUsed,
        costUsd,
        iterations,
      );
    }
    let proposal: ImprovementProposal;
    try {
      const context = immutableAuthorContext(
        options,
        iteration,
        currentCandidate,
        tokensUsed,
        costUsd,
        now() - startedMs,
      );
      proposal = await withinWallBudget(options, startedMs, now, (signal) =>
        options.callbacks.author(context, signal),
      );
    } catch (error) {
      if (error instanceof ImprovementDeadlineError) return wallFailure(iteration, undefined);
      iterations.push(
        fixedIteration(
          iteration,
          currentCandidate,
          "author_failed",
          tokensUsed,
          costUsd,
          undefined,
        ),
      );
      return finish(
        options,
        startedMs,
        now(),
        false,
        "author_failed",
        currentCandidate,
        tokensUsed,
        costUsd,
        iterations,
      );
    }
    let valid: ValidProposal | undefined;
    try {
      const usageIsValid =
        Number.isSafeInteger(proposal.tokensUsed) &&
        proposal.tokensUsed >= 0 &&
        Number.isFinite(proposal.costUsd) &&
        proposal.costUsd >= 0;
      if (usageIsValid) {
        tokensUsed += proposal.tokensUsed;
        costUsd += proposal.costUsd;
      }
      valid = validateProposal(proposal, currentCandidate);
    } catch {
      valid = undefined;
    }
    if (valid === undefined) {
      if (reject(iteration, "invalid_proposal", undefined)) {
        return finish(
          options,
          startedMs,
          now(),
          false,
          "no_improvement",
          currentCandidate,
          tokensUsed,
          costUsd,
          iterations,
        );
      }
      continue;
    }
    const afterAuthorReason = reasonForBudget(
      options.budgets,
      tokensUsed,
      costUsd,
      now() - startedMs,
    );
    if (afterAuthorReason !== undefined) {
      iterations.push(
        fixedIteration(iteration, currentCandidate, "budget_exceeded", tokensUsed, costUsd, valid),
      );
      return finish(
        options,
        startedMs,
        now(),
        false,
        afterAuthorReason,
        currentCandidate,
        tokensUsed,
        costUsd,
        iterations,
      );
    }
    if (seenCandidates.has(valid.candidateSha256)) {
      if (reject(iteration, "invalid_proposal", valid)) {
        return finish(
          options,
          startedMs,
          now(),
          false,
          "no_improvement",
          currentCandidate,
          tokensUsed,
          costUsd,
          iterations,
        );
      }
      continue;
    }

    let reviewApproved = false;
    try {
      const review = await withinWallBudget(options, startedMs, now, (signal) =>
        options.callbacks.review(proposal, signal),
      );
      reviewApproved =
        review.approved === true &&
        Array.isArray(review.issueCodes) &&
        review.issueCodes.every((code) => typeof code === "string");
    } catch (error) {
      if (error instanceof ImprovementDeadlineError) return wallFailure(iteration, valid);
      reviewApproved = false;
    }
    if (!reviewApproved) {
      if (reject(iteration, "review_rejected", valid)) {
        return finish(
          options,
          startedMs,
          now(),
          false,
          "no_improvement",
          currentCandidate,
          tokensUsed,
          costUsd,
          iterations,
        );
      }
      continue;
    }

    let deterministicPassed = false;
    try {
      deterministicPassed =
        (
          await withinWallBudget(options, startedMs, now, (signal) =>
            options.callbacks.deterministic(proposal, signal),
          )
        ).passed === true;
    } catch (error) {
      if (error instanceof ImprovementDeadlineError) return wallFailure(iteration, valid);
      deterministicPassed = false;
    }
    if (!deterministicPassed) {
      if (reject(iteration, "deterministic_failed", valid)) {
        return finish(
          options,
          startedMs,
          now(),
          false,
          "no_improvement",
          currentCandidate,
          tokensUsed,
          costUsd,
          iterations,
        );
      }
      continue;
    }

    let training: ImprovementEvaluation;
    try {
      training = await withinWallBudget(options, startedMs, now, (signal) =>
        options.callbacks.evaluateTraining(proposal, signal),
      );
    } catch (error) {
      if (error instanceof ImprovementDeadlineError) return wallFailure(iteration, valid);
      if (reject(iteration, "training_regression", valid)) {
        return finish(
          options,
          startedMs,
          now(),
          false,
          "no_improvement",
          currentCandidate,
          tokensUsed,
          costUsd,
          iterations,
        );
      }
      continue;
    }
    if (
      training.scenarioSetSha256 !== options.initial.trainingScenarioSetSha256 ||
      !validMetrics(training.metrics)
    ) {
      iterations.push(
        fixedIteration(
          iteration,
          currentCandidate,
          "scenario_set_changed",
          tokensUsed,
          costUsd,
          valid,
        ),
      );
      return finish(
        options,
        startedMs,
        now(),
        false,
        "scenario_set_changed",
        currentCandidate,
        tokensUsed,
        costUsd,
        iterations,
      );
    }
    if (
      !nonRegressing(training.metrics, currentTraining) ||
      !measurablyImproved(training.metrics, currentTraining)
    ) {
      if (reject(iteration, "training_regression", valid, training.metrics)) {
        return finish(
          options,
          startedMs,
          now(),
          false,
          "no_improvement",
          currentCandidate,
          tokensUsed,
          costUsd,
          iterations,
        );
      }
      continue;
    }

    let holdout: ImprovementEvaluation;
    try {
      holdout = await withinWallBudget(options, startedMs, now, (signal) =>
        options.callbacks.evaluateHoldout(proposal, signal),
      );
    } catch (error) {
      if (error instanceof ImprovementDeadlineError) {
        return wallFailure(iteration, valid, training.metrics);
      }
      if (reject(iteration, "holdout_regression", valid, training.metrics)) {
        return finish(
          options,
          startedMs,
          now(),
          false,
          "no_improvement",
          currentCandidate,
          tokensUsed,
          costUsd,
          iterations,
        );
      }
      continue;
    }
    if (
      holdout.scenarioSetSha256 !== options.initial.holdoutScenarioSetSha256 ||
      !validMetrics(holdout.metrics)
    ) {
      iterations.push(
        fixedIteration(
          iteration,
          currentCandidate,
          "scenario_set_changed",
          tokensUsed,
          costUsd,
          valid,
          training.metrics,
        ),
      );
      return finish(
        options,
        startedMs,
        now(),
        false,
        "scenario_set_changed",
        currentCandidate,
        tokensUsed,
        costUsd,
        iterations,
      );
    }
    if (!nonRegressing(holdout.metrics, currentHoldout)) {
      if (reject(iteration, "holdout_regression", valid, training.metrics, holdout.metrics)) {
        return finish(
          options,
          startedMs,
          now(),
          false,
          "no_improvement",
          currentCandidate,
          tokensUsed,
          costUsd,
          iterations,
        );
      }
      continue;
    }

    const beforeAcceptReason = reasonForBudget(
      options.budgets,
      tokensUsed,
      costUsd,
      now() - startedMs,
    );
    if (beforeAcceptReason !== undefined) {
      iterations.push(
        fixedIteration(
          iteration,
          currentCandidate,
          "budget_exceeded",
          tokensUsed,
          costUsd,
          valid,
          training.metrics,
          holdout.metrics,
        ),
      );
      return finish(
        options,
        startedMs,
        now(),
        false,
        beforeAcceptReason,
        currentCandidate,
        tokensUsed,
        costUsd,
        iterations,
      );
    }

    try {
      await withinWallBudget(options, startedMs, now, (signal) =>
        options.callbacks.accept(proposal, signal),
      );
    } catch (error) {
      if (error instanceof ImprovementDeadlineError) {
        return wallFailure(iteration, valid, training.metrics, holdout.metrics);
      }
      iterations.push(
        fixedIteration(
          iteration,
          currentCandidate,
          "accept_failed",
          tokensUsed,
          costUsd,
          valid,
          training.metrics,
          holdout.metrics,
        ),
      );
      return finish(
        options,
        startedMs,
        now(),
        false,
        "accept_failed",
        currentCandidate,
        tokensUsed,
        costUsd,
        iterations,
      );
    }
    iterations.push(
      fixedIteration(
        iteration,
        currentCandidate,
        "accepted",
        tokensUsed,
        costUsd,
        valid,
        training.metrics,
        holdout.metrics,
      ),
    );
    currentCandidate = valid.candidateSha256;
    currentTraining = training.metrics;
    currentHoldout = holdout.metrics;
    seenCandidates.add(currentCandidate);
    noImprovement = 0;
    if (
      allAtTarget(currentTraining, options.minimumSuccessRate) &&
      allAtTarget(currentHoldout, options.minimumSuccessRate)
    ) {
      return finish(
        options,
        startedMs,
        now(),
        true,
        "target_reached",
        currentCandidate,
        tokensUsed,
        costUsd,
        iterations,
      );
    }
  }
  return finish(
    options,
    startedMs,
    now(),
    false,
    "iteration_limit",
    currentCandidate,
    tokensUsed,
    costUsd,
    iterations,
  );
}
