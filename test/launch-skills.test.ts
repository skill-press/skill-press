import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { validateAgentSkill } from "../src/validate/agent-skill.js";
import { stageCanonicalSkill } from "../src/package/stage.js";
import { packageStagedSkill, loadPackagedSkill } from "../src/package/archive.js";
import { loadEvaluationSuite, loadEvaluationRubric } from "../src/eval/load.js";

const profiler = resolve("skills/csv-quality-check/scripts/profile.py");

describe("launch skill source candidates", () => {
  it("ships canonical release-note evaluation inputs and Tessl-independent author instructions", async () => {
    const base = "examples/launch-skills/release-notes-evals";
    const training = await loadEvaluationSuite(`${base}/training.yaml`);
    const holdout = await loadEvaluationSuite(`${base}/holdout.yaml`);
    const rubric = await loadEvaluationRubric(`${base}/rubric.yaml`);
    expect(training.skill).toBe("release-notes");
    expect(holdout.skill).toBe(training.skill);
    expect(new Set(training.scenarios.map((s) => s.category))).toEqual(
      new Set(["positive", "near-miss", "failure", "adversarial"]),
    );
    expect(new Set(holdout.scenarios.map((s) => s.category))).toEqual(
      new Set(["positive", "near-miss"]),
    );
    expect(
      rubric.criteria.filter((c) => c.evaluator === "judge").reduce((sum, c) => sum + c.weight, 0),
    ).toBeGreaterThanOrEqual(65);
    for (const scenario of holdout.scenarios) {
      expect(
        training.scenarios.some((s) => s.id === scenario.id || s.prompt === scenario.prompt),
      ).toBe(false);
    }
    const guide = await readFile("examples/launch-skills/AUTHORING.md", "utf8");
    expect(guide).toContain("--native --dry-run");
    expect(guide).toContain("--eval-source evals");
    expect(guide).not.toContain(".skill-press/tessl-evals");
  });
  it.each(["release-notes", "incident-handoff", "csv-quality-check"])(
    "stages and packages actual %s source in a separate author project",
    async (name) => {
      const root = await mkdtemp(join(tmpdir(), "launch-author-"));
      try {
        await mkdir(join(root, "skills"));
        await cp(resolve("skills", name), join(root, "skills", name), { recursive: true });
        const config = parse(await readFile("skill-press.yaml", "utf8"));
        config.project.name = name;
        config.project.description = `Local author preparation for ${name}.`;
        config.skill.name = name;
        config.skill.path = `skills/${name}`;
        await writeFile(join(root, "skill-press.yaml"), stringify(config));
        await writeFile(join(root, ".gitignore"), ".skill-press/\n");
        for (const args of [
          ["init", "--quiet"],
          ["add", "."],
          [
            "-c",
            "user.name=Local Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "Synthetic author project",
          ],
        ]) {
          const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
          expect(result.status, result.stderr).toBe(0);
        }
        const staged = await stageCanonicalSkill(root);
        const packaged = await packageStagedSkill(root, staged);
        const loaded = await loadPackagedSkill(root, packaged.artifactsPath);
        expect(loaded.skillArchive).toBe(`${name}-0.1.0.skill`);
        expect(loaded.skillSha256).toBe(staged.skillSha256);
        expect(loaded.artifactSha256).toBe(packaged.artifactSha256);
        expect(staged.files.length).toBe(name === "csv-quality-check" ? 2 : 1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["release-notes", "incident-handoff", "csv-quality-check"])(
    "validates the complete %s skill tree",
    async (name) => {
      expect(
        await validateAgentSkill(resolve("skills", name), { expectedName: name }),
      ).toMatchObject({
        ok: true,
        diagnostics: [],
      });
    },
  );

  it("profiles quoted multiline records without modifying the example", async () => {
    const file = resolve("examples/launch-skills/import.csv");
    const before = await readFile(file);
    const result = spawnSync("python3", [profiler, file], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      dataRecords: 5,
      columns: 3,
      emptyHeaderPositions: [],
      duplicateHeaderCount: 0,
      widthMismatchRecords: [5],
      blankCellsByColumn: [0, 1, 0],
      duplicateRecords: 1,
      possibleFormulaCells: 1,
    });
    expect(await readFile(file)).toEqual(before);
    expect(result.stdout).not.toContain("Ada");
  });

  it("supports BOM and alternate delimiter, and rejects invalid inputs without raw data", async () => {
    const root = await mkdtemp(join(tmpdir(), "launch-csv-"));
    const file = join(root, "input.csv");
    try {
      await writeFile(file, "\ufeffid;id;\n001;  ;@private-value\n");
      const valid = spawnSync("python3", [profiler, file, "--delimiter", ";"], {
        encoding: "utf8",
      });
      expect(valid.status).toBe(0);
      expect(JSON.parse(valid.stdout)).toMatchObject({
        emptyHeaderPositions: [3],
        duplicateHeaderCount: 1,
        blankCellsByColumn: [0, 1, 0],
        possibleFormulaCells: 1,
      });
      expect(valid.stdout).not.toContain("private-value");
      for (const data of [
        Buffer.from([0xff]),
        Buffer.from('name\n"private-value'),
        Buffer.alloc(0),
        Buffer.alloc(10 * 1024 * 1024 + 1, "a"),
      ]) {
        await writeFile(file, data);
        const result = spawnSync("python3", [profiler, file], { encoding: "utf8" });
        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr)).toMatchObject({ ok: false });
        expect(result.stderr).not.toContain("private-value");
        expect((await readFile(file)).equals(data)).toBe(true);
      }
      expect(spawnSync("python3", [profiler, file, "--delimiter", "xx"]).status).toBe(2);
      expect(spawnSync("python3", [profiler, join(root, "missing.csv")]).status).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
