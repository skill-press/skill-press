import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { Ajv, type ValidateFunction } from "ajv";

import { checkProject } from "../check/project.js";
import { loadProjectConfig } from "../config/load.js";
import { digestBoundedTree } from "../evidence/tree-digest.js";
import { runCapturedCommand } from "../process/capture.js";
import { runProjectTests } from "../test/project.js";
import type { SkillPressImprovementAdapterRequest } from "./generated-adapter-request.js";
import type {
  Evaluation as AdapterEvaluation,
  Proposal as AdapterProposal,
  Review as AdapterReview,
  SkillPressImprovementAdapterResponse,
} from "./generated-adapter-response.js";
import type { SkillPressImprovementReport } from "./generated-report.js";
import {
  candidateFilesFromDirectory,
  exactCanonicalSkillRoot,
  improvementEvidenceMetrics,
  improvementCandidateSha256,
  loadImprovementProjectInputs,
  type ImprovementEvidencePaths,
} from "./project-input.js";
import {
  runBoundedImprovement,
  type ImprovementAuthorContext,
  type ImprovementCandidateFile,
  type ImprovementProposal,
  type ImprovementReview,
} from "./state-machine.js";
import { ImprovementWorkflowError, improvementWorkflowIssue as issue } from "./workflow-error.js";

export type ImprovementAdapterOperation =
  | "author"
  | "review"
  | "evaluate-training"
  | "evaluate-holdout";

export interface ImprovementRoleCommand {
  readonly argv: readonly [string, ...string[]];
  readonly env?: Readonly<Record<string, string>>;
}

export interface CommandImprovementOptions extends ImprovementEvidencePaths {
  readonly author: ImprovementRoleCommand;
  readonly reviewer: ImprovementRoleCommand;
  readonly evaluator: ImprovementRoleCommand;
  readonly commandTimeoutSeconds?: number;
}

export interface CommandImprovementResult {
  readonly schemaVersion: 1;
  readonly resultType: "skillpress.improve-command";
  readonly changed: boolean;
  readonly storagePath: string;
  readonly report: SkillPressImprovementReport;
}

interface PreparedCandidate {
  readonly root: string;
  readonly sha256: string;
  readonly skillSha256: string;
  readonly files: readonly ImprovementCandidateFile[];
}

const responseSchema = JSON.parse(
  await readFile(
    new URL("../../schemas/improve-adapter-response.schema.json", import.meta.url),
    "utf8",
  ),
) as object;
const requestSchema = JSON.parse(
  await readFile(
    new URL("../../schemas/improve-adapter-request.schema.json", import.meta.url),
    "utf8",
  ),
) as object;
const evidenceSchema = JSON.parse(
  await readFile(new URL("../../schemas/eval-evidence.schema.json", import.meta.url), "utf8"),
) as object;
const ajv = new Ajv({ allErrors: true, strict: true, schemas: [evidenceSchema] });
const validateResponse = ajv.compile<SkillPressImprovementAdapterResponse>(
  responseSchema,
) as ValidateFunction<SkillPressImprovementAdapterResponse>;
const validateRequest = ajv.compile<SkillPressImprovementAdapterRequest>(
  requestSchema,
) as ValidateFunction<SkillPressImprovementAdapterRequest>;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const CANDIDATE_PATH = /^(?:SKILL[.]md|LICENSE|(?:assets|references|scripts)\/[A-Za-z0-9._/-]+)$/u;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

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

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new ImprovementWorkflowError("Improvement storage is unsafe.", [
      issue("improve.storage.unsafe", "/storage", "storage must use private real directories"),
    ]);
  }
  await chmod(path, 0o700);
}

function snapshotCommand(command: ImprovementRoleCommand, label: string): ImprovementRoleCommand {
  if (
    !Array.isArray(command.argv) ||
    command.argv.length < 1 ||
    command.argv.length > 32 ||
    command.argv.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 4096 ||
        entry.includes("\0"),
    )
  ) {
    throw new ImprovementWorkflowError("Improvement role command is invalid.", [
      issue("improve.command.argv", `/${label}`, "command argv must be explicit and bounded"),
    ]);
  }
  const environment: Record<string, string> = {};
  let environmentBytes = 0;
  for (const [name, value] of Object.entries(command.env ?? {})) {
    environmentBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (!ENVIRONMENT_NAME.test(name) || value.includes("\0") || environmentBytes > 64 * 1024) {
      throw new ImprovementWorkflowError("Improvement role environment is invalid.", [
        issue(
          "improve.command.environment",
          `/${label}`,
          "explicit environment names and values must remain bounded",
        ),
      ]);
    }
    environment[name] = value;
  }
  return freeze({
    argv: [...command.argv] as [string, ...string[]],
    ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
  });
}

function responseResult(
  value: SkillPressImprovementAdapterResponse,
  operation: ImprovementAdapterOperation,
  requestId: string,
): AdapterProposal | AdapterReview | AdapterEvaluation {
  if (value.operation !== operation || value.requestId !== requestId) {
    throw new ImprovementWorkflowError("Improvement adapter response operation changed.", [
      issue(
        "improve.adapter.operation",
        "/response/operation",
        "response requestId and operation must match its request",
      ),
    ]);
  }
  const result = value.result;
  if (operation === "author" && "baseCandidateSha256" in result) return result;
  if (operation === "review" && "approved" in result) return result;
  if (
    (operation === "evaluate-training" || operation === "evaluate-holdout") &&
    "evidence" in result
  ) {
    return result;
  }
  throw new ImprovementWorkflowError("Improvement adapter response type is invalid.", [
    issue(
      "improve.adapter.result",
      "/response/result",
      "response result must match its requested role",
    ),
  ]);
}

async function stableResponse(path: string): Promise<SkillPressImprovementAdapterResponse> {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > MAX_RESPONSE_BYTES ||
    (process.platform !== "win32" && (before.mode & 0o077) !== 0)
  ) {
    throw new ImprovementWorkflowError("Improvement adapter response is unsafe.", [
      issue(
        "improve.adapter.response_file",
        "/response",
        "response must be a bounded private regular file",
      ),
    ]);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new ImprovementWorkflowError("Improvement adapter response changed while read.", [
      issue("improve.adapter.response_changed", "/response", "response must remain stable"),
    ]);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    value = undefined;
  }
  if (!validateResponse(value)) {
    throw new ImprovementWorkflowError("Improvement adapter response is invalid.", [
      issue(
        "improve.adapter.response_schema",
        "/response",
        "response must satisfy the versioned adapter schema",
      ),
    ]);
  }
  return value;
}

function proposalKey(proposal: ImprovementProposal): string {
  return sha256(JSON.stringify(proposal));
}

async function writeCandidate(
  root: string,
  skillName: string,
  proposal: ImprovementProposal,
): Promise<PreparedCandidate> {
  const key = proposalKey(proposal);
  const candidateParent = join(root, "candidates", key);
  const candidateRoot = join(candidateParent, skillName);
  await rm(candidateParent, { recursive: true, force: true });
  await mkdir(candidateRoot, { recursive: true, mode: 0o700 });
  await chmod(candidateRoot, 0o700);
  for (const file of proposal.files) {
    if (
      !CANDIDATE_PATH.test(file.path) ||
      file.path.includes("//") ||
      file.path.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new ImprovementWorkflowError("Improvement proposal path is unsafe.", [
        issue("improve.candidate.path", "/proposal/files", "candidate paths must be canonical"),
      ]);
    }
    const destination = join(candidateRoot, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.content, {
      flag: "wx",
      mode: file.executable === true ? 0o700 : 0o600,
    });
    await chmod(destination, file.executable === true ? 0o700 : 0o600);
  }
  const files = await candidateFilesFromDirectory(candidateRoot, skillName);
  return freeze({
    root: candidateRoot,
    sha256: improvementCandidateSha256(files),
    skillSha256: await digestBoundedTree(candidateRoot),
    files,
  });
}

async function deterministicCandidate(
  root: string,
  canonicalSkillPath: string,
  candidate: PreparedCandidate,
  backupsRoot: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || (await digestBoundedTree(candidate.root)) !== candidate.skillSha256) {
    return false;
  }
  const canonical = await exactCanonicalSkillRoot(root, canonicalSkillPath);
  const backup = join(backupsRoot, `deterministic-${randomBytes(32).toString("hex")}`);
  await rename(canonical, backup);
  let installed = false;
  let recovered = false;
  let canonicalRestored = false;
  let candidatePassed = false;
  let candidateFailed = false;
  let candidateFailure: unknown;
  try {
    await rename(candidate.root, canonical);
    installed = true;
    const readiness = await checkProject(root);
    const tests = await runProjectTests(root, { signal });
    candidatePassed =
      !signal.aborted &&
      readiness.ok &&
      tests.ok &&
      (await digestBoundedTree(canonical)) === candidate.skillSha256;
  } catch (error) {
    candidateFailed = true;
    candidateFailure = error;
  }
  if (installed) {
    try {
      await rename(canonical, candidate.root);
      recovered = true;
    } catch {
      recovered = false;
    }
  }
  try {
    await rename(backup, canonical);
    canonicalRestored = true;
  } catch {
    canonicalRestored = false;
  }
  if (!canonicalRestored || (installed && !recovered)) {
    throw new ImprovementWorkflowError("Prepared candidate could not be restored.", [
      issue(
        "improve.deterministic.restore",
        "/candidate",
        "candidate verification must restore the canonical project transaction",
      ),
    ]);
  }
  if (candidateFailed) throw candidateFailure;
  return candidatePassed;
}

async function setCanonicalModes(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await setCanonicalModes(path);
      await chmod(path, 0o755);
    } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
      await chmod(path, (metadata.mode & 0o111) !== 0 ? 0o755 : 0o644);
    } else {
      throw new ImprovementWorkflowError("Prepared candidate changed before acceptance.", [
        issue("improve.accept.candidate", "/candidate", "candidate must remain a regular tree"),
      ]);
    }
  }
  await chmod(root, 0o755);
}

async function gitClean(root: string, paths: readonly string[]): Promise<boolean> {
  const result = await runCapturedCommand({
    argv: ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths],
    cwd: root,
    timeoutSeconds: 30,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  return result.status === "passed" && result.stdout.byteLength === 0;
}

/** Run the bounded state machine through explicit author, reviewer, and evaluator commands. */
export async function runCommandImprovement(
  projectDirectory: string,
  options: CommandImprovementOptions,
): Promise<CommandImprovementResult> {
  const root = await realpath(resolve(projectDirectory));
  const config = await loadProjectConfig(root);
  const author = snapshotCommand(options.author, "author");
  const reviewer = snapshotCommand(options.reviewer, "reviewer");
  const evaluator = snapshotCommand(options.evaluator, "evaluator");
  const timeoutSeconds = options.commandTimeoutSeconds ?? 900;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7200) {
    throw new ImprovementWorkflowError("Improvement command timeout is invalid.", [
      issue("improve.command.timeout", "/commandTimeoutSeconds", "timeout must be from 1 to 7200"),
    ]);
  }
  if (!(await gitClean(root, ["skill-press.yaml", config.skill.path, "evals"]))) {
    throw new ImprovementWorkflowError("Improvement inputs must start clean.", [
      issue(
        "improve.git.dirty",
        "/project",
        "configuration, canonical skill, and evaluation inputs must be clean",
      ),
    ]);
  }
  const inputs = await loadImprovementProjectInputs(root, options);
  const initialConfigSha256 = sha256(await readFile(join(root, "skill-press.yaml")));
  const initialEvalsSha256 = await digestBoundedTree(join(root, "evals"));
  const privateRoot = join(root, ".skill-press");
  const improvementsRoot = join(privateRoot, "improvements");
  for (const path of [privateRoot, improvementsRoot]) await ensurePrivateDirectory(path);
  const runId = randomBytes(32).toString("hex");
  const runRoot = join(improvementsRoot, runId);
  const candidatesRoot = join(runRoot, "candidates");
  const backupsRoot = join(runRoot, "backups");
  for (const path of [runRoot, candidatesRoot, backupsRoot]) {
    await ensurePrivateDirectory(path);
  }
  const prepared = new Map<string, PreparedCandidate>();
  let currentFiles = inputs.candidateFiles;
  let currentCandidateSha256 = inputs.initial.candidateSha256;

  const call = async (
    command: ImprovementRoleCommand,
    operation: ImprovementAdapterOperation,
    payload: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<AdapterProposal | AdapterReview | AdapterEvaluation> => {
    const requestId = randomBytes(32).toString("hex");
    const temporaryParent = await realpath(tmpdir());
    const callRoot = await mkdtemp(join(temporaryParent, "skill-press-improve-role-"));
    await chmod(callRoot, 0o700);
    const requestPath = join(callRoot, "request.json");
    const responsePath = join(callRoot, "response.json");
    const request: SkillPressImprovementAdapterRequest = {
      schemaVersion: 1,
      requestType: "skillpress.improve-adapter-request",
      requestId,
      operation,
      payload,
    };
    if (!validateRequest(request)) {
      throw new ImprovementWorkflowError("Internal improvement adapter request is invalid.", [
        issue("improve.adapter.request_schema", "/request", "request violated its schema"),
      ]);
    }
    try {
      await writeFile(requestPath, `${JSON.stringify(request)}\n`, { flag: "wx", mode: 0o600 });
      await writeFile(responsePath, "", { flag: "wx", mode: 0o600 });
      await chmod(requestPath, 0o600);
      await chmod(responsePath, 0o600);
      const result = await runCapturedCommand({
        argv: [
          ...command.argv,
          "--skill-press-operation",
          operation,
          "--request",
          requestPath,
          "--response",
          responsePath,
        ],
        cwd: callRoot,
        timeoutSeconds,
        maxOutputBytes: 1024 * 1024,
        ...(command.env === undefined ? {} : { env: command.env }),
        signal,
      });
      if (result.status !== "passed" || result.exitCode !== 0 || result.signal !== null) {
        throw new ImprovementWorkflowError("Improvement role adapter failed.", [
          issue(
            "improve.adapter.command",
            `/${operation}`,
            "adapter must exit successfully within output and time limits",
          ),
        ]);
      }
      return responseResult(await stableResponse(responsePath), operation, requestId);
    } finally {
      await rm(callRoot, { recursive: true, force: true });
    }
  };

  const report = await runBoundedImprovement({
    budgets: config.improve,
    minimumSuccessRate: config.evaluation.minimumSuccessRate,
    initial: inputs.initial,
    callbacks: {
      author: async (context: ImprovementAuthorContext, signal) =>
        (await call(
          author,
          "author",
          { context, candidateFiles: currentFiles },
          signal,
        )) as ImprovementProposal,
      review: async (proposal, signal) =>
        (await call(reviewer, "review", { proposal }, signal)) as ImprovementReview,
      deterministic: async (proposal, signal) => {
        let candidate: PreparedCandidate;
        try {
          candidate = await writeCandidate(runRoot, config.skill.name, proposal);
        } catch {
          return { passed: false };
        }
        prepared.set(proposalKey(proposal), candidate);
        return {
          passed: await deterministicCandidate(
            root,
            config.skill.path,
            candidate,
            backupsRoot,
            signal,
          ),
        };
      },
      evaluateTraining: async (proposal, signal) => {
        const candidate = prepared.get(proposalKey(proposal));
        if (candidate === undefined) throw new Error("candidate was not prepared");
        const result = (await call(
          evaluator,
          "evaluate-training",
          {
            proposal,
            candidateSha256: candidate.sha256,
            skillSha256: candidate.skillSha256,
            scenarioSetSha256: inputs.initial.trainingScenarioSetSha256,
            suite: inputs.trainingSuite,
            binding: inputs.evaluationBinding,
          },
          signal,
        )) as AdapterEvaluation;
        const metrics = improvementEvidenceMetrics(
          result.evidence,
          inputs.trainingSuite,
          "training",
          candidate.skillSha256,
          inputs.evaluationBinding,
        );
        if (
          result.candidateSha256 !== candidate.sha256 ||
          result.scenarioSetSha256 !== inputs.initial.trainingScenarioSetSha256 ||
          metrics === null
        ) {
          throw new Error("training evidence did not bind the prepared candidate");
        }
        return { scenarioSetSha256: result.scenarioSetSha256, metrics };
      },
      evaluateHoldout: async (proposal, signal) => {
        const candidate = prepared.get(proposalKey(proposal));
        if (candidate === undefined) throw new Error("candidate was not prepared");
        const result = (await call(
          evaluator,
          "evaluate-holdout",
          {
            proposal,
            candidateSha256: candidate.sha256,
            skillSha256: candidate.skillSha256,
            scenarioSetSha256: inputs.initial.holdoutScenarioSetSha256,
            suite: inputs.holdoutSuite,
            binding: inputs.evaluationBinding,
          },
          signal,
        )) as AdapterEvaluation;
        const metrics = improvementEvidenceMetrics(
          result.evidence,
          inputs.holdoutSuite,
          "holdout",
          candidate.skillSha256,
          inputs.evaluationBinding,
        );
        if (
          result.candidateSha256 !== candidate.sha256 ||
          result.scenarioSetSha256 !== inputs.initial.holdoutScenarioSetSha256 ||
          metrics === null
        ) {
          throw new Error("holdout evidence did not bind the prepared candidate");
        }
        return { scenarioSetSha256: result.scenarioSetSha256, metrics };
      },
      accept: async (proposal) => {
        const candidate = prepared.get(proposalKey(proposal));
        if (candidate === undefined) throw new Error("candidate was not prepared");
        const skillRoot = await exactCanonicalSkillRoot(root, config.skill.path);
        const liveFiles = await candidateFilesFromDirectory(skillRoot, config.skill.name);
        if (
          improvementCandidateSha256(liveFiles) !== currentCandidateSha256 ||
          sha256(await readFile(join(root, "skill-press.yaml"))) !== initialConfigSha256 ||
          (await digestBoundedTree(join(root, "evals"))) !== initialEvalsSha256
        ) {
          throw new Error("project changed during improvement");
        }
        await setCanonicalModes(candidate.root);
        const backup = join(backupsRoot, randomBytes(32).toString("hex"));
        const failedCandidate = join(runRoot, `failed-${randomBytes(16).toString("hex")}`);
        await rename(skillRoot, backup);
        try {
          await rename(candidate.root, join(dirname(skillRoot), basename(skillRoot)));
          const acceptedRoot = await exactCanonicalSkillRoot(root, config.skill.path);
          const acceptedFiles = await candidateFilesFromDirectory(acceptedRoot, config.skill.name);
          if (improvementCandidateSha256(acceptedFiles) !== candidate.sha256) {
            throw new Error("accepted candidate digest changed");
          }
          currentFiles = acceptedFiles;
          currentCandidateSha256 = candidate.sha256;
        } catch (error) {
          try {
            await rename(join(dirname(skillRoot), basename(skillRoot)), failedCandidate);
          } catch {
            // The candidate may not have reached the canonical path.
          }
          try {
            await rename(backup, skillRoot);
          } catch {
            throw new ImprovementWorkflowError("Accepted candidate could not be rolled back.", [
              issue(
                "improve.accept.restore",
                "/candidate",
                "failed acceptance must restore the canonical project transaction",
              ),
            ]);
          }
          throw error;
        }
      },
    },
  });
  const storagePath = `.skill-press/improvements/${runId}/report.json`;
  await writeFile(join(root, storagePath), `${JSON.stringify(report)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await chmod(join(root, storagePath), 0o600);
  return freeze({
    schemaVersion: 1,
    resultType: "skillpress.improve-command",
    changed: report.finalCandidateSha256 !== report.initialCandidateSha256,
    storagePath,
    report,
  });
}
