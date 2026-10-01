import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadProjectConfig } from "../config/load.js";
import { loadPackagedSkill, packageStagedSkill } from "../package/archive.js";
import { stageCanonicalSkill } from "../package/stage.js";
import { snapshotNativeSource } from "../release/native-evidence.js";
import { loadProjectEvaluationInputs } from "./load.js";
import { runReviewedTextSuite, type ReviewedTextSuiteOptions } from "./reviewed-text-suite.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Prepare reviewed text inputs, not permission to run them. Never invokes a model. */
export async function prepareReviewedTextProject(projectDirectory: string) {
  const root = await realpath(resolve(projectDirectory));
  const source = await snapshotNativeSource(root);
  const config = await loadProjectConfig(root);
  const inputs = await loadProjectEvaluationInputs(root);
  const staged = await stageCanonicalSkill(root);
  // A text-only profile must not silently omit a script, reference or other resource.
  if (staged.files.length !== 1 || staged.files[0]?.path !== "SKILL.md")
    throw new Error("Reviewed text projects support only a standalone SKILL.md.");
  if (
    staged.sourceCommit !== source.commit ||
    staged.skillSha256 !== source.skillSha256 ||
    staged.projectConfigSha256 !== source.projectConfigSha256
  )
    throw new Error("Reviewed text source changed during preparation.");
  const skillText = await readFile(
    join(root, staged.stagingPath, staged.skillPath, "SKILL.md"),
    "utf8",
  );
  const artifacts = await packageStagedSkill(root, staged);
  const verified = await loadPackagedSkill(root, artifacts.artifactsPath);
  if (
    !same(source, await snapshotNativeSource(root)) ||
    verified.sourceCommit !== source.commit ||
    verified.skillSha256 !== source.skillSha256 ||
    verified.projectConfigSha256 !== source.projectConfigSha256 ||
    digest(skillText) !== staged.files[0]?.sha256
  )
    throw new Error("Reviewed text source or artifact binding failed.");
  return freeze({
    source,
    config,
    inputs,
    artifacts: verified,
    skillText,
    skillTextSha256: digest(skillText),
    releaseEligible: false as const,
  });
}

/** Recheck once at command exit, not inside each model call. */
export async function verifyReviewedTextProject(
  projectDirectory: string,
  prepared: Awaited<ReturnType<typeof prepareReviewedTextProject>>,
): Promise<void> {
  const root = await realpath(resolve(projectDirectory));
  const source = await snapshotNativeSource(root);
  const artifacts = await loadPackagedSkill(root, prepared.artifacts.artifactsPath);
  const config = await loadProjectConfig(root);
  const inputs = await loadProjectEvaluationInputs(root);
  const currentText = await readFile(join(root, config.skill.path, "SKILL.md"), "utf8");
  if (
    !same(source, prepared.source) ||
    !same(artifacts, prepared.artifacts) ||
    !same(config, prepared.config) ||
    !same(inputs, prepared.inputs) ||
    digest(prepared.skillText) !== prepared.skillTextSha256 ||
    digest(currentText) !== prepared.skillTextSha256
  )
    throw new Error("Reviewed text project changed after preparation.");
}

/** Caller must review the prepared first-party inputs before invoking authenticated inference. */
export async function runPreparedReviewedTextSuite(
  projectDirectory: string,
  prepared: Awaited<ReturnType<typeof prepareReviewedTextProject>>,
  suite: "training" | "holdout",
  onResult: ReviewedTextSuiteOptions["onResult"],
  signal?: AbortSignal,
) {
  await verifyReviewedTextProject(projectDirectory, prepared);
  const measurement = await runReviewedTextSuite({
    suite: prepared.inputs[suite],
    rubric: prepared.inputs.rubric,
    skillText: prepared.skillText,
    repetitions: prepared.config.evaluation.repetitions,
    readinessMinimum: prepared.config.quality.readinessMinimum,
    onResult,
    ...(signal === undefined ? {} : { signal }),
  });
  await verifyReviewedTextProject(projectDirectory, prepared);
  return Object.freeze({
    ...measurement,
    source: prepared.source,
    config: prepared.config,
    artifact: {
      sha256: prepared.artifacts.artifactSha256,
      bytes: prepared.artifacts.artifactBytes,
      provenanceSha256: prepared.artifacts.provenanceSha256,
    },
    ineligibilityReasons: Object.freeze(
      measurement.ineligibilityReasons.filter(
        (reason) => reason !== "artifact_binding_not_established",
      ),
    ),
  });
}
