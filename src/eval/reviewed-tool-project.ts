import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadProjectConfig } from "../config/load.js";
import { loadPackagedSkill, packageStagedSkill } from "../package/archive.js";
import { stageCanonicalSkill, type StagedCanonicalSkill } from "../package/stage.js";
import { snapshotNativeSource } from "../release/native-evidence.js";
import { loadProjectEvaluationInputs } from "./load.js";
import { validateReviewedPythonToolRequest } from "./reviewed-python-tool.js";
import { validateReviewedToolActorInput } from "./reviewed-tool-actor.js";
import { runReviewedToolSuite, type ReviewedToolSuiteOptions } from "./reviewed-tool-suite.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function readReviewedToolResources(
  root: string,
  staged: StagedCanonicalSkill,
  image: string,
) {
  const skillFiles = await Promise.all(
    staged.files.map(async (file) => {
      const bytes = await readFile(join(root, staged.stagingPath, staged.skillPath, file.path));
      const content = bytes.toString("utf8");
      if (
        hash(bytes) !== file.sha256 ||
        bytes.length !== file.bytes ||
        !Buffer.from(content).equals(bytes)
      )
        throw new Error("Tool resource bytes must be exact UTF-8 staged source.");
      return { path: file.path, content };
    }),
  );
  validateReviewedPythonToolRequest({ python: "pass", image, inputs: [], skillFiles });
  const skillText = skillFiles.find((file) => file.path === "SKILL.md")?.content;
  if (skillText === undefined) throw new Error("Tool project is missing SKILL.md.");
  return { skillFiles, skillText };
}

/** No inference, image pull or execution. Caller reviews these first-party bytes before running. */
export async function prepareReviewedToolProject(projectDirectory: string, image: string) {
  const root = await realpath(resolve(projectDirectory));
  const source = await snapshotNativeSource(root);
  const config = await loadProjectConfig(root);
  const inputs = await loadProjectEvaluationInputs(root);
  const staged = await stageCanonicalSkill(root);
  const resources = await readReviewedToolResources(root, staged, image);
  for (const suite of [inputs.training, inputs.holdout]) {
    if (suite.skill !== config.skill.name) throw new Error("Tool suite skill identity differs.");
    for (const scenario of suite.scenarios)
      validateReviewedToolActorInput({ scenario, image, ...resources });
  }
  const packaged = await packageStagedSkill(root, staged);
  const artifacts = await loadPackagedSkill(root, packaged.artifactsPath);
  if (
    !same(source, await snapshotNativeSource(root)) ||
    artifacts.sourceCommit !== source.commit ||
    artifacts.skillSha256 !== source.skillSha256 ||
    artifacts.projectConfigSha256 !== source.projectConfigSha256
  )
    throw new Error("Tool project source or artifact binding failed.");
  return freeze({
    source,
    config,
    inputs,
    artifacts,
    image,
    ...resources,
    skillTextSha256: hash(resources.skillText),
    releaseEligible: false as const,
  });
}

/** Full source checks belong at invocation boundaries, never inside individual model/tool calls. */
export async function verifyReviewedToolProject(
  projectDirectory: string,
  prepared: Awaited<ReturnType<typeof prepareReviewedToolProject>>,
) {
  const root = await realpath(resolve(projectDirectory));
  const source = await snapshotNativeSource(root);
  const config = await loadProjectConfig(root);
  const inputs = await loadProjectEvaluationInputs(root);
  const artifacts = await loadPackagedSkill(root, prepared.artifacts.artifactsPath);
  // Canonical staging enumerates the entire tracked tree, so omitted/extra resources
  // cannot pass by merely presenting a self-consistent list of content hashes.
  const staged = await stageCanonicalSkill(root);
  const resources = await readReviewedToolResources(root, staged, prepared.image);
  if (
    !same(source, prepared.source) ||
    !same(config, prepared.config) ||
    !same(inputs, prepared.inputs) ||
    !same(artifacts, prepared.artifacts) ||
    artifacts.sourceCommit !== source.commit ||
    artifacts.skillSha256 !== source.skillSha256 ||
    artifacts.projectConfigSha256 !== source.projectConfigSha256 ||
    !same(resources.skillFiles, prepared.skillFiles) ||
    resources.skillText !== prepared.skillText ||
    hash(prepared.skillText) !== prepared.skillTextSha256 ||
    staged.sourceCommit !== source.commit ||
    staged.skillSha256 !== source.skillSha256 ||
    staged.projectConfigSha256 !== source.projectConfigSha256
  )
    throw new Error("Tool project changed after preparation.");
}

export async function runPreparedReviewedToolSuite(
  projectDirectory: string,
  preparedInput: Awaited<ReturnType<typeof prepareReviewedToolProject>>,
  suite: "training" | "holdout",
  callbacks: Pick<ReviewedToolSuiteOptions, "onEvent" | "onResult">,
  signal?: AbortSignal,
) {
  const prepared = freeze(structuredClone(preparedInput));
  if (suite !== "training" && suite !== "holdout") throw new Error("Unknown tool suite.");
  await verifyReviewedToolProject(projectDirectory, prepared);
  const measurement = await runReviewedToolSuite({
    suite: prepared.inputs[suite],
    rubric: prepared.inputs.rubric,
    skillText: prepared.skillText,
    skillFiles: prepared.skillFiles,
    image: prepared.image,
    repetitions: prepared.config.evaluation.repetitions,
    readinessMinimum: prepared.config.quality.readinessMinimum,
    onEvent: callbacks.onEvent,
    onResult: callbacks.onResult,
    ...(signal === undefined ? {} : { signal }),
  });
  await verifyReviewedToolProject(projectDirectory, prepared);
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
