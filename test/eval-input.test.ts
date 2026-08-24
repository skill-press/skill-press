import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";
import { EvaluationInputError } from "../src/eval/errors.js";
import type { SkillPressEvaluationRubric } from "../src/eval/generated-rubric.js";
import type { SkillPressEvaluationSuite } from "../src/eval/generated-suite.js";
import {
  EVALUATION_RUBRIC_PATH,
  HOLDOUT_SUITE_PATH,
  loadEvaluationRubric,
  loadEvaluationSuite,
  loadProjectEvaluationInputs,
  TRAINING_SUITE_PATH,
} from "../src/eval/load.js";

const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function generatedProject(): Promise<string> {
  const parent = await mkdtemp(join(temporaryRoot, "skillpress-eval-input-test-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "project");
  await writeRenderedProject(renderCapabilityProject(await loadCapabilityBrief(briefPath)), root);
  return root;
}

async function loadYaml<T>(path: string): Promise<T> {
  return parse(await readFile(path, "utf8")) as T;
}

async function saveYaml(path: string, value: unknown): Promise<void> {
  await writeFile(path, stringify(value, { lineWidth: 0 }));
}

async function expectCodes(promise: Promise<unknown>): Promise<readonly string[]> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluationInputError);
    return (error as EvaluationInputError).issues.map((entry) => entry.code);
  }
  throw new Error("expected evaluation input to fail");
}

describe("evaluation input contracts", () => {
  it("loads generated training, holdout, and weighted rubric inputs", async () => {
    const root = await generatedProject();

    const inputs = await loadProjectEvaluationInputs(root);

    expect(inputs.training).toMatchObject({ suite: "training", skill: "incident-summary" });
    expect(inputs.holdout).toMatchObject({ suite: "holdout", skill: "incident-summary" });
    expect(inputs.rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0)).toBe(100);
    expect(Object.isFrozen(inputs)).toBe(true);
  });

  it("reports schema errors without reflecting an invalid prompt", async () => {
    const root = await generatedProject();
    const path = join(root, TRAINING_SUITE_PATH);
    const suite = await loadYaml<Record<string, unknown>>(path);
    const secret = "do-not-reflect-this-invalid-prompt";
    suite.scenarios = [{ prompt: secret }];
    await saveYaml(path, suite);

    const errorJson = await loadEvaluationSuite(path).catch((error: unknown) =>
      JSON.stringify(error instanceof EvaluationInputError ? error.issues : error),
    );

    expect(errorJson).toContain("eval.suite.schema.required");
    expect(errorJson).not.toContain(secret);
  });

  it("remaps strict YAML failures to input-safe diagnostics", async () => {
    const root = await generatedProject();
    const path = join(root, TRAINING_SUITE_PATH);
    await writeFile(path, "schemaVersion: 1\nschemaVersion: private-sentinel\n");

    const error = await loadEvaluationSuite(path).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(EvaluationInputError);
    expect((error as EvaluationInputError).issues).toEqual([
      {
        code: "eval.input.yaml",
        path: "/",
        message: "evaluation input could not be loaded safely",
      },
    ]);
    expect(JSON.stringify((error as EvaluationInputError).issues)).not.toContain(
      "private-sentinel",
    );
  });

  it.each([
    {
      name: "activation expectations",
      mutate: (suite: SkillPressEvaluationSuite) => {
        suite.scenarios[0].shouldActivate = !suite.scenarios[0].shouldActivate;
      },
      code: "eval.suite.activation_mismatch",
    },
    {
      name: "required forbidden behavior",
      mutate: (suite: SkillPressEvaluationSuite) => {
        const nearMiss = suite.scenarios.find((scenario) => scenario.category === "near-miss");
        if (nearMiss !== undefined) delete nearMiss.forbiddenBehavior;
      },
      code: "eval.suite.forbidden_behavior_required",
    },
    {
      name: "unique ids",
      mutate: (suite: SkillPressEvaluationSuite) => {
        suite.scenarios[1].id = suite.scenarios[0].id;
      },
      code: "eval.suite.duplicate_id",
    },
    {
      name: "normalized unique prompts",
      mutate: (suite: SkillPressEvaluationSuite) => {
        suite.scenarios[1].prompt = `  ${suite.scenarios[0].prompt.toUpperCase()}!!!  `;
      },
      code: "eval.suite.duplicate_prompt",
    },
    {
      name: "unique expected behavior",
      mutate: (suite: SkillPressEvaluationSuite) => {
        suite.scenarios[0].expectedBehavior.push(suite.scenarios[0].expectedBehavior[0]);
      },
      code: "eval.suite.duplicate_behavior",
    },
    {
      name: "nonconflicting behavior",
      mutate: (suite: SkillPressEvaluationSuite) => {
        suite.scenarios[0].forbiddenBehavior = [suite.scenarios[0].expectedBehavior[0]];
      },
      code: "eval.suite.conflicting_behavior",
    },
    {
      name: "unique forbidden behavior",
      mutate: (suite: SkillPressEvaluationSuite) => {
        const nearMiss = suite.scenarios.find((scenario) => scenario.category === "near-miss");
        if (nearMiss?.forbiddenBehavior !== undefined) {
          nearMiss.forbiddenBehavior.push(nearMiss.forbiddenBehavior[0]);
        }
      },
      code: "eval.suite.duplicate_behavior",
    },
  ])("enforces $name", async ({ mutate, code }) => {
    const root = await generatedProject();
    const path = join(root, TRAINING_SUITE_PATH);
    const suite = await loadYaml<SkillPressEvaluationSuite>(path);
    mutate(suite);
    await saveYaml(path, suite);

    expect(await expectCodes(loadEvaluationSuite(path))).toContain(code);
  });

  it("restricts holdouts to positive and near-miss categories", async () => {
    const root = await generatedProject();
    const path = join(root, HOLDOUT_SUITE_PATH);
    const suite = await loadYaml<SkillPressEvaluationSuite>(path);
    suite.scenarios[0].category = "failure";
    suite.scenarios[0].shouldActivate = true;
    await saveYaml(path, suite);

    expect(await expectCodes(loadEvaluationSuite(path))).toContain("eval.suite.holdout_category");
  });

  it("requires unique rubric ids and a weight total of exactly 100", async () => {
    const root = await generatedProject();
    const path = join(root, EVALUATION_RUBRIC_PATH);
    const rubric = await loadYaml<SkillPressEvaluationRubric>(path);
    rubric.criteria[1].id = rubric.criteria[0].id;
    rubric.criteria[1].weight = 1;
    await saveYaml(path, rubric);

    const codes = await expectCodes(loadEvaluationRubric(path));
    expect(codes).toContain("eval.rubric.duplicate_id");
    expect(codes).toContain("eval.rubric.weight_total");
  });

  it("rejects a rubric that does not match the authoritative schema", async () => {
    const root = await generatedProject();
    const path = join(root, EVALUATION_RUBRIC_PATH);
    const rubric = await loadYaml<Record<string, unknown>>(path);
    rubric.unknown = true;
    await saveYaml(path, rubric);

    expect(await expectCodes(loadEvaluationRubric(path))).toContain(
      "eval.rubric.schema.additionalProperties",
    );
  });

  it.each([
    [
      "declared training role",
      "eval.training.suite",
      (training: SkillPressEvaluationSuite) => {
        training.suite = "holdout";
        for (const scenario of training.scenarios) {
          if (scenario.category !== "near-miss") scenario.category = "positive";
        }
      },
    ],
    [
      "canonical skill identity",
      "eval.training.skill",
      (training: SkillPressEvaluationSuite) => {
        training.skill = "other-skill";
      },
    ],
  ] as const)("checks the project %s", async (_name, code, mutate) => {
    const root = await generatedProject();
    const path = join(root, TRAINING_SUITE_PATH);
    const training = await loadYaml<SkillPressEvaluationSuite>(path);
    mutate(training);
    await saveYaml(path, training);

    expect(await expectCodes(loadProjectEvaluationInputs(root))).toContain(code);
  });

  it("checks the declared holdout role and canonical skill identity", async () => {
    const root = await generatedProject();
    const path = join(root, HOLDOUT_SUITE_PATH);
    const holdout = await loadYaml<SkillPressEvaluationSuite>(path);
    holdout.suite = "training";
    holdout.skill = "other-skill";
    await saveYaml(path, holdout);

    const codes = await expectCodes(loadProjectEvaluationInputs(root));
    expect(codes).toContain("eval.holdout.suite");
    expect(codes).toContain("eval.holdout.skill");
  });

  it.each([
    ["id", "eval.holdout.id_leakage"],
    ["prompt", "eval.holdout.prompt_leakage"],
  ] as const)("rejects cross-suite %s leakage", async (field, code) => {
    const root = await generatedProject();
    const training = await loadYaml<SkillPressEvaluationSuite>(join(root, TRAINING_SUITE_PATH));
    const holdoutPath = join(root, HOLDOUT_SUITE_PATH);
    const holdout = await loadYaml<SkillPressEvaluationSuite>(holdoutPath);
    if (field === "id") holdout.scenarios[0].id = training.scenarios[0].id;
    else holdout.scenarios[0].prompt = `  ${training.scenarios[0].prompt.toUpperCase()}!`;
    await saveYaml(holdoutPath, holdout);

    expect(await expectCodes(loadProjectEvaluationInputs(root))).toContain(code);
  });

  it("rejects ambiguous project paths before reading evaluation files", async () => {
    await expect(loadProjectEvaluationInputs("bad\u200bpath")).rejects.toThrow(TypeError);
  });
});
