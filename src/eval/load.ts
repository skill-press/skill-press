import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import { ProjectConfigError } from "../config/errors.js";
import { loadProjectConfig, loadStrictYamlDocument } from "../config/load.js";
import { normalizeComparableText } from "../create/comparable-text.js";
import { isSafePathInput } from "../path-safety.js";
import { type EvaluationInputIssue, EvaluationInputError } from "./errors.js";
import type { SkillPressEvaluationRubric } from "./generated-rubric.js";
import type { Scenario, SkillPressEvaluationSuite } from "./generated-suite.js";

export const TRAINING_SUITE_PATH = "evals/training.yaml";
export const HOLDOUT_SUITE_PATH = "evals/holdout.yaml";
export const EVALUATION_RUBRIC_PATH = "evals/rubric.yaml";

export interface ProjectEvaluationInputs {
  readonly training: SkillPressEvaluationSuite;
  readonly holdout: SkillPressEvaluationSuite;
  readonly rubric: SkillPressEvaluationRubric;
}

const normalizeComparableTextSnapshot = normalizeComparableText;
const suiteSchemaUrl = new URL("../../schemas/eval-suite.schema.json", import.meta.url);
const rubricSchemaUrl = new URL("../../schemas/eval-rubric.schema.json", import.meta.url);
const [suiteSchema, rubricSchema] = await Promise.all([
  readFile(suiteSchemaUrl, "utf8").then((text) => JSON.parse(text) as object),
  readFile(rubricSchemaUrl, "utf8").then((text) => JSON.parse(text) as object),
]);
const ajv = new Ajv({ allErrors: true, strict: true });
const validateSuite = ajv.compile<SkillPressEvaluationSuite>(
  suiteSchema,
) as ValidateFunction<SkillPressEvaluationSuite>;
const validateRubric = ajv.compile<SkillPressEvaluationRubric>(
  rubricSchema,
) as ValidateFunction<SkillPressEvaluationRubric>;

function issue(code: string, path: string, message: string): EvaluationInputIssue {
  return Object.freeze({ code, path, message });
}

function schemaIssues(
  kind: "suite" | "rubric",
  errors: readonly ErrorObject[],
): EvaluationInputIssue[] {
  return errors.map((error) =>
    issue(
      `eval.${kind}.schema.${error.keyword}`,
      error.instancePath === "" ? "/" : error.instancePath,
      error.message ?? `does not match the evaluation ${kind} schema`,
    ),
  );
}

async function loadInput(path: string): Promise<unknown> {
  try {
    return await loadStrictYamlDocument(path);
  } catch (error) {
    if (!(error instanceof ProjectConfigError)) throw error;
    throw new EvaluationInputError(
      "Unable to load an evaluation input.",
      error.issues.map((entry) =>
        issue(
          `eval.input.${entry.code.replace(/^config\./u, "")}`,
          entry.path,
          "evaluation input could not be loaded safely",
        ),
      ),
      error,
    );
  }
}

function behaviorOverlapIssues(scenario: Scenario, index: number): EvaluationInputIssue[] {
  const expected = new Set<string>();
  const issues: EvaluationInputIssue[] = [];
  for (
    let behaviorIndex = 0;
    behaviorIndex < scenario.expectedBehavior.length;
    behaviorIndex += 1
  ) {
    const normalized = normalizeComparableTextSnapshot(
      scenario.expectedBehavior[behaviorIndex] as string,
    );
    if (normalized === "" || expected.has(normalized)) {
      issues.push(
        issue(
          "eval.suite.duplicate_behavior",
          `/scenarios/${index}/expectedBehavior/${behaviorIndex}`,
          "expected behaviors must be distinct after normalization",
        ),
      );
    }
    expected.add(normalized);
  }

  const forbidden = new Set<string>();
  for (
    let behaviorIndex = 0;
    behaviorIndex < (scenario.forbiddenBehavior?.length ?? 0);
    behaviorIndex += 1
  ) {
    const normalized = normalizeComparableTextSnapshot(
      scenario.forbiddenBehavior?.[behaviorIndex] as string,
    );
    if (normalized === "" || forbidden.has(normalized)) {
      issues.push(
        issue(
          "eval.suite.duplicate_behavior",
          `/scenarios/${index}/forbiddenBehavior/${behaviorIndex}`,
          "forbidden behaviors must be distinct after normalization",
        ),
      );
    }
    if (expected.has(normalized)) {
      issues.push(
        issue(
          "eval.suite.conflicting_behavior",
          `/scenarios/${index}/forbiddenBehavior/${behaviorIndex}`,
          "a behavior cannot be both expected and forbidden",
        ),
      );
    }
    forbidden.add(normalized);
  }
  return issues;
}

function suiteSemanticIssues(value: SkillPressEvaluationSuite): EvaluationInputIssue[] {
  const issues: EvaluationInputIssue[] = [];
  const ids = new Set<string>();
  const prompts = new Set<string>();
  for (let index = 0; index < value.scenarios.length; index += 1) {
    const scenario = value.scenarios[index] as Scenario;
    const path = `/scenarios/${index}`;
    if (ids.has(scenario.id)) {
      issues.push(issue("eval.suite.duplicate_id", `${path}/id`, "scenario ids must be unique"));
    }
    ids.add(scenario.id);

    const prompt = normalizeComparableTextSnapshot(scenario.prompt);
    if (prompt === "" || prompts.has(prompt)) {
      issues.push(
        issue(
          "eval.suite.duplicate_prompt",
          `${path}/prompt`,
          "scenario prompts must be distinct after normalization",
        ),
      );
    }
    prompts.add(prompt);

    const shouldActivate = scenario.category !== "near-miss";
    if (scenario.shouldActivate !== shouldActivate) {
      issues.push(
        issue(
          "eval.suite.activation_mismatch",
          `${path}/shouldActivate`,
          "activation expectation does not match the scenario category",
        ),
      );
    }
    if (
      (scenario.category === "near-miss" || scenario.category === "adversarial") &&
      scenario.forbiddenBehavior === undefined
    ) {
      issues.push(
        issue(
          "eval.suite.forbidden_behavior_required",
          `${path}/forbiddenBehavior`,
          "near-miss and adversarial scenarios require forbidden behavior",
        ),
      );
    }
    if (
      value.suite === "holdout" &&
      scenario.category !== "positive" &&
      scenario.category !== "near-miss"
    ) {
      issues.push(
        issue(
          "eval.suite.holdout_category",
          `${path}/category`,
          "holdout suites may contain only positive and near-miss scenarios",
        ),
      );
    }
    issues.push(...behaviorOverlapIssues(scenario, index));
  }
  return issues;
}

export async function loadEvaluationSuite(path: string): Promise<SkillPressEvaluationSuite> {
  const value = await loadInput(path);
  if (!validateSuite(value)) {
    throw new EvaluationInputError(
      "Evaluation suite does not match schema version 1.",
      schemaIssues("suite", validateSuite.errors as ErrorObject[]),
    );
  }
  const issues = suiteSemanticIssues(value);
  if (issues.length > 0) {
    throw new EvaluationInputError("Evaluation suite is not semantically valid.", issues);
  }
  return value;
}

export async function loadEvaluationRubric(path: string): Promise<SkillPressEvaluationRubric> {
  const value = await loadInput(path);
  if (!validateRubric(value)) {
    throw new EvaluationInputError(
      "Evaluation rubric does not match schema version 1.",
      schemaIssues("rubric", validateRubric.errors as ErrorObject[]),
    );
  }
  const issues: EvaluationInputIssue[] = [];
  const ids = new Set<string>();
  let total = 0;
  for (let index = 0; index < value.criteria.length; index += 1) {
    const criterion = value.criteria[index] as (typeof value.criteria)[number];
    if (ids.has(criterion.id)) {
      issues.push(
        issue(
          "eval.rubric.duplicate_id",
          `/criteria/${index}/id`,
          "rubric criterion ids must be unique",
        ),
      );
    }
    ids.add(criterion.id);
    total += criterion.weight;
  }
  if (total !== 100) {
    issues.push(
      issue("eval.rubric.weight_total", "/criteria", "rubric criterion weights must total 100"),
    );
  }
  if (issues.length > 0) {
    throw new EvaluationInputError("Evaluation rubric is not semantically valid.", issues);
  }
  return value;
}

function crossSuiteIssues(
  training: SkillPressEvaluationSuite,
  holdout: SkillPressEvaluationSuite,
): EvaluationInputIssue[] {
  const trainingIds = new Set(training.scenarios.map((scenario) => scenario.id));
  const trainingPrompts = new Set(
    training.scenarios.map((scenario) => normalizeComparableTextSnapshot(scenario.prompt)),
  );
  const issues: EvaluationInputIssue[] = [];
  for (let index = 0; index < holdout.scenarios.length; index += 1) {
    const scenario = holdout.scenarios[index] as Scenario;
    if (trainingIds.has(scenario.id)) {
      issues.push(
        issue(
          "eval.holdout.id_leakage",
          `/holdout/scenarios/${index}/id`,
          "holdout scenario id is also present in training",
        ),
      );
    }
    if (trainingPrompts.has(normalizeComparableTextSnapshot(scenario.prompt))) {
      issues.push(
        issue(
          "eval.holdout.prompt_leakage",
          `/holdout/scenarios/${index}/prompt`,
          "holdout prompt is also present in training after normalization",
        ),
      );
    }
  }
  return issues;
}

export async function loadProjectEvaluationInputs(
  projectDirectory: string = process.cwd(),
): Promise<ProjectEvaluationInputs> {
  if (!isSafePathInput(projectDirectory)) {
    throw new TypeError("projectDirectory must be a bounded, unambiguous filesystem path.");
  }
  const root = resolve(projectDirectory);
  const [config, training, holdout, rubric] = await Promise.all([
    loadProjectConfig(root),
    loadEvaluationSuite(join(root, TRAINING_SUITE_PATH)),
    loadEvaluationSuite(join(root, HOLDOUT_SUITE_PATH)),
    loadEvaluationRubric(join(root, EVALUATION_RUBRIC_PATH)),
  ]);
  const issues: EvaluationInputIssue[] = [];
  if (training.suite !== "training") {
    issues.push(
      issue("eval.training.suite", "/training/suite", "training input must declare training"),
    );
  }
  if (holdout.suite !== "holdout") {
    issues.push(
      issue("eval.holdout.suite", "/holdout/suite", "holdout input must declare holdout"),
    );
  }
  if (training.skill !== config.skill.name) {
    issues.push(
      issue(
        "eval.training.skill",
        "/training/skill",
        "training input must target the canonical skill",
      ),
    );
  }
  if (holdout.skill !== config.skill.name) {
    issues.push(
      issue(
        "eval.holdout.skill",
        "/holdout/skill",
        "holdout input must target the canonical skill",
      ),
    );
  }
  issues.push(...crossSuiteIssues(training, holdout));
  if (issues.length > 0) {
    throw new EvaluationInputError("Project evaluation inputs do not agree.", issues);
  }
  return Object.freeze({ training, holdout, rubric });
}
