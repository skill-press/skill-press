import { describe, expect, it } from "vitest";

import * as skillpress from "../src/index.js";

describe("public API", () => {
  it("exports the CLI scaffold and project writer entrypoints", () => {
    expect(skillpress.VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(skillpress.renderHelp()).toContain(skillpress.VERSION);
    expect(skillpress.renderCreateHelp()).toContain("skillpress create");
    expect(skillpress.renderCheckHelp()).toContain("skillpress check");
    expect(skillpress.renderTestHelp()).toContain("skillpress test");
    expect(skillpress.renderEvalHelp()).toContain("skillpress eval");
    expect(skillpress.runCli).toBeTypeOf("function");
    expect(skillpress.checkProject).toBeTypeOf("function");
    expect(skillpress.runProjectTests).toBeTypeOf("function");
    expect(skillpress.loadEvaluationSuite).toBeTypeOf("function");
    expect(skillpress.loadEvaluationRubric).toBeTypeOf("function");
    expect(skillpress.loadProjectEvaluationInputs).toBeTypeOf("function");
    expect(skillpress.EvaluationInputError).toBeTypeOf("function");
    expect(skillpress.createSandboxInvocation).toBeTypeOf("function");
    expect(skillpress.SandboxPolicyError).toBeTypeOf("function");
    expect(skillpress.runPairedEvaluation).toBeTypeOf("function");
    expect(skillpress.EvaluationRunError).toBeTypeOf("function");
    expect(skillpress.MAX_TEST_OUTPUT_BYTES).toBe(1024 * 1024);
    expect(skillpress.ProjectCreationError).toBeTypeOf("function");
    expect(skillpress.writeRenderedProject).toBeTypeOf("function");
    expect(skillpress.validateAgentSkill).toBeTypeOf("function");
    expect(skillpress.MAX_SKILL_DIAGNOSTICS).toBe(256);
  });
});
