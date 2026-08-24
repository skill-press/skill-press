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
}

const EVIDENCE_PATH = /^\.skillpress\/runs\/([a-f0-9]{64})\/evidence[.]json$/u;
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
        "evidence must use .skillpress/runs/<run-id>/evidence.json",
      ),
    ]);
  }
  for (const parent of [
    join(root, ".skillpress"),
    join(root, ".skillpress", "runs"),
    join(root, ".skillpress", "runs", match[1] as string),
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

function metrics(evidence: SkillPressPairedEvaluationEvidence): Metrics {
  const runs = evidence.scenarioResults.flatMap((scenario) =>
    scenario.runs.map((run) => ({
      expectedActivation: scenario.expectedActivation,
      leg: run.withSkill,
    })),
  );
  const activationCorrect = runs.filter(
    (run) => run.leg.activated === run.expectedActivation,
  ).length;
  const safetyRuns = runs.filter((run) => !run.expectedActivation);
  const safetySuccesses = safetyRuns.filter((run) => run.leg.successful).length;
  const rate = (numerator: number, denominator: number) =>
    Math.round((denominator === 0 ? 1 : numerator / denominator) * 1_000_000) / 1_000_000;
  return {
    successRate: evidence.summary.withSkillSuccessRate,
    activationPrecision: rate(activationCorrect, runs.length),
    safetyRate: rate(safetySuccesses, safetyRuns.length),
  };
}

function fullSuiteEvidence(
  evidence: SkillPressPairedEvaluationEvidence,
  suite: SkillPressEvaluationSuite,
): boolean {
  return (
    evidence.scenarioResults.map((entry) => entry.id).join("\0") ===
      suite.scenarios.map((entry) => entry.id).join("\0") &&
    evidence.scenarioResults.every((entry, index) => {
      const scenario = suite.scenarios[index];
      return scenario !== undefined && entry.expectedActivation === scenario.shouldActivate;
    })
  );
}

function acceptableInitialEvidence(evidence: SkillPressPairedEvaluationEvidence): boolean {
  return evidence.evidenceEligible
    ? evidence.ineligibilityReasons.length === 0 && evidence.summary.behavioralGatePassed
    : !evidence.summary.behavioralGatePassed &&
        evidence.ineligibilityReasons.length === 1 &&
        evidence.ineligibilityReasons[0] === "behavioral_gate_failed";
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
  const skillRoot = await realpath(join(root, config.skill.path));
  const [skillSha256, candidateFiles] = await Promise.all([
    digestBoundedTree(skillRoot),
    candidateFilesFromDirectory(skillRoot, config.skill.name),
  ]);
  const configSha256 = sha256(`${JSON.stringify(config)}\n`);
  const evidencePairMatches =
    training.project.name === config.project.name &&
    training.project.version === config.project.version &&
    holdout.project.name === config.project.name &&
    holdout.project.version === config.project.version &&
    training.skillSha256 === skillSha256 &&
    holdout.skillSha256 === skillSha256 &&
    training.configSha256 === configSha256 &&
    holdout.configSha256 === configSha256 &&
    training.repetitions === config.evaluation.repetitions &&
    holdout.repetitions === config.evaluation.repetitions &&
    training.model === holdout.model &&
    JSON.stringify(training.adapter) === JSON.stringify(holdout.adapter) &&
    fullSuiteEvidence(training, inputs.training) &&
    fullSuiteEvidence(holdout, inputs.holdout) &&
    acceptableInitialEvidence(training) &&
    acceptableInitialEvidence(holdout);
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
    trainingMetrics: metrics(training),
    holdoutMetrics: metrics(holdout),
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
  });
}
