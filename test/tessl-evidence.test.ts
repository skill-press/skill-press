import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";
import type { CapturedCommand, CapturedCommandResult } from "../src/process/capture.js";
import {
  captureTesslEvalEvidence,
  captureTesslReviewEvidence,
  normalizeTesslRelativePath,
  TesslEvidenceError,
  type TesslCommandExecutor,
} from "../src/tessl/evidence.js";
import { tesslCommandDigest } from "../src/tessl/command-digest.js";
import { isTrustedTesslCli } from "../src/tessl/trusted-cli.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));
const temporaryRoot = realpathSync(tmpdir());

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function project(): Promise<{ root: string; executable: string; evalSource: string }> {
  const parent = await mkdtemp(join(temporaryRoot, "skillpress-tessl-evidence-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "project");
  await writeRenderedProject(renderCapabilityProject(await loadCapabilityBrief(briefPath)), root);
  const evalSource = join(root, "tessl-evals");
  await mkdir(join(evalSource, ".tessl-plugin"), { recursive: true });
  await mkdir(join(evalSource, "evals", "scenario-one"), { recursive: true });
  await mkdir(join(evalSource, "evals", "scenario-two"));
  await mkdir(join(evalSource, "skills"));
  await writeFile(
    join(evalSource, ".tessl-plugin", "plugin.json"),
    '{"name":"test/incident-summary","version":"0.1.0","private":true,"skills":["skills/incident-summary"]}\n',
  );
  const criteria =
    '{"context":"test","type":"weighted_checklist","checklist":[{"name":"critical_safety","description":"test","max_score":10},{"name":"quality","description":"test","max_score":90}]}\n';
  for (const scenario of ["scenario-one", "scenario-two"]) {
    await writeFile(join(evalSource, "evals", scenario, "criteria.json"), criteria);
    await writeFile(join(evalSource, "evals", scenario, "task.md"), "# Test\n");
  }
  await cp(
    join(root, "skills", "incident-summary"),
    join(evalSource, "skills", "incident-summary"),
    {
      recursive: true,
    },
  );
  const executable = join(parent, "tessl-fake");
  await writeFile(executable, "#!/bin/sh\nexit 99\n");
  await chmod(executable, 0o755);
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
  return { root, executable, evalSource };
}

function result(
  stdout: string,
  status: CapturedCommandResult["status"] = "passed",
  stderr = "",
): CapturedCommandResult {
  const stdoutBuffer = Buffer.from(stdout);
  const stderrBuffer = Buffer.from(stderr);
  return Object.freeze({
    status,
    exitCode: status === "passed" ? 0 : 1,
    signal: null,
    durationMs: 1,
    stdout: stdoutBuffer,
    stderr: stderrBuffer,
    stdoutBytes: stdoutBuffer.byteLength,
    stderrBytes: stderrBuffer.byteLength,
    stdoutSha256: createHash("sha256").update(stdoutBuffer).digest("hex"),
    stderrSha256: createHash("sha256").update(stderrBuffer).digest("hex"),
  });
}

function executorFor(
  handler: (args: readonly string[], command: CapturedCommand) => CapturedCommandResult,
  observed: string[][] = [],
): TesslCommandExecutor {
  let evalInvocation: readonly string[] = [];
  return async (command) => {
    const args = command.argv.slice(1);
    observed.push([...args]);
    if (args[0] === "eval" && args[1] === "run") evalInvocation = args;
    const captured = handler(args, command);
    if (captured.status !== "passed" || evalInvocation.length === 0) return captured;
    let value: unknown;
    try {
      value = JSON.parse(captured.stdout.toString("utf8"));
    } catch {
      return captured;
    }
    const candidate = Array.isArray(value) ? value[0] : value;
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      const contextPath = evalInvocation[evalInvocation.indexOf("--context") + 1] as string;
      if (typeof record.evalRunId === "string" && record.context === undefined) {
        record.context = {
          definition: { type: "plugin-directory", path: contextPath },
        };
      }
      const data = record.data;
      if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        const attributes = (data as Record<string, unknown>).attributes;
        if (
          attributes !== null &&
          typeof attributes === "object" &&
          !Array.isArray(attributes) &&
          (attributes as Record<string, unknown>).status === "completed"
        ) {
          const output = attributes as Record<string, unknown>;
          output.evalRunFixtures ??= {
            context: { type: "plugin-directory", path: contextPath },
          };
          output.metadata ??= { cliInvocation: evalInvocation.join(" ") };
        }
      }
    }
    const stdout = Buffer.from(JSON.stringify(value));
    return Object.freeze({
      ...captured,
      stdout,
      stdoutBytes: stdout.byteLength,
      stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
    });
  };
}

function reviewExecutor(
  review: Record<string, unknown> = {
    reviewRunId: "review-run-1",
    validation: { overallPassed: true },
    review: { reviewScore: 94 },
  },
  observed: string[][] = [],
  environments: Array<Readonly<Record<string, string>>> = [],
): TesslCommandExecutor {
  return executorFor((args, command) => {
    environments.push(command.env);
    if (args[0] === "--version") return result("Tessl terms\n0.101.0\n");
    if (args[0] === "skill") return result("lint passed\n");
    if (args[0] === "review") return result(`${JSON.stringify(review)}\n`);
    return result("", "failed", "unexpected command");
  }, observed);
}

function completedEval(
  overrides: Record<string, unknown> = {},
  invocation?: readonly string[],
): Record<string, unknown> {
  const contextPath =
    invocation === undefined ? undefined : invocation[invocation.indexOf("--context") + 1];
  const runCount =
    invocation === undefined ? 3 : Number(invocation[invocation.indexOf("--runs") + 1]);
  const completedRuns = () => Array.from({ length: runCount }, () => ({ status: "completed" }));
  return {
    data: {
      id: "eval-run-1",
      attributes: {
        status: "completed",
        agent: "codex",
        model: "gpt-fixed",
        runCount,
        ...(contextPath === undefined
          ? {}
          : {
              evalRunFixtures: {
                context: { type: "plugin-directory", path: contextPath },
              },
              metadata: { cliInvocation: invocation?.join(" ") },
            }),
        scenarios: [
          {
            fingerprint: "scenario-one",
            solutions: [
              {
                variant: "baseline",
                runs: completedRuns(),
                assessmentResults: [
                  { name: "critical_safety", score: 4, max_score: 10 },
                  { name: "quality", score: 36, max_score: 90 },
                ],
              },
              {
                variant: "usage-spec",
                runs: completedRuns(),
                assessmentResults: [
                  { name: "critical_safety", score: 10, max_score: 10 },
                  { name: "quality", score: 80, max_score: 90 },
                ],
              },
            ],
          },
          {
            fingerprint: "scenario-two",
            solutions: [
              {
                variant: "baseline",
                runs: completedRuns(),
                assessmentResults: [
                  { name: "critical_safety", score: 6, max_score: 10 },
                  { name: "quality", score: 54, max_score: 90 },
                ],
              },
              {
                variant: "usage-spec",
                runs: completedRuns(),
                assessmentResults: [
                  { name: "critical_safety", score: 10, max_score: 10 },
                  { name: "quality", score: 90, max_score: 90 },
                ],
              },
            ],
          },
        ],
        ...overrides,
      },
    },
  };
}

describe("Tessl official evidence bridge", () => {
  it("binds Windows lint staging paths with the portable server-policy spelling", () => {
    const executableSha256 = "a".repeat(64);
    const storagePath = `.skill-press/tessl/${"b".repeat(64)}`;
    const windowsManifest = win32.relative(
      String.raw`C:\repo`,
      win32.join(String.raw`C:\repo`, storagePath, "lint-plugin", ".tessl-plugin", "plugin.json"),
    );
    const portableManifest = `${storagePath}/lint-plugin/.tessl-plugin/plugin.json`;

    expect(windowsManifest).toContain("\\");
    expect(normalizeTesslRelativePath(windowsManifest)).toBe(portableManifest);
    expect(normalizeTesslRelativePath(portableManifest)).toBe(portableManifest);
    expect(
      tesslCommandDigest(executableSha256, [
        "skill",
        "lint",
        normalizeTesslRelativePath(windowsManifest),
      ]),
    ).toBe(tesslCommandDigest(executableSha256, ["skill", "lint", portableManifest]));
  });

  it("trusts only a signed-release version and executable digest pair", () => {
    const releaseDigests = [
      "9494050a66ec8a6f3f82405f7d7c5afccbdc03c1a195a823e07b6bfc5dea2f6c",
      "a8a71b43399998cbafa787503c6a51b0e212e0c2883f5bcc2cf094d141d7993a",
      "405aac95750048ec31c4026cf38b389442a6dbe5eecce9908a399c615e2ea386",
      "316819d34dbf200f07c605abdceda2ae920581c26da51a5f21b93b56e2b1a6b2",
      "67b974938e244edf0e24523be84dcb55b56ef41c4813bf86be8715d7055a4e0e",
      "fd2cf07b81f408c648013b76e92b5e8eea1565f54dca46adeda0ec8cc6a59098",
      "283d1df9bc8c6a12a5511979d6de5b1524703e7bd8cc99c77963ff29f4cd31ce",
      "4816ce6bea0188a3a61480e43807a0ffe588c114d224d027dcc2798d7bbd63b7",
      "ed1c04bd0e2242f2950e14acec99bb20d33b946af792c8133049bd72a7734601",
      "a922e16f58e223ddc5ef7d38f33138250548bc78b30668a27af9974159b12129",
    ];
    expect(releaseDigests.every((value) => isTrustedTesslCli("0.101.0", value))).toBe(true);
    expect(isTrustedTesslCli("0.101.0", "0".repeat(64))).toBe(false);
    expect(
      isTrustedTesslCli(
        "0.99.0",
        "60db8f2be553fd2221d097dca6f748f9372f54af42ad1329149ae4c180d7dd39",
      ),
    ).toBe(false);
    expect(
      isTrustedTesslCli(
        "1.0.0",
        "9494050a66ec8a6f3f82405f7d7c5afccbdc03c1a195a823e07b6bfc5dea2f6c",
      ),
    ).toBe(false);
  });
  it("captures lint and Quality from exact official commands without exposing raw output", async () => {
    const fixture = await project();
    const observed: string[][] = [];
    const environments: Array<Readonly<Record<string, string>>> = [];
    const evidence = await captureTesslReviewEvidence(fixture.root, {
      executable: fixture.executable,
      workspace: "fixed-workspace",
      executor: reviewExecutor(undefined, observed, environments),
      now: () => new Date("2026-08-24T12:34:56.789Z"),
    });

    expect(observed[0]).toEqual(["--version"]);
    expect(observed[1]).toEqual([
      "skill",
      "lint",
      expect.stringMatching(
        /^\.skill-press\/tessl\/[a-f0-9]{64}\/lint-plugin\/\.tessl-plugin\/plugin\.json$/u,
      ),
    ]);
    expect(observed[2]).toEqual([
      "review",
      "run",
      "quality",
      "--json",
      "--force",
      "--workspace",
      "fixed-workspace",
      "--threshold",
      "0",
      "skills/incident-summary",
    ]);
    expect(environments).toHaveLength(3);
    for (const [index, environment] of environments.entries()) {
      expect(environment).toMatchObject({
        NO_COLOR: "1",
        TESSL_AUTO_UPDATE_INTERVAL_MINUTES: "0",
      });
      const home = environment.HOME as string;
      expect(environment.USERPROFILE).toBe(home);
      expect(environment.XDG_CONFIG_HOME).toBe(join(home, "config"));
      expect(environment.XDG_DATA_HOME).toBe(join(home, "data"));
      expect(environment.XDG_STATE_HOME).toBe(join(home, "state"));
      expect(environment.XDG_CACHE_HOME).toBe(join(home, "cache"));
      expect(environment.APPDATA).toBe(join(home, "appdata", "roaming"));
      expect(environment.LOCALAPPDATA).toBe(join(home, "appdata", "local"));
      expect(
        Object.keys(environment)
          .filter((key) => key !== "TESSL_TOKEN")
          .sort(),
      ).toEqual(
        [
          "APPDATA",
          "HOME",
          "LOCALAPPDATA",
          "NO_COLOR",
          "TESSL_AUTO_UPDATE_INTERVAL_MINUTES",
          "USERPROFILE",
          "XDG_CACHE_HOME",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_STATE_HOME",
        ].sort(),
      );
      expect(environment.TESSL_TOKEN).toBe(index < 2 ? undefined : process.env.TESSL_TOKEN);
      await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(evidence).toMatchObject({
      evidenceType: "skillpress.tessl-review",
      provider: "tessl",
      createdAt: "2026-08-24T12:34:56.789Z",
      review: { runId: "review-run-1", qualityScore: 94, validationPassed: true },
      evidenceEligible: false,
      ineligibilityReasons: ["custom_executor", "untrusted_cli"],
    });
    expect(JSON.stringify(evidence)).not.toContain("lint passed");
    expect(JSON.stringify(evidence)).not.toContain("overallPassed");
    expect(Object.isFrozen(evidence.review)).toBe(true);
    const storage = join(fixture.root, evidence.storagePath);
    expect((await stat(storage)).mode & 0o777).toBe(0o700);
    expect((await stat(join(storage, "evidence.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(storage, "review.stdout"), "utf8")).toContain("reviewScore");
  });

  it("records a deterministic zero when official validation prevented judges from running", async () => {
    const fixture = await project();
    const evidence = await captureTesslReviewEvidence(fixture.root, {
      executable: fixture.executable,
      executor: reviewExecutor({
        validation: { overallPassed: false },
        review: { reviewScore: null },
      }),
    });
    expect(evidence.review).toMatchObject({
      qualityScore: 0,
      validationPassed: false,
      runId: null,
    });
  });

  it("marks dirty relevant inputs independently from provider scores", async () => {
    const fixture = await project();
    await writeFile(join(fixture.root, "skills/incident-summary/LICENSE"), "MIT\nchanged\n");
    const evidence = await captureTesslReviewEvidence(fixture.root, {
      executable: fixture.executable,
      executor: reviewExecutor(),
    });
    expect(evidence.ineligibilityReasons).toContain("dirty_inputs");
  });

  it.each([
    [
      "version failure",
      (args: readonly string[]) => (args[0] === "--version" ? result("", "failed") : undefined),
    ],
    [
      "unknown version",
      (args: readonly string[]) =>
        args[0] === "--version" ? result("Tessl development build\n") : undefined,
    ],
    [
      "lint failure",
      (args: readonly string[]) => (args[0] === "skill" ? result("", "failed") : undefined),
    ],
    [
      "review failure",
      (args: readonly string[]) => (args[0] === "review" ? result("", "failed") : undefined),
    ],
    [
      "missing JSON",
      (args: readonly string[]) => (args[0] === "review" ? result("not json") : undefined),
    ],
    [
      "bad review shape",
      (args: readonly string[]) => (args[0] === "review" ? result("{}") : undefined),
    ],
    [
      "incomplete JSON",
      (args: readonly string[]) =>
        args[0] === "review" ? result('{"review":{"reviewScore":90}') : undefined,
    ],
    [
      "malformed JSON",
      (args: readonly string[]) => (args[0] === "review" ? result("prefix {oops}") : undefined),
    ],
    [
      "missing score",
      (args: readonly string[]) =>
        args[0] === "review"
          ? result('{"validation":{"overallPassed":true},"review":{}}')
          : undefined,
    ],
    [
      "bad run id",
      (args: readonly string[]) =>
        args[0] === "review"
          ? result(
              '{"reviewRunId":7,"validation":{"overallPassed":true},"review":{"reviewScore":90}}',
            )
          : undefined,
    ],
  ] as const)("fails closed on %s", async (_name, fault) => {
    const fixture = await project();
    const executor = executorFor((args) => {
      const injected = fault(args);
      if (injected !== undefined) return injected;
      if (args[0] === "--version") return result("0.101.0\n");
      return result("ok\n");
    });
    await expect(
      captureTesslReviewEvidence(fixture.root, { executable: fixture.executable, executor }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);
  });

  it("rejects invalid options, executors, source roots, storage, and Git state", async () => {
    const fixture = await project();
    await expect(
      captureTesslReviewEvidence(fixture.root, {
        executable: fixture.executable,
        workspace: "bad\nworkspace",
        executor: reviewExecutor(),
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);
    await expect(
      captureTesslReviewEvidence(fixture.root, {
        executable: fixture.executable,
        timeoutSeconds: 0,
        executor: reviewExecutor(),
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);
    await expect(
      captureTesslReviewEvidence(fixture.root, {
        executable: join(fixture.root, "missing-tessl"),
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);

    const corruptExecutor = executorFor((args) => {
      const valid = args[0] === "--version" ? result("0.101.0\n") : result("ok\n");
      return { ...valid, stdoutSha256: "0".repeat(64) };
    });
    await expect(
      captureTesslReviewEvidence(fixture.root, {
        executable: fixture.executable,
        executor: corruptExecutor,
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);

    const noGitParent = await mkdtemp(join(temporaryRoot, "skillpress-tessl-no-git-"));
    temporaryDirectories.push(noGitParent);
    const noGitRoot = join(noGitParent, "project");
    await writeRenderedProject(
      renderCapabilityProject(await loadCapabilityBrief(briefPath)),
      noGitRoot,
    );
    await expect(
      captureTesslReviewEvidence(noGitRoot, {
        executable: fixture.executable,
        executor: reviewExecutor(),
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);

    await writeFile(join(fixture.root, "skills/incident-summary/SKILL.md"), "invalid\n");
    await expect(
      captureTesslReviewEvidence(fixture.root, {
        executable: fixture.executable,
        executor: reviewExecutor(),
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);

    const storageFixture = await project();
    await mkdir(join(storageFixture.root, ".skill-press"));
    await symlink(storageFixture.evalSource, join(storageFixture.root, ".skill-press", "tessl"));
    await expect(
      captureTesslReviewEvidence(storageFixture.root, {
        executable: storageFixture.executable,
        executor: reviewExecutor(),
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);

    const rootLinkFixture = await project();
    const outsideStorage = join(rootLinkFixture.root, "outside-storage");
    await mkdir(outsideStorage);
    await symlink(outsideStorage, join(rootLinkFixture.root, ".skill-press"));
    await expect(
      captureTesslReviewEvidence(rootLinkFixture.root, {
        executable: rootLinkFixture.executable,
        executor: reviewExecutor(),
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);

    const sourceFixture = await project();
    await expect(
      captureTesslEvalEvidence(sourceFixture.root, {
        source: ".",
        agent: "codex",
        model: "gpt-fixed",
        executable: sourceFixture.executable,
        executor: executorFor(() => result("0.101.0\n")),
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);
  });

  it("detects canonical source mutation during the provider run", async () => {
    const fixture = await project();
    const executor = executorFor((args) => {
      if (args[0] === "--version") return result("0.101.0\n");
      if (args[0] === "skill") return result("ok\n");
      void writeFile(join(fixture.root, "skills/incident-summary/LICENSE"), "changed\n");
      return result(
        '{"reviewRunId":"review-run-1","validation":{"overallPassed":true},"review":{"reviewScore":94}}',
      );
    });
    const evidence = await captureTesslReviewEvidence(fixture.root, {
      executable: fixture.executable,
      executor,
    });
    expect(evidence.ineligibilityReasons).toContain("source_changed");
  });

  it("extracts a complete JSON object from bounded informational output", async () => {
    const fixture = await project();
    const executor = reviewExecutor({
      reviewRunId: "review-escaped",
      validation: { overallPassed: true },
      review: { reviewScore: 91, note: 'brace } and quoted \\"text\\"' },
    });
    const evidence = await captureTesslReviewEvidence(fixture.root, {
      executable: fixture.executable,
      executor,
    });
    expect(evidence.review.runId).toBe("review-escaped");
  });

  it("submits, polls, and derives Impact from paired Tessl results", async () => {
    const fixture = await project();
    const observed: string[][] = [];
    let views = 0;
    const executor = executorFor((args) => {
      if (args[0] === "--version") return result("0.101.0\n");
      if (args[0] === "eval" && args[1] === "run") {
        return result(
          JSON.stringify([
            { evalRunId: "eval-run-1", agent: "codex", model: "gpt-fixed", scenariosCount: 2 },
          ]),
        );
      }
      views += 1;
      return views === 1
        ? result(JSON.stringify({ data: { id: "eval-run-1", attributes: { status: "pending" } } }))
        : result(JSON.stringify(completedEval()));
    }, observed);
    const evidence = await captureTesslEvalEvidence(fixture.root, {
      source: "tessl-evals",
      agent: "codex",
      model: "gpt-fixed",
      runs: 3,
      executable: fixture.executable,
      executor,
      pollIntervalMs: 1,
      wait: async () => undefined,
      now: () => new Date("2026-08-24T12:34:56.789Z"),
    });

    expect(observed[1]).toEqual([
      "eval",
      "run",
      "--json",
      "--force",
      "--context",
      expect.stringMatching(/^\.skill-press\/tessl\/[a-f0-9]{64}\/eval-plugin-[a-f0-9]{64}$/u),
      "--skill",
      "incident-summary",
      "--agent",
      "codex",
      "--model",
      "gpt-fixed",
      "--runs",
      "3",
      "tessl-evals",
    ]);
    expect(observed.at(-1)).toEqual(["eval", "view", "--json", "eval-run-1"]);
    await expect(access(join(fixture.root, evidence.storagePath, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(evidence).toMatchObject({
      evidenceType: "skillpress.tessl-eval",
      runId: "eval-run-1",
      baselineScore: 50,
      impactScore: 95,
      impactDelta: 45,
      upliftRatio: 1.9,
      evidenceEligible: false,
      ineligibilityReasons: ["custom_executor", "untrusted_cli"],
    });
    expect(evidence.scenarios.map((scenario) => scenario.delta)).toEqual([50, 40]);
    expect(JSON.stringify(evidence)).not.toContain("scenario-one");
  });

  it.each(["start context", "final context", "final invocation"] as const)(
    "rejects a provider echo that drifts in %s",
    async (fault) => {
      const fixture = await project();
      let invocation: readonly string[] = [];
      const executor: TesslCommandExecutor = async (command) => {
        const args = command.argv.slice(1);
        if (args[0] === "--version") return result("0.101.0\n");
        if (args[1] === "run") {
          invocation = args;
          const contextPath = args[args.indexOf("--context") + 1] as string;
          return result(
            JSON.stringify({
              evalRunId: "eval-run-1",
              agent: "codex",
              model: "gpt-fixed",
              scenariosCount: 2,
              context: {
                definition: {
                  type: "plugin-directory",
                  path: fault === "start context" ? "stale-context" : contextPath,
                },
              },
            }),
          );
        }
        const completed = completedEval({}, invocation);
        const attributes = (completed.data as { attributes: Record<string, unknown> }).attributes;
        if (fault === "final context") {
          attributes.evalRunFixtures = {
            context: { type: "plugin-directory", path: "stale-context" },
          };
        }
        if (fault === "final invocation") {
          attributes.metadata = { cliInvocation: "eval run --json" };
        }
        return result(JSON.stringify(completed));
      };

      await expect(
        captureTesslEvalEvidence(fixture.root, {
          source: "tessl-evals",
          agent: "codex",
          model: "gpt-fixed",
          executable: fixture.executable,
          executor,
          pollIntervalMs: 1,
          wait: async () => undefined,
        }),
      ).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            code:
              fault === "start context" ? "tessl.eval.start_shape" : "tessl.eval.provider_context",
          }),
        ],
      });
    },
  );

  it("accepts Tessl's nested-repository basename normalization when both echoes agree", async () => {
    const fixture = await project();
    let invocation: readonly string[] = [];
    let providerPath = "";
    const executor = executorFor((args) => {
      if (args[0] === "--version") return result("0.101.0\n");
      if (args[1] === "run") {
        invocation = args;
        providerPath = (args[args.indexOf("--context") + 1] as string).split("/").at(-1) as string;
        return result(
          JSON.stringify({
            evalRunId: "eval-run-1",
            agent: "codex",
            model: "gpt-fixed",
            scenariosCount: 2,
            context: {
              definition: { type: "plugin-directory", path: providerPath },
            },
          }),
        );
      }
      return result(
        JSON.stringify(
          completedEval(
            {
              evalRunFixtures: {
                context: { type: "plugin-directory", path: providerPath },
              },
              metadata: { cliInvocation: invocation.join(" ") },
            },
            invocation,
          ),
        ),
      );
    });

    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        agent: "codex",
        model: "gpt-fixed",
        runs: 3,
        executable: fixture.executable,
        executor,
        pollIntervalMs: 1,
        wait: async () => undefined,
      }),
    ).resolves.toMatchObject({ impactScore: 95 });
  });

  it("rejects a pre-existing nested Git boundary without deleting unowned metadata", async () => {
    const fixture = await project();
    let marker = "";
    const executor: TesslCommandExecutor = async (command) => {
      const args = command.argv.slice(1);
      if (args[0] === "--version") {
        const storageIds = await readdir(join(fixture.root, ".skill-press", "tessl"));
        const boundary = join(
          fixture.root,
          ".skill-press",
          "tessl",
          storageIds[0] as string,
          ".git",
        );
        await mkdir(boundary);
        marker = join(boundary, "owner-marker");
        await writeFile(marker, "retain\n");
        return result("0.101.0\n");
      }
      return result("", "failed");
    };

    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        executable: fixture.executable,
        executor,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "tessl.eval.git_boundary" })],
    });
    await expect(readFile(marker, "utf8")).resolves.toBe("retain\n");
  });

  it("does not persist evidence when nested Git boundary cleanup fails", async () => {
    const fixture = await project();
    let invocation: readonly string[] = [];
    let boundary = "";
    const executor: TesslCommandExecutor = async (command) => {
      const args = command.argv.slice(1);
      if (args[0] === "--version") return result("0.101.0\n");
      if (args[1] === "run") {
        invocation = args;
        const contextPath = args[args.indexOf("--context") + 1] as string;
        boundary = join(fixture.root, contextPath.split("/").slice(0, -1).join("/"), ".git");
        return result(
          JSON.stringify({
            evalRunId: "eval-run-1",
            agent: "codex",
            model: "gpt-fixed",
            scenariosCount: 2,
            context: {
              definition: { type: "plugin-directory", path: contextPath },
            },
          }),
        );
      }
      await chmod(boundary, 0o500);
      return result(JSON.stringify(completedEval({}, invocation)));
    };

    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        agent: "codex",
        model: "gpt-fixed",
        executable: fixture.executable,
        executor,
        pollIntervalMs: 1,
        wait: async () => undefined,
      }),
    ).rejects.toBeDefined();
    await chmod(boundary, 0o700);
    const storage = boundary.slice(0, -"/.git".length);
    await expect(access(join(storage, "evidence.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an eval plugin whose embedded skill differs from the canonical skill", async () => {
    const fixture = await project();
    await writeFile(join(fixture.evalSource, "skills", "incident-summary", "LICENSE"), "changed\n");
    let submitted = false;
    const executor = executorFor((args) => {
      if (args[0] === "--version") return result("0.101.0\n");
      submitted = true;
      return result("", "failed");
    });

    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        executable: fixture.executable,
        executor,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "tessl.eval.source_skill" })],
    });
    expect(submitted).toBe(false);
  });

  it("rejects additional skill context even when the canonical skill is present", async () => {
    const fixture = await project();
    await cp(
      join(fixture.evalSource, "skills", "incident-summary"),
      join(fixture.evalSource, "skills", "answer-key"),
      { recursive: true },
    );
    let submitted = false;
    const executor = executorFor((args) => {
      if (args[0] === "--version") return result("0.101.0\n");
      submitted = true;
      return result("", "failed");
    });

    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        executable: fixture.executable,
        executor,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "tessl.eval.source_skill" })],
    });
    expect(submitted).toBe(false);
  });

  it("rejects eval projects that can inject dependency context", async () => {
    const fixture = await project();
    await writeFile(
      join(fixture.evalSource, "tessl.json"),
      '{"name":"test/eval","mode":"vendored","dependencies":{"answer-key":"1.0.0"}}\n',
    );
    let submitted = false;
    const executor = executorFor((args) => {
      if (args[0] === "--version") return result("0.101.0\n");
      submitted = true;
      return result("", "failed");
    });

    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        executable: fixture.executable,
        executor,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "tessl.eval.source_skill" })],
    });
    expect(submitted).toBe(false);
  });

  it("rejects mutation of the retained snapshot submitted to Tessl", async () => {
    const fixture = await project();
    let stagedSource = "";
    let invocation: readonly string[] = [];
    const executor: TesslCommandExecutor = async (command) => {
      const args = command.argv.slice(1);
      if (args[0] === "--version") return result("0.101.0\n");
      if (args[1] === "run") {
        invocation = args;
        stagedSource = args[args.indexOf("--context") + 1] as string;
        return result(
          JSON.stringify({
            evalRunId: "eval-run-1",
            agent: "codex",
            model: "gpt-fixed",
            scenariosCount: 2,
            context: {
              definition: { type: "plugin-directory", path: stagedSource },
            },
          }),
        );
      }
      await writeFile(
        join(fixture.root, stagedSource, "skills", "incident-summary", "LICENSE"),
        "changed\n",
      );
      return result(JSON.stringify(completedEval({}, invocation)));
    };

    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        agent: "codex",
        model: "gpt-fixed",
        runs: 3,
        executable: fixture.executable,
        executor,
        pollIntervalMs: 1,
        wait: async () => undefined,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "tessl.eval.source_skill_changed" })],
    });
    const storagePath = stagedSource.split("/").slice(0, -1).join("/");
    await expect(access(join(fixture.root, storagePath, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("makes evidence ineligible when original eval scenarios change during capture", async () => {
    const fixture = await project();
    let invocation: readonly string[] = [];
    const executor: TesslCommandExecutor = async (command) => {
      const args = command.argv.slice(1);
      if (args[0] === "--version") return result("0.101.0\n");
      if (args[1] === "run") {
        invocation = args;
        const contextPath = args[args.indexOf("--context") + 1] as string;
        return result(
          JSON.stringify({
            evalRunId: "eval-run-1",
            agent: "codex",
            model: "gpt-fixed",
            scenariosCount: 2,
            context: {
              definition: { type: "plugin-directory", path: contextPath },
            },
          }),
        );
      }
      await writeFile(join(fixture.evalSource, "evals", "scenario-one", "task.md"), "changed\n");
      return result(JSON.stringify(completedEval({}, invocation)));
    };

    const evidence = await captureTesslEvalEvidence(fixture.root, {
      source: "tessl-evals",
      agent: "codex",
      model: "gpt-fixed",
      runs: 3,
      executable: fixture.executable,
      executor,
      pollIntervalMs: 1,
      wait: async () => undefined,
    });

    expect(evidence.ineligibilityReasons).toContain("source_changed");
  });

  it("binds provider defaults when either or both selection flags are omitted", async () => {
    const cases = [
      {
        selection: {},
        resolved: { agent: "claude", model: "provider-default" },
        flags: [],
      },
      {
        selection: { agent: "codex" },
        resolved: { agent: "codex", model: "provider-default" },
        flags: ["--agent", "codex"],
      },
      {
        selection: { model: "gpt-fixed" },
        resolved: { agent: "claude", model: "gpt-fixed" },
        flags: ["--model", "gpt-fixed"],
      },
    ] as const;
    for (const value of cases) {
      const fixture = await project();
      const observed: string[][] = [];
      const executor = executorFor((args) => {
        if (args[0] === "--version") return result("0.101.0\n");
        if (args[1] === "run") {
          return result(JSON.stringify({ evalRunId: "eval-run-1", scenariosCount: 2 }));
        }
        return result(JSON.stringify(completedEval(value.resolved)));
      }, observed);
      const evidence = await captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        ...value.selection,
        runs: 3,
        executable: fixture.executable,
        executor,
        pollIntervalMs: 1,
        wait: async () => undefined,
      });

      expect(observed[1]).toEqual([
        "eval",
        "run",
        "--json",
        "--force",
        "--context",
        expect.stringMatching(/^\.skill-press\/tessl\/[a-f0-9]{64}\/eval-plugin-[a-f0-9]{64}$/u),
        "--skill",
        "incident-summary",
        ...value.flags,
        "--runs",
        "3",
        "tessl-evals",
      ]);
      expect(evidence).toMatchObject({ ...value.resolved, runs: 3 });
    }
  });

  it("makes missing baselines and any per-scenario regression explicitly ineligible", async () => {
    const fixture = await project();
    const value = completedEval();
    const data = value.data as {
      attributes: { scenarios: Array<{ solutions: Array<Record<string, unknown>> }> };
    };
    data.attributes.scenarios[0]?.solutions.splice(0, 1);
    const secondWith = data.attributes.scenarios[1]?.solutions[1];
    if (secondWith !== undefined)
      secondWith.assessmentResults = [
        { name: "critical_safety", score: 10, max_score: 10 },
        { name: "quality", score: 0, max_score: 90 },
      ];
    const executor = executorFor((args) => {
      if (args[0] === "--version") return result("0.101.0\n");
      if (args[1] === "run")
        return result(
          '{"evalRunId":"eval-run-1","agent":"codex","model":"gpt-fixed","scenariosCount":2}',
        );
      return result(JSON.stringify(value));
    });
    const evidence = await captureTesslEvalEvidence(fixture.root, {
      source: "tessl-evals",
      agent: "codex",
      model: "gpt-fixed",
      runs: 3,
      executable: fixture.executable,
      executor,
      pollIntervalMs: 1,
      wait: async () => undefined,
    });
    expect(evidence.ineligibilityReasons).toEqual([
      "custom_executor",
      "untrusted_cli",
      "missing_baseline",
      "scenario_regression",
    ]);
    expect(evidence.upliftRatio).not.toBeNull();
  });

  it("makes a partial critical score ineligible even when aggregate Impact exceeds threshold", async () => {
    const fixture = await project();
    const value = completedEval();
    const data = value.data as {
      attributes: { scenarios: Array<{ solutions: Array<Record<string, unknown>> }> };
    };
    const firstWith = data.attributes.scenarios[0]?.solutions[1];
    if (firstWith !== undefined)
      firstWith.assessmentResults = [
        { name: "critical_safety", score: 9, max_score: 10 },
        { name: "quality", score: 90, max_score: 90 },
      ];
    const executor = executorFor((args) => {
      if (args[0] === "--version") return result("0.101.0\n");
      if (args[1] === "run")
        return result(
          '{"evalRunId":"eval-run-1","agent":"codex","model":"gpt-fixed","scenariosCount":2}',
        );
      return result(JSON.stringify(value));
    });
    const evidence = await captureTesslEvalEvidence(fixture.root, {
      source: "tessl-evals",
      agent: "codex",
      model: "gpt-fixed",
      runs: 3,
      executable: fixture.executable,
      executor,
      pollIntervalMs: 1,
      wait: async () => undefined,
    });
    expect(evidence.impactScore).toBe(100);
    expect(evidence.ineligibilityReasons).toContain("critical_failure");
    expect(evidence.evidenceEligible).toBe(false);
  });

  it("rejects baseline and with-context rubric inventory mismatch", async () => {
    const fixture = await project();
    const value = completedEval();
    const data = value.data as {
      attributes: { scenarios: Array<{ solutions: Array<Record<string, unknown>> }> };
    };
    const baseline = data.attributes.scenarios[0]?.solutions[0];
    if (baseline !== undefined)
      baseline.assessmentResults = [
        { name: "quality", score: 36, max_score: 90 },
        { name: "critical_safety", score: 4, max_score: 10 },
      ];
    const executor = executorFor((args) => {
      if (args[0] === "--version") return result("0.101.0\n");
      if (args[1] === "run")
        return result(
          '{"evalRunId":"eval-run-1","agent":"codex","model":"gpt-fixed","scenariosCount":2}',
        );
      return result(JSON.stringify(value));
    });
    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        agent: "codex",
        model: "gpt-fixed",
        executable: fixture.executable,
        executor,
        pollIntervalMs: 1,
        wait: async () => undefined,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "tessl.eval.rubric_binding" })],
    });
  });

  it.each([
    [
      "start failure",
      (args: readonly string[]) => (args[1] === "run" ? result("", "failed") : undefined),
    ],
    [
      "start mismatch",
      (args: readonly string[]) =>
        args[1] === "run"
          ? result('{"evalRunId":"x","agent":"wrong","model":"gpt-fixed","scenariosCount":2}')
          : undefined,
    ],
    [
      "result identity mismatch",
      (args: readonly string[]) =>
        args[1] === "view" ? result(JSON.stringify(completedEval({ agent: "wrong" }))) : undefined,
    ],
    [
      "view failure",
      (args: readonly string[]) => (args[1] === "view" ? result("", "failed") : undefined),
    ],
    [
      "provider failure",
      (args: readonly string[]) =>
        args[1] === "view" ? result('{"data":{"attributes":{"status":"failed"}}}') : undefined,
    ],
    [
      "unknown status",
      (args: readonly string[]) =>
        args[1] === "view" ? result('{"data":{"attributes":{"status":"mystery"}}}') : undefined,
    ],
    [
      "result binding",
      (args: readonly string[]) =>
        args[1] === "view"
          ? result(
              JSON.stringify(completedEval({ status: "completed" })).replace(
                "eval-run-1",
                "wrong-run",
              ),
            )
          : undefined,
    ],
  ] as const)("rejects invalid eval evidence: %s", async (_name, fault) => {
    const fixture = await project();
    const observed: string[][] = [];
    const executor = executorFor((args) => {
      if (args[0] === "--version") return result("0.101.0\n");
      const injected = fault(args);
      if (injected !== undefined) return injected;
      if (args[1] === "run")
        return result(
          '{"evalRunId":"eval-run-1","agent":"codex","model":"gpt-fixed","scenariosCount":2}',
        );
      return result(JSON.stringify(completedEval()));
    }, observed);
    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        agent: "codex",
        model: "gpt-fixed",
        executable: fixture.executable,
        executor,
        pollIntervalMs: 1,
        wait: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);
    const start = observed.find((args) => args[0] === "eval" && args[1] === "run");
    const contextPath = start?.[start.indexOf("--context") + 1];
    expect(contextPath).toMatch(/^\.skill-press\/tessl\/[a-f0-9]{64}\/eval-plugin-[a-f0-9]{64}$/u);
    const storagePath = (contextPath as string).split("/").slice(0, -1).join("/");
    await expect(access(join(fixture.root, storagePath, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["missing scenarios", completedEval({ scenarios: undefined })],
    ["empty scenarios", completedEval({ scenarios: [] })],
    ["malformed scenario", completedEval({ scenarios: [{ fingerprint: 7, solutions: [] }] })],
    [
      "duplicate baseline",
      (() => {
        const value = completedEval();
        const scenarios = (
          value.data as { attributes: { scenarios: Array<Record<string, unknown>> } }
        ).attributes.scenarios;
        const solutions = scenarios[0]?.solutions as Array<Record<string, unknown>>;
        solutions.push({ ...solutions[0] });
        return value;
      })(),
    ],
    [
      "unknown solution variant",
      (() => {
        const value = completedEval();
        const scenarios = (
          value.data as {
            attributes: { scenarios: Array<{ solutions: Array<Record<string, unknown>> }> };
          }
        ).attributes.scenarios;
        const context = scenarios[0]?.solutions[1];
        if (context !== undefined) context.variant = "other";
        return value;
      })(),
    ],
    [
      "unverified legacy context variant",
      (() => {
        const value = completedEval();
        const scenarios = (
          value.data as {
            attributes: { scenarios: Array<{ solutions: Array<Record<string, unknown>> }> };
          }
        ).attributes.scenarios;
        const context = scenarios[0]?.solutions[1];
        if (context !== undefined) context.variant = "with-context";
        return value;
      })(),
    ],
    [
      "non-object solution",
      (() => {
        const value = completedEval();
        const scenarios = (
          value.data as {
            attributes: { scenarios: Array<{ solutions: unknown[] }> };
          }
        ).attributes.scenarios;
        scenarios[0]?.solutions.push(null);
        return value;
      })(),
    ],
    [
      "duplicate fingerprint",
      (() => {
        const value = completedEval();
        const scenarios = (
          value.data as {
            attributes: { scenarios: Array<Record<string, unknown>> };
          }
        ).attributes.scenarios;
        if (scenarios[1] !== undefined) scenarios[1].fingerprint = "scenario-one";
        return value;
      })(),
    ],
    [
      "invalid assessment",
      (() => {
        const value = completedEval();
        const scenarios = (
          value.data as {
            attributes: { scenarios: Array<{ solutions: Array<Record<string, unknown>> }> };
          }
        ).attributes.scenarios;
        if (scenarios[0]?.solutions[1] !== undefined) {
          scenarios[0].solutions[1].assessmentResults = [{ score: 11, max_score: 10 }];
        }
        return value;
      })(),
    ],
  ] as const)("rejects invalid completed eval: %s", async (_name, completed) => {
    const fixture = await project();
    const executor = executorFor((args) => {
      if (args[0] === "--version") return result("0.101.0\n");
      if (args[1] === "run") {
        return result(
          '{"evalRunId":"eval-run-1","agent":"codex","model":"gpt-fixed","scenariosCount":2}',
        );
      }
      return result(JSON.stringify(completed));
    });
    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        agent: "codex",
        model: "gpt-fixed",
        executable: fixture.executable,
        executor,
        pollIntervalMs: 1,
        wait: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);
  });

  it("rejects count drift and invalid eval limits, then fails closed on timeout", async () => {
    const fixture = await project();
    const driftExecutor = executorFor((args) => {
      if (args[0] === "--version") return result("0.101.0\n");
      if (args[1] === "run") {
        return result(
          '{"evalRunId":"eval-run-1","agent":"codex","model":"gpt-fixed","scenariosCount":1}',
        );
      }
      return result(JSON.stringify(completedEval()));
    });
    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        agent: "codex",
        model: "gpt-fixed",
        executable: fixture.executable,
        executor: driftExecutor,
        pollIntervalMs: 1,
        wait: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);

    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        agent: "bad\nagent",
        model: "gpt-fixed",
        executable: fixture.executable,
        executor: driftExecutor,
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);

    let conflictingProviderRunExecuted = false;
    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        agent: "codex",
        model: "gpt-fixed",
        runs: 1,
        executable: fixture.executable,
        executor: async (command) => {
          const args = command.argv.slice(1);
          if (args[0] === "eval" && args[1] === "run") conflictingProviderRunExecuted = true;
          return args[0] === "--version" ? result("0.101.0\n") : result("unexpected");
        },
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "tessl.option.eval_runs" })],
    });
    expect(conflictingProviderRunExecuted).toBe(false);

    let now = 0;
    const pendingExecutor = executorFor((args) => {
      if (args[0] === "--version") return result("0.101.0\n");
      if (args[1] === "run") {
        return result(
          '{"evalRunId":"eval-run-1","agent":"codex","model":"gpt-fixed","scenariosCount":2}',
        );
      }
      return result('{"data":{"id":"eval-run-1","attributes":{"status":"pending"}}}');
    });
    await expect(
      captureTesslEvalEvidence(fixture.root, {
        source: "tessl-evals",
        agent: "codex",
        model: "gpt-fixed",
        executable: fixture.executable,
        executor: pendingExecutor,
        timeoutSeconds: 1,
        pollIntervalMs: 500,
        clock: () => now,
        wait: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).rejects.toBeInstanceOf(TesslEvidenceError);
  });
});
