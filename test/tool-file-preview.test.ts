import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

it("previews exact original bytes through the CLI, but blocks model execution and v1 admission", async () => {
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
      executionSupported: false,
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
