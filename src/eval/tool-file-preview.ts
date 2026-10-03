import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv } from "ajv";
import { loadProjectConfig, loadStrictYamlDocument } from "../config/load.js";
import { snapshotNativeSource } from "../release/native-evidence.js";
import { stageCanonicalSkill } from "../package/stage.js";
import { loadEvaluationRubric, parseEvaluationSuite } from "./load.js";
import type { SkillPressToolFileSuite } from "./generated-tool-file-suite.js";
import {
  TOOL_FILE_LIMITS,
  validateReviewedBinaryToolFiles,
  type ReviewedBinaryToolFile,
} from "./reviewed-python-tool.js";

const schema = JSON.parse(
  await readFile(new URL("../../schemas/tool-file-suite.schema.json", import.meta.url), "utf8"),
);
const validate = new Ajv({ strict: true }).compile<SkillPressToolFileSuite>(schema);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function parseToolFileSuite(value: unknown): SkillPressToolFileSuite {
  if (!validate(value)) throw new Error("Invalid v2 file fixture suite.");
  // Retain existing behavioral/identity/duplicate-scenario validation, without
  // pretending file references are inline text or modifying v1 acceptance.
  parseEvaluationSuite({
    ...value,
    schemaVersion: 1,
    scenarios: value.scenarios.map((scenario) => ({ ...scenario, fixture: undefined })),
  });
  return value;
}

async function readSource(
  root: string,
  suite: string,
  source: string,
  bytes: number,
  sha256: string,
) {
  const parts = source.split("/");
  if (
    !source.startsWith(`fixtures/${suite}/`) ||
    parts.some((part) => part === "." || part === "..")
  )
    throw new Error("File fixture source escapes its suite.");
  let path = join(root, "evals");
  for (const part of ["", ...parts]) {
    if (part) path = join(path, part);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("File fixture symlink rejected.");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== bytes || bytes > TOOL_FILE_LIMITS.perFileBytes)
      throw new Error("File fixture size or type mismatch.");
    const data = Buffer.alloc(bytes + 1);
    let length = 0;
    while (length < data.length) {
      const read = await handle.read(data, length, data.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const content = data.subarray(0, length);
    if (length !== bytes || hash(content) !== sha256)
      throw new Error("File fixture digest mismatch.");
    return content;
  } finally {
    await handle.close();
  }
}

/** Returns null for v1. No model, container, evidence or admission is produced. */
export async function prepareToolFilePreview(root: string, suite: "training" | "holdout") {
  const selected = await loadStrictYamlDocument(join(root, "evals", `${suite}.yaml`));
  if (
    selected === null ||
    typeof selected !== "object" ||
    !("schemaVersion" in selected) ||
    selected.schemaVersion !== 2
  )
    return null;
  const source = await snapshotNativeSource(root);
  const config = await loadProjectConfig(root);
  const parsed = parseToolFileSuite(
    await loadStrictYamlDocument(join(root, "evals", `${suite}.yaml`)),
  );
  if (parsed.suite !== suite || parsed.skill !== config.skill.name)
    throw new Error("File fixture suite identity mismatch.");
  await loadEvaluationRubric(join(root, "evals/rubric.yaml"));
  await stageCanonicalSkill(root);
  const scenarios = [];
  for (const scenario of parsed.scenarios) {
    const files: ReviewedBinaryToolFile[] = [];
    for (const file of scenario.fixture?.files ?? []) {
      files.push({
        path: file.path,
        content: await readSource(root, suite, file.source, file.bytes, file.sha256),
      });
    }
    validateReviewedBinaryToolFiles(files);
    scenarios.push({
      id: scenario.id,
      files,
      metadata: (scenario.fixture?.files ?? []).map((file) => ({
        ...file,
        mount: `/input/${file.path}`,
      })),
    });
  }
  if (JSON.stringify(source) !== JSON.stringify(await snapshotNativeSource(root)))
    throw new Error("File fixture source changed during preparation.");
  return { source, scenarios, limits: TOOL_FILE_LIMITS, executionSupported: false as const };
}

export async function verifyToolFilePreview(
  root: string,
  prepared: NonNullable<Awaited<ReturnType<typeof prepareToolFilePreview>>>,
) {
  if (JSON.stringify(prepared.source) !== JSON.stringify(await snapshotNativeSource(root)))
    throw new Error("File fixture source changed after preparation.");
  for (const scenario of prepared.scenarios) {
    validateReviewedBinaryToolFiles(scenario.files);
    if (
      scenario.files.length !== scenario.metadata.length ||
      scenario.files.some(
        (file, index) =>
          file.path !== scenario.metadata[index]?.path ||
          file.content.byteLength !== scenario.metadata[index]?.bytes ||
          hash(file.content) !== scenario.metadata[index]?.sha256,
      )
    )
      throw new Error("Prepared file fixture bytes changed.");
  }
}
