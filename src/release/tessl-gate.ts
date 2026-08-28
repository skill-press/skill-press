import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { Ajv, type ValidateFunction } from "ajv";

import { loadProjectConfig } from "../config/load.js";
import { digestBoundedTree } from "../evidence/tree-digest.js";
import { runCapturedCommand } from "../process/capture.js";
import { tesslCommandDigest } from "../tessl/command-digest.js";
import { inspectTesslEvalSource } from "../tessl/eval-source.js";
import type { SkillPressTesslEvalEvidence } from "../tessl/generated-eval-evidence.js";
import type { SkillPressTesslReviewEvidence } from "../tessl/generated-review-evidence.js";
import { isTrustedTesslCli } from "../tessl/trusted-cli.js";
import { SERVER_REVIEW_POLICY } from "./server-policy.js";

export interface TesslReleaseGateIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface TesslReleaseGateOptions {
  readonly reviewEvidencePath: string;
  readonly evalEvidencePath: string;
  readonly evalSource: string;
  readonly now?: () => Date;
}

export interface TesslReleaseGateReport {
  readonly schemaVersion: 1;
  readonly gateType: "skillpress.tessl-release";
  readonly evaluatedAt: string;
  readonly sourceCommit: string;
  readonly passed: boolean;
  readonly thresholds: {
    readonly quality: number;
    readonly impact: number;
    readonly maxAgeHours: number;
  };
  readonly scores: {
    readonly quality: number | null;
    readonly impact: number | null;
  };
  readonly evidence: {
    readonly reviewPath: string;
    readonly evalPath: string;
  };
  readonly issues: readonly TesslReleaseGateIssue[];
}

export class TesslReleaseGateError extends Error {
  readonly issues: readonly TesslReleaseGateIssue[];

  constructor(message: string, issues: readonly TesslReleaseGateIssue[]) {
    super(message);
    this.name = "TesslReleaseGateError";
    this.issues = Object.freeze([...issues]);
  }
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

interface InvocationEvidence {
  readonly passed: boolean;
  readonly commandSha256: string;
  readonly exitCode: 0;
  readonly signal: null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
}

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_RAW_BYTES = 4 * 1024 * 1024;
const EVIDENCE_PATH = /^\.skill-press\/tessl\/([a-f0-9]{64})\/evidence\.json$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
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
const validateReview = ajv.compile<SkillPressTesslReviewEvidence>(
  reviewSchema,
) as ValidateFunction<SkillPressTesslReviewEvidence>;
const validateEval = ajv.compile<SkillPressTesslEvalEvidence>(
  evalSchema,
) as ValidateFunction<SkillPressTesslEvalEvidence>;

function issue(code: string, path: string, message: string): TesslReleaseGateIssue {
  return Object.freeze({ code, path, message });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function digestExistingTree(path: string): Promise<string | null> {
  try {
    return await digestBoundedTree(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

async function pathAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return true;
    throw error;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function safeRelativeDirectory(root: string, input: string, label: string): string {
  const absolute = resolve(root, input);
  const path = relative(root, absolute);
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(path)
  ) {
    throw new TesslReleaseGateError("A release-gate path is unsafe.", [
      issue("release.path.unsafe", label, "path must be a project subdirectory"),
    ]);
  }
  return path.split(process.platform === "win32" ? "\\" : "/").join("/");
}

async function assertPrivateEvidencePath(root: string, input: string): Promise<string> {
  const match = EVIDENCE_PATH.exec(input);
  if (match === null) {
    throw new TesslReleaseGateError("A Tessl evidence path is invalid.", [
      issue(
        "release.evidence.path",
        "/evidence",
        "evidence must be .skill-press/tessl/<run-id>/evidence.json",
      ),
    ]);
  }
  const components = [
    join(root, ".skill-press"),
    join(root, ".skill-press", "tessl"),
    join(root, ".skill-press", "tessl", match[1] as string),
  ];
  for (const component of components) {
    const metadata = await lstat(component);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new TesslReleaseGateError("Tessl evidence storage is unsafe.", [
        issue("release.evidence.storage", "/evidence", "storage must use real directories"),
      ]);
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new TesslReleaseGateError("Tessl evidence storage permissions are unsafe.", [
        issue("release.evidence.permissions", "/evidence", "storage must be private"),
      ]);
    }
  }
  const path = join(root, input);
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_EVIDENCE_BYTES ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new TesslReleaseGateError("Tessl evidence file is unsafe.", [
      issue(
        "release.evidence.file",
        "/evidence",
        "evidence must be a bounded private regular file",
      ),
    ]);
  }
  return path;
}

async function loadEvidence<T>(
  root: string,
  input: string,
  validate: ValidateFunction<T>,
  expectedType: string,
): Promise<T> {
  const path = await assertPrivateEvidencePath(root, input);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)));
  } catch {
    throw new TesslReleaseGateError("Tessl evidence JSON is invalid.", [
      issue("release.evidence.json", "/evidence", "evidence must be strict UTF-8 JSON"),
    ]);
  }
  if (!validate(value) || !isRecord(value) || value.evidenceType !== expectedType) {
    throw new TesslReleaseGateError("Tessl evidence schema is invalid.", [
      issue("release.evidence.schema", "/evidence", "evidence does not match its official schema"),
    ]);
  }
  return value;
}

async function readRaw(root: string, storagePath: string, name: string): Promise<Buffer> {
  const path = join(root, storagePath, name);
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_RAW_BYTES ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new TesslReleaseGateError("Tessl raw evidence is unsafe.", [
      issue("release.evidence.raw", "/evidence", "raw evidence must be bounded private files"),
    ]);
  }
  return readFile(path);
}

async function verifyInvocation(
  root: string,
  storagePath: string,
  name: string,
  invocation: InvocationEvidence,
  expectedCommandSha256: string,
): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }> {
  const stdout = await readRaw(root, storagePath, `${name}.stdout`);
  const stderr = await readRaw(root, storagePath, `${name}.stderr`);
  if (
    !invocation.passed ||
    invocation.exitCode !== 0 ||
    invocation.signal !== null ||
    invocation.stdoutBytes + invocation.stderrBytes > MAX_RAW_BYTES ||
    invocation.commandSha256 !== expectedCommandSha256 ||
    invocation.stdoutBytes !== stdout.byteLength ||
    invocation.stderrBytes !== stderr.byteLength ||
    invocation.stdoutSha256 !== sha256(stdout) ||
    invocation.stderrSha256 !== sha256(stderr)
  ) {
    throw new TesslReleaseGateError("Tessl command evidence binding is invalid.", [
      issue(
        "release.evidence.command",
        "/evidence",
        "command, status, bytes, and hashes must match",
      ),
    ]);
  }
  return { stdout, stderr };
}

function extractJsonObject(bytes: Buffer): JsonRecord {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const start = text.indexOf("{");
  if (start < 0) throw new TypeError("missing JSON object");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === "{") {
      depth += 1;
    } else if (!quoted && character === "}") {
      depth -= 1;
      if (depth === 0) {
        const value: unknown = JSON.parse(text.slice(start, index + 1));
        if (!isRecord(value)) throw new TypeError("JSON value is not an object");
        return value;
      }
    }
  }
  throw new TypeError("incomplete JSON object");
}

function solutionScore(value: unknown): number {
  if (!isRecord(value) || !Array.isArray(value.assessmentResults)) throw new TypeError("score");
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
      throw new TypeError("score");
    }
    earned += Number(criterion.score);
    maximum += Number(criterion.max_score);
  }
  if (maximum === 0) throw new TypeError("score");
  return Math.round((earned / maximum) * 100);
}

function verifyReviewOutput(bytes: Buffer, evidence: SkillPressTesslReviewEvidence): void {
  const value = extractJsonObject(bytes);
  const validation = value.validation;
  const review = value.review;
  if (!isRecord(validation) || !isRecord(review)) throw new TypeError("review");
  if (typeof validation.overallPassed !== "boolean") throw new TypeError("review");
  const score =
    review.reviewScore === null && validation.overallPassed === false
      ? 0
      : Number.isInteger(review.reviewScore) &&
          Number(review.reviewScore) >= 0 &&
          Number(review.reviewScore) <= 100
        ? Number(review.reviewScore)
        : undefined;
  const runId = value.reviewRunId ?? null;
  if (
    validation.overallPassed !== evidence.review.validationPassed ||
    score === undefined ||
    score !== evidence.review.qualityScore ||
    runId !== evidence.review.runId
  ) {
    throw new TypeError("review");
  }
}

function verifyEvalOutputs(
  startBytes: Buffer,
  resultBytes: Buffer,
  evidence: SkillPressTesslEvalEvidence,
  expectedContextPath: string,
  expectedCliInvocation: string,
): void {
  const start = extractJsonObject(startBytes);
  const startContext = start.context;
  const startContextDefinition = isRecord(startContext) ? startContext.definition : undefined;
  const providerContextPath = isRecord(startContextDefinition)
    ? startContextDefinition.path
    : undefined;
  const contextBasename = expectedContextPath.split("/").at(-1);
  if (
    start.evalRunId !== evidence.runId ||
    (start.agent !== undefined && start.agent !== evidence.agent) ||
    (start.model !== undefined && start.model !== evidence.model) ||
    start.scenariosCount !== evidence.scenarios.length ||
    !isRecord(startContextDefinition) ||
    startContextDefinition.type !== "plugin-directory" ||
    (providerContextPath !== expectedContextPath && providerContextPath !== contextBasename)
  ) {
    throw new TypeError("eval start");
  }
  const result = extractJsonObject(resultBytes);
  const data = result.data;
  if (!isRecord(data) || data.id !== evidence.runId || !isRecord(data.attributes)) {
    throw new TypeError("eval result");
  }
  const fixtures = data.attributes.evalRunFixtures;
  const finalContext = isRecord(fixtures) ? fixtures.context : undefined;
  const metadata = data.attributes.metadata;
  if (
    !isRecord(finalContext) ||
    finalContext.type !== "plugin-directory" ||
    finalContext.path !== providerContextPath ||
    !isRecord(metadata) ||
    metadata.cliInvocation !== expectedCliInvocation
  ) {
    throw new TypeError("eval provider context");
  }
  if (data.attributes.agent !== evidence.agent || data.attributes.model !== evidence.model) {
    throw new TypeError("eval identity");
  }
  const rawScenarios = data.attributes.scenarios;
  if (data.attributes.status !== "completed" || !Array.isArray(rawScenarios)) {
    throw new TypeError("eval result");
  }
  const fingerprints = new Set<string>();
  const scenarios = rawScenarios.map((scenario) => {
    if (!isRecord(scenario) || typeof scenario.fingerprint !== "string") {
      throw new TypeError("scenario");
    }
    if (
      scenario.fingerprint.length === 0 ||
      scenario.fingerprint.length > 10_000 ||
      Array.from(scenario.fingerprint).some((character) => {
        const point = character.codePointAt(0);
        return point === undefined || point <= 0x1f || point === 0x7f;
      }) ||
      fingerprints.has(scenario.fingerprint)
    ) {
      throw new TypeError("scenario fingerprint");
    }
    fingerprints.add(scenario.fingerprint);
    if (!Array.isArray(scenario.solutions)) throw new TypeError("scenario");
    const baseline = scenario.solutions.filter(
      (solution) => isRecord(solution) && solution.variant === "baseline",
    );
    const withContext = scenario.solutions.filter(
      (solution) => isRecord(solution) && solution.variant !== "baseline",
    );
    if (baseline.length > 1 || withContext.length !== 1) throw new TypeError("pairing");
    const baselineScore = baseline.length === 0 ? 0 : solutionScore(baseline[0]);
    const withContextScore = solutionScore(withContext[0]);
    return {
      fingerprintSha256: sha256(scenario.fingerprint),
      baselineScore,
      withContextScore,
      delta: withContextScore - baselineScore,
    };
  });
  const baselineScore = Math.round(
    scenarios.reduce((sum, scenario) => sum + scenario.baselineScore, 0) / scenarios.length,
  );
  const impactScore = Math.round(
    scenarios.reduce((sum, scenario) => sum + scenario.withContextScore, 0) / scenarios.length,
  );
  const upliftRatio =
    baselineScore === 0 ? null : Math.round((impactScore / baselineScore) * 1_000_000) / 1_000_000;
  if (
    JSON.stringify(scenarios) !== JSON.stringify(evidence.scenarios) ||
    baselineScore !== evidence.baselineScore ||
    impactScore !== evidence.impactScore ||
    impactScore - baselineScore !== evidence.impactDelta ||
    upliftRatio !== evidence.upliftRatio
  ) {
    throw new TypeError("eval aggregate");
  }
}

async function verifyRawEvidence(
  root: string,
  skillPath: string,
  evalSource: string,
  evalContext: string,
  evalSkillName: string,
  review: SkillPressTesslReviewEvidence,
  evaluation: SkillPressTesslEvalEvidence,
): Promise<void> {
  const reviewVersion = await verifyInvocation(
    root,
    review.storagePath,
    "version",
    { passed: true, ...review.cli },
    tesslCommandDigest(review.cli.executableSha256, ["--version"]),
  );
  const evalVersion = await verifyInvocation(
    root,
    evaluation.storagePath,
    "version",
    { passed: true, ...evaluation.cli },
    tesslCommandDigest(evaluation.cli.executableSha256, ["--version"]),
  );
  if (
    !reviewVersion.stdout.toString("utf8").split(/\r?\n/u).includes(review.cli.version) ||
    !evalVersion.stdout.toString("utf8").split(/\r?\n/u).includes(evaluation.cli.version)
  ) {
    throw new TesslReleaseGateError("Tessl version output is not bound.", [
      issue("release.evidence.version", "/evidence", "raw CLI version must match evidence"),
    ]);
  }
  await verifyInvocation(
    root,
    review.storagePath,
    "lint",
    review.lint,
    tesslCommandDigest(review.cli.executableSha256, [
      "skill",
      "lint",
      `${review.storagePath}/lint-plugin/.tessl-plugin/plugin.json`,
    ]),
  );
  const reviewResult = await verifyInvocation(
    root,
    review.storagePath,
    "review",
    review.review,
    tesslCommandDigest(review.cli.executableSha256, [
      "review",
      "run",
      "quality",
      "--json",
      "--force",
      ...(review.review.workspace === null ? [] : ["--workspace", review.review.workspace]),
      "--threshold",
      "0",
      skillPath,
    ]),
  );
  const evalStartCandidates = [
    [
      "eval",
      "run",
      "--json",
      "--force",
      "--context",
      evalContext,
      "--skill",
      evalSkillName,
      "--runs",
      String(evaluation.runs),
      evalSource,
    ],
    [
      "eval",
      "run",
      "--json",
      "--force",
      "--context",
      evalContext,
      "--skill",
      evalSkillName,
      "--agent",
      evaluation.agent,
      "--runs",
      String(evaluation.runs),
      evalSource,
    ],
    [
      "eval",
      "run",
      "--json",
      "--force",
      "--context",
      evalContext,
      "--skill",
      evalSkillName,
      "--model",
      evaluation.model,
      "--runs",
      String(evaluation.runs),
      evalSource,
    ],
    [
      "eval",
      "run",
      "--json",
      "--force",
      "--context",
      evalContext,
      "--skill",
      evalSkillName,
      "--agent",
      evaluation.agent,
      "--model",
      evaluation.model,
      "--runs",
      String(evaluation.runs),
      evalSource,
    ],
  ] as const;
  const evalStartArgv =
    evalStartCandidates.find(
      (argv) =>
        tesslCommandDigest(evaluation.cli.executableSha256, argv) ===
        evaluation.start.commandSha256,
    ) ?? evalStartCandidates[3];
  const startResult = await verifyInvocation(
    root,
    evaluation.storagePath,
    "eval-start",
    evaluation.start,
    tesslCommandDigest(evaluation.cli.executableSha256, evalStartArgv),
  );
  const evalResult = await verifyInvocation(
    root,
    evaluation.storagePath,
    "eval-result",
    evaluation.result,
    tesslCommandDigest(evaluation.cli.executableSha256, [
      "eval",
      "view",
      "--json",
      evaluation.runId,
    ]),
  );
  try {
    verifyReviewOutput(reviewResult.stdout, review);
    verifyEvalOutputs(
      startResult.stdout,
      evalResult.stdout,
      evaluation,
      evalContext,
      evalStartArgv.join(" "),
    );
  } catch {
    throw new TesslReleaseGateError("Tessl provider output does not match evidence scores.", [
      issue("release.evidence.output", "/evidence", "scores must derive from raw provider JSON"),
    ]);
  }
}

async function gitHead(root: string): Promise<string> {
  const result = await runCapturedCommand({
    argv: ["git", "rev-parse", "--verify", "HEAD"],
    cwd: root,
    timeoutSeconds: 30,
  });
  const commit = result.stdout.toString("utf8").trim();
  if (result.status !== "passed" || !COMMIT.test(commit)) {
    throw new TesslReleaseGateError("The release source is not committed.", [
      issue("release.git.commit", "/project", "release gate requires a valid Git HEAD"),
    ]);
  }
  return commit;
}

async function gitInputsDirty(root: string, paths: readonly string[]): Promise<boolean> {
  const result = await runCapturedCommand({
    argv: ["git", "status", "--porcelain=v1", "--untracked-files=all", "--", ...paths],
    cwd: root,
    timeoutSeconds: 30,
  });
  if (result.status !== "passed") {
    throw new TesslReleaseGateError("Release Git inputs could not be inspected.", [
      issue("release.git.status", "/project", "relevant Git status must be readable"),
    ]);
  }
  return result.stdout.byteLength !== 0;
}

function addCheck(
  issues: TesslReleaseGateIssue[],
  condition: boolean,
  code: string,
  path: string,
  message: string,
): void {
  if (!condition) issues.push(issue(code, path, message));
}

/** Revalidate current source and raw official evidence before a Tessl-gated release. */
export async function checkTesslReleaseGate(
  projectDirectory: string,
  options: TesslReleaseGateOptions,
): Promise<TesslReleaseGateReport> {
  const root = await realpath(resolve(projectDirectory));
  const config = await loadProjectConfig(root);
  const review = await loadEvidence(
    root,
    options.reviewEvidencePath,
    validateReview,
    "skillpress.tessl-review",
  );
  const evaluation = await loadEvidence(
    root,
    options.evalEvidencePath,
    validateEval,
    "skillpress.tessl-eval",
  );
  if (
    review.storagePath !== options.reviewEvidencePath.slice(0, -"/evidence.json".length) ||
    evaluation.storagePath !== options.evalEvidencePath.slice(0, -"/evidence.json".length)
  ) {
    throw new TesslReleaseGateError("Tessl evidence storage binding is invalid.", [
      issue(
        "release.evidence.storage_binding",
        "/evidence",
        "storagePath must match the evidence file",
      ),
    ]);
  }
  const evalSource = safeRelativeDirectory(root, options.evalSource, "/evalSource");
  const skillPath = safeRelativeDirectory(root, config.skill.path, "/skill");
  const sourceCommit = await gitHead(root);
  const configSha256 = sha256(await readFile(join(root, "skill-press.yaml")));
  const skillSha256 = await digestBoundedTree(join(root, skillPath));
  const scenarioSourceSha256 = await digestBoundedTree(join(root, evalSource));
  const capturedEvalSource = safeRelativeDirectory(
    root,
    `${evaluation.storagePath}/eval-plugin-${scenarioSourceSha256}`,
    "/eval/storagePath",
  );
  const capturedScenarioSourceSha256 = await digestExistingTree(join(root, capturedEvalSource));
  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new TesslReleaseGateError("The release-gate clock is invalid.", [
      issue("release.clock", "/now", "clock must return a valid Date"),
    ]);
  }
  const issues: TesslReleaseGateIssue[] = [];
  addCheck(
    issues,
    await pathAbsent(join(root, evaluation.storagePath, ".git")),
    "release.evidence.git_boundary",
    "/eval/storagePath",
    "temporary Tessl Git boundary must be absent before release",
  );
  const evalSourceBinding = await inspectTesslEvalSource(join(root, evalSource), config.skill.name);
  const capturedEvalSourceBinding = await inspectTesslEvalSource(
    join(root, capturedEvalSource),
    config.skill.name,
  );
  addCheck(
    issues,
    evalSourceBinding.structureValid &&
      evalSourceBinding.contextExclusive &&
      evalSourceBinding.skillValid &&
      evalSourceBinding.embeddedSkillSha256 === skillSha256 &&
      capturedEvalSourceBinding.structureValid &&
      capturedEvalSourceBinding.contextExclusive &&
      capturedEvalSourceBinding.skillValid &&
      capturedEvalSourceBinding.embeddedSkillSha256 === skillSha256,
    "release.eval_source.skill_binding",
    "/evalSource/skills",
    "eval plugin must embed the complete current canonical skill",
  );
  addCheck(
    issues,
    !(await gitInputsDirty(root, ["skill-press.yaml", skillPath, evalSource])),
    "release.git.dirty",
    "/project",
    "release-relevant inputs must be clean",
  );
  const effectiveMaxAgeHours = Math.min(
    config.quality.evidenceMaxAgeHours,
    SERVER_REVIEW_POLICY.evidenceMaxAgeHours,
  );
  const maxAgeMs = effectiveMaxAgeHours * 60 * 60 * 1000;
  for (const [label, evidence] of [
    ["review", review],
    ["eval", evaluation],
  ] as const) {
    const created = Date.parse(evidence.createdAt);
    addCheck(
      issues,
      created <= nowMs && nowMs - created <= maxAgeMs,
      "release.evidence.stale",
      `/${label}/createdAt`,
      `${label} evidence must be current and not future-dated`,
    );
    addCheck(
      issues,
      evidence.sourceCommit === sourceCommit,
      "release.evidence.commit",
      `/${label}/sourceCommit`,
      `${label} evidence must match current Git HEAD`,
    );
    addCheck(
      issues,
      evidence.projectConfigSha256 === configSha256,
      "release.evidence.config",
      `/${label}/projectConfigSha256`,
      `${label} evidence must match current project configuration`,
    );
    addCheck(
      issues,
      evidence.skillSha256 === skillSha256,
      "release.evidence.skill",
      `/${label}/skillSha256`,
      `${label} evidence must match the complete canonical skill`,
    );
    addCheck(
      issues,
      evidence.evidenceEligible && evidence.ineligibilityReasons.length === 0,
      "release.evidence.ineligible",
      `/${label}/evidenceEligible`,
      `${label} evidence must be release-eligible`,
    );
    addCheck(
      issues,
      isTrustedTesslCli(evidence.cli.version, evidence.cli.executableSha256),
      "release.evidence.cli",
      `/${label}/cli`,
      `${label} evidence must use a pinned signed-release Tessl CLI`,
    );
  }
  addCheck(
    issues,
    evaluation.scenarioSourceSha256 === scenarioSourceSha256 &&
      evaluation.scenarioSourceSha256 === capturedScenarioSourceSha256,
    "release.evidence.scenarios",
    "/eval/scenarioSourceSha256",
    "Impact evidence must match the complete current eval source",
  );
  addCheck(
    issues,
    review.review.validationPassed &&
      review.review.qualityScore >= config.quality.tesslQualityMinimum,
    "release.quality.minimum",
    "/review/qualityScore",
    "official Tessl Quality must pass validation and meet the configured minimum",
  );
  addCheck(
    issues,
    evaluation.impactScore >= config.quality.tesslImpactMinimum &&
      evaluation.scenarios.every((scenario) => scenario.delta >= 0),
    "release.impact.minimum",
    "/eval/impactScore",
    "official Tessl Impact must meet the configured minimum without scenario regression",
  );
  try {
    await verifyRawEvidence(
      root,
      skillPath,
      evalSource,
      capturedEvalSource,
      config.skill.name,
      review,
      evaluation,
    );
  } catch (error) {
    if (error instanceof TesslReleaseGateError) issues.push(...error.issues);
    else throw error;
  }
  const finalCommit = await gitHead(root);
  const finalConfigSha256 = sha256(await readFile(join(root, "skill-press.yaml")));
  const finalSkillSha256 = await digestBoundedTree(join(root, skillPath));
  const finalScenarioSha256 = await digestBoundedTree(join(root, evalSource));
  const finalCapturedScenarioSha256 = await digestExistingTree(join(root, capturedEvalSource));
  const finalEvalSourceBinding = await inspectTesslEvalSource(
    join(root, evalSource),
    config.skill.name,
  );
  const finalCapturedEvalSourceBinding = await inspectTesslEvalSource(
    join(root, capturedEvalSource),
    config.skill.name,
  );
  const finalDirty = await gitInputsDirty(root, ["skill-press.yaml", skillPath, evalSource]);
  addCheck(
    issues,
    finalCommit === sourceCommit &&
      finalConfigSha256 === configSha256 &&
      finalSkillSha256 === skillSha256 &&
      finalScenarioSha256 === scenarioSourceSha256 &&
      finalCapturedScenarioSha256 === scenarioSourceSha256 &&
      finalEvalSourceBinding.structureValid &&
      finalEvalSourceBinding.contextExclusive &&
      finalEvalSourceBinding.skillValid &&
      finalEvalSourceBinding.embeddedSkillSha256 === finalSkillSha256 &&
      finalCapturedEvalSourceBinding.structureValid &&
      finalCapturedEvalSourceBinding.contextExclusive &&
      finalCapturedEvalSourceBinding.skillValid &&
      finalCapturedEvalSourceBinding.embeddedSkillSha256 === finalSkillSha256 &&
      !finalDirty,
    "release.source.changed",
    "/project",
    "release-relevant inputs must remain unchanged throughout the gate",
  );
  return freeze({
    schemaVersion: 1,
    gateType: "skillpress.tessl-release",
    evaluatedAt: now.toISOString(),
    sourceCommit,
    passed: issues.length === 0,
    thresholds: {
      quality: config.quality.tesslQualityMinimum,
      impact: config.quality.tesslImpactMinimum,
      maxAgeHours: effectiveMaxAgeHours,
    },
    scores: {
      quality: review.review.qualityScore,
      impact: evaluation.impactScore,
    },
    evidence: {
      reviewPath: options.reviewEvidencePath,
      evalPath: options.evalEvidencePath,
    },
    issues,
  });
}
