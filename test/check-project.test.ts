import { realpathSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { checkProject } from "../src/check/project.js";
import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";

const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function generatedProject(): Promise<string> {
  const parent = await mkdtemp(join(temporaryRoot, "skillpress-check-test-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "project");
  const rendered = renderCapabilityProject(await loadCapabilityBrief(briefPath));
  await writeRenderedProject(rendered, root);
  return root;
}

describe("project readiness check", () => {
  it("passes the complete generated project with a truthful local readiness score", async () => {
    const root = await generatedProject();

    const report = await checkProject(root);

    expect(report).toMatchObject({
      schemaVersion: 1,
      ok: true,
      eligible: true,
      score: 100,
      minimum: 90,
      project: {
        name: "incident-summary",
        version: "0.1.0",
        skillPath: "skills/incident-summary",
      },
    });
    expect(report.criteria).toHaveLength(5);
    expect(report.criteria.every((entry) => entry.passed)).toBe(true);
    expect(report.diagnostics.map((entry) => entry.code)).toEqual(["skill.license.missing"]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.criteria)).toBe(true);
    expect(Object.isFrozen(report.diagnostics)).toBe(true);
    expect(JSON.stringify(report)).not.toContain(root);
    expect(JSON.stringify(report)).not.toContain("tesslQuality");
  });

  it("fails closed when the canonical skill contains a placeholder", async () => {
    const root = await generatedProject();
    const skillPath = join(root, "skills/incident-summary/SKILL.md");
    const skill = await readFile(skillPath, "utf8");
    await writeFile(skillPath, skill.replace("# Incident Summary", "# TODO: finish title"));

    const report = await checkProject(root);

    expect(report.ok).toBe(false);
    expect(report.eligible).toBe(false);
    expect(report.score).toBe(40);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "skill.markdown.placeholder",
          severity: "error",
          path: "skills/incident-summary/SKILL.md",
        }),
      ]),
    );
  });

  it.each([
    ["LICENSE", "project.license_missing", "licenses"],
    ["evals/holdout.yaml", "project.scenarios_missing", "scenarios"],
  ] as const)("fails closed when %s is absent", async (relativePath, code, criterionId) => {
    const root = await generatedProject();
    await unlink(join(root, relativePath));

    const report = await checkProject(root);

    expect(report.ok).toBe(false);
    expect(report.eligible).toBe(false);
    expect(report.score).toBe(90);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code, path: relativePath }),
    );
    expect(report.criteria).toContainEqual(
      expect.objectContaining({ id: criterionId, passed: false, earned: 0 }),
    );
  });

  it("does not accept a symbolic link as a required evaluation input", async () => {
    const root = await generatedProject();
    const rubricPath = join(root, "evals/rubric.yaml");
    await unlink(rubricPath);
    symlinkSync(join(root, "evals/training.yaml"), rubricPath);

    const report = await checkProject(root);

    expect(report.ok).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "project.scenarios_missing", path: "evals/rubric.yaml" }),
    );
  });

  it("requires project and canonical skill names to agree", async () => {
    const root = await generatedProject();
    const configPath = join(root, "skill-press.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, config.replace("name: incident-summary", "name: other-project"));

    const report = await checkProject(root);

    expect(report.ok).toBe(false);
    expect(report.score).toBe(90);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "project.skill_name_mismatch", path: "/skill/name" }),
    );
  });

  it("fails readiness when evaluation inputs are semantically invalid", async () => {
    const root = await generatedProject();
    const rubricPath = join(root, "evals/rubric.yaml");
    const rubric = await readFile(rubricPath, "utf8");
    await writeFile(rubricPath, rubric.replace("weight: 40", "weight: 39"));

    const report = await checkProject(root);

    expect(report.ok).toBe(false);
    expect(report.score).toBe(90);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "eval.rubric.weight_total", path: "/criteria" }),
    );
    expect(report.criteria).toContainEqual(
      expect.objectContaining({ id: "scenarios", passed: false, earned: 0 }),
    );
  });

  it("maps location-free validator warnings without inventing coordinates", async () => {
    const root = await generatedProject();
    const skillPath = join(root, "skills/incident-summary/SKILL.md");
    const skill = await readFile(skillPath, "utf8");
    const bodyStart = skill.indexOf("# Incident Summary");
    if (bodyStart < 0) throw new Error("expected generated skill body");
    await writeFile(skillPath, skill.slice(0, bodyStart));

    const report = await checkProject(root);

    expect(report.ok).toBe(true);
    expect(report.diagnostics).toContainEqual({
      code: "skill.body.empty",
      severity: "warning",
      scope: "agent-skills",
      path: "skills/incident-summary/SKILL.md",
      message: "skill instructions should contain a non-empty Markdown body",
    });
  });

  it("rejects a non-directory component in the required artifact tree", async () => {
    const root = await generatedProject();
    await rm(join(root, "evals"), { recursive: true });
    await writeFile(join(root, "evals"), "not a directory\n");

    const report = await checkProject(root);

    expect(report.ok).toBe(false);
    expect(
      report.diagnostics.filter((entry) => entry.code === "project.scenarios_missing"),
    ).toHaveLength(3);
  });

  it("rejects ambiguous API paths before filesystem inspection", async () => {
    await expect(checkProject("bad\u200bpath")).rejects.toThrow(TypeError);
  });
});
