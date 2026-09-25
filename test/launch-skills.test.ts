import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { validateAgentSkill } from "../src/validate/agent-skill.js";

const profiler = resolve("skills/csv-quality-check/scripts/profile.py");

describe("launch skill source candidates", () => {
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
