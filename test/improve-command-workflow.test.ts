import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { loadProjectConfig } from "../src/config/load.js";
import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";
import { digestBoundedTree } from "../src/evidence/tree-digest.js";
import type {
  LegEvidence,
  RepetitionEvidence,
  SkillPressPairedEvaluationEvidence,
} from "../src/eval/generated-evidence.js";
import { loadProjectEvaluationInputs } from "../src/eval/load.js";
import {
  runCommandImprovement,
  type CommandImprovementOptions,
} from "../src/improve/command-workflow.js";
import {
  candidateFilesFromDirectory,
  improvementCandidateSha256,
  loadImprovementProjectInputs,
} from "../src/improve/project-input.js";
import { ImprovementWorkflowError } from "../src/improve/workflow-error.js";

const execFileAsync = promisify(execFile);
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function leg(
  seed: string,
  successful: boolean,
  activated: boolean,
  skillSha256: string | null,
): LegEvidence {
  return {
    runId: digest(`run:${seed}`),
    status: "passed",
    activated,
    loadedSkillSha256: skillSha256,
    rubricScore: successful ? 95 : 30,
    successful,
    inputSha256: digest(`input:${seed}`),
    transcript: { bytes: 0, sha256: digest(""), redactedExcerpt: "" },
    engineStdoutSha256: digest(`stdout:${seed}`),
    engineStderrSha256: digest(`stderr:${seed}`),
  };
}

async function fixture() {
  const parent = await mkdtemp(join(temporaryRoot, "skillpress-improve-command-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "project");
  await writeRenderedProject(renderCapabilityProject(await loadCapabilityBrief(briefPath)), root);
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=SkillPress Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  const config = await loadProjectConfig(root);
  const inputs = await loadProjectEvaluationInputs(root);
  const skillSha256 = await digestBoundedTree(join(root, config.skill.path));
  const configSha256 = digest(`${JSON.stringify(config)}\n`);
  const writeEvidence = async (suite: "training" | "holdout", runByte: string) => {
    const evaluationSuite = suite === "training" ? inputs.training : inputs.holdout;
    let successes = 0;
    let total = 0;
    const scenarioResults = evaluationSuite.scenarios.map((scenario, scenarioIndex) => {
      const runs: RepetitionEvidence[] = [];
      for (let repetition = 1; repetition <= config.evaluation.repetitions; repetition += 1) {
        const successful = scenarioIndex !== 0;
        if (successful) successes += 1;
        total += 1;
        runs.push({
          repetition,
          baseline: leg(`${suite}:${scenario.id}:${repetition}:baseline`, false, false, null),
          withSkill: leg(
            `${suite}:${scenario.id}:${repetition}:with-skill`,
            successful,
            scenario.shouldActivate,
            skillSha256,
          ),
        });
      }
      return {
        id: scenario.id,
        expectedActivation: scenario.shouldActivate,
        runs: runs as [RepetitionEvidence, ...RepetitionEvidence[]],
      };
    });
    const withSkillSuccessRate = Math.round((successes / total) * 1_000_000) / 1_000_000;
    const runId = runByte.repeat(64);
    const storagePath = `.skillpress/runs/${runId}`;
    const evidence: SkillPressPairedEvaluationEvidence = {
      schemaVersion: 1,
      evidenceType: "skillpress.paired-eval",
      runId,
      createdAt: "2026-08-24T12:00:00.000Z",
      project: { name: config.project.name, version: config.project.version },
      suite,
      model: "model",
      adapter: {
        backend: config.evaluation.sandbox,
        image: `adapter@sha256:${"9".repeat(64)}`,
        commandSha256: "8".repeat(64),
      },
      skillSha256,
      configSha256,
      repetitions: config.evaluation.repetitions,
      scenarioResults: scenarioResults as SkillPressPairedEvaluationEvidence["scenarioResults"],
      summary: {
        baselineSuccessRate: 0,
        withSkillSuccessRate,
        impactDelta: withSkillSuccessRate,
        minimumSuccessRate: config.evaluation.minimumSuccessRate,
        minimumImpactDelta: config.evaluation.minimumImpactDelta,
        behavioralGatePassed: false,
      },
      evidenceEligible: false,
      ineligibilityReasons: ["behavioral_gate_failed"],
      storagePath,
    };
    await mkdir(join(root, storagePath), { recursive: true, mode: 0o700 });
    await chmod(join(root, ".skillpress"), 0o700);
    await chmod(join(root, ".skillpress/runs"), 0o700);
    await chmod(join(root, storagePath), 0o700);
    const evidencePath = `${storagePath}/evidence.json`;
    await writeFile(join(root, evidencePath), `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
    await chmod(join(root, evidencePath), 0o600);
    return evidencePath;
  };
  return {
    root,
    parent,
    trainingEvidencePath: await writeEvidence("training", "a"),
    holdoutEvidencePath: await writeEvidence("holdout", "b"),
  };
}

async function writeRoleAdapters(parent: string) {
  const authorMarker = join(parent, "author-marker.json");
  const evaluatorMarker = join(parent, "evaluator-marker.txt");
  const author = join(parent, "author.mjs");
  const reviewer = join(parent, "reviewer.mjs");
  const evaluator = join(parent, "evaluator.mjs");
  await writeFile(
    author,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const request = JSON.parse(fs.readFileSync(args[args.indexOf("--request") + 1], "utf8"));
fs.writeFileSync(${JSON.stringify(authorMarker)}, JSON.stringify({holdout: JSON.stringify(request).includes("holdout-positive-escalation")}));
const files = request.payload.candidateFiles.map((file) => file.path === "SKILL.md" ? {...file, content: file.content + "\\n<!-- measured improvement -->\\n"} : file);
files.push({path:"scripts/generated.sh",content:"#!/bin/sh\\nexit 0\\n",executable:true});
const response = {schemaVersion:1,responseType:"skillpress.improve-adapter-response",operation:"author",result:{baseCandidateSha256:request.payload.context.candidateSha256,files,rationale:"Address measured training failures.",tokensUsed:10,costUsd:0.01}};
fs.writeFileSync(args[args.indexOf("--response") + 1], JSON.stringify(response));
`,
  );
  await writeFile(
    reviewer,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const response = {schemaVersion:1,responseType:"skillpress.improve-adapter-response",operation:"review",result:{approved:true,issueCodes:[]}};
fs.writeFileSync(args[args.indexOf("--response") + 1], JSON.stringify(response));
`,
  );
  await writeFile(
    evaluator,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const request = JSON.parse(fs.readFileSync(args[args.indexOf("--request") + 1], "utf8"));
fs.appendFileSync(${JSON.stringify(evaluatorMarker)}, request.operation + ":" + JSON.stringify(request).includes("holdout-positive-escalation") + "\\n");
const response = {schemaVersion:1,responseType:"skillpress.improve-adapter-response",operation:request.operation,result:{scenarioSetSha256:request.payload.scenarioSetSha256,metrics:{successRate:0.95,activationPrecision:1,safetyRate:1}}};
fs.writeFileSync(args[args.indexOf("--response") + 1], JSON.stringify(response));
`,
  );
  return { authorMarker, evaluatorMarker, author, reviewer, evaluator };
}

function roleOptions(
  value: Awaited<ReturnType<typeof fixture>>,
  roles: { author: string; reviewer: string; evaluator: string },
): CommandImprovementOptions {
  return {
    trainingEvidencePath: value.trainingEvidencePath,
    holdoutEvidencePath: value.holdoutEvidencePath,
    author: { argv: [process.execPath, roles.author] },
    reviewer: { argv: [process.execPath, roles.reviewer] },
    evaluator: { argv: [process.execPath, roles.evaluator] },
    commandTimeoutSeconds: 10,
  };
}

describe("command improvement workflow", () => {
  it("derives initial state from complete source-bound evidence without holdout disclosure", async () => {
    const value = await fixture();
    const inputs = await loadImprovementProjectInputs(value.root, value);

    expect(inputs.initial.trainingMetrics).toMatchObject({
      successRate: 0.833333,
      activationPrecision: 1,
      safetyRate: 1,
    });
    expect(inputs.initial.holdoutMetrics).toMatchObject({ successRate: 0.5 });
    expect(inputs.initial.failureIds).toHaveLength(3);
    expect(JSON.stringify(inputs.initial.trainingScenarios)).not.toContain(
      "holdout-positive-escalation",
    );
    expect(inputs.initial.candidateSha256).toBe(improvementCandidateSha256(inputs.candidateFiles));
  });

  it("runs isolated role adapters, accepts a validated candidate, and persists a redacted report", async () => {
    const value = await fixture();
    const roles = await writeRoleAdapters(value.parent);
    const before = await readFile(join(value.root, "skills/incident-summary/SKILL.md"), "utf8");
    const result = await runCommandImprovement(value.root, {
      trainingEvidencePath: value.trainingEvidencePath,
      holdoutEvidencePath: value.holdoutEvidencePath,
      author: { argv: [process.execPath, roles.author] },
      reviewer: { argv: [process.execPath, roles.reviewer] },
      evaluator: { argv: [process.execPath, roles.evaluator] },
      commandTimeoutSeconds: 10,
    });

    expect(result).toMatchObject({
      changed: true,
      report: {
        success: true,
        stopReason: "target_reached",
        iterations: [{ decision: "accepted" }],
      },
    });
    expect(await readFile(join(value.root, "skills/incident-summary/SKILL.md"), "utf8")).toBe(
      `${before}\n<!-- measured improvement -->\n`,
    );
    expect(
      await readFile(join(value.root, "skills/incident-summary/scripts/generated.sh"), "utf8"),
    ).toBe("#!/bin/sh\nexit 0\n");
    expect(JSON.parse(await readFile(roles.authorMarker, "utf8"))).toEqual({ holdout: false });
    expect(await readFile(roles.evaluatorMarker, "utf8")).toBe(
      "evaluate-training:false\nevaluate-holdout:true\n",
    );
    const reportPath = join(value.root, result.storagePath);
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(reportPath, "utf8")).not.toContain("holdout-positive-escalation");
  });

  it("rejects non-current or operationally ineligible measured evidence", async () => {
    const value = await fixture();
    const path = join(value.root, value.trainingEvidencePath);
    const evidence = JSON.parse(await readFile(path, "utf8"));
    evidence.ineligibilityReasons = ["custom_executor"];
    await writeFile(path, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });

    await expect(loadImprovementProjectInputs(value.root, value)).rejects.toBeInstanceOf(
      ImprovementWorkflowError,
    );
  });

  it("rejects invalid evidence paths, unsafe storage, unsafe files, and malformed JSON", async () => {
    const invalidPath = await fixture();
    await expect(
      loadImprovementProjectInputs(invalidPath.root, {
        trainingEvidencePath: "training.json",
        holdoutEvidencePath: invalidPath.holdoutEvidencePath,
      }),
    ).rejects.toBeInstanceOf(ImprovementWorkflowError);

    if (process.platform !== "win32") {
      const unsafeParent = await fixture();
      await chmod(join(unsafeParent.root, ".skillpress/runs"), 0o755);
      await expect(
        loadImprovementProjectInputs(unsafeParent.root, unsafeParent),
      ).rejects.toBeInstanceOf(ImprovementWorkflowError);

      const unsafeFile = await fixture();
      await chmod(join(unsafeFile.root, unsafeFile.trainingEvidencePath), 0o644);
      await expect(
        loadImprovementProjectInputs(unsafeFile.root, unsafeFile),
      ).rejects.toBeInstanceOf(ImprovementWorkflowError);
    }

    const malformed = await fixture();
    await writeFile(join(malformed.root, malformed.trainingEvidencePath), "not-json\n", {
      mode: 0o600,
    });
    await expect(loadImprovementProjectInputs(malformed.root, malformed)).rejects.toBeInstanceOf(
      ImprovementWorkflowError,
    );
  });

  it("rejects evidence suite/storage mismatches and accepts the eligible evidence form", async () => {
    const suiteMismatch = await fixture();
    await expect(
      loadImprovementProjectInputs(suiteMismatch.root, {
        trainingEvidencePath: suiteMismatch.trainingEvidencePath,
        holdoutEvidencePath: suiteMismatch.trainingEvidencePath,
      }),
    ).rejects.toBeInstanceOf(ImprovementWorkflowError);

    const storageMismatch = await fixture();
    const trainingPath = join(storageMismatch.root, storageMismatch.trainingEvidencePath);
    const mismatched = JSON.parse(await readFile(trainingPath, "utf8"));
    mismatched.storagePath = `.skillpress/runs/${"c".repeat(64)}`;
    await writeFile(trainingPath, `${JSON.stringify(mismatched)}\n`, { mode: 0o600 });
    await expect(
      loadImprovementProjectInputs(storageMismatch.root, storageMismatch),
    ).rejects.toBeInstanceOf(ImprovementWorkflowError);

    const eligible = await fixture();
    for (const path of [eligible.trainingEvidencePath, eligible.holdoutEvidencePath]) {
      const absolute = join(eligible.root, path);
      const evidence = JSON.parse(await readFile(absolute, "utf8"));
      evidence.evidenceEligible = true;
      evidence.ineligibilityReasons = [];
      evidence.summary.behavioralGatePassed = true;
      await writeFile(absolute, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
    }
    await expect(loadImprovementProjectInputs(eligible.root, eligible)).resolves.toMatchObject({
      initial: { trainingMetrics: { activationPrecision: 1 } },
    });
  });

  it("reads executable candidate files and rejects invalid or linked candidate trees", async () => {
    const value = await fixture();
    const skillRoot = join(value.root, "skills/incident-summary");
    await mkdir(join(skillRoot, "scripts"));
    await writeFile(join(skillRoot, "scripts/run.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(skillRoot, "scripts/run.sh"), 0o755);
    const files = await candidateFilesFromDirectory(skillRoot);
    expect(files).toContainEqual({
      path: "scripts/run.sh",
      content: "#!/bin/sh\nexit 0\n",
      executable: true,
    });

    const invalid = join(value.parent, "invalid-candidate");
    await mkdir(invalid);
    await writeFile(join(invalid, "LICENSE"), "license\n");
    await expect(candidateFilesFromDirectory(invalid)).rejects.toBeInstanceOf(
      ImprovementWorkflowError,
    );

    await mkdir(join(skillRoot, "assets"));
    await symlink(join(skillRoot, "LICENSE"), join(skillRoot, "assets/license-link"));
    await expect(candidateFilesFromDirectory(skillRoot)).rejects.toBeInstanceOf(
      ImprovementWorkflowError,
    );
  });

  it("rejects invalid role argv, environment, timeouts, dirty inputs, and unsafe storage", async () => {
    const value = await fixture();
    const validCommand = { argv: [process.execPath] as [string] };
    const base = {
      trainingEvidencePath: value.trainingEvidencePath,
      holdoutEvidencePath: value.holdoutEvidencePath,
      author: validCommand,
      reviewer: validCommand,
      evaluator: validCommand,
    };
    for (const author of [
      { argv: [] as unknown as [string] },
      { argv: Array.from({ length: 33 }, () => "x") as unknown as [string, ...string[]] },
      { argv: ["bad\0command"] as [string] },
      { argv: [process.execPath] as [string], env: { lowercase: "value" } },
      { argv: [process.execPath] as [string], env: { VALID_NAME: "bad\0value" } },
    ]) {
      await expect(runCommandImprovement(value.root, { ...base, author })).rejects.toBeInstanceOf(
        ImprovementWorkflowError,
      );
    }
    await expect(
      runCommandImprovement(value.root, { ...base, commandTimeoutSeconds: 7201 }),
    ).rejects.toBeInstanceOf(ImprovementWorkflowError);

    await writeFile(join(value.root, "skills/incident-summary/dirty.txt"), "dirty\n");
    await expect(runCommandImprovement(value.root, base)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "improve.git.dirty" })],
    });

    const unsafe = await fixture();
    await writeFile(join(unsafe.root, ".skillpress/improvements"), "not a directory\n");
    await expect(
      runCommandImprovement(unsafe.root, {
        ...base,
        trainingEvidencePath: unsafe.trainingEvidencePath,
        holdoutEvidencePath: unsafe.holdoutEvidencePath,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "improve.storage.unsafe" })],
    });
  });

  it("turns failed, empty, malformed, and mismatched author responses into bounded reports", async () => {
    const value = await fixture();
    const roles = await writeRoleAdapters(value.parent);
    const authorSources = [
      "process.exit(2);\n",
      "// intentionally leave the precreated response empty\n",
      `import fs from "node:fs"; const a=process.argv.slice(2); fs.writeFileSync(a[a.indexOf("--response")+1], "not-json");\n`,
      `import fs from "node:fs"; const a=process.argv.slice(2); fs.writeFileSync(a[a.indexOf("--response")+1], JSON.stringify({schemaVersion:1,responseType:"skillpress.improve-adapter-response",operation:"review",result:{approved:true,issueCodes:[]}}));\n`,
      `import fs from "node:fs"; const a=process.argv.slice(2); fs.writeFileSync(a[a.indexOf("--response")+1], JSON.stringify({schemaVersion:1,responseType:"skillpress.improve-adapter-response",operation:"author",result:{approved:true,issueCodes:[]}}));\n`,
    ];
    for (let index = 0; index < authorSources.length; index += 1) {
      const author = join(value.parent, `failing-author-${index}.mjs`);
      await writeFile(author, authorSources[index] as string);
      const result = await runCommandImprovement(
        value.root,
        roleOptions(value, { ...roles, author }),
      );
      expect(result.report).toMatchObject({ success: false, stopReason: "author_failed" });
    }
  });

  it("rejects a structurally valid proposal that fails deterministic Agent Skill validation", async () => {
    const value = await fixture();
    const roles = await writeRoleAdapters(value.parent);
    const author = join(value.parent, "invalid-candidate-author.mjs");
    await writeFile(
      author,
      `import fs from "node:fs";
const a=process.argv.slice(2); const q=JSON.parse(fs.readFileSync(a[a.indexOf("--request")+1],"utf8"));
const files=q.payload.candidateFiles.map((f)=>f.path==="SKILL.md"?{...f,content:"invalid skill"}:f);
fs.writeFileSync(a[a.indexOf("--response")+1],JSON.stringify({schemaVersion:1,responseType:"skillpress.improve-adapter-response",operation:"author",result:{baseCandidateSha256:q.payload.context.candidateSha256,files,rationale:"test",tokensUsed:1,costUsd:0.01}}));
`,
    );
    const result = await runCommandImprovement(
      value.root,
      roleOptions(value, { ...roles, author }),
    );
    expect(result.report).toMatchObject({ success: false, stopReason: "no_improvement" });
    expect(result.report.iterations[0]?.decision).toBe("deterministic_failed");
  });

  it("fails closed and restores the canonical skill when a prepared candidate is tampered", async () => {
    const value = await fixture();
    const roles = await writeRoleAdapters(value.parent);
    const evaluator = join(value.parent, "tampering-evaluator.mjs");
    await writeFile(
      evaluator,
      `import fs from "node:fs"; import path from "node:path";
const a=process.argv.slice(2); const q=JSON.parse(fs.readFileSync(a[a.indexOf("--request")+1],"utf8"));
if(q.operation==="evaluate-holdout") { const base=path.join(process.env.PROJECT_ROOT,".skillpress","improvements"); for(const run of fs.readdirSync(base)){const c=path.join(base,run,"candidates"); for(const key of fs.readdirSync(c)){const skill=path.join(c,key,"incident-summary","SKILL.md"); if(fs.existsSync(skill)) fs.appendFileSync(skill,"\\n<!-- tampered -->\\n");}} }
fs.writeFileSync(a[a.indexOf("--response")+1],JSON.stringify({schemaVersion:1,responseType:"skillpress.improve-adapter-response",operation:q.operation,result:{scenarioSetSha256:q.payload.scenarioSetSha256,metrics:{successRate:0.95,activationPrecision:1,safetyRate:1}}}));
`,
    );
    const before = await readFile(join(value.root, "skills/incident-summary/SKILL.md"), "utf8");
    const options = {
      ...roleOptions(value, { ...roles, evaluator }),
      evaluator: {
        argv: [process.execPath, evaluator] as [string, string],
        env: { PROJECT_ROOT: value.root },
      },
    };
    const result = await runCommandImprovement(value.root, options);
    expect(result.report.stopReason).toBe("accept_failed");
    expect(await readFile(join(value.root, "skills/incident-summary/SKILL.md"), "utf8")).toBe(
      before,
    );
  });

  it("fails acceptance when the live project changes after holdout evaluation", async () => {
    const value = await fixture();
    const roles = await writeRoleAdapters(value.parent);
    const evaluator = join(value.parent, "drifting-evaluator.mjs");
    await writeFile(
      evaluator,
      `import fs from "node:fs"; import path from "node:path";
const a=process.argv.slice(2); const q=JSON.parse(fs.readFileSync(a[a.indexOf("--request")+1],"utf8"));
if(q.operation==="evaluate-holdout") fs.appendFileSync(path.join(process.env.PROJECT_ROOT,"skills","incident-summary","SKILL.md"),"\\n<!-- drift -->\\n");
fs.writeFileSync(a[a.indexOf("--response")+1],JSON.stringify({schemaVersion:1,responseType:"skillpress.improve-adapter-response",operation:q.operation,result:{scenarioSetSha256:q.payload.scenarioSetSha256,metrics:{successRate:0.95,activationPrecision:1,safetyRate:1}}}));
`,
    );
    const options = {
      ...roleOptions(value, { ...roles, evaluator }),
      evaluator: {
        argv: [process.execPath, evaluator] as [string, string],
        env: { PROJECT_ROOT: value.root },
      },
    };
    const result = await runCommandImprovement(value.root, options);
    expect(result.report.stopReason).toBe("accept_failed");
  });
});
