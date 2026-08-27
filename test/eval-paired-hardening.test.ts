import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";
import type { SkillPressAgentResult } from "../src/eval/generated-agent-result.js";
import {
  type AdapterRequest,
  EvaluationRunError,
  readAdapterResult,
  redactEvaluationTranscript,
  runPairedEvaluation,
  type SandboxExecutor,
  validAdapterSemantics,
} from "../src/eval/paired.js";
import type { SandboxExecutionResult } from "../src/eval/sandbox-execute.js";
import type { SandboxInvocation } from "../src/eval/sandbox.js";

const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const emptyDigest = createHash("sha256").update("").digest("hex");
const skillDigest = "b".repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(temporaryRoot, "skillpress-paired-hardening-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function generatedProject(): Promise<string> {
  const parent = await temporaryDirectory();
  const root = join(parent, "project");
  await writeRenderedProject(renderCapabilityProject(await loadCapabilityBrief(briefPath)), root);
  return root;
}

function sourceFor(invocation: SandboxInvocation, target: string): string {
  for (let index = 0; index < invocation.argv.length - 1; index += 1) {
    if (invocation.argv[index] !== "--mount") continue;
    const fields = (invocation.argv[index + 1] as string).split(",");
    if (!fields.includes(`dst=${target}`)) continue;
    return (fields.find((field) => field.startsWith("src=")) as string).slice(4);
  }
  throw new Error("expected mount");
}

function passedExecution(overrides: Partial<SandboxExecutionResult> = {}): SandboxExecutionResult {
  return Object.freeze({
    status: "passed",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutSha256: emptyDigest,
    stderrSha256: emptyDigest,
    stdoutText: "",
    stderrText: "",
    cleanupAttempted: false,
    cleanupOk: false,
    ...overrides,
  });
}

function localAdapter(overrides: Partial<SandboxExecutionResult> = {}): SandboxExecutor {
  return async (invocation) => {
    const input = await readFile(join(sourceFor(invocation, "/input"), "request.json"));
    const request = JSON.parse(input.toString("utf8")) as AdapterRequest;
    const nearMiss = /fictional outage|novel chapter|marketing status/u.test(request.prompt);
    const result: SkillPressAgentResult = {
      schemaVersion: 1,
      runId: request.runId,
      variant: request.variant,
      model: request.model,
      inputSha256: createHash("sha256").update(input).digest("hex"),
      activated: request.variant === "with-skill" && !nearMiss,
      loadedSkillSha256: request.skill.available ? request.skill.sha256 : null,
      transcript: "bounded adapter transcript",
      criteria: [
        { id: "task-success", score: request.variant === "with-skill" ? 1 : 0, rationale: "fixed" },
        {
          id: "safety-boundary",
          score: request.variant === "with-skill" ? 1 : 0,
          rationale: "fixed",
        },
      ],
    };
    await writeFile(join(sourceFor(invocation, "/output"), "result.json"), JSON.stringify(result));
    return passedExecution(overrides);
  };
}

function baseRequest(variant: "baseline" | "with-skill" = "baseline"): AdapterRequest {
  return {
    schemaVersion: 1,
    runId: "1".repeat(64),
    variant,
    model: "model",
    prompt: "A sufficiently long evaluation prompt.",
    fixture: null,
    skill:
      variant === "baseline"
        ? { available: false, sha256: null }
        : { available: true, sha256: skillDigest, path: "/skill" },
  };
}

function baseResult(variant: "baseline" | "with-skill" = "baseline"): SkillPressAgentResult {
  return {
    schemaVersion: 1,
    runId: "1".repeat(64),
    variant,
    model: "model",
    inputSha256: "2".repeat(64),
    activated: false,
    loadedSkillSha256: variant === "baseline" ? null : skillDigest,
    transcript: "transcript",
    criteria: [
      { id: "task-success", score: 1, rationale: "fixed" },
      { id: "safety-boundary", score: 1, rationale: "fixed" },
    ],
  };
}

describe("paired evaluation hardening", () => {
  it("accepts only adapter semantics bound to the exact run and judge rubric", () => {
    const judgeIds = new Set(["task-success", "safety-boundary"]);
    const valid = baseResult();
    const request = baseRequest();
    expect(validAdapterSemantics(valid, request, "2".repeat(64), skillDigest, judgeIds)).toBe(true);
    expect(
      validAdapterSemantics(
        baseResult("with-skill"),
        baseRequest("with-skill"),
        "2".repeat(64),
        skillDigest,
        judgeIds,
      ),
    ).toBe(true);

    const cases: SkillPressAgentResult[] = [
      { ...valid, runId: "3".repeat(64) },
      { ...valid, variant: "with-skill" },
      { ...valid, model: "other" },
      { ...valid, inputSha256: "4".repeat(64) },
      { ...valid, loadedSkillSha256: skillDigest },
      { ...baseResult("with-skill"), loadedSkillSha256: "5".repeat(64) },
      {
        ...valid,
        criteria: [...valid.criteria, valid.criteria[0] as (typeof valid.criteria)[number]],
      },
      { ...valid, criteria: [valid.criteria[0] as (typeof valid.criteria)[number]] },
      {
        ...valid,
        criteria: [
          { id: "wrong-id", score: 1, rationale: "fixed" },
          valid.criteria[1] as (typeof valid.criteria)[number],
        ],
      },
    ];
    for (const candidate of cases) {
      const candidateRequest =
        candidate.variant === "with-skill" ? baseRequest("with-skill") : request;
      expect(
        validAdapterSemantics(candidate, candidateRequest, "2".repeat(64), skillDigest, judgeIds),
      ).toBe(false);
    }
  });

  it("accepts one bounded regular result and rejects malformed output shapes", async () => {
    const validDirectory = await temporaryDirectory();
    await writeFile(join(validDirectory, "result.json"), JSON.stringify(baseResult()));
    await expect(readAdapterResult(validDirectory)).resolves.toMatchObject({ schemaVersion: 1 });

    const empty = await temporaryDirectory();
    await expect(readAdapterResult(empty)).resolves.toBeUndefined();

    const wrongName = await temporaryDirectory();
    await writeFile(join(wrongName, "other.json"), "{}");
    await expect(readAdapterResult(wrongName)).resolves.toBeUndefined();

    const extra = await temporaryDirectory();
    await writeFile(join(extra, "result.json"), JSON.stringify(baseResult()));
    await writeFile(join(extra, "extra.txt"), "unexpected");
    await expect(readAdapterResult(extra)).resolves.toBeUndefined();

    const directoryResult = await temporaryDirectory();
    await mkdir(join(directoryResult, "result.json"));
    await expect(readAdapterResult(directoryResult)).resolves.toBeUndefined();

    const tooLarge = await temporaryDirectory();
    await writeFile(join(tooLarge, "result.json"), "{}");
    await expect(readAdapterResult(tooLarge, 1)).resolves.toBeUndefined();

    const invalidJson = await temporaryDirectory();
    await writeFile(join(invalidJson, "result.json"), "{");
    await expect(readAdapterResult(invalidJson)).resolves.toBeUndefined();

    const invalidSchema = await temporaryDirectory();
    await writeFile(join(invalidSchema, "result.json"), "{}");
    await expect(readAdapterResult(invalidSchema)).resolves.toBeUndefined();
  });

  it("redacts registered and common credential or PII forms before excerpting", () => {
    const text = [
      "registered-secret",
      `ghp_${"a".repeat(24)}`,
      `github_pat_${"b".repeat(24)}`,
      "AKIA1234567890ABCDEF",
      `Bearer ${"c".repeat(24)}`,
      "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----",
      "person@example.com",
      "x".repeat(2000),
    ].join(" ");

    const redacted = redactEvaluationTranscript(text, ["registered-secret"]);

    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("[REDACTED_TOKEN]");
    expect(redacted).toContain("[REDACTED_KEY]");
    expect(redacted).toContain("[REDACTED_PRIVATE_KEY]");
    expect(redacted).toContain("[REDACTED_EMAIL]");
    expect(redacted).toHaveLength(1000);
    expect(redacted).not.toContain("registered-secret");
  });

  it("reuses safe storage and exercises default suite, selection, secrets, policy, and clock", async () => {
    const root = await generatedProject();
    const first = await runPairedEvaluation(root, {
      image: `example/agent@sha256:${"a".repeat(64)}`,
      command: ["adapter"],
      model: "model",
      executor: localAdapter(),
    });
    const second = await runPairedEvaluation(root, {
      image: "local-agent:latest",
      allowUnpinnedImage: true,
      command: ["adapter"],
      model: "model",
      suite: "holdout",
      scenarioIds: ["holdout-positive-escalation"],
      secrets: ["registered-secret"],
      policy: {
        timeoutSeconds: 5,
        cpus: 0.5,
        memoryMib: 128,
        pids: 16,
        tmpfsMib: 16,
        shmMib: 8,
        maxOutputBytes: 4096,
        maxArtifactBytes: 4096,
        maxArtifactFiles: 1,
      },
      executor: localAdapter({ cleanupAttempted: true, cleanupOk: false }),
      now: () => new Date("2026-08-24T00:00:00.000Z"),
    });

    expect(first.scenarioResults).toHaveLength(6);
    expect(first.summary).toMatchObject({ withSkillSuccessRate: 1, behavioralGatePassed: true });
    expect(second.suite).toBe("holdout");
    expect(second.ineligibilityReasons).toEqual(
      expect.arrayContaining(["container_cleanup_failed", "sandbox_image_unpinned"]),
    );
  });

  it.each(["skillpress", "runs"] as const)(
    "rejects an unsafe existing %s storage component",
    async (component) => {
      const root = await generatedProject();
      if (component === "skillpress") {
        await writeFile(join(root, ".skill-press"), "not a directory");
      } else {
        await mkdir(join(root, ".skill-press"));
        await writeFile(join(root, ".skill-press/runs"), "not a directory");
      }

      const promise = runPairedEvaluation(root, {
        image: `example/agent@sha256:${"a".repeat(64)}`,
        command: ["adapter"],
        model: "model",
        scenarioIds: ["positive-shift-handoff"],
        executor: localAdapter(),
      });

      await expect(promise).rejects.toBeInstanceOf(EvaluationRunError);
      await promise.catch((error: unknown) => {
        expect((error as EvaluationRunError).issues.map((entry) => entry.code)).toContain(
          "eval.run.storage",
        );
      });
    },
  );

  it("rejects an invalid canonical skill before copying it", async () => {
    const root = await generatedProject();
    const path = join(root, "skills/incident-summary/SKILL.md");
    const content = await readFile(path, "utf8");
    await writeFile(path, content.replace("# Incident Summary", "# TODO: finish"));

    await expect(
      runPairedEvaluation(root, {
        image: `example/agent@sha256:${"a".repeat(64)}`,
        command: ["adapter"],
        model: "model",
        scenarioIds: ["positive-shift-handoff"],
        executor: localAdapter(),
      }),
    ).rejects.toMatchObject({ issues: [{ code: "eval.run.skill_invalid" }] });
  });

  it("hashes nested executable resources and rejects oversized staged files", async () => {
    const executableRoot = await generatedProject();
    const scripts = join(executableRoot, "skills/incident-summary/scripts");
    await mkdir(scripts);
    const helper = join(scripts, "helper.sh");
    await writeFile(helper, "#!/bin/sh\nexit 0\n");
    await chmod(helper, 0o755);
    await expect(
      runPairedEvaluation(executableRoot, {
        image: `example/agent@sha256:${"a".repeat(64)}`,
        command: ["adapter"],
        model: "model",
        scenarioIds: ["positive-shift-handoff"],
        executor: localAdapter(),
      }),
    ).resolves.toMatchObject({ evidenceType: "skillpress.paired-eval" });

    const oversizedRoot = await generatedProject();
    const oversized = join(oversizedRoot, "skills/incident-summary/reference.bin");
    await writeFile(oversized, "");
    await truncate(oversized, 16 * 1024 * 1024 + 1);
    await expect(
      runPairedEvaluation(oversizedRoot, {
        image: `example/agent@sha256:${"a".repeat(64)}`,
        command: ["adapter"],
        model: "model",
        scenarioIds: ["positive-shift-handoff"],
        executor: localAdapter(),
      }),
    ).rejects.toMatchObject({ issues: [{ code: "eval.run.skill_file_size" }] });
  });
});
