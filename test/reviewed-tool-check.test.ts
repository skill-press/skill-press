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
const roots: string[] = [];
const image = `python@sha256:${"a".repeat(64)}`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
async function fixture(licensed = true) {
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
  for (const suite of ["training", "holdout"] as const) {
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
                    score: stage === 2 ? 0.5 : 1,
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
  return { root, paths, prepared };
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
