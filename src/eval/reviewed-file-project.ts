import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadProjectConfig, loadStrictYamlDocument } from "../config/load.js";
import { stageCanonicalSkill } from "../package/stage.js";
import { snapshotNativeSource } from "../release/native-evidence.js";
import { loadEvaluationRubric } from "./load.js";
import { prepareToolFilePreview, parseToolFileSuite } from "./tool-file-preview.js";
import { readReviewedToolResources } from "./reviewed-tool-project.js";
import { validateReviewedFilePairInput } from "./reviewed-file-pair.js";
import { runReviewedFileSuite, type ReviewedFileSuiteOptions } from "./reviewed-file-suite.js";

/** Capture both committed suites and exact resources; no model or container execution. */
export async function prepareReviewedFileProject(directory: string, image: string) {
  const root = await realpath(resolve(directory));
  const source = await snapshotNativeSource(root);
  const config = await loadProjectConfig(root);
  const rubric = await loadEvaluationRubric(join(root, "evals/rubric.yaml"));
  const staged = await stageCanonicalSkill(root);
  const resources = await readReviewedToolResources(root, staged, image);
  async function capture(suite: "training" | "holdout") {
    const preview = await prepareToolFilePreview(root, suite);
    if (preview === null) throw new Error("Both file suites must use schemaVersion 2.");
    const definition = parseToolFileSuite(
      await loadStrictYamlDocument(join(root, `evals/${suite}.yaml`)),
    );
    const files = preview.scenarios.map(({ id, files }) => ({
      id,
      files: files.map(({ path, content }) => ({ path, content: new Uint8Array(content) })),
    }));
    for (const [index, scenario] of definition.scenarios.entries())
      validateReviewedFilePairInput({
        scenario,
        suite,
        files: (files[index] as (typeof files)[number]).files,
        rubric,
        image,
        ...resources,
      });
    return { definition, files };
  }
  const training = await capture("training");
  const holdout = await capture("holdout");
  if (JSON.stringify(source) !== JSON.stringify(await snapshotNativeSource(root)))
    throw new Error("File project changed during preparation.");
  return {
    source,
    config,
    rubric,
    image,
    ...resources,
    training,
    holdout,
    releaseEligible: false as const,
  };
}

export async function verifyReviewedFileProject(
  directory: string,
  prepared: Awaited<ReturnType<typeof prepareReviewedFileProject>>,
) {
  const current = await prepareReviewedFileProject(directory, prepared.image);
  if (JSON.stringify(current) !== JSON.stringify(prepared))
    throw new Error("File project changed after preparation.");
}

/** Whole-source validation only at invocation entry and exit; never per model call. */
export async function runPreparedReviewedFileSuite(
  directory: string,
  input: Awaited<ReturnType<typeof prepareReviewedFileProject>>,
  suite: "training" | "holdout",
  maxModelCalls: number,
  callbacks: Pick<ReviewedFileSuiteOptions, "onEvent" | "onResult">,
  signal?: AbortSignal,
) {
  if (suite !== "training" && suite !== "holdout") throw new Error("Unknown file suite.");
  const prepared = structuredClone(input);
  await verifyReviewedFileProject(directory, prepared);
  try {
    const measurement = await runReviewedFileSuite({
      suite: prepared[suite].definition,
      files: prepared[suite].files,
      rubric: prepared.rubric,
      skillText: prepared.skillText,
      skillFiles: prepared.skillFiles,
      image: prepared.image,
      repetitions: prepared.config.evaluation.repetitions,
      readinessMinimum: prepared.config.quality.readinessMinimum,
      maxModelCalls,
      onEvent: callbacks.onEvent,
      onResult: callbacks.onResult,
      ...(signal === undefined ? {} : { signal }),
    });
    return { ...measurement, source: prepared.source };
  } finally {
    await verifyReviewedFileProject(directory, prepared);
  }
}
