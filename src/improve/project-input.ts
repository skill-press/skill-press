import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { Ajv, type ValidateFunction } from "ajv";

import { loadProjectConfig } from "../config/load.js";
import { digestBoundedTree } from "../evidence/tree-digest.js";
import type { SkillPressPairedEvaluationEvidence } from "../eval/generated-evidence.js";
import type { SkillPressEvaluationSuite } from "../eval/generated-suite.js";
import { loadProjectEvaluationInputs } from "../eval/load.js";
import { validateAgentSkill } from "../validate/agent-skill.js";
import type { Metrics } from "./generated-report.js";
import type { ImprovementCandidateFile, ImprovementInitialState } from "./state-machine.js";
import { ImprovementWorkflowError, improvementWorkflowIssue as issue } from "./workflow-error.js";

export interface ImprovementEvidencePaths {
  readonly trainingEvidencePath: string;
  readonly holdoutEvidencePath: string;
}

export interface ImprovementProjectInputs {
  readonly initial: ImprovementInitialState;
  readonly trainingSuite: SkillPressEvaluationSuite;
  readonly holdoutSuite: SkillPressEvaluationSuite;
  readonly candidateFiles: readonly ImprovementCandidateFile[];
  readonly evaluationBinding: ImprovementEvaluationBinding;
}

export interface ImprovementEvaluationBinding {
  readonly project: { readonly name: string; readonly version: string };
  readonly model: string;
  readonly adapter: SkillPressPairedEvaluationEvidence["adapter"];
  readonly configSha256: string;
  readonly repetitions: number;
  readonly readinessMinimum: number;
  readonly minimumSuccessRate: number;
  readonly minimumImpactDelta: number;
}

const EVIDENCE_PATH = /^\.skill-press\/runs\/([a-f0-9]{64})\/evidence[.]json$/u;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_FILES = 64;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const evidenceSchema = JSON.parse(
  await readFile(new URL("../../schemas/eval-evidence.schema.json", import.meta.url), "utf8"),
) as object;
const validateEvidence = new Ajv({ allErrors: true, strict: true }).compile(
  evidenceSchema,
) as ValidateFunction<SkillPressPairedEvaluationEvidence>;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function sameMetadata(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function loadEvidence(
  root: string,
  path: string,
  suite: "training" | "holdout",
): Promise<SkillPressPairedEvaluationEvidence> {
  const match = EVIDENCE_PATH.exec(path);
  if (match === null) {
    throw new ImprovementWorkflowError("Paired evaluation evidence path is invalid.", [
      issue(
        "improve.evidence.path",
        `/${suite}EvidencePath`,
        "evidence must use .skill-press/runs/<run-id>/evidence.json",
      ),
    ]);
  }
  for (const parent of [
    join(root, ".skill-press"),
    join(root, ".skill-press", "runs"),
    join(root, ".skill-press", "runs", match[1] as string),
  ]) {
    const metadata = await lstat(parent);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      throw new ImprovementWorkflowError("Paired evaluation storage is unsafe.", [
        issue(
          "improve.evidence.storage",
          `/${suite}EvidencePath`,
          "evidence parents must be private real directories",
        ),
      ]);
    }
  }
  const absolute = join(root, path);
  const before = await lstat(absolute);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > MAX_EVIDENCE_BYTES ||
    (process.platform !== "win32" && (before.mode & 0o077) !== 0)
  ) {
    throw new ImprovementWorkflowError("Paired evaluation evidence is unsafe.", [
      issue(
        "improve.evidence.file",
        `/${suite}EvidencePath`,
        "evidence must be a bounded private regular file",
      ),
    ]);
  }
  const bytes = await readFile(absolute);
  const after = await lstat(absolute);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    parsed = undefined;
  }
  if (!sameMetadata(before, after) || !validateEvidence(parsed) || parsed.suite !== suite) {
    throw new ImprovementWorkflowError("Paired evaluation evidence is invalid.", [
      issue(
        "improve.evidence.schema",
        `/${suite}EvidencePath`,
        "evidence must remain stable and match its suite and versioned schema",
      ),
    ]);
  }
  if (`${parsed.storagePath}/evidence.json` !== path) {
    throw new ImprovementWorkflowError("Paired evaluation storage binding is invalid.", [
      issue(
        "improve.evidence.binding",
        `/${suite}EvidencePath`,
        "evidence storagePath must match its private file",
      ),
    ]);
  }
  return parsed;
}

function suiteSha256(suite: SkillPressEvaluationSuite): string {
  return sha256(JSON.stringify(suite));
}

function rate(numerator: number, denominator: number): number {
  return Math.round((denominator === 0 ? 1 : numerator / denominator) * 1_000_000) / 1_000_000;
}

/** Recompute improvement metrics from individual with-skill legs, never supplied aggregates. */
export function improvementMetrics(evidence: SkillPressPairedEvaluationEvidence): Metrics {
  const runs = evidence.scenarioResults.flatMap((scenario) =>
    scenario.runs.map((run) => ({
      expectedActivation: scenario.expectedActivation,
      leg: run.withSkill,
    })),
  );
  const truePositives = runs.filter(
    (run) => run.expectedActivation && run.leg.activated === true,
  ).length;
  const falsePositives = runs.filter(
    (run) => !run.expectedActivation && run.leg.activated === true,
  ).length;
  const positiveRuns = runs.filter((run) => run.expectedActivation).length;
  const safetyRuns = runs.filter((run) => !run.expectedActivation);
  const safetySuccesses = safetyRuns.filter(
    (run) => run.leg.successful && run.leg.activated === false,
  ).length;
  const predictedActivations = truePositives + falsePositives;
  return {
    successRate: rate(runs.filter((run) => run.leg.successful).length, runs.length),
    activationPrecision:
      predictedActivations === 0
        ? positiveRuns === 0
          ? 1
          : 0
        : rate(truePositives, predictedActivations),
    safetyRate: rate(safetySuccesses, safetyRuns.length),
  };
}

function inputSha256(
  runId: string,
  variant: "baseline" | "with-skill",
  model: string,
  scenario: SkillPressEvaluationSuite["scenarios"][number],
  skillSha256: string,
): string {
  return sha256(
    `${JSON.stringify({
      schemaVersion: 1,
      runId,
      variant,
      model,
      prompt: scenario.prompt,
      fixture: scenario.fixture ?? null,
      skill:
        variant === "baseline"
          ? { available: false, sha256: null }
          : { available: true, sha256: skillSha256, path: "/skill" },
    })}\n`,
  );
}

function summaryMatches(
  evidence: SkillPressPairedEvaluationEvidence,
  binding: ImprovementEvaluationBinding,
): boolean {
  const runs = evidence.scenarioResults.flatMap((scenario) => scenario.runs);
  const baselineSuccessRate = rate(
    runs.filter((run) => run.baseline.successful).length,
    runs.length,
  );
  const withSkillSuccessRate = rate(
    runs.filter((run) => run.withSkill.successful).length,
    runs.length,
  );
  const impactDelta =
    Math.round((withSkillSuccessRate - baselineSuccessRate) * 1_000_000) / 1_000_000;
  const behavioralGatePassed =
    withSkillSuccessRate >= binding.minimumSuccessRate && impactDelta >= binding.minimumImpactDelta;
  return (
    evidence.summary.baselineSuccessRate === baselineSuccessRate &&
    evidence.summary.withSkillSuccessRate === withSkillSuccessRate &&
    evidence.summary.impactDelta === impactDelta &&
    evidence.summary.minimumSuccessRate === binding.minimumSuccessRate &&
    evidence.summary.minimumImpactDelta === binding.minimumImpactDelta &&
    evidence.summary.behavioralGatePassed === behavioralGatePassed &&
    (behavioralGatePassed
      ? evidence.evidenceEligible && evidence.ineligibilityReasons.length === 0
      : !evidence.evidenceEligible &&
        evidence.ineligibilityReasons.length === 1 &&
        evidence.ineligibilityReasons[0] === "behavioral_gate_failed")
  );
}

/** Verify complete paired evidence against its candidate, suite, adapter, and project binding. */
export function improvementEvidenceMetrics(
  value: unknown,
  suite: SkillPressEvaluationSuite,
  expectedSuite: "training" | "holdout",
  skillSha256: string,
  binding: ImprovementEvaluationBinding,
): Metrics | null {
  if (!validateEvidence(value)) return null;
  const evidence = value;
  const runIds = new Set<string>();
  const complete =
    evidence.suite === expectedSuite &&
    evidence.project.name === binding.project.name &&
    evidence.project.version === binding.project.version &&
    evidence.skillSha256 === skillSha256 &&
    evidence.configSha256 === binding.configSha256 &&
    evidence.model === binding.model &&
    JSON.stringify(evidence.adapter) === JSON.stringify(binding.adapter) &&
    evidence.repetitions === binding.repetitions &&
    evidence.scenarioResults.length === suite.scenarios.length &&
    evidence.scenarioResults.every((entry, index) => {
      const scenario = suite.scenarios[index];
      if (
        scenario === undefined ||
        entry.id !== scenario.id ||
        entry.expectedActivation !== scenario.shouldActivate ||
        entry.runs.length !== binding.repetitions
      ) {
        return false;
      }
      return entry.runs.every((run, repetitionIndex) => {
        const repetition = repetitionIndex + 1;
        const legs = [run.baseline, run.withSkill];
        if (
          run.repetition !== repetition ||
          legs.some((leg) => runIds.has(leg.runId)) ||
          run.baseline.status !== "passed" ||
          run.withSkill.status !== "passed" ||
          typeof run.baseline.activated !== "boolean" ||
          typeof run.withSkill.activated !== "boolean" ||
          run.baseline.loadedSkillSha256 !== null ||
          run.withSkill.loadedSkillSha256 !== skillSha256 ||
          run.baseline.inputSha256 !==
            inputSha256(run.baseline.runId, "baseline", binding.model, scenario, skillSha256) ||
          run.withSkill.inputSha256 !==
            inputSha256(run.withSkill.runId, "with-skill", binding.model, scenario, skillSha256) ||
          run.baseline.successful !==
            (run.baseline.rubricScore ?? -1) >= binding.readinessMinimum ||
          run.withSkill.successful !== (run.withSkill.rubricScore ?? -1) >= binding.readinessMinimum
        ) {
          return false;
        }
        for (const leg of legs) runIds.add(leg.runId);
        return true;
      });
    });
  return complete && summaryMatches(evidence, binding) ? improvementMetrics(evidence) : null;
}

/** Read the complete canonical candidate using the state-machine's candidate digest encoding. */
export async function candidateFilesFromDirectory(
  root: string,
  expectedName?: string,
): Promise<readonly ImprovementCandidateFile[]> {
  const validation = await validateAgentSkill(root, {
    ...(expectedName === undefined ? {} : { expectedName }),
  });
  if (!validation.ok) {
    throw new ImprovementWorkflowError(
      "Improvement candidate is not a valid Agent Skill.",
      validation.diagnostics
        .slice(0, 16)
        .map((diagnostic) =>
          issue(
            `improve.candidate.${diagnostic.code}`,
            diagnostic.file === "." ? "/candidate" : `/candidate/${diagnostic.file}`,
            diagnostic.message,
          ),
        ),
    );
  }
  const files: ImprovementCandidateFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const names = await readdir(directory);
    names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
      const path = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const absolute = join(directory, name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new ImprovementWorkflowError("Improvement candidate contains a symbolic link.", [
          issue("improve.candidate.symlink", "/candidate", "candidate cannot contain links"),
        ]);
      }
      if (metadata.isDirectory()) {
        await visit(absolute, path);
        continue;
      }
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES || files.length >= MAX_FILES) {
        throw new ImprovementWorkflowError("Improvement candidate exceeds its file limits.", [
          issue(
            "improve.candidate.limit",
            "/candidate",
            "candidate files must remain regular and within bounded limits",
          ),
        ]);
      }
      const bytes = await readFile(absolute);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new ImprovementWorkflowError("Improvement candidate exceeds its byte limit.", [
          issue("improve.candidate.limit", "/candidate", "candidate total bytes are too large"),
        ]);
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new ImprovementWorkflowError("Improvement candidate contains non-UTF-8 data.", [
          issue("improve.candidate.utf8", "/candidate", "candidate files must be strict UTF-8"),
        ]);
      }
      files.push({ path, content, executable: (metadata.mode & 0o111) !== 0 });
    }
  };
  await visit(root, "");
  files.sort((left, right) => (left.path < right.path ? -1 : 1));
  return freeze(files);
}

export function improvementCandidateSha256(files: readonly ImprovementCandidateFile[]): string {
  return sha256(
    JSON.stringify(
      files.map((file) => ({
        path: file.path,
        content: file.content,
        executable: file.executable === true,
      })),
    ),
  );
}

/** Resolve only a canonical skill root whose configured path and every parent are link-free. */
export async function exactCanonicalSkillRoot(root: string, skillPath: string): Promise<string> {
  const configured = join(root, skillPath);
  const resolved = await realpath(configured);
  if (resolved !== configured) {
    throw new ImprovementWorkflowError("Canonical skill storage is unsafe.", [
      issue(
        "improve.canonical.symlink",
        "/project/skill/path",
        "canonical skill storage cannot traverse symbolic links",
      ),
    ]);
  }
  return configured;
}

/** Build initial improvement state only from current, complete paired-eval evidence. */
export async function loadImprovementProjectInputs(
  projectDirectory: string,
  paths: ImprovementEvidencePaths,
): Promise<ImprovementProjectInputs> {
  const root = await realpath(projectDirectory);
  const config = await loadProjectConfig(root);
  const inputs = await loadProjectEvaluationInputs(root);
  const [training, holdout] = await Promise.all([
    loadEvidence(root, paths.trainingEvidencePath, "training"),
    loadEvidence(root, paths.holdoutEvidencePath, "holdout"),
  ]);
  const skillRoot = await exactCanonicalSkillRoot(root, config.skill.path);
  const [skillSha256, candidateFiles] = await Promise.all([
    digestBoundedTree(skillRoot),
    candidateFilesFromDirectory(skillRoot, config.skill.name),
  ]);
  const configSha256 = sha256(`${JSON.stringify(config)}\n`);
  const evaluationBinding: ImprovementEvaluationBinding = {
    project: { name: config.project.name, version: config.project.version },
    model: training.model,
    adapter: training.adapter,
    configSha256,
    repetitions: config.evaluation.repetitions,
    readinessMinimum: config.quality.readinessMinimum,
    minimumSuccessRate: config.evaluation.minimumSuccessRate,
    minimumImpactDelta: config.evaluation.minimumImpactDelta,
  };
  const trainingMetrics = improvementEvidenceMetrics(
    training,
    inputs.training,
    "training",
    skillSha256,
    evaluationBinding,
  );
  const holdoutMetrics = improvementEvidenceMetrics(
    holdout,
    inputs.holdout,
    "holdout",
    skillSha256,
    evaluationBinding,
  );
  const evidencePairMatches =
    trainingMetrics !== null &&
    holdoutMetrics !== null &&
    training.model === holdout.model &&
    JSON.stringify(training.adapter) === JSON.stringify(holdout.adapter);
  if (!evidencePairMatches) {
    throw new ImprovementWorkflowError("Paired evaluation evidence is not current and complete.", [
      issue(
        "improve.evidence.current",
        "/evidence",
        "training and holdout evidence must bind the current complete project and same adapter",
      ),
    ]);
  }
  const failedTraining = training.scenarioResults.flatMap((scenario) =>
    scenario.runs.flatMap((run) =>
      run.withSkill.successful ? [] : [`${scenario.id}/${run.repetition}`],
    ),
  );
  const initial: ImprovementInitialState = {
    candidateSha256: improvementCandidateSha256(candidateFiles),
    trainingScenarioSetSha256: suiteSha256(inputs.training),
    holdoutScenarioSetSha256: suiteSha256(inputs.holdout),
    trainingMetrics: trainingMetrics as Metrics,
    holdoutMetrics: holdoutMetrics as Metrics,
    trainingScenarios: inputs.training.scenarios.map((scenario) => ({
      id: scenario.id,
      prompt: scenario.prompt,
      expectedBehavior: [...scenario.expectedBehavior],
      ...(scenario.forbiddenBehavior === undefined
        ? {}
        : { forbiddenBehavior: [...scenario.forbiddenBehavior] }),
    })),
    failureIds: failedTraining,
    feedback: [
      {
        source: "paired-eval",
        text: `${failedTraining.length} measured training run(s) did not satisfy the rubric.`,
      },
    ],
  };
  return freeze({
    initial,
    trainingSuite: inputs.training,
    holdoutSuite: inputs.holdout,
    candidateFiles,
    evaluationBinding,
  });
}
