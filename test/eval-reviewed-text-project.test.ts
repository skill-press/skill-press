import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

vi.mock("../src/eval/codex-text.js", () => ({ runReviewedSelectedTextPair: vi.fn() }));
import { runReviewedSelectedTextPair } from "../src/eval/codex-text.js";
import {
  prepareReviewedTextProject,
  runPreparedReviewedTextSuite,
  verifyReviewedTextProject,
} from "../src/eval/reviewed-text-project.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reviewed-text-project-"));
  roots.push(root);
  await mkdir(join(root, "skills"));
  await cp("skills/release-notes", join(root, "skills/release-notes"), { recursive: true });
  await cp("examples/launch-skills/release-notes-evals", join(root, "evals"), { recursive: true });
  const config = parse(await readFile("skill-press.yaml", "utf8"));
  config.project.name = "release-notes";
  config.skill.name = "release-notes";
  config.skill.path = "skills/release-notes";
  await writeFile(join(root, "skill-press.yaml"), stringify(config));
  await writeFile(join(root, ".gitignore"), ".skill-press/\n");
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Synthetic source",
    ],
  ])
    execFileSync("git", args, { cwd: root });
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

it("binds reviewed text, full source, config, suites and a verified release archive without inference", async () => {
  const root = await fixture();
  const prepared = await prepareReviewedTextProject(root);
  expect(prepared.source.commit).toBe(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  );
  expect(prepared.source.skillSha256).toBe(prepared.artifacts.skillSha256);
  expect(prepared.skillTextSha256).toBe(
    createHash("sha256").update(prepared.skillText).digest("hex"),
  );
  expect(prepared.skillTextSha256).not.toBe(prepared.source.skillSha256);
  expect(prepared.inputs.training.scenarios).toHaveLength(5);
  expect(prepared.inputs.holdout.scenarios).toHaveLength(2);
  expect(prepared.releaseEligible).toBe(false);
  await verifyReviewedTextProject(root, prepared);
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it("connects the prepared project to all holdout repetitions while keeping admission false", async () => {
  const root = await fixture();
  const prepared = await prepareReviewedTextProject(root);
  vi.mocked(runReviewedSelectedTextPair).mockImplementation(async (scenario, rubric) => {
    const criteria = rubric.criteria
      .filter((c) => c.evaluator === "judge")
      .map((c) => ({ id: c.id, score: 1, rationale: "Synthetic protocol test." }));
    return {
      baseline: { criteria },
      withSkill: { activated: scenario.shouldActivate, criteria },
      releaseEligible: false,
    } as Awaited<ReturnType<typeof runReviewedSelectedTextPair>>;
  });
  const persisted = vi.fn().mockResolvedValue(undefined);
  const result = await runPreparedReviewedTextSuite(root, prepared, "holdout", persisted);
  expect(result).toMatchObject({
    complete: true,
    plannedPairs: 6,
    releaseEligible: false,
    source: prepared.source,
    artifact: { sha256: prepared.artifacts.artifactSha256 },
    ineligibilityReasons: ["text_profile_not_admitted"],
  });
  expect(persisted).toHaveBeenCalledTimes(6);
  expect(Object.isFrozen(prepared.inputs.holdout.scenarios)).toBe(true);
});

it.each(["text", "inputs", "config"])(
  "rejects altered prepared %s before inference",
  async (kind) => {
    const root = await fixture();
    const prepared = await prepareReviewedTextProject(root);
    const altered = structuredClone(prepared);
    if (kind === "text") {
      altered.skillText = "replacement";
      altered.skillTextSha256 = createHash("sha256").update(altered.skillText).digest("hex");
    }
    if (kind === "inputs") altered.inputs.training.scenarios[0].prompt = "A different task.";
    if (kind === "config") altered.config.evaluation.repetitions = 1;
    await expect(
      runPreparedReviewedTextSuite(root, altered, "training", async () => {}),
    ).rejects.toThrow(/changed/);
    expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
  },
);

it("refuses to return bound evidence when source changes during model evaluation", async () => {
  const root = await fixture();
  const prepared = await prepareReviewedTextProject(root);
  vi.mocked(runReviewedSelectedTextPair).mockRejectedValue(new Error("Synthetic interrupted pair"));
  await expect(
    runPreparedReviewedTextSuite(root, prepared, "holdout", async () => {
      await writeFile(join(root, "evals/holdout.yaml"), "changed during evaluation");
    }),
  ).rejects.toThrow();
  expect(runReviewedSelectedTextPair).toHaveBeenCalledTimes(1);
});

it("rejects dirty evaluation inputs before preparing evidence", async () => {
  const root = await fixture();
  await writeFile(join(root, "evals/untracked.txt"), "unreviewed data");
  await expect(prepareReviewedTextProject(root)).rejects.toThrow(/clean and tracked/);
});

it("rejects bundled resources instead of silently evaluating only the document", async () => {
  const root = await fixture();
  await writeFile(join(root, "skills/release-notes/extra.txt"), "Extra resource");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Add resource",
    ],
    { cwd: root },
  );
  await expect(prepareReviewedTextProject(root)).rejects.toThrow();
  expect(runReviewedSelectedTextPair).not.toHaveBeenCalled();
});

it.each(["source", "artifact"])("detects changed %s at the exit boundary", async (kind) => {
  const root = await fixture();
  const prepared = await prepareReviewedTextProject(root);
  const target =
    kind === "source"
      ? join(root, "evals/training.yaml")
      : join(root, prepared.artifacts.artifactsPath, prepared.artifacts.skillArchive);
  await writeFile(target, "modified");
  await expect(verifyReviewedTextProject(root, prepared)).rejects.toThrow();
});
