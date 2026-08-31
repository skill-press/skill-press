import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { tesslSolutionAssessment } from "./assessment.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function isRealDirectory(path: string): Promise<boolean> {
  const metadata = await lstat(path);
  return metadata.isDirectory() && !metadata.isSymbolicLink();
}

async function isRealFile(path: string): Promise<boolean> {
  const metadata = await lstat(path);
  return metadata.isFile() && !metadata.isSymbolicLink();
}

/** Load the exact ordered `(name,max_score)` inventory for each Tessl eval scenario. */
export async function loadTesslEvalRubricInventories(source: string): Promise<readonly string[]> {
  const evals = join(source, "evals");
  if (!(await isRealDirectory(evals))) throw new TypeError("eval rubric directory");
  const entries = (await readdir(evals, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  );
  if (entries.length === 0 || entries.some((entry) => !entry.isDirectory())) {
    throw new TypeError("eval rubric scenarios");
  }
  const inventories: string[] = [];
  for (const entry of entries) {
    const scenario = join(evals, entry.name);
    const criteriaPath = join(scenario, "criteria.json");
    if (!(await isRealDirectory(scenario)) || !(await isRealFile(criteriaPath))) {
      throw new TypeError("eval rubric scenario");
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readFile(criteriaPath)),
    );
    if (
      !isRecord(value) ||
      value.type !== "weighted_checklist" ||
      !Array.isArray(value.checklist) ||
      value.checklist.length === 0 ||
      value.checklist.length > 100
    ) {
      throw new TypeError("eval rubric shape");
    }
    const synthetic = {
      assessmentResults: value.checklist.map((criterion) => {
        if (
          !isRecord(criterion) ||
          typeof criterion.name !== "string" ||
          typeof criterion.description !== "string" ||
          !Number.isFinite(criterion.max_score)
        ) {
          throw new TypeError("eval rubric criterion");
        }
        return { name: criterion.name, score: 0, max_score: criterion.max_score };
      }),
    };
    const assessment = tesslSolutionAssessment(synthetic);
    if (assessment === undefined) throw new TypeError("eval rubric inventory");
    inventories.push(assessment.inventoryKey);
  }
  return Object.freeze(inventories);
}
