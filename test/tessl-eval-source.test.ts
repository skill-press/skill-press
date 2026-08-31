import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";
import { tesslSolutionAssessment } from "../src/tessl/assessment.js";
import { loadTesslEvalRubricInventories } from "../src/tessl/eval-rubric.js";
import { inspectTesslEvalSource } from "../src/tessl/eval-source.js";

const temporaryDirectories: string[] = [];
const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));
const temporaryRoot = realpathSync(tmpdir());

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function source(): Promise<string> {
  const parent = await mkdtemp(join(temporaryRoot, "skillpress-tessl-source-"));
  temporaryDirectories.push(parent);
  const project = join(parent, "project");
  await writeRenderedProject(
    renderCapabilityProject(await loadCapabilityBrief(briefPath)),
    project,
  );
  const evalSource = join(project, "eval-source");
  await mkdir(join(evalSource, ".tessl-plugin"), { recursive: true });
  await mkdir(join(evalSource, "evals"));
  await mkdir(join(evalSource, "skills"));
  await writeFile(
    join(evalSource, ".tessl-plugin", "plugin.json"),
    '{"name":"test/incident-summary","version":"0.1.0","private":true,"skills":["skills/incident-summary"]}\n',
  );
  await cp(
    join(project, "skills", "incident-summary"),
    join(evalSource, "skills", "incident-summary"),
    { recursive: true },
  );
  return evalSource;
}

describe("Tessl eval source inspection", () => {
  it("loads exact ordered rubric inventories from scenario criteria", async () => {
    const value = await source();
    await mkdir(join(value, "evals", "one"));
    const criteria =
      '{"context":"test","type":"weighted_checklist","checklist":[{"name":"critical_safety","description":"test","max_score":10},{"name":"quality","description":"test","max_score":90}]}\n';
    await writeFile(join(value, "evals", "one", "criteria.json"), criteria);
    const expected = tesslSolutionAssessment({
      assessmentResults: [
        { name: "critical_safety", score: 0, max_score: 10 },
        { name: "quality", score: 0, max_score: 90 },
      ],
    })?.inventoryKey;
    await expect(loadTesslEvalRubricInventories(value)).resolves.toEqual([expected]);
  });

  it.each([
    ["empty scenarios", async (_value: string) => undefined],
    ["flat file", async (value: string) => writeFile(join(value, "evals", "scenario.json"), "{}")],
    [
      "evals is not a directory",
      async (value: string) => {
        await rm(join(value, "evals"), { recursive: true });
        await writeFile(join(value, "evals"), "not a directory");
      },
    ],
    [
      "missing criteria",
      async (value: string) => {
        await mkdir(join(value, "evals", "one"));
      },
    ],
    [
      "invalid shape",
      async (value: string) => {
        await mkdir(join(value, "evals", "one"));
        await writeFile(join(value, "evals", "one", "criteria.json"), "[]");
      },
    ],
    [
      "invalid criterion",
      async (value: string) => {
        await mkdir(join(value, "evals", "one"));
        await writeFile(
          join(value, "evals", "one", "criteria.json"),
          '{"type":"weighted_checklist","checklist":[{"name":"critical_safety","description":7,"max_score":100}]}',
        );
      },
    ],
    [
      "missing critical",
      async (value: string) => {
        await mkdir(join(value, "evals", "one"));
        await writeFile(
          join(value, "evals", "one", "criteria.json"),
          '{"type":"weighted_checklist","checklist":[{"name":"quality","description":"test","max_score":100}]}',
        );
      },
    ],
    [
      "wrong total",
      async (value: string) => {
        await mkdir(join(value, "evals", "one"));
        await writeFile(
          join(value, "evals", "one", "criteria.json"),
          '{"type":"weighted_checklist","checklist":[{"name":"critical_safety","description":"test","max_score":99}]}',
        );
      },
    ],
  ] as const)("rejects invalid rubric source: %s", async (_name, arrange) => {
    const value = await source();
    await arrange(value);
    await expect(loadTesslEvalRubricInventories(value)).rejects.toBeInstanceOf(Error);
  });

  it("accepts an exclusive single-skill plugin with an optional dependency-free vendored project", async () => {
    const value = await source();
    await writeFile(
      join(value, ".tessl-plugin", "plugin.json"),
      '{"name":"test/incident-summary","version":"0.1.0","description":"test","private":true,"skills":["skills/incident-summary"]}\n',
    );
    await writeFile(
      join(value, "tessl.json"),
      '{"name":"test/evals","mode":"vendored","dependencies":{}}\n',
    );

    await expect(inspectTesslEvalSource(value, "incident-summary")).resolves.toMatchObject({
      structureValid: true,
      contextExclusive: true,
      skillValid: true,
      embeddedSkillSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("returns a closed report for missing structural components", async () => {
    const missing = join(temporaryRoot, `skillpress-missing-${process.pid}-${Date.now()}`);
    await expect(inspectTesslEvalSource(missing, "incident-summary")).resolves.toEqual({
      structureValid: false,
      contextExclusive: false,
      skillValid: false,
      embeddedSkillSha256: null,
    });

    const value = await source();
    await rm(join(value, ".tessl-plugin", "plugin.json"));
    await expect(inspectTesslEvalSource(value, "incident-summary")).resolves.toMatchObject({
      structureValid: false,
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["non-object JSON", "[]"],
    [
      "unexpected field",
      '{"name":"test/x","version":"1.0.0","private":true,"skills":["skills/incident-summary"],"rules":[]}',
    ],
    [
      "invalid name",
      '{"name":7,"version":"1.0.0","private":true,"skills":["skills/incident-summary"]}',
    ],
    [
      "invalid version",
      '{"name":"test/x","version":7,"private":true,"skills":["skills/incident-summary"]}',
    ],
    [
      "invalid description",
      '{"name":"test/x","version":"1.0.0","description":7,"private":true,"skills":["skills/incident-summary"]}',
    ],
    [
      "public plugin",
      '{"name":"test/x","version":"1.0.0","private":false,"skills":["skills/incident-summary"]}',
    ],
    ["missing skills", '{"name":"test/x","version":"1.0.0","private":true}'],
    [
      "invalid skills",
      '{"name":"test/x","version":"1.0.0","private":true,"skills":"skills/incident-summary"}',
    ],
    ["empty skills", '{"name":"test/x","version":"1.0.0","private":true,"skills":[]}'],
    [
      "extra skill declaration",
      '{"name":"test/x","version":"1.0.0","private":true,"skills":["skills/incident-summary","skills/answer-key"]}',
    ],
    [
      "wrong skill declaration",
      '{"name":"test/x","version":"1.0.0","private":true,"skills":["skills/answer-key"]}',
    ],
  ] as const)("rejects plugin manifest context: %s", async (_name, manifest) => {
    const value = await source();
    await writeFile(join(value, ".tessl-plugin", "plugin.json"), `${manifest}\n`);
    await expect(inspectTesslEvalSource(value, "incident-summary")).resolves.toMatchObject({
      structureValid: true,
      contextExclusive: false,
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["non-object JSON", "[]"],
    ["unexpected field", '{"name":"test/x","mode":"vendored","dependencies":{},"rules":[]}'],
    ["invalid name", '{"name":7,"mode":"vendored","dependencies":{}}'],
    ["wrong mode", '{"name":"test/x","mode":"linked","dependencies":{}}'],
    ["invalid dependencies", '{"name":"test/x","mode":"vendored","dependencies":[]}'],
    [
      "non-empty dependencies",
      '{"name":"test/x","mode":"vendored","dependencies":{"answer-key":"1.0.0"}}',
    ],
  ] as const)("rejects Tessl project context: %s", async (_name, project) => {
    const value = await source();
    await writeFile(join(value, "tessl.json"), `${project}\n`);
    await expect(inspectTesslEvalSource(value, "incident-summary")).resolves.toMatchObject({
      structureValid: true,
      contextExclusive: false,
    });
  });

  it("rejects extra root, plugin, and skill context", async () => {
    const root = await source();
    await writeFile(join(root, "rules.md"), "hidden\n");
    expect((await inspectTesslEvalSource(root, "incident-summary")).contextExclusive).toBe(false);

    const plugin = await source();
    await writeFile(join(plugin, ".tessl-plugin", "extra.json"), "{}\n");
    expect((await inspectTesslEvalSource(plugin, "incident-summary")).contextExclusive).toBe(false);

    const skills = await source();
    await cp(join(skills, "skills", "incident-summary"), join(skills, "skills", "answer-key"), {
      recursive: true,
    });
    expect((await inspectTesslEvalSource(skills, "incident-summary")).contextExclusive).toBe(false);
  });

  it("reports an invalid embedded skill without producing its digest", async () => {
    const value = await source();
    await writeFile(join(value, "skills", "incident-summary", "SKILL.md"), "invalid\n");

    await expect(inspectTesslEvalSource(value, "incident-summary")).resolves.toMatchObject({
      structureValid: true,
      contextExclusive: true,
      skillValid: false,
      embeddedSkillSha256: null,
    });
  });
});
