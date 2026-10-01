import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadProjectConfig } from "../config/load.js";
import type { SkillPressProject } from "../config/generated.js";
import { digestBoundedTree } from "../evidence/tree-digest.js";
import type { SkillPressPairedEvaluationEvidence } from "../eval/generated-evidence.js";
import type { ProjectEvaluationInputs } from "../eval/load.js";
import { runCapturedCommand } from "../process/capture.js";
import { type checkNativeEvaluation, loadNativeEvaluation } from "./native-check.js";
import { TesslReleaseGateError, type TesslReleaseGateOptions } from "./tessl-gate.js";

export interface NativeEvidenceEnvelope {
  readonly schemaVersion: 1;
  readonly evidenceType: "skillpress.native-evidence";
  readonly advisory: true;
  readonly source: {
    readonly commit: string;
    readonly projectConfigSha256: string;
    readonly skillSha256: string;
    readonly evalSource: "evals";
    readonly evalSourceSha256: string;
  };
  readonly config: SkillPressProject;
  readonly inputs: ProjectEvaluationInputs;
  readonly measurement: SkillPressPairedEvaluationEvidence;
}

export interface NativeReleaseGateReport {
  readonly schemaVersion: 1;
  readonly gateType: "skillpress.native-release";
  readonly sourceCommit: string;
  readonly passed: boolean;
  readonly assessment: Awaited<ReturnType<typeof checkNativeEvaluation>>;
  readonly issues: readonly {
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }[];
}

function blocked(code: string, message: string): never {
  // Reuse the public release-error channel while legacy callers remain supported.
  throw new TesslReleaseGateError(message, [{ code, path: "/evidence", message }]);
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await runCapturedCommand({
    argv: ["git", ...args],
    cwd: root,
    timeoutSeconds: 30,
    maxOutputBytes: 1024 * 1024,
  });
  if (result.status !== "passed")
    blocked("native.source.git", "Git could not verify native release inputs.");
  return result.stdout.toString("utf8").trim();
}

async function snapshot(root: string) {
  const config = await loadProjectConfig(root);
  const commit = await git(root, ["rev-parse", "--verify", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(commit))
    blocked("native.source.commit", "Native release source must be committed.");
  const paths = ["skill-press.yaml", config.skill.path, "evals"];
  if (await git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...paths]))
    blocked("native.source.dirty", "Native release inputs must be clean and tracked.");
  if (await git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--", ...paths]))
    blocked("native.source.ignored", "Native release inputs must not contain ignored files.");
  for (const path of [
    "skill-press.yaml",
    `${config.skill.path}/SKILL.md`,
    "evals/training.yaml",
    "evals/holdout.yaml",
    "evals/rubric.yaml",
  ]) {
    if ((await git(root, ["ls-files", "--error-unmatch", "--", path])) !== path)
      blocked("native.source.untracked", "Required native release inputs must be tracked.");
  }
  return {
    commit,
    projectConfigSha256: createHash("sha256")
      .update(await readFile(join(root, "skill-press.yaml")))
      .digest("hex"),
    skillSha256: await digestBoundedTree(join(root, config.skill.path)),
    evalSource: "evals" as const,
    evalSourceSha256: await digestBoundedTree(join(root, "evals")),
  };
}

/** Construct deterministic upload envelopes; never relabel legacy/Tessl evidence. */
export async function prepareNativeEvidence(
  projectDirectory: string,
  options: TesslReleaseGateOptions,
) {
  if (options.evalSource !== "evals")
    blocked(
      "native.source.path",
      "Native evaluation source must be the canonical evals directory.",
    );
  const root = await realpath(resolve(projectDirectory));
  const source = await snapshot(root);
  const {
    report: assessment,
    config,
    inputs,
    training,
    holdout,
  } = await loadNativeEvaluation(
    root,
    {
      trainingEvidencePath: options.reviewEvidencePath,
      holdoutEvidencePath: options.evalEvidencePath,
    },
    (options.now ?? (() => new Date()))(),
  );
  const envelope = (measurement: SkillPressPairedEvaluationEvidence): NativeEvidenceEnvelope => ({
    schemaVersion: 1,
    evidenceType: "skillpress.native-evidence",
    advisory: true,
    source,
    config,
    inputs,
    measurement,
  });
  const review = envelope(training);
  const evaluation = envelope(holdout);
  const reviewBytes = Buffer.from(`${JSON.stringify(review)}\n`);
  const evaluationBytes = Buffer.from(`${JSON.stringify(evaluation)}\n`);
  if (reviewBytes.byteLength > 1024 * 1024 || evaluationBytes.byteLength > 1024 * 1024)
    blocked("native.evidence.size", "Native evidence exceeds the upload limit.");
  if (JSON.stringify(source) !== JSON.stringify(await snapshot(root)))
    blocked("native.source.changed", "Native release source changed during preparation.");
  const report: NativeReleaseGateReport = {
    schemaVersion: 1,
    gateType: "skillpress.native-release",
    sourceCommit: source.commit,
    passed: assessment.passed,
    assessment,
    issues: assessment.issues.map((code) => ({
      code,
      path: "/evidence",
      message: "Native measurement policy failed.",
    })),
  };
  return { report, review, evaluation, reviewBytes, evaluationBytes };
}

export async function checkNativeReleaseGate(
  projectDirectory: string,
  options: TesslReleaseGateOptions,
): Promise<NativeReleaseGateReport> {
  return (await prepareNativeEvidence(projectDirectory, options)).report;
}
