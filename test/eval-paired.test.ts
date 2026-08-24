import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";
import type { SkillPressEvaluationSuite } from "../src/eval/generated-suite.js";
import {
  EvaluationRunError,
  type PairedEvaluationOptions,
  runPairedEvaluation,
  type SandboxExecutor,
} from "../src/eval/paired.js";
import type { SandboxExecutionResult } from "../src/eval/sandbox-execute.js";
import type { SandboxInvocation } from "../src/eval/sandbox.js";

const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const emptyDigest = createHash("sha256").update("").digest("hex");
const image = `example/agent@sha256:${"a".repeat(64)}`;

interface ObservedRequest {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly variant: "baseline" | "with-skill";
  readonly model: string;
  readonly prompt: string;
  readonly fixture: {
    readonly files?: readonly { readonly path: string; readonly content: string }[];
    readonly environment?: Readonly<Record<string, string>>;
  } | null;
  readonly skill:
    | { readonly available: false; readonly sha256: null }
    | { readonly available: true; readonly sha256: string; readonly path: string };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function generatedProject(): Promise<string> {
  const parent = await mkdtemp(join(temporaryRoot, "skillpress-paired-test-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "project");
  await writeRenderedProject(renderCapabilityProject(await loadCapabilityBrief(briefPath)), root);
  const trainingPath = join(root, "evals/training.yaml");
  const training = parse(await readFile(trainingPath, "utf8")) as SkillPressEvaluationSuite;
  const selected = training.scenarios.find((scenario) => scenario.id === "positive-shift-handoff");
  if (selected === undefined) throw new Error("expected selected training scenario");
  selected.fixture = {
    files: [{ path: "records/incident.txt", content: "fixed setup record\n" }],
    environment: { API_TOKEN: "fixture-secret-value" },
  };
  await writeFile(trainingPath, stringify(training, { lineWidth: 0 }));
  return root;
}

function mountSource(invocation: SandboxInvocation, target: string): string {
  for (let index = 0; index < invocation.argv.length - 1; index += 1) {
    if (invocation.argv[index] !== "--mount") continue;
    const fields = (invocation.argv[index + 1] as string).split(",");
    if (fields.includes(`dst=${target}`)) {
      const source = fields.find((field) => field.startsWith("src="));
      if (source !== undefined) return source.slice(4);
    }
  }
  throw new Error(`missing ${target} mount`);
}

function execution(overrides: Partial<SandboxExecutionResult> = {}): SandboxExecutionResult {
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

function adapter(
  observed: ObservedRequest[],
  mutate?: (
    result: Record<string, unknown>,
    request: ObservedRequest,
    invocation: SandboxInvocation,
  ) => void,
): SandboxExecutor {
  return async (invocation) => {
    const inputPath = join(mountSource(invocation, "/input"), "request.json");
    const outputPath = join(mountSource(invocation, "/output"), "result.json");
    const input = await readFile(inputPath);
    const request = JSON.parse(input.toString("utf8")) as ObservedRequest;
    observed.push(request);
    const result: Record<string, unknown> = {
      schemaVersion: 1,
      runId: request.runId,
      variant: request.variant,
      model: request.model,
      inputSha256: createHash("sha256").update(input).digest("hex"),
      activated: request.variant === "with-skill",
      loadedSkillSha256: request.skill.available ? request.skill.sha256 : null,
      transcript: `completed with fixture-secret-value and private.person@example.com`,
      criteria: [
        {
          id: "task-success",
          score: request.variant === "with-skill" ? 1 : 0,
          rationale: "fixed task score",
        },
        {
          id: "safety-boundary",
          score: request.variant === "with-skill" ? 1 : 0,
          rationale: "fixed safety score",
        },
      ],
    };
    mutate?.(result, request, invocation);
    await writeFile(outputPath, `${JSON.stringify(result)}\n`);
    return execution();
  };
}

function options(executor: SandboxExecutor): PairedEvaluationOptions {
  return {
    image,
    command: ["agent-adapter"],
    model: "fixed-test-model",
    suite: "training",
    scenarioIds: ["positive-shift-handoff"],
    executor,
    now: () => new Date("2026-08-24T12:34:56.789Z"),
  };
}

describe("paired sandbox evaluation", () => {
  it("binds setup, baseline, transcripts, and the exact loaded skill digest", async () => {
    const root = await generatedProject();
    const observed: ObservedRequest[] = [];

    const evidence = await runPairedEvaluation(root, options(adapter(observed)));

    expect(observed).toHaveLength(6);
    expect(observed.map((request) => request.variant)).toEqual([
      "baseline",
      "with-skill",
      "baseline",
      "with-skill",
      "baseline",
      "with-skill",
    ]);
    expect(
      observed.every((request) => request.fixture?.files?.[0]?.content === "fixed setup record\n"),
    ).toBe(true);
    expect(
      observed.every(
        (request) => request.fixture?.environment?.API_TOKEN === "fixture-secret-value",
      ),
    ).toBe(true);
    expect(
      observed
        .filter((request) => request.variant === "baseline")
        .every((request) => !request.skill.available),
    ).toBe(true);
    expect(
      observed
        .filter((request) => request.variant === "with-skill")
        .every(
          (request) => request.skill.available && request.skill.sha256 === evidence.skillSha256,
        ),
    ).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("Turn these escalation notes");

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      evidenceType: "skillpress.paired-eval",
      createdAt: "2026-08-24T12:34:56.789Z",
      suite: "training",
      repetitions: 3,
      summary: {
        baselineSuccessRate: 0,
        withSkillSuccessRate: 1,
        impactDelta: 1,
        behavioralGatePassed: true,
      },
      evidenceEligible: false,
      ineligibilityReasons: ["custom_executor"],
    });
    expect(evidence.scenarioResults[0]?.runs).toHaveLength(3);
    for (const run of evidence.scenarioResults[0]?.runs ?? []) {
      expect(run.baseline).toMatchObject({ status: "passed", rubricScore: 35, successful: false });
      expect(run.withSkill).toMatchObject({
        status: "passed",
        loadedSkillSha256: evidence.skillSha256,
        rubricScore: 100,
        successful: true,
      });
      expect(run.baseline.inputSha256).not.toBe(run.withSkill.inputSha256);
      expect(run.baseline.transcript.sha256).toBe(run.withSkill.transcript.sha256);
    }
    expect(JSON.stringify(evidence)).not.toContain("fixture-secret-value");
    expect(JSON.stringify(evidence)).not.toContain("private.person@example.com");
    expect(JSON.stringify(evidence)).toContain("[REDACTED]");
    expect(JSON.stringify(evidence)).toContain("[REDACTED_EMAIL]");
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.scenarioResults[0]?.runs)).toBe(true);

    const evidencePath = join(root, evidence.storagePath, "evidence.json");
    await expect(readFile(evidencePath, "utf8")).resolves.toContain("skillpress.paired-eval");
    const rawResult = join(
      root,
      evidence.storagePath,
      "scenario-1/rep-1/with-skill/output/result.json",
    );
    await expect(readFile(rawResult, "utf8")).resolves.toContain("fixture-secret-value");
    expect((await lstat(rawResult)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, evidence.storagePath))).mode & 0o777).toBe(0o700);
  });

  it("rejects adapter results that do not bind to the input digest", async () => {
    const root = await generatedProject();
    const observed: ObservedRequest[] = [];
    const corrupt = adapter(observed, (result) => {
      result.inputSha256 = "0".repeat(64);
    });

    const evidence = await runPairedEvaluation(root, options(corrupt));

    expect(evidence.summary.behavioralGatePassed).toBe(false);
    expect(evidence.ineligibilityReasons).toContain("adapter_invalid_result");
    expect(evidence.scenarioResults[0]?.runs[0]?.withSkill).toMatchObject({
      status: "invalid_result",
      activated: null,
      loadedSkillSha256: null,
      successful: false,
    });
  });

  it("rejects a with-skill result that reports a different loaded digest", async () => {
    const root = await generatedProject();
    const observed: ObservedRequest[] = [];
    const corrupt = adapter(observed, (result, request) => {
      if (request.variant === "with-skill") result.loadedSkillSha256 = "f".repeat(64);
    });

    const evidence = await runPairedEvaluation(root, options(corrupt));

    expect(evidence.ineligibilityReasons).toContain("adapter_invalid_result");
    expect(
      evidence.scenarioResults[0]?.runs.every((run) => run.withSkill.status === "invalid_result"),
    ).toBe(true);
  });

  it("records engine failures without accepting a missing result", async () => {
    const root = await generatedProject();
    const failedExecutor: SandboxExecutor = async () =>
      execution({
        status: "timed_out",
        exitCode: null,
        stdoutText: "partial engine transcript",
        stdoutBytes: 25,
        stdoutSha256: createHash("sha256").update("partial engine transcript").digest("hex"),
        cleanupAttempted: true,
        cleanupOk: true,
      });

    const evidence = await runPairedEvaluation(root, options(failedExecutor));

    expect(evidence.ineligibilityReasons).toContain("adapter_timed_out");
    expect(evidence.scenarioResults[0]?.runs[0]?.baseline).toMatchObject({
      status: "timed_out",
      transcript: { redactedExcerpt: "partial engine transcript" },
    });
  });

  it("treats an unexpected adapter throw as a spawn failure", async () => {
    const root = await generatedProject();
    const throwing: SandboxExecutor = async () => {
      throw new Error("private adapter failure");
    };

    const evidence = await runPairedEvaluation(root, options(throwing));

    expect(evidence.ineligibilityReasons).toContain("adapter_spawn_error");
    expect(JSON.stringify(evidence)).not.toContain("private adapter failure");
  });

  it.each([
    ["empty selection", { scenarioIds: [] }, "eval.run.scenario_selection"],
    [
      "duplicate selection",
      { scenarioIds: ["positive-shift-handoff", "positive-shift-handoff"] },
      "eval.run.scenario_selection",
    ],
    ["missing selection", { scenarioIds: ["not-in-suite"] }, "eval.run.scenario_missing"],
    ["invalid model", { model: "bad\nmodel" }, "eval.run.model"],
    ["short redaction secret", { secrets: ["abc"] }, "eval.run.secret"],
  ] as const)("rejects %s", async (_name, overrides, code) => {
    const root = await generatedProject();
    const observed: ObservedRequest[] = [];

    const promise = runPairedEvaluation(root, { ...options(adapter(observed)), ...overrides });

    await expect(promise).rejects.toBeInstanceOf(EvaluationRunError);
    await promise.catch((error: unknown) => {
      expect((error as EvaluationRunError).issues.map((entry) => entry.code)).toContain(code);
    });
  });

  it("rejects an ambiguous project path before filesystem access", async () => {
    const observed: ObservedRequest[] = [];
    await expect(runPairedEvaluation("bad\u200bpath", options(adapter(observed)))).rejects.toThrow(
      TypeError,
    );
  });
});
