import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/eval/reviewed-tool-suite.js", () => ({ runReviewedToolSuite: vi.fn() }));
import { runReviewedToolSuite } from "../src/eval/reviewed-tool-suite.js";
import {
  prepareReviewedToolProject,
  runPreparedReviewedToolSuite,
  verifyReviewedToolProject,
} from "../src/eval/reviewed-tool-project.js";
const run = vi.mocked(runReviewedToolSuite);
const roots: string[] = [];
const image = `python@sha256:${"a".repeat(64)}`;
const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
function commit(root: string) {
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
    "Synthetic reviewed inputs",
  ]);
}
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "reviewed-tool-project-"));
  roots.push(root);
  await mkdir(join(root, "skills"));
  await cp("skills/csv-quality-check", join(root, "skills/csv-quality-check"), { recursive: true });
  await cp("examples/launch-skills/csv-quality-check-evals", join(root, "evals"), {
    recursive: true,
  });
  await cp("LICENSE", join(root, "skills/csv-quality-check/LICENSE"));
  const config = parse(await readFile("skill-press.yaml", "utf8"));
  config.project.name = "csv-quality-check";
  config.skill.name = "csv-quality-check";
  config.skill.path = "skills/csv-quality-check";
  await writeFile(join(root, "skill-press.yaml"), stringify(config));
  await writeFile(join(root, ".gitignore"), ".skill-press/\n");
  git(root, ["init", "--quiet"]);
  commit(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.resetAllMocks();
});
it("binds the complete script-bearing skill, inputs and real archive without execution", async () => {
  const root = await fixture();
  const prepared = await prepareReviewedToolProject(root, image);
  expect(prepared.skillFiles.map((f) => f.path)).toEqual([
    "LICENSE",
    "SKILL.md",
    "scripts/profile.py",
  ]);
  expect(prepared.source.commit).toBe(git(root, ["rev-parse", "HEAD"]));
  expect(prepared.source.skillSha256).toBe(prepared.artifacts.skillSha256);
  expect(Object.isFrozen(prepared.skillFiles[0])).toBe(true);
  expect(prepared.releaseEligible).toBe(false);
  await verifyReviewedToolProject(root, prepared);
  expect(run).not.toHaveBeenCalled();
});
it.each(["training", "holdout"] as const)(
  "passes prepared %s inputs and binds the returned manifest",
  async (suite) => {
    const root = await fixture();
    const prepared = await prepareReviewedToolProject(root, image);
    const signal = new AbortController().signal;
    run.mockResolvedValue({
      releaseEligible: false,
      ineligibilityReasons: ["tool_profile_not_admitted", "artifact_binding_not_established"],
    } as never);
    const callbacks = { onEvent: vi.fn(), onResult: vi.fn() };
    const result = await runPreparedReviewedToolSuite(root, prepared, suite, callbacks, signal);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        suite: prepared.inputs[suite],
        skillFiles: prepared.skillFiles,
        image,
        signal,
        repetitions: 3,
        readinessMinimum: 90,
        ...callbacks,
      }),
    );
    expect(result).toMatchObject({
      source: prepared.source,
      artifact: { sha256: prepared.artifacts.artifactSha256 },
      ineligibilityReasons: ["tool_profile_not_admitted"],
      releaseEligible: false,
    });
  },
);
it.each(["resource", "omitted", "extra", "text", "config", "inputs", "artifact", "hash"])(
  "rejects forged prepared %s before inference",
  async (kind) => {
    const root = await fixture();
    const prepared = structuredClone(await prepareReviewedToolProject(root, image));
    if (kind === "resource") prepared.skillFiles[2].content = "print('changed')";
    if (kind === "omitted") prepared.skillFiles.pop();
    if (kind === "extra") prepared.skillFiles.push({ path: "extra.txt", content: "extra" });
    if (kind === "text") prepared.skillText += "changed";
    if (kind === "config") prepared.config.evaluation.repetitions = 1;
    if (kind === "inputs") prepared.inputs.training.scenarios[0].prompt += " changed";
    if (kind === "artifact") prepared.artifacts.artifactSha256 = "f".repeat(64);
    if (kind === "hash") prepared.skillTextSha256 = "f".repeat(64);
    await expect(
      runPreparedReviewedToolSuite(root, prepared, "training", {
        onEvent: vi.fn(),
        onResult: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  },
);
it("rejects old provenance mixed with newly committed evaluation inputs before inference", async () => {
  const root = await fixture();
  const old = await prepareReviewedToolProject(root, image);
  const path = join(root, "evals/training.yaml");
  const suite = parse(await readFile(path, "utf8"));
  suite.scenarios[0].prompt += " Verify all counts.";
  await writeFile(path, stringify(suite));
  commit(root);
  const current = structuredClone(await prepareReviewedToolProject(root, image));
  current.artifacts = old.artifacts;
  await expect(
    runPreparedReviewedToolSuite(root, current, "training", {
      onEvent: vi.fn(),
      onResult: vi.fn(),
    }),
  ).rejects.toThrow("changed after preparation");
  expect(run).not.toHaveBeenCalled();
});

it.each(["dirty", "committed", "added"])("detects %s source changes at exit", async (kind) => {
  const root = await fixture();
  const prepared = await prepareReviewedToolProject(root, image);
  run.mockImplementation(async () => {
    await writeFile(
      join(
        root,
        kind === "added"
          ? "skills/csv-quality-check/extra.txt"
          : "skills/csv-quality-check/scripts/profile.py",
      ),
      "changed\n",
    );
    if (kind === "committed") commit(root);
    return { ineligibilityReasons: [] } as never;
  });
  await expect(
    runPreparedReviewedToolSuite(root, prepared, "training", {
      onEvent: vi.fn(),
      onResult: vi.fn(),
    }),
  ).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(1);
});
it("snapshots deserialized prepared inputs before awaiting and propagates storage errors", async () => {
  const root = await fixture();
  const prepared = structuredClone(await prepareReviewedToolProject(root, image));
  run.mockImplementation(async () => {
    prepared.skillFiles.pop();
    return { ineligibilityReasons: ["artifact_binding_not_established"] } as never;
  });
  await expect(
    runPreparedReviewedToolSuite(root, prepared, "holdout", {
      onEvent: vi.fn(),
      onResult: vi.fn(),
    }),
  ).resolves.toHaveProperty("artifact");
  const fresh = await prepareReviewedToolProject(root, image);
  run.mockRejectedValue(Error("disk full"));
  await expect(
    runPreparedReviewedToolSuite(root, fresh, "holdout", { onEvent: vi.fn(), onResult: vi.fn() }),
  ).rejects.toThrow("disk full");
});
it.each(["binary", "image", "environment", "suite"])(
  "rejects unsupported %s before execution",
  async (kind) => {
    const root = await fixture();
    if (kind === "binary") {
      await writeFile(join(root, "skills/csv-quality-check/data.bin"), Buffer.from([255]));
      commit(root);
    }
    if (kind === "environment") {
      const path = join(root, "evals/training.yaml");
      const value = parse(await readFile(path, "utf8"));
      value.scenarios[0].fixture.environment = { TOKEN: "no" };
      await writeFile(path, stringify(value));
      commit(root);
    }
    if (kind === "suite") {
      const prepared = await prepareReviewedToolProject(root, image);
      await expect(
        runPreparedReviewedToolSuite(root, prepared, "unknown" as never, {
          onEvent: vi.fn(),
          onResult: vi.fn(),
        }),
      ).rejects.toThrow("Unknown tool suite");
    } else
      await expect(
        prepareReviewedToolProject(root, kind === "image" ? "python:latest" : image),
      ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  },
);
