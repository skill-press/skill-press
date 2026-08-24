import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, cp, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

import { Ajv, type ValidateFunction } from "ajv";

import { loadProjectConfig } from "../config/load.js";
import { digestBoundedTree } from "../evidence/tree-digest.js";
import {
  runCapturedCommand,
  type CapturedCommand,
  type CapturedCommandResult,
} from "../process/capture.js";
import { validateAgentSkill } from "../validate/agent-skill.js";
import { tesslCommandDigest } from "./command-digest.js";
import type { SkillPressTesslEvalEvidence } from "./generated-eval-evidence.js";
import type { SkillPressTesslReviewEvidence } from "./generated-review-evidence.js";
import { isTrustedTesslCli } from "./trusted-cli.js";

export interface TesslEvidenceIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class TesslEvidenceError extends Error {
  readonly issues: readonly TesslEvidenceIssue[];

  constructor(message: string, issues: readonly TesslEvidenceIssue[], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TesslEvidenceError";
    this.issues = Object.freeze([...issues]);
  }
}

export type TesslCommandExecutor = (command: CapturedCommand) => Promise<CapturedCommandResult>;

interface CommonOptions {
  readonly executable?: string;
  readonly timeoutSeconds?: number;
  /** Custom executors are for hermetic contract tests and always make evidence ineligible. */
  readonly executor?: TesslCommandExecutor;
  readonly now?: () => Date;
}

export interface TesslReviewOptions extends CommonOptions {
  readonly workspace?: string;
}

export interface TesslEvalOptions extends CommonOptions {
  readonly source: string;
  readonly agent?: string;
  readonly model?: string;
  readonly runs?: number;
  readonly pollIntervalMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly clock?: () => number;
}

interface CommonContext {
  readonly root: string;
  readonly configSha256: string;
  readonly skillPath: string;
  readonly skillName: string;
  readonly skillSha256: string;
  readonly projectName: string;
  readonly projectVersion: string;
  readonly projectDescription: string;
  readonly sourceCommit: string;
  readonly dirty: boolean;
  readonly executable: string;
  readonly executableSha256: string;
  readonly storage: string;
  readonly storagePath: string;
  readonly executor: TesslCommandExecutor;
  readonly customExecutor: boolean;
  readonly trustedCli: boolean;
  readonly cli: SkillPressTesslReviewEvidence["cli"];
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

const DIGEST = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_JSON_TEXT_BYTES = 4 * 1024 * 1024;
const reviewSchema = JSON.parse(
  await readFile(
    new URL("../../schemas/tessl-review-evidence.schema.json", import.meta.url),
    "utf8",
  ),
) as object;
const evalSchema = JSON.parse(
  await readFile(new URL("../../schemas/tessl-eval-evidence.schema.json", import.meta.url), "utf8"),
) as object;
const ajv = new Ajv({ allErrors: true, strict: true });
const validateReviewEvidence = ajv.compile<SkillPressTesslReviewEvidence>(
  reviewSchema,
) as ValidateFunction<SkillPressTesslReviewEvidence>;
const validateEvalEvidence = ajv.compile<SkillPressTesslEvalEvidence>(
  evalSchema,
) as ValidateFunction<SkillPressTesslEvalEvidence>;

function issue(code: string, path: string, message: string): TesslEvidenceIssue {
  return Object.freeze({ code, path, message });
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedIdentifier(value: string, maximum: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
    })
  );
}

function ensureInside(root: string, target: string, label: string): string {
  const path = relative(root, target);
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(path)
  ) {
    throw new TesslEvidenceError("Tessl evidence path is outside the project.", [
      issue("tessl.path.outside", label, "path must resolve to a project subdirectory"),
    ]);
  }
  return path.split(process.platform === "win32" ? "\\" : "/").join("/");
}

async function resolveExecutablePath(root: string, input: string): Promise<string> {
  const candidates =
    input.includes("/") || input.includes("\\")
      ? [resolve(root, input)]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .filter((entry) => entry.length > 0)
          .map((entry) => join(entry, input));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const canonical = await realpath(candidate);
      const metadata = await lstat(canonical);
      if (
        metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        metadata.size <= MAX_EXECUTABLE_BYTES
      ) {
        return canonical;
      }
    } catch {
      // Try the next explicit PATH entry.
    }
  }
  throw new TesslEvidenceError("The Tessl CLI executable is unavailable.", [
    issue("tessl.cli.missing", "/executable", "install Tessl or provide an executable path"),
  ]);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function providerEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(process.env.TESSL_TOKEN === undefined ? {} : { TESSL_TOKEN: process.env.TESSL_TOKEN }),
  });
}

function validateCaptured(result: CapturedCommandResult): void {
  if (
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr) ||
    result.stdoutBytes < result.stdout.byteLength ||
    result.stderrBytes < result.stderr.byteLength ||
    (result.status === "passed" && (result.exitCode !== 0 || result.signal !== null)) ||
    result.stdoutSha256 !== digest(result.stdout) ||
    result.stderrSha256 !== digest(result.stderr)
  ) {
    throw new TesslEvidenceError("Tessl command executor returned invalid evidence.", [
      issue("tessl.executor.invalid", "/executor", "executor output binding is invalid"),
    ]);
  }
}

async function execute(
  context: Pick<CommonContext, "root" | "executor">,
  argv: readonly [string, ...string[]],
  timeoutSeconds: number,
): Promise<CapturedCommandResult> {
  const result = await context.executor({
    argv,
    cwd: context.root,
    timeoutSeconds,
    maxOutputBytes: MAX_JSON_TEXT_BYTES,
    env: providerEnvironment(),
  });
  validateCaptured(result);
  return result;
}

function resultText(result: CapturedCommandResult): string {
  return `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`;
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function parseObjectOutput(result: CapturedCommandResult, path: string): JsonRecord {
  const json = extractJsonObject(result.stdout.toString("utf8"));
  if (json === undefined) {
    throw new TesslEvidenceError("Tessl did not return a complete JSON object.", [
      issue("tessl.output.json", path, "official CLI JSON output is missing or incomplete"),
    ]);
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new TesslEvidenceError(
      "Tessl returned malformed JSON.",
      [issue("tessl.output.json", path, "official CLI JSON output cannot be parsed")],
      error,
    );
  }
  if (!isRecord(value)) {
    throw new TesslEvidenceError("Tessl returned an unexpected JSON value.", [
      issue("tessl.output.shape", path, "official CLI output must contain an object"),
    ]);
  }
  return value;
}

async function writeRaw(
  storage: string,
  name: string,
  result: CapturedCommandResult,
): Promise<void> {
  const stdoutPath = join(storage, `${name}.stdout`);
  const stderrPath = join(storage, `${name}.stderr`);
  await writeFile(stdoutPath, result.stdout, { mode: 0o600, flag: "wx" });
  await writeFile(stderrPath, result.stderr, { mode: 0o600, flag: "wx" });
  await chmod(stdoutPath, 0o600);
  await chmod(stderrPath, 0o600);
}

function invocation(
  argv: readonly string[],
  result: CapturedCommandResult,
  executableSha256: string,
): SkillPressTesslReviewEvidence["lint"] {
  return {
    passed: result.status === "passed",
    commandSha256: tesslCommandDigest(executableSha256, argv.slice(1)),
    exitCode: 0,
    signal: null,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutSha256: result.stdoutSha256,
    stderrSha256: result.stderrSha256,
  };
}

async function gitState(
  root: string,
  paths: readonly string[],
): Promise<{ readonly commit: string; readonly dirty: boolean }> {
  const commitResult = await runCapturedCommand({
    argv: ["git", "rev-parse", "--verify", "HEAD"],
    cwd: root,
    timeoutSeconds: 30,
  });
  const commit = commitResult.stdout.toString("utf8").trim();
  if (commitResult.status !== "passed" || !COMMIT.test(commit)) {
    throw new TesslEvidenceError("Tessl evidence requires a committed Git source.", [
      issue("tessl.git.commit", "/project", "project must have a valid Git HEAD commit"),
    ]);
  }
  const statusResult = await runCapturedCommand({
    argv: ["git", "status", "--porcelain=v1", "--untracked-files=all", "--", ...paths],
    cwd: root,
    timeoutSeconds: 30,
  });
  if (statusResult.status !== "passed") {
    throw new TesslEvidenceError("Tessl evidence could not inspect Git inputs.", [
      issue("tessl.git.status", "/project", "relevant Git status could not be read"),
    ]);
  }
  return { commit, dirty: statusResult.stdout.byteLength !== 0 };
}

async function createStorage(root: string): Promise<{ path: string; reportPath: string }> {
  const privateRoot = join(root, ".skillpress");
  const parent = join(privateRoot, "tessl");
  await mkdir(privateRoot, { mode: 0o700 }).catch((error: unknown) => {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
  });
  const privateRootMetadata = await lstat(privateRoot);
  if (!privateRootMetadata.isDirectory() || privateRootMetadata.isSymbolicLink()) {
    throw new TesslEvidenceError("SkillPress private storage is unsafe.", [
      issue("tessl.storage.unsafe", "/storage", ".skillpress must be a real directory"),
    ]);
  }
  await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
  });
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new TesslEvidenceError("Tessl evidence storage is unsafe.", [
      issue("tessl.storage.unsafe", "/storage", "storage must be a real directory"),
    ]);
  }
  await chmod(privateRoot, 0o700);
  await chmod(parent, 0o700);
  const id = randomBytes(32).toString("hex");
  const path = join(parent, id);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  return { path, reportPath: `.skillpress/tessl/${id}` };
}

function timeoutOf(options: CommonOptions): number {
  const timeout = options.timeoutSeconds ?? 2700;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 7200) {
    throw new TesslEvidenceError("Tessl timeout is invalid.", [
      issue("tessl.option.timeout", "/timeoutSeconds", "timeout must be 1 to 7200 seconds"),
    ]);
  }
  return timeout;
}

async function commonContext(
  projectDirectory: string,
  options: CommonOptions,
  extraGitPaths: readonly string[] = [],
): Promise<CommonContext> {
  const root = await realpath(resolve(projectDirectory));
  const config = await loadProjectConfig(root);
  const skillPath = ensureInside(root, await realpath(join(root, config.skill.path)), "/skill");
  const skillReport = await validateAgentSkill(join(root, skillPath), {
    expectedName: config.skill.name,
  });
  if (!skillReport.ok) {
    throw new TesslEvidenceError("Tessl evidence requires a valid canonical skill.", [
      issue("tessl.skill.invalid", "/skill", "canonical skill validation failed"),
    ]);
  }
  const configBytes = await readFile(join(root, "skillpress.yaml"));
  const skillSha256 = await digestBoundedTree(join(root, skillPath));
  const state = await gitState(root, ["skillpress.yaml", skillPath, ...extraGitPaths]);
  const executable = await resolveExecutablePath(root, options.executable ?? "tessl");
  const executableSha256 = await hashFile(executable);
  if (!DIGEST.test(executableSha256)) throw new TypeError("unreachable executable digest");
  const executor = options.executor ?? runCapturedCommand;
  const storage = await createStorage(root);
  const versionArgv = [executable, "--version"] as const;
  const versionResult = await execute({ root, executor }, versionArgv, 30);
  await writeRaw(storage.path, "version", versionResult);
  if (versionResult.status !== "passed") {
    throw new TesslEvidenceError("Tessl CLI version probe failed.", [
      issue("tessl.cli.version", "/cli", "official CLI did not report its version"),
    ]);
  }
  const version = resultText(versionResult)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => VERSION.test(line));
  if (version === undefined) {
    throw new TesslEvidenceError("Tessl CLI version is unrecognized.", [
      issue("tessl.cli.version", "/cli", "CLI version output is not a supported semantic version"),
    ]);
  }
  return {
    root,
    configSha256: digest(configBytes),
    skillPath,
    skillName: config.skill.name,
    skillSha256,
    projectName: config.project.name,
    projectVersion: config.project.version,
    projectDescription: config.project.description,
    sourceCommit: state.commit,
    dirty: state.dirty,
    executable,
    executableSha256,
    storage: storage.path,
    storagePath: storage.reportPath,
    executor,
    customExecutor: options.executor !== undefined,
    trustedCli: isTrustedTesslCli(version, executableSha256),
    cli: {
      version,
      executableSha256,
      commandSha256: tesslCommandDigest(executableSha256, versionArgv.slice(1)),
      exitCode: 0,
      signal: null,
      durationMs: versionResult.durationMs,
      stdoutBytes: versionResult.stdoutBytes,
      stderrBytes: versionResult.stderrBytes,
      stdoutSha256: versionResult.stdoutSha256,
      stderrSha256: versionResult.stderrSha256,
    },
  };
}

async function stageTesslLintPlugin(
  context: CommonContext,
): Promise<{ readonly manifestPath: string; readonly skillPath: string }> {
  const plugin = join(context.storage, "lint-plugin");
  const stagedSkill = join(plugin, "skills", context.skillName);
  await mkdir(join(plugin, ".tessl-plugin"), { recursive: true, mode: 0o700 });
  await cp(join(context.root, context.skillPath), stagedSkill, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
  });
  const manifest = {
    name: `skillpress-local/${context.projectName}`,
    version: context.projectVersion,
    description: context.projectDescription,
    private: true,
  };
  await writeFile(
    join(plugin, ".tessl-plugin", "plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  const stagedReport = await validateAgentSkill(stagedSkill, { expectedName: context.skillName });
  if (!stagedReport.ok || (await digestBoundedTree(stagedSkill)) !== context.skillSha256) {
    throw new TesslEvidenceError("Tessl lint staging changed the canonical skill.", [
      issue("tessl.lint.staging", "/lint", "staged skill must match the canonical skill digest"),
    ]);
  }
  return {
    manifestPath: relative(context.root, join(plugin, ".tessl-plugin", "plugin.json")),
    skillPath: relative(context.root, stagedSkill),
  };
}

async function postRunReasons(
  context: CommonContext,
  extraGitPaths: readonly string[] = [],
  expectedExtraDigest?: { readonly path: string; readonly sha256: string },
): Promise<Array<"custom_executor" | "dirty_inputs" | "source_changed" | "untrusted_cli">> {
  const reasons: Array<"custom_executor" | "dirty_inputs" | "source_changed" | "untrusted_cli"> =
    [];
  if (context.customExecutor) reasons.push("custom_executor");
  if (!context.trustedCli) reasons.push("untrusted_cli");
  const afterSkill = await digestBoundedTree(join(context.root, context.skillPath));
  const afterState = await gitState(context.root, [
    "skillpress.yaml",
    context.skillPath,
    ...extraGitPaths,
  ]);
  const extraChanged =
    expectedExtraDigest === undefined
      ? false
      : (await digestBoundedTree(expectedExtraDigest.path)) !== expectedExtraDigest.sha256;
  if (context.dirty || afterState.dirty) reasons.push("dirty_inputs");
  if (
    afterSkill !== context.skillSha256 ||
    afterState.commit !== context.sourceCommit ||
    extraChanged
  ) {
    reasons.push("source_changed");
  }
  return reasons;
}

async function assertCliUnchanged(context: CommonContext): Promise<void> {
  if ((await hashFile(context.executable)) !== context.executableSha256) {
    throw new TesslEvidenceError("The Tessl CLI changed during evidence capture.", [
      issue("tessl.cli.changed", "/cli", "CLI executable digest must remain stable for the run"),
    ]);
  }
}

async function persistEvidence(
  storage: string,
  evidence: SkillPressTesslReviewEvidence | SkillPressTesslEvalEvidence,
): Promise<void> {
  const path = join(storage, "evidence.json");
  await writeFile(path, `${JSON.stringify(evidence)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Capture Quality only by invoking Tessl's official lint and quality-review commands. */
export async function captureTesslReviewEvidence(
  projectDirectory: string,
  options: TesslReviewOptions = {},
): Promise<SkillPressTesslReviewEvidence> {
  if (options.workspace !== undefined && !boundedIdentifier(options.workspace, 200)) {
    throw new TesslEvidenceError("Tessl workspace is invalid.", [
      issue("tessl.option.workspace", "/workspace", "workspace must be a bounded identifier"),
    ]);
  }
  const timeout = timeoutOf(options);
  const context = await commonContext(projectDirectory, options);
  const lintSource = await stageTesslLintPlugin(context);
  const lintArgv = [context.executable, "skill", "lint", lintSource.manifestPath] as const;
  const lintResult = await execute(context, lintArgv, Math.min(timeout, 300));
  await writeRaw(context.storage, "lint", lintResult);
  if (lintResult.status !== "passed") {
    throw new TesslEvidenceError("Tessl skill lint failed.", [
      issue("tessl.lint.failed", "/lint", "official Tessl lint must pass before review"),
    ]);
  }
  if ((await digestBoundedTree(join(context.root, lintSource.skillPath))) !== context.skillSha256) {
    throw new TesslEvidenceError("Tessl lint modified its staged skill.", [
      issue("tessl.lint.mutated", "/lint", "official lint must not modify staged skill inputs"),
    ]);
  }
  await assertCliUnchanged(context);
  const reviewArgv = [
    context.executable,
    "review",
    "run",
    "quality",
    "--json",
    ...(options.workspace === undefined ? [] : ["--workspace", options.workspace]),
    "--threshold",
    "0",
    context.skillPath,
  ] as readonly [string, ...string[]];
  const reviewResult = await execute(context, reviewArgv, timeout);
  await writeRaw(context.storage, "review", reviewResult);
  if (reviewResult.status !== "passed") {
    throw new TesslEvidenceError("Tessl quality review failed.", [
      issue("tessl.review.failed", "/review", "official Tessl review did not complete"),
    ]);
  }
  const value = parseObjectOutput(reviewResult, "/review");
  const validation = value.validation;
  const review = value.review;
  if (!isRecord(validation) || typeof validation.overallPassed !== "boolean" || !isRecord(review)) {
    throw new TesslEvidenceError("Tessl quality review shape is invalid.", [
      issue("tessl.review.shape", "/review", "review and validation results are required"),
    ]);
  }
  const scoreValue = review.reviewScore;
  const qualityScore =
    scoreValue === null && validation.overallPassed === false
      ? 0
      : Number.isInteger(scoreValue) && Number(scoreValue) >= 0 && Number(scoreValue) <= 100
        ? Number(scoreValue)
        : undefined;
  if (qualityScore === undefined) {
    throw new TesslEvidenceError("Tessl quality score is invalid.", [
      issue("tessl.review.score", "/review/qualityScore", "official review score is missing"),
    ]);
  }
  const runIdValue = value.reviewRunId;
  const runId =
    runIdValue === undefined || runIdValue === null
      ? null
      : typeof runIdValue === "string" && boundedIdentifier(runIdValue, 200)
        ? runIdValue
        : undefined;
  if (runId === undefined) {
    throw new TesslEvidenceError("Tessl review run id is invalid.", [
      issue("tessl.review.run_id", "/review/runId", "review run id is malformed"),
    ]);
  }
  const reasons = await postRunReasons(context);
  await assertCliUnchanged(context);
  const evidence: SkillPressTesslReviewEvidence = {
    schemaVersion: 1,
    evidenceType: "skillpress.tessl-review",
    provider: "tessl",
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    sourceCommit: context.sourceCommit,
    projectConfigSha256: context.configSha256,
    skillSha256: context.skillSha256,
    cli: context.cli,
    lint: invocation(lintArgv, lintResult, context.executableSha256),
    review: {
      ...invocation(reviewArgv, reviewResult, context.executableSha256),
      runId,
      workspace: options.workspace ?? null,
      qualityScore,
      validationPassed: validation.overallPassed,
    },
    storagePath: context.storagePath,
    evidenceEligible: reasons.length === 0,
    ineligibilityReasons: reasons,
  };
  if (!validateReviewEvidence(evidence)) {
    throw new TesslEvidenceError("Tessl review evidence violated its schema.", [
      issue("tessl.evidence.schema", "/evidence", "internal review evidence is invalid"),
    ]);
  }
  await persistEvidence(context.storage, evidence);
  return freeze(evidence);
}

function solutionScore(value: unknown): number | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.assessmentResults) ||
    value.assessmentResults.length === 0
  ) {
    return undefined;
  }
  let earned = 0;
  let maximum = 0;
  for (const criterion of value.assessmentResults) {
    if (
      !isRecord(criterion) ||
      !Number.isFinite(criterion.score) ||
      !Number.isFinite(criterion.max_score) ||
      Number(criterion.score) < 0 ||
      Number(criterion.max_score) <= 0 ||
      Number(criterion.score) > Number(criterion.max_score)
    ) {
      return undefined;
    }
    earned += Number(criterion.score);
    maximum += Number(criterion.max_score);
  }
  return Math.round((earned / maximum) * 100);
}

function parseCompletedEval(
  value: JsonRecord,
  expectedRunId: string,
): {
  readonly scenarios: SkillPressTesslEvalEvidence["scenarios"];
  readonly missingBaseline: boolean;
  readonly agent: string;
  readonly model: string;
} {
  const data = value.data;
  if (!isRecord(data) || data.id !== expectedRunId || !isRecord(data.attributes)) {
    throw new TesslEvidenceError("Tessl eval result binding is invalid.", [
      issue("tessl.eval.binding", "/result", "eval result must match the submitted run id"),
    ]);
  }
  if (data.attributes.status !== "completed" || !Array.isArray(data.attributes.scenarios)) {
    throw new TesslEvidenceError("Tessl eval did not complete successfully.", [
      issue("tessl.eval.status", "/result", "eval status must be completed"),
    ]);
  }
  const agent = data.attributes.agent;
  const model = data.attributes.model;
  if (
    typeof agent !== "string" ||
    !boundedIdentifier(agent, 100) ||
    typeof model !== "string" ||
    !boundedIdentifier(model, 200)
  ) {
    throw new TesslEvidenceError("Tessl eval result identity is invalid.", [
      issue("tessl.eval.identity", "/result", "completed eval must identify its agent and model"),
    ]);
  }
  if (data.attributes.scenarios.length < 1 || data.attributes.scenarios.length > 256) {
    throw new TesslEvidenceError("Tessl eval scenario count is invalid.", [
      issue("tessl.eval.scenarios", "/result/scenarios", "eval must contain 1 to 256 scenarios"),
    ]);
  }
  let missingBaseline = false;
  const fingerprints = new Set<string>();
  const scenarios = data.attributes.scenarios.map((scenario, index) => {
    if (
      !isRecord(scenario) ||
      typeof scenario.fingerprint !== "string" ||
      !boundedIdentifier(scenario.fingerprint, 10_000) ||
      !Array.isArray(scenario.solutions)
    ) {
      throw new TesslEvidenceError("Tessl eval scenario shape is invalid.", [
        issue("tessl.eval.scenario", `/result/scenarios/${index}`, "scenario result is malformed"),
      ]);
    }
    if (fingerprints.has(scenario.fingerprint)) {
      throw new TesslEvidenceError("Tessl eval scenario fingerprints are duplicated.", [
        issue(
          "tessl.eval.scenario_duplicate",
          `/result/scenarios/${index}`,
          "scenario fingerprints must be unique",
        ),
      ]);
    }
    fingerprints.add(scenario.fingerprint);
    const baselines = scenario.solutions.filter(
      (solution) => isRecord(solution) && solution.variant === "baseline",
    );
    const withContext = scenario.solutions.filter(
      (solution) => isRecord(solution) && solution.variant !== "baseline",
    );
    if (baselines.length > 1 || withContext.length !== 1) {
      throw new TesslEvidenceError("Tessl eval pairing is invalid.", [
        issue(
          "tessl.eval.pairing",
          `/result/scenarios/${index}`,
          "each scenario needs one context result",
        ),
      ]);
    }
    if (baselines.length === 0) missingBaseline = true;
    const baselineScore = baselines.length === 0 ? 0 : solutionScore(baselines[0]);
    const withContextScore = solutionScore(withContext[0]);
    if (baselineScore === undefined || withContextScore === undefined) {
      throw new TesslEvidenceError("Tessl eval scores are invalid.", [
        issue("tessl.eval.score", `/result/scenarios/${index}`, "assessment scores are malformed"),
      ]);
    }
    return {
      fingerprintSha256: digest(scenario.fingerprint),
      baselineScore,
      withContextScore,
      delta: withContextScore - baselineScore,
    };
  }) as SkillPressTesslEvalEvidence["scenarios"];
  return { scenarios, missingBaseline, agent, model };
}

/** Capture Impact only by submitting and polling an actual paired Tessl CLI eval run. */
export async function captureTesslEvalEvidence(
  projectDirectory: string,
  options: TesslEvalOptions,
): Promise<SkillPressTesslEvalEvidence> {
  const timeout = timeoutOf(options);
  const runs = options.runs ?? 1;
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  if (
    (options.agent !== undefined && !boundedIdentifier(options.agent, 100)) ||
    (options.model !== undefined && !boundedIdentifier(options.model, 200)) ||
    !Number.isSafeInteger(runs) ||
    runs < 1 ||
    runs > 10 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > 60_000
  ) {
    throw new TesslEvidenceError("Tessl eval options are invalid.", [
      issue(
        "tessl.option.eval",
        "/options",
        "agent/model selection, runs, or polling limit is invalid",
      ),
    ]);
  }
  const root = await realpath(resolve(projectDirectory));
  const source = await realpath(resolve(root, options.source));
  const sourcePath = ensureInside(root, source, "/source");
  const scenarioSourceSha256 = await digestBoundedTree(source);
  const context = await commonContext(projectDirectory, options, [sourcePath]);
  const startArgv = [
    context.executable,
    "eval",
    "run",
    "--json",
    ...(options.agent === undefined ? [] : ["--agent", options.agent]),
    ...(options.model === undefined ? [] : ["--model", options.model]),
    "--runs",
    String(runs),
    sourcePath,
  ] as const;
  const startResult = await execute(context, startArgv, Math.min(timeout, 300));
  await writeRaw(context.storage, "eval-start", startResult);
  if (startResult.status !== "passed") {
    throw new TesslEvidenceError("Tessl eval submission failed.", [
      issue("tessl.eval.start", "/start", "official Tessl eval run did not start"),
    ]);
  }
  const start = parseObjectOutput(startResult, "/start");
  const startAgent = start.agent;
  const startModel = start.model;
  if (
    typeof start.evalRunId !== "string" ||
    !boundedIdentifier(start.evalRunId, 200) ||
    (startAgent !== undefined &&
      (typeof startAgent !== "string" ||
        !boundedIdentifier(startAgent, 100) ||
        (options.agent !== undefined && startAgent !== options.agent))) ||
    (startModel !== undefined &&
      (typeof startModel !== "string" ||
        !boundedIdentifier(startModel, 200) ||
        (options.model !== undefined && startModel !== options.model))) ||
    !Number.isSafeInteger(start.scenariosCount) ||
    Number(start.scenariosCount) < 1 ||
    Number(start.scenariosCount) > 256
  ) {
    throw new TesslEvidenceError("Tessl eval submission binding is invalid.", [
      issue(
        "tessl.eval.start_shape",
        "/start",
        "run id, selected agent/model, and count must match provider output",
      ),
    ]);
  }
  const runId = start.evalRunId;
  const clock = options.clock ?? Date.now;
  const wait =
    options.wait ??
    ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const deadline = clock() + timeout * 1000;
  let finalResult: CapturedCommandResult | undefined;
  let finalValue: JsonRecord | undefined;
  while (clock() < deadline) {
    await wait(Math.min(pollIntervalMs, Math.max(1, deadline - clock())));
    const viewArgv = [context.executable, "eval", "view", "--json", runId] as const;
    const viewResult = await execute(context, viewArgv, Math.min(60, timeout));
    if (viewResult.status !== "passed") {
      throw new TesslEvidenceError("Tessl eval result query failed.", [
        issue("tessl.eval.view", "/result", "official Tessl eval view did not complete"),
      ]);
    }
    const view = parseObjectOutput(viewResult, "/result");
    const data = view.data;
    const status = isRecord(data) && isRecord(data.attributes) ? data.attributes.status : undefined;
    if (status === "completed") {
      finalResult = viewResult;
      finalValue = view;
      break;
    }
    if (status === "failed") {
      throw new TesslEvidenceError("Tessl eval run failed.", [
        issue("tessl.eval.status", "/result", "provider marked the eval run failed"),
      ]);
    }
    if (status !== "pending" && status !== "in_progress") {
      throw new TesslEvidenceError("Tessl eval status is invalid.", [
        issue("tessl.eval.status", "/result", "provider returned an unknown eval status"),
      ]);
    }
  }
  if (finalResult === undefined || finalValue === undefined) {
    throw new TesslEvidenceError("Tessl eval timed out.", [
      issue("tessl.eval.timeout", "/result", "provider eval did not finish before the deadline"),
    ]);
  }
  await writeRaw(context.storage, "eval-result", finalResult);
  const parsed = parseCompletedEval(finalValue, runId);
  if (
    (options.agent !== undefined && parsed.agent !== options.agent) ||
    (options.model !== undefined && parsed.model !== options.model) ||
    (startAgent !== undefined && parsed.agent !== startAgent) ||
    (startModel !== undefined && parsed.model !== startModel)
  ) {
    throw new TesslEvidenceError("Tessl eval resolved identity changed.", [
      issue(
        "tessl.eval.identity",
        "/result",
        "completed agent/model must match the request and any start identity",
      ),
    ]);
  }
  if (parsed.scenarios.length !== Number(start.scenariosCount)) {
    throw new TesslEvidenceError("Tessl eval scenario count changed.", [
      issue(
        "tessl.eval.count",
        "/result/scenarios",
        "completed scenario count differs from submission",
      ),
    ]);
  }
  const baselineScore = Math.round(
    parsed.scenarios.reduce((sum, scenario) => sum + scenario.baselineScore, 0) /
      parsed.scenarios.length,
  );
  const impactScore = Math.round(
    parsed.scenarios.reduce((sum, scenario) => sum + scenario.withContextScore, 0) /
      parsed.scenarios.length,
  );
  const impactDelta = impactScore - baselineScore;
  const baseReasons = await postRunReasons(context, [sourcePath], {
    path: source,
    sha256: scenarioSourceSha256,
  });
  await assertCliUnchanged(context);
  const reasons: SkillPressTesslEvalEvidence["ineligibilityReasons"] = [...baseReasons];
  if (parsed.missingBaseline) reasons.push("missing_baseline");
  if (parsed.scenarios.some((scenario) => scenario.delta < 0)) reasons.push("scenario_regression");
  const viewArgv = [context.executable, "eval", "view", "--json", runId] as const;
  const evidence: SkillPressTesslEvalEvidence = {
    schemaVersion: 1,
    evidenceType: "skillpress.tessl-eval",
    provider: "tessl",
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    sourceCommit: context.sourceCommit,
    projectConfigSha256: context.configSha256,
    skillSha256: context.skillSha256,
    scenarioSourceSha256,
    cli: context.cli,
    runId,
    agent: parsed.agent,
    model: parsed.model,
    runs,
    impactScore,
    baselineScore,
    impactDelta,
    upliftRatio:
      baselineScore === 0
        ? null
        : Math.round((impactScore / baselineScore) * 1_000_000) / 1_000_000,
    scenarios: parsed.scenarios,
    start: invocation(startArgv, startResult, context.executableSha256),
    result: invocation(viewArgv, finalResult, context.executableSha256),
    storagePath: context.storagePath,
    evidenceEligible: reasons.length === 0,
    ineligibilityReasons: reasons,
  };
  if (!validateEvalEvidence(evidence)) {
    throw new TesslEvidenceError("Tessl eval evidence violated its schema.", [
      issue("tessl.evidence.schema", "/evidence", "internal eval evidence is invalid"),
    ]);
  }
  await persistEvidence(context.storage, evidence);
  return freeze(evidence);
}
