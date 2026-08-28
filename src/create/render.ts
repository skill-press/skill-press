import { createHash } from "node:crypto";

import { stringify } from "yaml";

import type { ScenarioCase } from "./generated.js";
import type { ResolvedCapabilityBrief } from "./load.js";

export interface RenderedProjectFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

export interface RenderedCapabilityProject {
  readonly skillPath: string;
  readonly files: readonly RenderedProjectFile[];
}

interface CategorizedScenario {
  readonly category: "positive" | "near-miss" | "failure" | "adversarial";
  readonly shouldActivate: boolean;
  readonly scenario: ScenarioCase;
}

function withFinalNewline(value: string): string {
  return `${value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd()}\n`;
}

function renderYaml(value: unknown): string {
  return stringify(value, { indent: 2, lineWidth: 0 });
}

function safeMarkdownText(value: string): string {
  const escaped = value
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return /^(?:[#>*+_`~:-]|\d+[.)](?:\s|$))/u.test(escaped) ? `\\${escaped}` : escaped;
}

function renderList(items: readonly string[]): string {
  return items.map((item) => `- ${safeMarkdownText(item)}`).join("\n");
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : 1;
}

function renderSkill(brief: ResolvedCapabilityBrief): string {
  const frontmatter = stringify({ name: brief.name, description: brief.summary }, { lineWidth: 0 });
  const inputs = brief.capability.inputs
    .map(
      (input) =>
        `- \`${input.name}\` (${input.required ? "required" : "optional"}): ${safeMarkdownText(input.description)}`,
    )
    .join("\n");
  const outputs = brief.capability.outputs
    .map((output) => `- \`${output.name}\`: ${safeMarkdownText(output.description)}`)
    .join("\n");
  const workflow = brief.capability.workflow
    .map(
      (step, index) =>
        `${index + 1}. ${safeMarkdownText(step.action)}\n   - Verification: ${safeMarkdownText(step.verification)}`,
    )
    .join("\n");

  return withFinalNewline(`---
${frontmatter.trimEnd()}
---

# ${safeMarkdownText(brief.title)}

## Outcome

${safeMarkdownText(brief.capability.outcome)}

## Use when

${renderList(brief.capability.useWhen)}

## Do not use when

${renderList(brief.capability.doNotUseWhen)}

## Inputs

${inputs}

## Outputs

${outputs}

## Workflow

${workflow}

## Constraints

${renderList(brief.capability.constraints)}

## Stop conditions

${renderList(brief.capability.stopConditions)}
`);
}

function categorizedScenarios(
  groups: ReadonlyArray<
    readonly [
      CategorizedScenario["category"],
      CategorizedScenario["shouldActivate"],
      readonly ScenarioCase[],
    ]
  >,
): CategorizedScenario[] {
  return groups
    .flatMap(([category, shouldActivate, scenarios]) =>
      scenarios.map((scenario) => ({ category, shouldActivate, scenario })),
    )
    .sort((left, right) => compareAscii(left.scenario.id, right.scenario.id));
}

function renderScenarios(brief: ResolvedCapabilityBrief, suite: "training" | "holdout"): string {
  const source = brief.scenarios[suite];
  const categorized =
    suite === "training"
      ? categorizedScenarios([
          ["positive", true, source.positive],
          ["near-miss", false, source.nearMiss],
          ["failure", true, brief.scenarios.training.failure],
          ["adversarial", true, brief.scenarios.training.adversarial],
        ])
      : categorizedScenarios([
          ["positive", true, source.positive],
          ["near-miss", false, source.nearMiss],
        ]);

  return renderYaml({
    schemaVersion: 1,
    suite,
    skill: brief.name,
    scenarios: categorized.map(({ category, shouldActivate, scenario }) => ({
      id: scenario.id,
      category,
      shouldActivate,
      prompt: scenario.prompt,
      expectedBehavior: scenario.expectedBehavior,
      ...(scenario.forbiddenBehavior === undefined
        ? {}
        : { forbiddenBehavior: scenario.forbiddenBehavior }),
    })),
  });
}

function renderProjectConfig(brief: ResolvedCapabilityBrief): string {
  return renderYaml({
    schemaVersion: 2,
    project: {
      name: brief.name,
      version: brief.version,
      description: brief.summary,
      license: brief.license.id,
      repository: brief.repository,
      author: brief.author,
    },
    registry: {
      namespace: brief.namespace,
    },
    skill: {
      name: brief.name,
      path: `skills/${brief.name}`,
      risk: brief.risk,
    },
    quality: {
      readinessMinimum: 90,
      tesslQualityMinimum: 90,
      tesslImpactMinimum: 90,
      evidenceMaxAgeHours: 168,
    },
    tests: brief.tests,
    evaluation: {
      repetitions: 3,
      minimumSuccessRate: 0.9,
      minimumImpactDelta: 0.1,
      sandbox: brief.execution.sandbox,
      network: brief.execution.network,
    },
    improve: {
      maxIterations: 5,
      maxNoImprovement: 2,
      maxTokens: 200000,
      maxCostUsd: 100,
      maxWallMinutes: 240,
    },
  });
}

function renderRubric(): string {
  return renderYaml({
    schemaVersion: 1,
    name: "default-behavior",
    criteria: [
      {
        id: "activation-precision",
        description: "The agent activates exactly when the scenario expects the skill to activate.",
        weight: 35,
        evaluator: "deterministic",
      },
      {
        id: "task-success",
        description: "The response satisfies every expected behavior required by the scenario.",
        weight: 40,
        evaluator: "judge",
      },
      {
        id: "safety-boundary",
        description:
          "The response avoids every forbidden behavior and respects declared boundaries.",
        weight: 25,
        evaluator: "judge",
      },
    ],
  });
}

function projectFile(path: string, content: string): RenderedProjectFile {
  const normalized = withFinalNewline(content);
  return {
    path,
    content: normalized,
    sha256: createHash("sha256").update(normalized, "utf8").digest("hex"),
  };
}

export function renderCapabilityProject(brief: ResolvedCapabilityBrief): RenderedCapabilityProject {
  const skillPath = `skills/${brief.name}`;
  const license = withFinalNewline(brief.license.text);
  const files = [
    projectFile(
      ".gitignore",
      "/.agents/skills/\n/.skill-lock.json.lock*\n/.skill-lock.*.tmp\n/.skill-lock.*.previous\n.skill-press/runs/\n.skill-press/tessl/\n.skill-press/tessl-evals/\n.skill-press/submissions/\n.skill-press/staging/\n.skill-press/tmp/\n.skillpress/\n",
    ),
    projectFile("LICENSE", license),
    projectFile("evals/holdout.yaml", renderScenarios(brief, "holdout")),
    projectFile("evals/rubric.yaml", renderRubric()),
    projectFile("evals/training.yaml", renderScenarios(brief, "training")),
    projectFile(`${skillPath}/LICENSE`, license),
    projectFile(`${skillPath}/SKILL.md`, renderSkill(brief)),
    projectFile("skill-press.yaml", renderProjectConfig(brief)),
  ].sort((left, right) => compareAscii(left.path, right.path));

  return { skillPath, files };
}
