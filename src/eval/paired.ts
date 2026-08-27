import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Ajv, type ValidateFunction } from "ajv";

import { loadProjectConfig } from "../config/load.js";
import { isSafePathInput } from "../path-safety.js";
import { validateAgentSkill } from "../validate/agent-skill.js";
import type { Scenario } from "./generated-suite.js";
import type { SkillPressAgentResult } from "./generated-agent-result.js";
import type {
  LegEvidence,
  RepetitionEvidence,
  ScenarioEvidence,
  SkillPressPairedEvaluationEvidence,
  TranscriptEvidence,
} from "./generated-evidence.js";
import { loadProjectEvaluationInputs } from "./load.js";
import { executeSandboxInvocation, type SandboxExecutionResult } from "./sandbox-execute.js";
import {
  createSandboxInvocation,
  type SandboxInvocation,
  type SandboxResourcePolicy,
} from "./sandbox.js";

export interface EvaluationRunIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class EvaluationRunError extends Error {
  readonly issues: readonly EvaluationRunIssue[];

  constructor(message: string, issues: readonly EvaluationRunIssue[], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EvaluationRunError";
    this.issues = Object.freeze([...issues]);
  }
}

export type SandboxExecutor = (invocation: SandboxInvocation) => Promise<SandboxExecutionResult>;

export interface PairedEvaluationOptions {
  readonly image: string;
  readonly command: readonly [string, ...string[]];
  readonly model: string;
  readonly suite?: "training" | "holdout";
  readonly scenarioIds?: readonly string[];
  readonly secrets?: readonly string[];
  readonly policy?: SandboxResourcePolicy;
  readonly allowUnpinnedImage?: boolean;
  /** A custom executor is intended for hermetic tests and always makes evidence ineligible. */
  readonly executor?: SandboxExecutor;
  readonly now?: () => Date;
}

export interface AdapterRequest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly variant: "baseline" | "with-skill";
  readonly model: string;
  readonly prompt: string;
  readonly fixture: Scenario["fixture"] | null;
  readonly skill:
    | { readonly available: false; readonly sha256: null }
    | { readonly available: true; readonly sha256: string; readonly path: "/skill" };
}

interface RunContext {
  readonly root: string;
  readonly skill: string;
  readonly emptySkill: string;
  readonly runId: string;
  readonly skillSha256: string;
}

const MAX_STAGED_SKILL_BYTES = 64 * 1024 * 1024;
const MAX_STAGED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_STAGED_ENTRIES = 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_EXCERPT_CODE_UNITS = 1000;

const agentResultSchema = JSON.parse(
  await readFile(new URL("../../schemas/eval-agent-result.schema.json", import.meta.url), "utf8"),
) as object;
const evidenceSchema = JSON.parse(
  await readFile(new URL("../../schemas/eval-evidence.schema.json", import.meta.url), "utf8"),
) as object;
const ajv = new Ajv({ allErrors: true, strict: true });
const validateAgentResult = ajv.compile<SkillPressAgentResult>(
  agentResultSchema,
) as ValidateFunction<SkillPressAgentResult>;
const validateEvidence = ajv.compile<SkillPressPairedEvaluationEvidence>(
  evidenceSchema,
) as ValidateFunction<SkillPressPairedEvaluationEvidence>;

function issue(code: string, path: string, message: string): EvaluationRunIssue {
  return Object.freeze({ code, path, message });
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function ensureDirectory(path: string, mode: number): Promise<void> {
  await mkdir(path, { mode });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new EvaluationRunError("Evaluation storage is not a safe directory.", [
      issue("eval.run.storage", "/storage", "evaluation storage must not contain symbolic links"),
    ]);
  }
  await chmod(path, mode);
}

async function optionalMetadata(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

async function bestEffortPrivateMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // The adapter result is already rejected or captured; permission repair is best effort.
  }
}

async function createRunStorage(projectRoot: string, runId: string): Promise<string> {
  const skillpressDirectory = join(projectRoot, ".skill-press");
  const runsDirectory = join(skillpressDirectory, "runs");
  try {
    await mkdir(skillpressDirectory, { mode: 0o700 });
  } catch (error) {
    const metadata = await optionalMetadata(skillpressDirectory);
    if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new EvaluationRunError(
        "Evaluation storage is unavailable.",
        [issue("eval.run.storage", "/storage", "the .skill-press path must be a real directory")],
        error,
      );
    }
  }
  await chmod(skillpressDirectory, 0o700);
  try {
    await mkdir(runsDirectory, { mode: 0o700 });
  } catch (error) {
    const metadata = await optionalMetadata(runsDirectory);
    if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new EvaluationRunError(
        "Evaluation storage is unavailable.",
        [issue("eval.run.storage", "/storage", "the runs path must be a real directory")],
        error,
      );
    }
  }
  await chmod(runsDirectory, 0o700);
  const runRoot = join(runsDirectory, runId);
  await ensureDirectory(runRoot, 0o700);
  return runRoot;
}

async function digestAndNormalizeTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const names = await readdir(directory);
    names.sort();
    for (const name of names) {
      entries += 1;
      if (entries > MAX_STAGED_ENTRIES) {
        throw new EvaluationRunError("Staged skill exceeds the entry budget.", [
          issue("eval.run.skill_entries", "/skill", "staged skill has too many entries"),
        ]);
      }
      const path = join(directory, name);
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new EvaluationRunError("Staged skill contains a symbolic link.", [
          issue("eval.run.skill_symlink", "/skill", "staged skill must not contain symbolic links"),
        ]);
      }
      if (metadata.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        await visit(path, relativePath);
        await chmod(path, 0o755);
      } else if (metadata.isFile()) {
        if (metadata.size > MAX_STAGED_FILE_BYTES) {
          throw new EvaluationRunError("Staged skill contains an oversized file.", [
            issue("eval.run.skill_file_size", "/skill", "staged skill file exceeds the byte limit"),
          ]);
        }
        bytes += metadata.size;
        if (bytes > MAX_STAGED_SKILL_BYTES) {
          throw new EvaluationRunError("Staged skill exceeds the byte budget.", [
            issue("eval.run.skill_size", "/skill", "staged skill exceeds the total byte limit"),
          ]);
        }
        const content = await readFile(path);
        const executable = (metadata.mode & 0o111) === 0 ? "0" : "1";
        hash.update(`F\0${relativePath}\0${executable}\0${content.byteLength}\0`);
        hash.update(content);
        await chmod(path, executable === "1" ? 0o555 : 0o444);
      } else {
        throw new EvaluationRunError("Staged skill contains an unsupported file kind.", [
          issue(
            "eval.run.skill_kind",
            "/skill",
            "staged skill must contain only files and directories",
          ),
        ]);
      }
    }
  }
  await visit(root, "");
  await chmod(root, 0o755);
  return hash.digest("hex");
}

async function stageSkill(
  projectRoot: string,
  skillPath: string,
  expectedName: string,
  runRoot: string,
): Promise<{ readonly path: string; readonly sha256: string }> {
  const source = join(projectRoot, skillPath);
  const sourceReport = await validateAgentSkill(source, { expectedName });
  if (!sourceReport.ok) {
    throw new EvaluationRunError("Canonical skill cannot be staged for evaluation.", [
      issue("eval.run.skill_invalid", "/skill", "canonical skill validation failed"),
    ]);
  }
  const destination = join(runRoot, expectedName);
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });
  const stagedReport = await validateAgentSkill(destination, { expectedName });
  if (!stagedReport.ok) {
    throw new EvaluationRunError("Staged skill validation failed.", [
      issue("eval.run.skill_changed", "/skill", "canonical skill changed while it was staged"),
    ]);
  }
  return { path: destination, sha256: await digestAndNormalizeTree(destination) };
}

function validateOptions(options: PairedEvaluationOptions): void {
  const issues: EvaluationRunIssue[] = [];
  if (options.model.length === 0 || options.model.length > 200 || !isSafePathInput(options.model)) {
    issues.push(issue("eval.run.model", "/model", "model must be a bounded printable identifier"));
  }
  if (options.command.length === 0 || options.command.length > 240) {
    issues.push(
      issue("eval.run.command", "/command", "adapter command must contain 1 to 240 arguments"),
    );
  }
  if ((options.secrets?.length ?? 0) > 128) {
    issues.push(issue("eval.run.secrets", "/secrets", "at most 128 redaction values are accepted"));
  }
  for (let index = 0; index < (options.secrets?.length ?? 0); index += 1) {
    const secret = options.secrets?.[index] as string;
    if (secret.length < 4 || secret.length > 4096) {
      issues.push(
        issue(
          "eval.run.secret",
          `/secrets/${index}`,
          "redaction values must contain 4 to 4096 characters",
        ),
      );
    }
  }
  if (issues.length > 0) throw new EvaluationRunError("Evaluation options are invalid.", issues);
}

function selectScenarios(
  scenarios: readonly Scenario[],
  requested: readonly string[] | undefined,
): readonly Scenario[] {
  if (requested === undefined) return scenarios;
  const requestedIds = new Set(requested);
  if (requested.length === 0 || requestedIds.size !== requested.length) {
    throw new EvaluationRunError("Scenario selection is invalid.", [
      issue(
        "eval.run.scenario_selection",
        "/scenarioIds",
        "scenario ids must be non-empty and unique",
      ),
    ]);
  }
  const selected = scenarios.filter((scenario) => requestedIds.has(scenario.id));
  if (selected.length !== requested.length) {
    throw new EvaluationRunError("Scenario selection is invalid.", [
      issue(
        "eval.run.scenario_missing",
        "/scenarioIds",
        "a requested scenario id does not exist in the suite",
      ),
    ]);
  }
  return selected;
}

export function redactEvaluationTranscript(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
  result = result
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
      "[REDACTED_TOKEN]",
    )
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "[REDACTED_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/giu, "Bearer [REDACTED_TOKEN]")
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]");
  return result.slice(0, MAX_EXCERPT_CODE_UNITS);
}

function transcriptEvidence(text: string, secrets: readonly string[]): TranscriptEvidence {
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: digest(text),
    redactedExcerpt: redactEvaluationTranscript(text, secrets),
  };
}

function failedLeg(
  runId: string,
  inputSha256: string,
  execution: SandboxExecutionResult,
  secrets: readonly string[],
): LegEvidence {
  const transcript = `${execution.stdoutText}${execution.stderrText}`;
  return {
    runId,
    status: execution.status,
    activated: null,
    loadedSkillSha256: null,
    rubricScore: null,
    successful: false,
    inputSha256,
    transcript: transcriptEvidence(transcript, secrets),
    engineStdoutSha256: execution.stdoutSha256,
    engineStderrSha256: execution.stderrSha256,
  };
}

export async function readAdapterResult(
  outputDirectory: string,
  maxBytes: number = MAX_RESULT_BYTES,
): Promise<SkillPressAgentResult | undefined> {
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]?.name !== "result.json" || !entries[0].isFile())
    return undefined;
  const path = join(outputDirectory, "result.json");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  } finally {
    await bestEffortPrivateMode(path, 0o600);
    await bestEffortPrivateMode(outputDirectory, 0o700);
  }
  return validateAgentResult(value) ? value : undefined;
}

export function validAdapterSemantics(
  result: SkillPressAgentResult,
  request: AdapterRequest,
  inputSha256: string,
  skillSha256: string,
  judgeIds: ReadonlySet<string>,
): boolean {
  if (
    result.runId !== request.runId ||
    result.variant !== request.variant ||
    result.model !== request.model ||
    result.inputSha256 !== inputSha256 ||
    (request.variant === "baseline"
      ? result.loadedSkillSha256 !== null
      : result.loadedSkillSha256 !== skillSha256)
  ) {
    return false;
  }
  const resultIds = new Set(result.criteria.map((criterion) => criterion.id));
  if (resultIds.size !== result.criteria.length || resultIds.size !== judgeIds.size) return false;
  for (const id of judgeIds) if (!resultIds.has(id)) return false;
  return true;
}

function scoreResult(
  result: SkillPressAgentResult,
  expectedActivation: boolean,
  criteria: ProjectEvaluationInputs["rubric"]["criteria"],
): number {
  const judgeScores = new Map(result.criteria.map((criterion) => [criterion.id, criterion.score]));
  const total = criteria.reduce((score, criterion) => {
    const criterionScore =
      criterion.evaluator === "deterministic"
        ? result.activated === expectedActivation
          ? 1
          : 0
        : (judgeScores.get(criterion.id) as number);
    return score + criterion.weight * criterionScore;
  }, 0);
  return Math.round(total * 1_000_000) / 1_000_000;
}

type ProjectEvaluationInputs = Awaited<ReturnType<typeof loadProjectEvaluationInputs>>;

async function persistEngineOutput(
  legDirectory: string,
  execution: SandboxExecutionResult,
): Promise<void> {
  await writeFile(join(legDirectory, "engine.stdout"), execution.stdoutText, { mode: 0o600 });
  await writeFile(join(legDirectory, "engine.stderr"), execution.stderrText, { mode: 0o600 });
}

async function runLeg(
  context: RunContext,
  scenario: Scenario,
  scenarioIndex: number,
  repetition: number,
  variant: "baseline" | "with-skill",
  options: PairedEvaluationOptions,
  config: Awaited<ReturnType<typeof loadProjectConfig>>,
  inputs: ProjectEvaluationInputs,
  secrets: readonly string[],
): Promise<{
  readonly evidence: LegEvidence;
  readonly invocation: SandboxInvocation;
  readonly execution: SandboxExecutionResult;
}> {
  const runId = digest(`${context.runId}:${scenarioIndex}:${repetition}:${variant}`);
  const legDirectory = join(
    context.root,
    `scenario-${scenarioIndex + 1}`,
    `rep-${repetition}`,
    variant,
  );
  const inputDirectory = join(legDirectory, "input");
  const outputDirectory = join(legDirectory, "output");
  await mkdir(inputDirectory, { recursive: true, mode: 0o755 });
  await mkdir(outputDirectory, { mode: 0o733 });
  await chmod(outputDirectory, 0o733);
  await writeFile(join(outputDirectory, "result.json"), "", { mode: 0o666 });
  await chmod(join(outputDirectory, "result.json"), 0o666);
  const request: AdapterRequest = {
    schemaVersion: 1,
    runId,
    variant,
    model: options.model,
    prompt: scenario.prompt,
    fixture: scenario.fixture ?? null,
    skill:
      variant === "baseline"
        ? { available: false, sha256: null }
        : { available: true, sha256: context.skillSha256, path: "/skill" },
  };
  const requestText = canonicalJson(request);
  const inputSha256 = digest(requestText);
  await writeFile(join(inputDirectory, "request.json"), requestText, { mode: 0o444 });
  await chmod(inputDirectory, 0o555);
  let invocation: SandboxInvocation;
  try {
    invocation = createSandboxInvocation({
      backend: config.evaluation.sandbox,
      runId: runId.slice(0, 32),
      image: options.image,
      command: [
        ...options.command,
        "--request",
        "/input/request.json",
        "--result",
        "/output/result.json",
        variant === "baseline" ? "--no-skill" : "--skill=/skill",
      ],
      mounts: [
        {
          source: variant === "baseline" ? context.emptySkill : context.skill,
          target: "/skill",
          mode: "read-only",
        },
        { source: inputDirectory, target: "/input", mode: "read-only" },
        { source: outputDirectory, target: "/output", mode: "read-write" },
      ],
      network: config.evaluation.network,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.allowUnpinnedImage === undefined
        ? {}
        : { allowUnpinnedImage: options.allowUnpinnedImage }),
    });
  } catch (error) {
    await bestEffortPrivateMode(join(inputDirectory, "request.json"), 0o600);
    await bestEffortPrivateMode(inputDirectory, 0o700);
    await bestEffortPrivateMode(join(outputDirectory, "result.json"), 0o600);
    await bestEffortPrivateMode(outputDirectory, 0o700);
    throw error;
  }
  let execution: SandboxExecutionResult;
  try {
    execution = await (options.executor ?? executeSandboxInvocation)(invocation);
  } catch {
    const empty = digest("");
    execution = Object.freeze({
      status: "spawn_error",
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutSha256: empty,
      stderrSha256: empty,
      stdoutText: "",
      stderrText: "",
      cleanupAttempted: false,
      cleanupOk: false,
    });
  }
  await persistEngineOutput(legDirectory, execution);
  await chmod(join(inputDirectory, "request.json"), 0o600);
  await chmod(inputDirectory, 0o700);
  await chmod(outputDirectory, 0o700);
  if (execution.status !== "passed") {
    await bestEffortPrivateMode(join(outputDirectory, "result.json"), 0o600);
    return { evidence: failedLeg(runId, inputSha256, execution, secrets), invocation, execution };
  }
  const result = await readAdapterResult(
    outputDirectory,
    Math.min(MAX_RESULT_BYTES, invocation.policy.maxArtifactBytes),
  );
  const judgeIds = new Set(
    inputs.rubric.criteria
      .filter((criterion) => criterion.evaluator === "judge")
      .map((criterion) => criterion.id),
  );
  if (
    result === undefined ||
    !validAdapterSemantics(result, request, inputSha256, context.skillSha256, judgeIds)
  ) {
    return {
      evidence: {
        ...failedLeg(runId, inputSha256, execution, secrets),
        status: "invalid_result",
      },
      invocation,
      execution,
    };
  }
  const expectedActivation = variant === "baseline" ? false : scenario.shouldActivate;
  const rubricScore = scoreResult(result, expectedActivation, inputs.rubric.criteria);
  return {
    evidence: {
      runId,
      status: "passed",
      activated: result.activated,
      loadedSkillSha256: result.loadedSkillSha256,
      rubricScore,
      successful: rubricScore >= config.quality.readinessMinimum,
      inputSha256,
      transcript: transcriptEvidence(result.transcript, secrets),
      engineStdoutSha256: execution.stdoutSha256,
      engineStderrSha256: execution.stderrSha256,
    },
    invocation,
    execution,
  };
}

function rate(successes: number, total: number): number {
  return Math.round((successes / total) * 1_000_000) / 1_000_000;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Run paired baseline/with-skill scenarios and persist raw material only under ignored storage. */
export async function runPairedEvaluation(
  projectDirectory: string = process.cwd(),
  options: PairedEvaluationOptions,
): Promise<SkillPressPairedEvaluationEvidence> {
  if (!isSafePathInput(projectDirectory)) {
    throw new TypeError("projectDirectory must be a bounded, unambiguous filesystem path.");
  }
  validateOptions(options);
  const root = await realpath(resolve(projectDirectory));
  const [config, inputs] = await Promise.all([
    loadProjectConfig(root),
    loadProjectEvaluationInputs(root),
  ]);
  const suiteName = options.suite ?? "training";
  const suite = inputs[suiteName];
  const scenarios = selectScenarios(suite.scenarios, options.scenarioIds);
  const runId = randomBytes(32).toString("hex");
  const runRoot = await createRunStorage(root, runId);
  const staged = await stageSkill(root, config.skill.path, config.skill.name, runRoot);
  const emptySkill = join(runRoot, "empty-skill");
  await ensureDirectory(emptySkill, 0o755);
  const context: RunContext = {
    root: runRoot,
    skill: staged.path,
    emptySkill,
    runId,
    skillSha256: staged.sha256,
  };
  const registeredSecrets = [
    ...(options.secrets ?? []),
    ...scenarios.flatMap((scenario) => Object.values(scenario.fixture?.environment ?? {})),
  ];
  const scenarioResults: ScenarioEvidence[] = [];
  const ineligibilityReasons = new Set<string>();
  if (options.executor !== undefined) ineligibilityReasons.add("custom_executor");
  let baselineSuccesses = 0;
  let withSkillSuccesses = 0;
  let total = 0;
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    const scenario = scenarios[scenarioIndex] as Scenario;
    const runs: RepetitionEvidence[] = [];
    for (let repetition = 1; repetition <= config.evaluation.repetitions; repetition += 1) {
      const baseline = await runLeg(
        context,
        scenario,
        scenarioIndex,
        repetition,
        "baseline",
        options,
        config,
        inputs,
        registeredSecrets,
      );
      const withSkill = await runLeg(
        context,
        scenario,
        scenarioIndex,
        repetition,
        "with-skill",
        options,
        config,
        inputs,
        registeredSecrets,
      );
      for (const leg of [baseline, withSkill]) {
        for (const reason of leg.invocation.ineligibilityReasons) ineligibilityReasons.add(reason);
        if (leg.evidence.status !== "passed") {
          ineligibilityReasons.add(`adapter_${leg.evidence.status}`);
        }
        if (leg.execution.cleanupAttempted && !leg.execution.cleanupOk) {
          ineligibilityReasons.add("container_cleanup_failed");
        }
      }
      if (baseline.evidence.successful) baselineSuccesses += 1;
      if (withSkill.evidence.successful) withSkillSuccesses += 1;
      total += 1;
      runs.push({ repetition, baseline: baseline.evidence, withSkill: withSkill.evidence });
    }
    scenarioResults.push({
      id: scenario.id,
      expectedActivation: scenario.shouldActivate,
      runs: runs as [RepetitionEvidence, ...RepetitionEvidence[]],
    });
  }
  const baselineSuccessRate = rate(baselineSuccesses, total);
  const withSkillSuccessRate = rate(withSkillSuccesses, total);
  const impactDelta =
    Math.round((withSkillSuccessRate - baselineSuccessRate) * 1_000_000) / 1_000_000;
  const behavioralGatePassed =
    withSkillSuccessRate >= config.evaluation.minimumSuccessRate &&
    impactDelta >= config.evaluation.minimumImpactDelta;
  if (!behavioralGatePassed) ineligibilityReasons.add("behavioral_gate_failed");
  const evidence: SkillPressPairedEvaluationEvidence = {
    schemaVersion: 1,
    evidenceType: "skillpress.paired-eval",
    runId,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    project: { name: config.project.name, version: config.project.version },
    suite: suiteName,
    model: options.model,
    adapter: {
      backend: config.evaluation.sandbox,
      image: options.image,
      commandSha256: digest(canonicalJson(options.command)),
    },
    skillSha256: staged.sha256,
    configSha256: digest(canonicalJson(config)),
    repetitions: config.evaluation.repetitions,
    scenarioResults: scenarioResults as [ScenarioEvidence, ...ScenarioEvidence[]],
    summary: {
      baselineSuccessRate,
      withSkillSuccessRate,
      impactDelta,
      minimumSuccessRate: config.evaluation.minimumSuccessRate,
      minimumImpactDelta: config.evaluation.minimumImpactDelta,
      behavioralGatePassed,
    },
    evidenceEligible: ineligibilityReasons.size === 0,
    ineligibilityReasons: [...ineligibilityReasons].sort(),
    storagePath: `.skill-press/runs/${runId}`,
  };
  if (!validateEvidence(evidence)) {
    throw new EvaluationRunError("Paired evaluation evidence violated its schema.", [
      issue("eval.run.evidence_schema", "/evidence", "internal evidence validation failed"),
    ]);
  }
  await writeFile(join(runRoot, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  return deepFreeze(evidence);
}
