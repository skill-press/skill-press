import { describe, expect, it } from "vitest";

import * as skillpress from "../src/index.js";

describe("public API", () => {
  it("exports the CLI scaffold and project writer entrypoints", () => {
    expect(skillpress.VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(skillpress.renderHelp()).toContain(skillpress.VERSION);
    expect(skillpress.renderCreateHelp()).toContain("skillpress create");
    expect(skillpress.renderCheckHelp()).toContain("skillpress check");
    expect(skillpress.runCli).toBeTypeOf("function");
    expect(skillpress.checkProject).toBeTypeOf("function");
    expect(skillpress.ProjectCreationError).toBeTypeOf("function");
    expect(skillpress.writeRenderedProject).toBeTypeOf("function");
    expect(skillpress.validateAgentSkill).toBeTypeOf("function");
    expect(skillpress.MAX_SKILL_DIAGNOSTICS).toBe(256);
  });
});
