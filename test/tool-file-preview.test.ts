import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { runCli } from "../src/cli.js";
import {
  parseToolFileSuite,
  prepareToolFilePreview,
  verifyToolFilePreview,
} from "../src/eval/tool-file-preview.js";
import { parseEvaluationSuite } from "../src/eval/load.js";
import * as configLoader from "../src/config/load.js";
import * as staging from "../src/package/stage.js";
import * as fileSuiteRunner from "../src/eval/reviewed-file-suite.js";
import {
  prepareReviewedFileProject,
  verifyReviewedFileProject,
  runPreparedReviewedFileSuite,
} from "../src/eval/reviewed-file-project.js";
vi.mock("../src/eval/codex-text.js", () => ({
  runReviewedCodexText: vi.fn(),
  runReviewedSelectedTextPair: vi.fn(),
}));
import { runReviewedCodexText } from "../src/eval/codex-text.js";

const roots: string[] = [];
const data = Buffer.from([0, 255, 1, 128, 10]);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
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
    "Synthetic fixture",
  ]);
}
function suite(name = "training") {
  return {
    schemaVersion: 2,
    suite: name,
    skill: "csv-quality-check",
    scenarios: [
      {
        id: "read-files",
        category: "positive",
        shouldActivate: true,
        prompt: "Read the supplied original bytes without executing them.",
        expectedBehavior: ["Report the exact byte digest."],
        fixture: {
          files: [
            {
              path: "input.bin",
              source: `fixtures/${name}/input.bin`,
              bytes: data.length,
              sha256: digest(data),
            },
          ],
        },
      },
    ],
  };
}
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "tool-file-preview-"));
  roots.push(root);
  await mkdir(join(root, "skills"));
  await cp("skills/csv-quality-check", join(root, "skills/csv-quality-check"), { recursive: true });
  await cp("examples/launch-skills/csv-quality-check-evals", join(root, "evals"), {
    recursive: true,
  });
  const config = parse(await readFile("skill-press.yaml", "utf8"));
  config.skill.name = config.project.name = "csv-quality-check";
  config.skill.path = "skills/csv-quality-check";
  await writeFile(join(root, "skill-press.yaml"), stringify(config));
  await writeFile(join(root, ".gitignore"), ".skill-press/\n");
  for (const name of ["training", "holdout"]) {
    await mkdir(join(root, "evals/fixtures", name), { recursive: true });
    await writeFile(join(root, `evals/fixtures/${name}/input.bin`), data);
    await writeFile(join(root, `evals/${name}.yaml`), stringify(suite(name)));
  }
  git(root, ["init", "--quiet"]);
  commit(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

it("binds both file suites and all skill resources to the committed project", async () => {
  const root = await fixture();
  const prepared = await prepareReviewedFileProject(root, `python@sha256:${"a".repeat(64)}`);
  expect(prepared.training.files[0]?.files[0]?.content).toEqual(new Uint8Array(data));
  expect(prepared.holdout.definition.suite).toBe("holdout");
  expect(prepared.skillFiles.some((file) => file.path === "SKILL.md")).toBe(true);
  await verifyReviewedFileProject(root, structuredClone(prepared));
  const runner = vi
    .spyOn(fileSuiteRunner, "runReviewedFileSuite")
    .mockResolvedValue({ complete: true, releaseEligible: false } as never);
  const callbacks = {
    onEvent: vi.fn(),
    onResult: vi.fn(),
    suite: { skill: "injected" },
    files: [],
    maxModelCalls: 999999,
  };
  const result = await runPreparedReviewedFileSuite(root, prepared, "holdout", 1000, callbacks);
  expect(result).toMatchObject({ source: prepared.source, complete: true, releaseEligible: false });
  expect(runner.mock.calls[0]?.[0]).toMatchObject({
    suite: prepared.holdout.definition,
    maxModelCalls: 1000,
    repetitions: prepared.config.evaluation.repetitions,
    files: prepared.holdout.files,
  });
  expect(runReviewedCodexText).not.toHaveBeenCalled();
});

it.each(["memory", "source", "suite"])(
  "rejects changed %s before suite execution",
  async (kind) => {
    const root = await fixture();
    const prepared = await prepareReviewedFileProject(root, `python@sha256:${"a".repeat(64)}`);
    const runner = vi.spyOn(fileSuiteRunner, "runReviewedFileSuite");
    if (kind === "memory") prepared.skillText += "changed";
    if (kind === "source")
      await writeFile(join(root, "evals/fixtures/training/input.bin"), "changed");
    await expect(
      runPreparedReviewedFileSuite(
        root,
        prepared,
        kind === "suite" ? ("bad" as never) : "training",
        1000,
        { onEvent: vi.fn(), onResult: vi.fn() },
      ),
    ).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  },
);

it.each([true, false])("checks source on exit when suite throws=%s", async (throws) => {
  const root = await fixture();
  const prepared = await prepareReviewedFileProject(root, `python@sha256:${"a".repeat(64)}`);
  vi.spyOn(fileSuiteRunner, "runReviewedFileSuite").mockImplementation(async () => {
    await writeFile(join(root, "evals/fixtures/holdout/input.bin"), "changed");
    if (throws) throw new Error("suite failed");
    return { complete: true } as never;
  });
  await expect(
    runPreparedReviewedFileSuite(
      root,
      prepared,
      "training",
      1000,
      { onEvent: vi.fn(), onResult: vi.fn() },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Native release inputs must be clean and tracked.");
});

it("rejects a mixed v1/v2 project before model execution", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "evals/holdout.yaml"),
    stringify({ ...suite("holdout"), schemaVersion: 1 }),
  );
  commit(root);
  await expect(prepareReviewedFileProject(root, `python@sha256:${"a".repeat(64)}`)).rejects.toThrow(
    "Both file suites",
  );
});

it("rejects a commit changed during project preparation", async () => {
  const root = await fixture();
  const original = staging.stageCanonicalSkill;
  let first = true;
  vi.spyOn(staging, "stageCanonicalSkill").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (first) {
      first = false;
      await writeFile(join(root, "README.md"), "source changed");
      commit(root);
    }
    return result;
  });
  await expect(prepareReviewedFileProject(root, `python@sha256:${"a".repeat(64)}`)).rejects.toThrow(
    "changed during preparation",
  );
});

it("previews original bytes but blocks insufficient execution budget and v1 admission", async () => {
  const root = await fixture();
  const prepared = await prepareToolFilePreview(root, "training");
  expect(prepared?.scenarios[0].files[0].content).toEqual(data);
  if (prepared === null) throw new Error("Expected v2 preview");
  await verifyToolFilePreview(root, prepared);
  expect(() => parseEvaluationSuite(suite())).toThrow();
  for (const dry of [true, false]) {
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    const args = [
      "eval-tool",
      "--project",
      root,
      "--suite",
      "training",
      "--json",
      ...(dry ? ["--dry-run"] : ["--reviewed-inputs", "--max-model-calls", "11"]),
    ];
    expect(await runCli(args, io)).toBe(dry ? 0 : 3);
    const report = JSON.parse(io.stdout.mock.calls[0][0]);
    expect(report).toMatchObject({
      modelCalls: 0,
      readinessAssessed: false,
      executionSupported: true,
      releaseAuthorized: false,
    });
    expect(report.scenarios[0].files[0]).toMatchObject({
      mount: "/input/input.bin",
      bytes: data.length,
      sha256: digest(data),
    });
  }
  expect(runReviewedCodexText).not.toHaveBeenCalled();
  const io = {
    stdout: vi.fn(() => {
      throw new Error("closed output");
    }),
    stderr: vi.fn(),
  };
  expect(
    await runCli(["eval-tool", "--project", root, "--suite", "training", "--dry-run"], io),
  ).toBe(1);
});

it.each([
  "complete",
  "incomplete",
  "cancel",
  "suite-error",
  "progress-error",
  "closed-output",
  "closed-error",
])("public file evaluation retains private checkpoints for %s", async (kind) => {
  const root = await fixture();
  const before = process.listenerCount("SIGINT");
  const runner = vi
    .spyOn(fileSuiteRunner, "runReviewedFileSuite")
    .mockImplementation(async (options) => {
      await options.onEvent({ runId: "synthetic", scenarioId: "read-files", repetition: 1 }, {
        phase: "actor",
        prompt: { text: "PRIVATE_PROMPT" },
      } as never);
      if (kind === "suite-error") throw new Error("PRIVATE_PROVIDER_FAILURE");
      if (kind === "cancel") {
        process.emit("SIGINT");
        expect(options.signal?.aborted).toBe(true);
      }
      await options.onResult({
        runId: "synthetic",
        scenarioId: "read-files",
        repetition: 1,
        status: "failed",
        reason: "pair_execution_failed",
      });
      return {
        complete: kind !== "incomplete",
        summary: null,
        releaseEligible: false,
      } as never;
    });
  const io = {
    stdout: vi.fn(() => {
      if (kind === "closed-output") throw new Error("closed");
    }),
    stderr: vi.fn((text: string) => {
      if (kind === "closed-error" || (kind === "progress-error" && text.includes("eval-tool.step")))
        throw new Error("closed");
    }),
  };
  const code = await runCli(
    [
      "eval-tool",
      "--project",
      root,
      "--suite",
      "training",
      "--reviewed-inputs",
      "--max-model-calls",
      "1000",
      "--json",
    ],
    io,
  );
  expect(code).toBe(
    kind === "complete" ? 0 : ["closed-output", "closed-error"].includes(kind) ? 1 : 3,
  );
  expect(process.listenerCount("SIGINT")).toBe(before);
  const messages = io.stderr.mock.calls.map(([text]) => JSON.parse(text));
  const started = messages.find((message) => message.event === "eval-tool.started");
  expect(started.checkpointPath).toMatch(/^\.skill-press\/runs\/[a-f0-9]{64}$/);
  const path = join(root, started.checkpointPath);
  expect((await stat(join(path, "plan.json"))).mode & 0o777).toBe(0o600);
  if (kind !== "closed-error")
    expect(await readFile(join(path, "event-1.json"), "utf8")).toContain("PRIVATE_PROMPT");
  if (["complete", "incomplete", "closed-output"].includes(kind)) {
    expect(JSON.parse(await readFile(join(path, "diagnostic.json"), "utf8"))).toMatchObject({
      releaseEligible: false,
    });
  }
  expect(JSON.stringify(io.stdout.mock.calls)).not.toContain("PRIVATE_PROMPT");
  expect(JSON.stringify(io.stderr.mock.calls)).not.toContain("PRIVATE_PROVIDER_FAILURE");
  expect(runner).toHaveBeenCalledTimes(kind === "closed-error" ? 0 : 1);
});

it("rejects file execution when checkpoints are not ignored", async () => {
  const root = await fixture();
  await writeFile(join(root, ".gitignore"), ".skill-press/staging/\n");
  commit(root);
  const runner = vi.spyOn(fileSuiteRunner, "runReviewedFileSuite");
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(
    await runCli(
      [
        "eval-tool",
        "--project",
        root,
        "--suite",
        "training",
        "--reviewed-inputs",
        "--max-model-calls",
        "1000",
      ],
      io,
    ),
  ).toBe(3);
  expect(runner).not.toHaveBeenCalled();
});

it.each([
  "digest",
  "size",
  "cross-suite",
  "traversal",
  "mount-collision",
  "identity",
  "suite-identity",
  "symlink",
])("rejects committed %s input", async (kind) => {
  const root = await fixture();
  const value = suite();
  const file = value.scenarios[0].fixture.files[0];
  if (kind === "digest") file.sha256 = "0".repeat(64);
  if (kind === "size") file.bytes++;
  if (kind === "cross-suite") file.source = "fixtures/holdout/input.bin";
  if (kind === "traversal") file.source = "fixtures/training/../input.bin";
  if (kind === "mount-collision") value.scenarios[0].fixture.files.push({ ...file });
  if (kind === "identity") value.skill = "wrong-skill";
  if (kind === "suite-identity") value.suite = "holdout";
  if (kind === "symlink") {
    await symlink("input.bin", join(root, "evals/fixtures/training/link.bin"));
    file.source = "fixtures/training/link.bin";
  }
  await writeFile(join(root, "evals/training.yaml"), stringify(value));
  commit(root);
  await expect(prepareToolFilePreview(root, "training")).rejects.toThrow();
});

it.each(["source", "memory", "length"])("rejects changed %s after preparing", async (kind) => {
  const root = await fixture();
  const prepared = await prepareToolFilePreview(root, "training");
  if (prepared === null) throw new Error("Expected v2 preview");
  if (kind === "source")
    await writeFile(join(root, "evals/fixtures/training/input.bin"), "changed");
  if (kind === "memory") prepared.scenarios[0].files[0].content[0] = 3;
  if (kind === "length") prepared.scenarios[0].files.pop();
  await expect(verifyToolFilePreview(root, prepared)).rejects.toThrow();
});

it("supports an empty fixture and preserves v1 routing", async () => {
  const root = await fixture();
  const value = suite();
  delete (value.scenarios[0] as { fixture?: unknown }).fixture;
  await writeFile(join(root, "evals/training.yaml"), stringify(value));
  commit(root);
  expect((await prepareToolFilePreview(root, "training"))?.scenarios[0].files).toEqual([]);
  await writeFile(join(root, "evals/training.yaml"), "schemaVersion: 1\n");
  expect(await prepareToolFilePreview(root, "training")).toBeNull();
  expect(() => parseToolFileSuite({})).toThrow();
});

it("uses the manifest reloaded after the source snapshot, not the version probe", async () => {
  const root = await fixture();
  const stale = suite();
  stale.scenarios[0].fixture.files[0].sha256 = "0".repeat(64);
  const load = configLoader.loadStrictYamlDocument;
  let probed = false;
  vi.spyOn(configLoader, "loadStrictYamlDocument").mockImplementation(async (path) => {
    if (!probed && path.endsWith("/evals/training.yaml")) {
      probed = true;
      return stale;
    }
    return load(path);
  });
  expect((await prepareToolFilePreview(root, "training"))?.scenarios[0].metadata[0].sha256).toBe(
    digest(data),
  );
});

it("rejects source changes during preparation before returning a preview", async () => {
  const root = await fixture();
  const stage = staging.stageCanonicalSkill;
  vi.spyOn(staging, "stageCanonicalSkill").mockImplementation(async (...args) => {
    const result = await stage(...args);
    await writeFile(join(root, "evals/new.txt"), "changed after entry");
    return result;
  });
  await expect(prepareToolFilePreview(root, "training")).rejects.toThrow();
});
