import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  chmod,
  symlink,
  lstat,
  readdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/eval/codex-text.js", () => ({ runReviewedCodexText: vi.fn() }));
import { runReviewedCodexText } from "../src/eval/codex-text.js";
import {
  prepareReviewedToolProject,
  runPreparedReviewedToolSuite,
} from "../src/eval/reviewed-tool-project.js";
import { TOOL_ACTION_SCHEMA_JSON } from "../src/eval/tool-action-schema.js";
import { checkReviewedToolEvaluation } from "../src/release/reviewed-tool-check.js";
import { prepareReviewedToolEvidence } from "../src/release/reviewed-tool-evidence.js";
import { runCli } from "../src/cli.js";
import { runNativeCheckCommand } from "../src/cli/native-check.js";
import * as checks from "../src/check/project.js";
import * as toolProjects from "../src/eval/reviewed-tool-project.js";
import * as capture from "../src/process/capture.js";
import { TOOL_REVIEW_POLICY } from "../src/release/tool-policy.js";
import { checkReleaseGate } from "../src/release/gate.js";
import {
  prepareSkillSubmission,
  type PreparedSubmissionPayload,
} from "../src/submission/manifest.js";
import { diagnoseProject } from "../src/doctor/project.js";
import { runSkillSubmission } from "../src/submission/run.js";
import type { SkillPressSubmissionResource } from "../src/submission/generated-resource.js";
const roots: string[] = [];
const image = TOOL_REVIEW_POLICY.image;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const evalArgs = (root: string) => [
  "eval-tool",
  "--project",
  root,
  "--suite",
  "holdout",
  "--reviewed-inputs",
  "--max-model-calls",
  "66",
  "--json",
];
const evalIo = () => ({
  stdout: vi.fn<(value: string) => void>(),
  stderr: vi.fn<(value: string) => void>(),
});

it.each(["SIGINT", "SIGTERM"] as const)(
  "propagates in-flight tool %s without another call",
  async (signal) => {
    const f = await fixture();
    const before = process.listenerCount(signal);
    let aborted = false;
    vi.mocked(runReviewedCodexText).mockImplementation(
      async (_prompt, inputSignal) =>
        new Promise((_resolve, reject) => {
          inputSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("cancelled"));
            },
            { once: true },
          );
          process.emit(signal);
        }),
    );
    const io = evalIo();
    expect(await runCli(evalArgs(f.root), io)).toBe(3);
    expect(aborted).toBe(true);
    expect(runReviewedCodexText).toHaveBeenCalledTimes(1);
    expect(process.listenerCount(signal)).toBe(before);
    expect(JSON.parse(io.stdout.mock.calls[0][0])).toMatchObject({
      complete: false,
      summary: null,
    });
  },
);

it("requires the final tool evidence path to be ignored independently", async () => {
  const f = await fixture();
  f.configureProvider("holdout");
  const original = capture.runCapturedCommand;
  let refused = "";
  vi.spyOn(capture, "runCapturedCommand").mockImplementation((options) => {
    if (options.argv[1] === "check-ignore" && options.argv.at(-1)?.endsWith("/evidence.json")) {
      refused = options.argv.at(-1) as string;
      return original({
        ...options,
        argv: ["git", "check-ignore", "--quiet", "--", "not-ignored"],
      });
    }
    return original(options);
  });
  const io = evalIo();
  expect(await runCli(evalArgs(f.root), io)).toBe(3);
  expect(refused).toContain("/evidence.json");
  await expect(lstat(join(f.root, refused))).rejects.toThrow();
  expect(io.stdout).not.toHaveBeenCalled();
});

it.each([
  [],
  ["--suite", "unknown"],
  ["--suite", "training"],
  ["--suite", "holdout", "--reviewed-inputs"],
  ["--suite", "holdout", "--max-model-calls", "66"],
  ["--suite", "training", "--dry-run", "--max-model-calls", "0"],
  ["--suite", "training", "--dry-run", "--max-model-calls", "9007199254740992"],
  ["--dry-run", "--dry-run"],
  ["--suite", "holdout", "--suite", "training"],
  ["--unknown"],
  ["--suite"],
  ["--project", "--json"],
])("rejects eval-tool usage before inference: %j", async (...flags) => {
  expect(await runCli(["eval-tool", ...flags], evalIo())).toBe(2);
  expect(runReviewedCodexText).not.toHaveBeenCalled();
});

it("documents eval-tool and handles unavailable output", async () => {
  const io = evalIo();
  expect(await runCli(["eval-tool", "--help"], io)).toBe(0);
  expect(io.stdout.mock.calls[0][0]).toContain("eleven per pair");
  io.stderr.mockImplementation(() => {
    throw new Error("broken output");
  });
  expect(await runCli(["eval-tool"], io)).toBe(1);
  expect(await runCli(evalArgs("/nonexistent-eval-project"), io)).toBe(1);
});

it.each(["preview", "cap", "readiness", "stdout"])(
  "checks eval-tool %s before inference",
  async (kind) => {
    const f = await fixture(kind !== "readiness");
    const io = evalIo();
    const args = evalArgs(f.root);
    if (kind === "preview" || kind === "stdout") args.push("--dry-run");
    if (kind === "cap") args[args.indexOf("66")] = "65";
    if (kind === "stdout") {
      args.splice(args.indexOf("--json"), 1);
      io.stdout.mockImplementation(() => {
        throw new Error("broken output");
      });
    }
    expect(await runCli(args, io)).toBe(kind === "preview" ? 0 : kind === "stdout" ? 1 : 3);
    if (kind === "preview")
      expect(JSON.parse(io.stdout.mock.calls[0][0])).toMatchObject({
        plannedPairs: 6,
        plannedModelCalls: 66,
        image,
        releaseAuthorized: false,
      });
    expect(runReviewedCodexText).not.toHaveBeenCalled();
  },
);

it.each(["training", "holdout"] as const)(
  "persists private tool %s events, pairs and evidence",
  async (suite) => {
    const f = await fixture();
    f.configureProvider(suite);
    const io = evalIo();
    const args = evalArgs(f.root);
    args[args.indexOf("holdout")] = suite;
    args[args.indexOf("66")] = "165";
    expect(await runCli(args, io)).toBe(0);
    const report = JSON.parse(io.stdout.mock.calls[0][0]);
    expect(report).toMatchObject({ complete: true, status: "completed", releaseAuthorized: false });
    expect(runReviewedCodexText).toHaveBeenCalledTimes(suite === "training" ? 75 : 30);
    expect((await lstat(join(f.root, report.evidencePath))).mode & 0o777).toBe(0o600);
    const directory = join(f.root, report.checkpointPath);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    const files = await readdir(directory);
    expect(files.some((name) => name.startsWith("event-"))).toBe(true);
    expect(files.filter((name) => name.startsWith("pair-")).length).toBe(
      suite === "training" ? 15 : 6,
    );
    for (const name of files) expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
    expect(io.stderr.mock.calls.flat().join("")).not.toContain("Synthetic answer.");
  },
);

it.each(["SIGINT", "SIGTERM"] as const)(
  "cancels tool evaluation on %s and restores listeners",
  async (signal) => {
    const f = await fixture();
    const io = evalIo();
    const before = process.listenerCount(signal);
    io.stderr.mockImplementation((value) => {
      if (JSON.parse(value).event === "eval-tool.started") process.emit(signal);
    });
    expect(await runCli(evalArgs(f.root), io)).toBe(3);
    expect(runReviewedCodexText).not.toHaveBeenCalled();
    expect(process.listenerCount(signal)).toBe(before);
    expect(JSON.parse(io.stdout.mock.calls[0][0])).toMatchObject({
      complete: false,
      summary: null,
    });
  },
);

it.each(["provider", "quality", "stdout", "oversize"])(
  "retains tool %s failure without retry",
  async (kind) => {
    const f = await fixture(true, kind === "quality" ? 1 : 0.5);
    f.configureProvider("holdout");
    if (kind === "provider")
      vi.mocked(runReviewedCodexText).mockRejectedValue(new Error("PRIVATE_PROVIDER_DETAIL"));
    if (kind === "oversize") {
      const measurement = JSON.parse(
        await readFile(join(f.root, f.paths.holdoutEvidencePath), "utf8"),
      );
      vi.spyOn(toolProjects, "runPreparedReviewedToolSuite").mockResolvedValue({
        ...measurement,
        ineligibilityReasons: ["x".repeat(1048576)],
      });
    }
    const io = evalIo();
    if (kind === "stdout")
      io.stdout.mockImplementation(() => {
        throw new Error("broken output");
      });
    expect(
      await runCli(
        evalArgs(f.root).filter((arg) => arg !== "--json"),
        io,
      ),
    ).toBe(kind === "stdout" ? 1 : 3);
    if (kind === "provider") expect(runReviewedCodexText).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([io.stdout.mock.calls, io.stderr.mock.calls])).not.toContain(
      "PRIVATE_PROVIDER_DETAIL",
    );
  },
);

it.each(["ignore", "event", "pair", "source", "progress"])(
  "blocks tool evaluation on %s storage/boundary failure",
  async (kind) => {
    const f = await fixture();
    f.configureProvider("holdout");
    const io = evalIo();
    if (kind === "ignore") {
      const original = capture.runCapturedCommand;
      vi.spyOn(capture, "runCapturedCommand").mockImplementation((options) =>
        original(
          options.argv[1] === "check-ignore"
            ? { ...options, argv: ["git", "check-ignore", "--quiet", "--", "not-ignored"] }
            : options,
        ),
      );
    }
    io.stderr.mockImplementation(async (value) => {
      const event = JSON.parse(value);
      if (event.event === "eval-tool.started" && (kind === "event" || kind === "pair"))
        await mkdir(join(f.root, event.checkpointPath, `${kind}-1.json`));
      if (event.event === "eval-tool.progress" && kind === "source")
        await writeFile(join(f.root, "evals/holdout.yaml"), "changed source");
      if (event.event === "eval-tool.progress" && kind === "progress")
        throw new Error("broken progress");
    });
    expect(await runCli(evalArgs(f.root), io)).toBe(3);
    expect(io.stdout).not.toHaveBeenCalled();
    expect(JSON.parse(io.stderr.mock.calls.at(-1)?.[0] ?? "{}").code).toBe(
      "tool.evaluation.failed",
    );
  },
);
async function fixture(licensed = true, baseline = 0.5) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "reviewed-tool-check-"));
  roots.push(root);
  await mkdir(join(root, "skills"));
  await cp("skills/csv-quality-check", join(root, "skills/csv-quality-check"), { recursive: true });
  await cp("examples/launch-skills/csv-quality-check-evals", join(root, "evals"), {
    recursive: true,
  });
  if (licensed) {
    await cp("LICENSE", join(root, "LICENSE"));
    await cp("LICENSE", join(root, "skills/csv-quality-check/LICENSE"));
  }
  const config = parse(await readFile("skill-press.yaml", "utf8"));
  config.project.name = "csv-quality-check";
  config.skill.name = "csv-quality-check";
  config.skill.path = "skills/csv-quality-check";
  await writeFile(join(root, "skill-press.yaml"), stringify(config));
  await writeFile(join(root, ".gitignore"), ".skill-press/\n");
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Synthetic tool project",
  ]);
  const prepared = await prepareReviewedToolProject(root, image);
  const paths = { trainingEvidencePath: "", holdoutEvidencePath: "" };
  const configureProvider = (suite: "training" | "holdout") => {
    let calls = 0;
    vi.mocked(runReviewedCodexText).mockImplementation(async (prompt, _signal, schema) => {
      const index = calls++;
      const stage = index % 5;
      const scenario = prepared.inputs[suite].scenarios[Math.floor(index / 15)];
      const text =
        stage === 0
          ? JSON.stringify({ selected: scenario.shouldActivate, rationale: "Synthetic selection" })
          : stage === 1 || stage === 3
            ? JSON.stringify({ action: { kind: "answer", text: "Synthetic answer." } })
            : JSON.stringify({
                criteria: prepared.inputs.rubric.criteria
                  .filter((c) => c.evaluator === "judge")
                  .map((c) => ({
                    id: c.id,
                    score: stage === 2 ? baseline : 1,
                    rationale: "Synthetic rubric response",
                  })),
              });
      return {
        text,
        inputSha256: hash(prompt),
        outputSha256: hash(text),
        ...(schema ? { outputSchemaSha256: hash(TOOL_ACTION_SCHEMA_JSON) } : {}),
        requestedModel: "gpt-6.1-sol",
        effort: "medium",
        authentication: "forced-chatgpt",
        cliVersion: "0.160.0",
        execution: "reviewed-host-text-pilot",
        releaseEligible: false,
        diagnostics: [],
        durationMs: 1,
        usage: { inputTokens: 10, cachedInputTokens: 1, outputTokens: 2 },
      };
    });
  };
  for (const suite of ["training", "holdout"] as const) {
    configureProvider(suite);
    const result = await runPreparedReviewedToolSuite(root, prepared, suite, {
      onEvent: async () => {},
      onResult: async () => {},
    });
    const directory = join(root, ".skill-press/runs", result.runId);
    await mkdir(join(root, ".skill-press/runs"), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "evidence.json"), JSON.stringify(result), { mode: 0o600 });
    paths[`${suite}EvidencePath`] = `.skill-press/runs/${result.runId}/evidence.json`;
  }
  vi.mocked(runReviewedCodexText).mockClear();
  return { root, paths, prepared, configureProvider };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("checks and encodes real private source-bound fixtures without inference", async () => {
  const f = await fixture();
  const result = await prepareReviewedToolEvidence(f.root, f.paths, image);
  expect(result.report).toMatchObject({
    passed: true,
    readiness: { ok: true },
    releaseAuthorized: false,
    releaseEligible: false,
    admissionIssues: ["release_gate_required"],
  });
  expect(JSON.parse(result.reviewBytes.toString()).measurement.source).toEqual(f.prepared.source);
  expect(
    (await prepareReviewedToolEvidence(f.root, f.paths, image)).reviewBytes.equals(
      result.reviewBytes,
    ),
  ).toBe(true);
  const args = [
    "--reviewed-tool",
    "--image",
    image,
    "--project",
    f.root,
    "--training-evidence",
    f.paths.trainingEvidencePath,
    "--holdout-evidence",
    f.paths.holdoutEvidencePath,
  ];
  const out = vi.fn();
  expect(await runCli(["eval-check", ...args, "--json"], { stdout: out, stderr: vi.fn() })).toBe(0);
  expect(JSON.parse(out.mock.calls[0][0]).reportType).toBe(
    "skillpress.reviewed-tool-evaluation-check",
  );
  expect(await runNativeCheckCommand(args, { stdout: out, stderr: vi.fn() })).toBe(0);
  expect(out.mock.calls[1][0]).toContain("Reviewed tool evaluation");
  expect(runReviewedCodexText).not.toHaveBeenCalled();
});
it("retains missing-license readiness failure", async () => {
  const f = await fixture(false);
  expect((await checkReviewedToolEvaluation(f.root, f.paths, image)).issues).toContain(
    "tool.readiness.failed",
  );
});
it("rejects run reuse, wrong storage IDs and wrong reviewed image", async () => {
  const f = await fixture();
  const reused = await checkReviewedToolEvaluation(
    f.root,
    { ...f.paths, holdoutEvidencePath: f.paths.trainingEvidencePath },
    image,
  );
  expect(reused.issues).toContain("tool.pair.run_reuse");
  expect(
    (await checkReviewedToolEvaluation(f.root, f.paths, `python@sha256:${"b".repeat(64)}`)).passed,
  ).toBe(false);
  const path = join(f.root, f.paths.trainingEvidencePath);
  const value = JSON.parse(await readFile(path, "utf8"));
  value.runId = "f".repeat(64);
  await writeFile(path, JSON.stringify(value));
  expect((await checkReviewedToolEvaluation(f.root, f.paths, image)).issues).toContain(
    "training:tool.storage.binding",
  );
  await writeFile(path, "null");
  expect((await checkReviewedToolEvaluation(f.root, f.paths, image)).issues).toContain(
    "training:tool.storage.binding",
  );
  await expect(prepareReviewedToolEvidence(f.root, f.paths, image)).rejects.toThrow(
    "upload contract",
  );
});
it.each(["oversize", "permissions", "symlink", "dirty"])(
  "rejects unsafe %s input",
  async (kind) => {
    const f = await fixture();
    const path = join(f.root, f.paths.trainingEvidencePath);
    if (kind === "oversize") await writeFile(path, "x".repeat(1048577));
    if (kind === "permissions") await chmod(path, 0o644);
    if (kind === "symlink") {
      await rm(path);
      await symlink(join(f.root, f.paths.holdoutEvidencePath), path);
    }
    if (kind === "dirty")
      await writeFile(join(f.root, "skills/csv-quality-check/scripts/profile.py"), "changed");
    await expect(checkReviewedToolEvaluation(f.root, f.paths, image)).rejects.toThrow();
    expect(runReviewedCodexText).not.toHaveBeenCalled();
  },
);
it("detects source mutation during the check at exit", async () => {
  const f = await fixture();
  const original = checks.checkProject;
  vi.spyOn(checks, "checkProject").mockImplementation(async (root) => {
    const result = await original(root);
    await writeFile(join(root, "skills/csv-quality-check/scripts/profile.py"), "changed");
    return result;
  });
  await expect(checkReviewedToolEvaluation(f.root, f.paths, image)).rejects.toThrow();
});
it.each([
  ["--reviewed-tool"],
  ["--reviewed-tool", "--image", "python:latest"],
  ["--reviewed-tool", "--reviewed-text", "--image", image],
  ["--reviewed-text", "--reviewed-tool", "--image", image],
  ["--reviewed-tool", "--reviewed-tool", "--image", image],
  ["--image", image],
])("rejects invalid profile/image combinations", async (flags) => {
  expect(
    await runNativeCheckCommand([...flags, "--training-evidence", "a", "--holdout-evidence", "b"], {
      stdout: vi.fn(),
      stderr: vi.fn(),
    }),
  ).toBe(2);
});
it("reports missing private evidence without leaking input errors", async () => {
  const err = vi.fn();
  expect(
    await runNativeCheckCommand(
      [
        "--reviewed-tool",
        "--image",
        image,
        "--project",
        "/nonexistent-synthetic-project",
        "--training-evidence",
        "a",
        "--holdout-evidence",
        "b",
      ],
      { stdout: vi.fn(), stderr: err },
    ),
  ).toBe(3);
  expect(JSON.parse(err.mock.calls[0][0]).code).toBe("tool.evidence.unavailable");
});

function releaseOptions(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    provider: "reviewed-tool" as const,
    reviewEvidencePath: f.paths.trainingEvidencePath,
    evalEvidencePath: f.paths.holdoutEvidencePath,
    evalSource: "evals",
  };
}

it.each([
  "sourceCommit",
  "projectConfigSha256",
  "skillSha256",
  "artifactSha256",
  "artifactBytes",
  "provenanceSha256",
] as const)("rejects mismatched tool package %s before upload", async (key) => {
  const f = await fixture();
  await expect(
    prepareSkillSubmission(
      f.root,
      {
        ...f.prepared.artifacts,
        [key]: key === "artifactBytes" ? 1 : "f".repeat(key === "sourceCommit" ? 40 : 64),
      },
      releaseOptions(f),
    ),
  ).rejects.toThrow("exact package");
  expect(runReviewedCodexText).not.toHaveBeenCalled();
});

it("rejects stale tool evidence, noncanonical eval source and sanitizes malformed input", async () => {
  const f = await fixture();
  expect(
    (await checkReleaseGate(f.root, { ...releaseOptions(f), now: () => new Date("2030-01-01") }))
      .passed,
  ).toBe(false);
  await expect(
    checkReleaseGate(f.root, { ...releaseOptions(f), evalSource: "other" }),
  ).rejects.toThrow("canonical evals");
  await writeFile(join(f.root, f.paths.trainingEvidencePath), "provider-secret-not-json");
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(await runCli(["submit", ...releaseArgs(f)], io)).toBe(3);
  expect(io.stderr.mock.calls[0][0]).not.toContain("provider-secret");
});

it.each(["training-text", "holdout-native", "image"])(
  "rejects mixed or unreviewed %s receipts without upload",
  async (kind) => {
    const f = await fixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    for (const suite of ["training", "holdout"] as const) {
      if (kind !== "image" && !kind.startsWith(suite)) continue;
      const path = join(f.root, f.paths[`${suite}EvidencePath`]);
      const raw = await readFile(path, "utf8");
      const value = JSON.parse(raw);
      value.evidenceType = kind.endsWith("text")
        ? "skillpress.reviewed-text-suite"
        : "skillpress.native-evidence";
      await writeFile(
        path,
        kind === "image"
          ? raw.replaceAll(image, `python@sha256:${"b".repeat(64)}`)
          : JSON.stringify(value),
      );
    }
    for (const command of ["package", "submit"]) {
      expect(await runCli([command, ...releaseArgs(f)], { stdout: vi.fn(), stderr: vi.fn() })).toBe(
        3,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(runReviewedCodexText).not.toHaveBeenCalled();
  },
);

it("rejects duplicate, conflicting and incomplete tool command options", async () => {
  for (const command of ["package", "submit", "status", "doctor"]) {
    for (const flags of [
      ["--reviewed-tool"],
      ["--reviewed-tool", "--reviewed-tool"],
      ["--reviewed-tool", "--reviewed-text"],
      ["--native", "--reviewed-tool"],
    ])
      expect(await runCli([command, ...flags], { stdout: vi.fn(), stderr: vi.fn() })).toBe(2);
  }
  expect(
    await runCli(
      [
        "doctor",
        "--reviewed-tool",
        "--review-evidence",
        "a",
        "--eval-evidence",
        "b",
        "--eval-source",
        "evals",
        "--tessl-executable",
        "tessl",
      ],
      { stdout: vi.fn(), stderr: vi.fn() },
    ),
  ).toBe(2);
});
function releaseArgs(f: Awaited<ReturnType<typeof fixture>>) {
  return [
    "--reviewed-tool",
    "--project",
    f.root,
    "--review-evidence",
    f.paths.trainingEvidencePath,
    "--eval-evidence",
    f.paths.holdoutEvidencePath,
    "--eval-source",
    "evals",
  ];
}

it("binds tool release gate and submission payload without inference or network", async () => {
  const f = await fixture();
  const options = releaseOptions(f);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const gate = await checkReleaseGate(f.root, options);
  expect(gate).toMatchObject({
    gateType: "skillpress.reviewed-tool-release",
    passed: true,
    releaseAuthorized: false,
    independentVerificationRequired: true,
    sourceCommit: f.prepared.source.commit,
  });
  const payload = await prepareSkillSubmission(f.root, f.prepared.artifacts, options);
  const prepared = await prepareReviewedToolEvidence(f.root, f.paths, image);
  expect(payload.reviewEvidenceBytes).toEqual(prepared.reviewBytes);
  expect(payload.evalEvidenceBytes).toEqual(prepared.evaluationBytes);
  expect(payload.manifest.evidence.review.sha256).toBe(hash(prepared.reviewBytes.toString()));
  expect(JSON.parse(payload.reviewEvidenceBytes.toString()).measurement.releaseEligible).toBe(
    false,
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(runReviewedCodexText).not.toHaveBeenCalled();
});

it("packages and prepares a tool submission through real CLI paths", async () => {
  const f = await fixture();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const output: string[] = [];
  const io = {
    stdout: (text: string) => {
      output.push(text);
    },
    stderr: vi.fn(),
  };
  const args = releaseArgs(f);
  expect(await runCli(["package", ...args], io)).toBe(0);
  expect(output.at(-1)).toContain("Reviewed tool release gate: passed (advisory)");
  expect(await runCli(["submit", ...args, "--dry-run", "--json"], io)).toBe(0);
  expect(JSON.parse(output.at(-1) as string)).toMatchObject({
    ok: true,
    receipt: { operationStatus: "prepared", dryRun: true },
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(runReviewedCodexText).not.toHaveBeenCalled();
});

it("prepares and inspects tool submission with explicit artifacts through real CLI paths", async () => {
  const f = await fixture();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const output: string[] = [];
  const io = {
    stdout: (text: string) => {
      output.push(text);
    },
    stderr: vi.fn(),
  };
  const args = releaseArgs(f);
  expect(
    await runCli(
      ["submit", ...args, "--dry-run", "--artifacts", f.prepared.artifacts.artifactsPath],
      io,
    ),
  ).toBe(0);
  expect(output.at(-1)).toContain("Reviewed tool release gate: passed (advisory)");
  const statusCode = await runCli(
    ["status", ...args, "--artifacts", f.prepared.artifacts.artifactsPath],
    io,
  );
  expect(statusCode, `${output.at(-1)} ${JSON.stringify(io.stderr.mock.calls)}`).toBe(0);
  expect(output.at(-1)).toContain("Reviewed tool gate: passed");
  expect(fetch).not.toHaveBeenCalled();
  expect(runReviewedCodexText).not.toHaveBeenCalled();
});

it("diagnoses tool submission readiness without inference or network", async () => {
  const f = await fixture();
  const options = releaseOptions(f);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const commands: string[] = [];
  const doctor = await diagnoseProject(f.root, {
    evidence: options,
    homeDirectory: f.root,
    environment: {},
    executor: async (command) => {
      commands.push(command.argv[0]);
      return {
        status: "passed",
        exitCode: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    },
  });
  expect(doctor.ready).toBe(true);
  expect(commands).toEqual(["git"]);
  expect(doctor.checks.map(({ id }) => id)).toContain("evidence.reviewed-tool");
  expect(doctor.checks.map(({ id }) => id)).not.toContain("credential.tessl");
  expect(fetch).not.toHaveBeenCalled();
  expect(runReviewedCodexText).not.toHaveBeenCalled();
});

it("sends tool envelopes through submission orchestration without granting publication", async () => {
  const f = await fixture();
  const options = releaseOptions(f);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const date = new Date().toISOString();
  let remote: SkillPressSubmissionResource;
  const receive = (payload: PreparedSubmissionPayload): SkillPressSubmissionResource => ({
    schemaVersion: 1,
    resourceType: "skillpress.submission",
    id: "submission_12345678",
    idempotencyKey: payload.idempotencyKey,
    namespace: payload.manifest.registry.namespace,
    status: "received",
    statusVersion: 1,
    sourceCommit: payload.manifest.source.commit,
    artifactSha256: payload.manifest.package.artifact.sha256,
    projectVersion: payload.manifest.project.version,
    url: "https://skill-press.com/api/v1/submissions/submission_12345678",
    receivedAt: date,
    updatedAt: date,
  });
  const client = {
    checkSession: vi.fn(async () => ({
      schemaVersion: 1 as const,
      sessionType: "skillpress.session" as const,
      authenticated: true as const,
    })),
    submit: vi.fn(async (payload: PreparedSubmissionPayload) => {
      remote = receive(payload);
      return remote;
    }),
    getSubmission: vi.fn(async () => remote),
  };
  const receipt = await runSkillSubmission(f.root, f.prepared.artifacts, {
    evidence: options,
    client,
  });
  expect(receipt.operationStatus).toBe("submitted");
  expect(receipt.remote?.status).toBe("received");
  expect(receipt.remote?.release).toBeUndefined();
  expect(client.submit).toHaveBeenCalledTimes(1);
  const payload = client.submit.mock.calls[0][0];
  expect(payload.manifest.source.commit).toBe(f.prepared.source.commit);
  expect(payload.manifest.package.artifact.sha256).toBe(f.prepared.artifacts.artifactSha256);
  for (const [bytes, path] of [
    [payload.reviewEvidenceBytes, f.paths.trainingEvidencePath],
    [payload.evalEvidenceBytes, f.paths.holdoutEvidencePath],
  ] as const) {
    const envelope = JSON.parse(bytes.toString());
    expect(envelope.evidenceType).toBe("skillpress.reviewed-tool-evidence");
    expect(envelope.inputs).toEqual(f.prepared.inputs);
    expect(envelope.measurement).toEqual(JSON.parse(await readFile(join(f.root, path), "utf8")));
  }
  expect(client.getSubmission).toHaveBeenCalledExactlyOnceWith("submission_12345678");
  expect(fetch).not.toHaveBeenCalled();
  expect(runReviewedCodexText).not.toHaveBeenCalled();
});

it("blocks quality-failed tool before submission, with no native or legacy fallback", async () => {
  const f = await fixture(true, 1);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const options = releaseOptions(f);
  const gate = await checkReleaseGate(f.root, options);
  expect(gate.passed).toBe(false);
  expect(gate.issues.map(({ code }) => code)).toContain("training:tool.impact.failed");
  const output: string[] = [];
  const io = {
    stdout: (text: string) => {
      output.push(text);
    },
    stderr: vi.fn(),
  };
  for (const command of ["package", "submit"]) {
    expect(await runCli([command, ...releaseArgs(f)], io)).toBe(3);
    expect(output.at(-1)).toContain("Reviewed tool release gate: blocked");
  }
  await expect(prepareSkillSubmission(f.root, f.prepared.artifacts, options)).rejects.toThrow(
    "exact package",
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(runReviewedCodexText).not.toHaveBeenCalled();
});
