import { describe, expect, it } from "vitest";

import * as skillPress from "../src/index.js";

describe("Skill Press public API", () => {
  it("exports the canonical CLI, project, and submission entrypoints", () => {
    expect(skillPress.VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(skillPress.renderHelp()).toContain(`Skill Press CLI ${skillPress.VERSION}`);
    expect(skillPress.renderHelp()).toContain(
      "Build, verify, submit, and install trusted agent skills.",
    );
    expect(skillPress.renderInitHelp()).toContain("skpress init");
    expect(skillPress.renderCheckHelp()).toContain("skpress check");
    expect(skillPress.renderTestHelp()).toContain("skpress test");
    expect(skillPress.renderEvalHelp()).toContain("skpress eval");
    expect(skillPress.renderPackageHelp()).toContain("skpress package");
    expect(skillPress.renderSubmitHelp()).toContain("skpress submit");
    expect(skillPress.runCli).toBeTypeOf("function");
    expect(skillPress.checkProject).toBeTypeOf("function");
    expect(skillPress.runProjectTests).toBeTypeOf("function");
    expect(skillPress.loadEvaluationSuite).toBeTypeOf("function");
    expect(skillPress.loadEvaluationRubric).toBeTypeOf("function");
    expect(skillPress.loadProjectEvaluationInputs).toBeTypeOf("function");
    expect(skillPress.EvaluationInputError).toBeTypeOf("function");
    expect(skillPress.createSandboxInvocation).toBeTypeOf("function");
    expect(skillPress.SandboxPolicyError).toBeTypeOf("function");
    expect(skillPress.runPairedEvaluation).toBeTypeOf("function");
    expect(skillPress.EvaluationRunError).toBeTypeOf("function");
    expect(skillPress.MAX_TEST_OUTPUT_BYTES).toBe(1024 * 1024);
    expect(skillPress.ProjectCreationError).toBeTypeOf("function");
    expect(skillPress.writeRenderedProject).toBeTypeOf("function");
    expect(skillPress.validateAgentSkill).toBeTypeOf("function");
    expect(skillPress.MAX_SKILL_DIAGNOSTICS).toBe(256);
    expect(skillPress.CONFIG_FILE_NAME).toBe("skill-press.yaml");
    expect(skillPress.LEGACY_CONFIG_FILE_NAME).toBe("skillpress.yaml");
    expect(skillPress.createCanonicalSubmissionClient).toBeTypeOf("function");
    expect(skillPress.prepareSkillSubmission).toBeTypeOf("function");
    expect(skillPress.runSkillSubmission).toBeTypeOf("function");
    expect(skillPress.readSubmissionReceipt).toBeTypeOf("function");
    expect(skillPress.SKILL_PRESS_ORIGIN).toBe("https://skill-press.com");
    expect(skillPress.SKILL_PRESS_TOKEN_ENV).toBe("SKILL_PRESS_TOKEN");
    expect(skillPress.createCanonicalDiscoveryClient).toBeTypeOf("function");
    expect(skillPress.computeDiscoverySnapshotSha256).toBeTypeOf("function");
    expect(skillPress.SKILL_PRESS_DISCOVERY_URL).toBe("https://skill-press.com/api/v1/discovery");
    expect(skillPress.DISCOVERY_SNAPSHOT_DOMAIN).toBe("skillpress.discovery-snapshot.v1\n");
    expect(skillPress.SERVER_REVIEW_POLICY).toMatchObject({
      id: "skillpress.server-review",
      version: 1,
      tesslVersion: "0.101.0",
      qualityMinimum: 90,
      impactMinimum: 90,
      evidenceMaxAgeHours: 168,
    });
  });

  it("does not expose the retired multi-provider publication surface", () => {
    for (const retired of [
      "renderCreateHelp",
      "renderPublishHelp",
      "runPublicationSaga",
      "readPublicationReceipt",
      "createGitHubPublicationAdapter",
      "createNpmPublicationAdapter",
      "createAskillPublicationAdapter",
      "createAgentSkillHubPublicationAdapter",
      "createAgentSkillsHubCatalogAdapter",
      "createClawHubPublicationAdapter",
      "createSkillsShDerivedAdapter",
      "createTesslPublicationAdapter",
    ]) {
      expect(skillPress).not.toHaveProperty(retired);
    }
  });

  it("does not expose install test seams that can replace production trust roots", () => {
    for (const internal of [
      "addTrustedSkill",
      "installTrustedSkills",
      "createCanonicalInstallClient",
    ]) {
      expect(skillPress).not.toHaveProperty(internal);
    }
    expect(skillPress.parseExactSkillLocator).toBeTypeOf("function");
    expect(skillPress.readSkillLock).toBeTypeOf("function");
    expect(skillPress.SKILL_PRESS_PINNED_KEYS).toHaveLength(3);
  });
});
