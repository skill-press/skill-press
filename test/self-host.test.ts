import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkProject } from "../src/check/project.js";
import { loadProjectConfig } from "../src/config/load.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

describe("Skill Press self-hosted project", () => {
  it("passes its own local readiness gate", async () => {
    const report = await checkProject(repositoryRoot);

    expect(report).toMatchObject({
      schemaVersion: 1,
      ok: true,
      eligible: true,
      score: 100,
      minimum: 90,
      project: { name: "skill-press", version: "0.1.0", skillPath: "skills/skill-press" },
      diagnostics: [],
    });
  });

  it("binds the canonical skill, deterministic tests, and private holdout input", async () => {
    const config = await loadProjectConfig(repositoryRoot);
    const skill = await readFile(
      new URL("../skills/skill-press/SKILL.md", import.meta.url),
      "utf8",
    );
    const authoring = await readFile(
      new URL("../skills/skill-press/references/authoring-and-evaluation.md", import.meta.url),
      "utf8",
    );
    const holdout = await readFile(new URL("../evals/holdout.yaml", import.meta.url), "utf8");

    expect(config.skill).toEqual({
      name: "skill-press",
      path: "skills/skill-press",
      risk: "moderate",
    });
    expect(config.tests.commands).toEqual([
      { name: "repository quality gates", argv: ["npm", "run", "check"], timeoutSeconds: 600 },
    ]);
    expect(holdout).toContain("suite: holdout");
    expect(holdout).not.toContain("passed:");
    expect(holdout).not.toContain("score:");
    for (const path of ["evals/training.yaml", "evals/holdout.yaml", "evals/rubric.yaml"]) {
      expect(`${skill}\n${authoring}`).toContain(path);
    }
  });
});
