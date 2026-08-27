import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";
import { checkProject } from "../src/check/project.js";
import { loadProjectConfig } from "../src/config/load.js";
import { diagnoseProject } from "../src/doctor/project.js";
import type { CapturedCommand, CapturedCommandResult } from "../src/process/capture.js";
import type { TesslReleaseGateReport } from "../src/release/tessl-gate.js";

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture() {
  const parent = await mkdtemp(join(temporaryRoot, "skillpress-doctor-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "project");
  const home = join(parent, "home");
  await writeRenderedProject(renderCapabilityProject(await loadCapabilityBrief(briefPath)), root);
  await mkdir(home);
  return { root, home };
}

function commandResult(passed: boolean): CapturedCommandResult {
  return {
    status: passed ? "passed" : "spawn_error",
    exitCode: passed ? 0 : null,
    signal: null,
    durationMs: 1,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutSha256: "0".repeat(64),
    stderrSha256: "0".repeat(64),
  };
}

function gate(passed: boolean): TesslReleaseGateReport {
  return {
    schemaVersion: 1,
    gateType: "skillpress.tessl-release",
    evaluatedAt: "2026-08-24T12:00:00.000Z",
    sourceCommit: "1".repeat(40),
    passed,
    thresholds: { quality: 90, impact: 90, maxAgeHours: 168 },
    scores: { quality: passed ? 95 : 80, impact: 95 },
    evidence: { reviewPath: "review", evalPath: "eval" },
    issues: [],
  };
}

describe("project doctor", () => {
  it("probes configured tools without exposing credentials or claiming external readiness", async () => {
    const value = await fixture();
    const commands: CapturedCommand[] = [];
    const report = await diagnoseProject(value.root, {
      executor: async (command) => {
        commands.push(command);
        return commandResult(true);
      },
      environment: {
        SKILL_PRESS_TOKEN: "super-secret",
        TESSL_TOKEN: "another-secret",
      },
      homeDirectory: value.home,
      nodeVersion: "v22.14.0",
    });

    expect(commands.map((entry) => entry.argv)).toEqual([
      ["git", "--version"],
      ["docker", "--version"],
      ["tessl", "--version"],
    ]);
    expect(report.ready).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime.node", status: "pass" }),
        expect.objectContaining({ id: "project.readiness", status: "pass" }),
        expect.objectContaining({ id: "credential.skill_press", status: "pass" }),
        expect.objectContaining({ id: "credential.tessl", status: "pass" }),
        expect.objectContaining({ id: "evidence.tessl", status: "error" }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("super-secret");
    expect(JSON.stringify(report)).not.toContain("another-secret");
  });

  it("reports unsupported runtimes, missing executables, and local name collisions", async () => {
    const value = await fixture();
    await mkdir(join(value.home, ".agents/skills/incident-summary"), { recursive: true });
    const report = await diagnoseProject(value.root, {
      executor: async (command) => commandResult(command.argv[0] !== "docker"),
      environment: {},
      homeDirectory: value.home,
      nodeVersion: "v20.19.0",
    });

    expect(report.ready).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime.node", status: "error" }),
        expect.objectContaining({ id: "command.docker", status: "error" }),
        expect.objectContaining({ id: "collision.agents", status: "warning" }),
        expect.objectContaining({ id: "credential.skill_press", status: "warning" }),
      ]),
    );
  });

  it("honors explicit provider executable paths without a shell", async () => {
    const value = await fixture();
    const commands: CapturedCommand[] = [];
    await diagnoseProject(value.root, {
      executor: async (command) => {
        commands.push(command);
        return commandResult(true);
      },
      tesslExecutable: "/opt/tools/tessl-safe",
      environment: {},
      homeDirectory: value.home,
      nodeVersion: "22.0.0",
    });

    expect(commands.map((entry) => entry.argv)).toContainEqual([
      "/opt/tools/tessl-safe",
      "--version",
    ]);
    expect(commands.every((entry) => !("shell" in entry))).toBe(true);
  });

  it("isolates probe state in one private temporary home and removes it afterward", async () => {
    const value = await fixture();
    const homes: string[] = [];
    await diagnoseProject(value.root, {
      executor: async (command) => {
        const home = command.env?.HOME as string;
        homes.push(home);
        await writeFile(join(home, `probe-${homes.length}`), "state\n");
        return commandResult(true);
      },
      environment: {},
      homeDirectory: value.home,
      nodeVersion: "22.0.0",
    });
    expect(new Set(homes).size).toBe(1);
    expect(homes[0]?.startsWith(value.root)).toBe(false);
    await expect(stat(homes[0] as string)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("covers canonical tool probes and credential context with a passing gate", async () => {
    const value = await fixture();
    const config = await loadProjectConfig(value.root);
    const commands: CapturedCommand[] = [];
    const report = await diagnoseProject(
      value.root,
      {
        evidence: { reviewEvidencePath: "review", evalEvidencePath: "eval", evalSource: "source" },
        executor: async (command) => {
          commands.push(command);
          return commandResult(true);
        },
        environment: {
          TESSL_TOKEN: "tessl",
          SKILL_PRESS_TOKEN: "skill-press",
        },
        homeDirectory: value.home,
        nodeVersion: "v23.1.0-beta.1",
        tesslExecutable: "/opt/tessl",
      },
      {
        loadConfig: async () => config,
        checkGate: async () => gate(true),
      },
    );
    expect(commands.map((entry) => entry.argv)).toEqual([
      ["git", "--version"],
      ["docker", "--version"],
      ["/opt/tessl", "--version"],
    ]);
    expect(report.ready).toBe(true);
    expect(report.checks.filter((entry) => entry.id.startsWith("credential."))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "credential.tessl", status: "pass" }),
        expect.objectContaining({ id: "credential.skill_press", status: "pass" }),
      ]),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "evidence.tessl", status: "pass" }),
    );
  });

  it("distinguishes canonical links, file collisions, and uninspectable homes", async () => {
    const value = await fixture();
    await mkdir(join(value.home, ".agents/skills"), { recursive: true });
    await mkdir(join(value.home, ".codex/skills"), { recursive: true });
    await symlink(
      join(value.root, "skills/incident-summary"),
      join(value.home, ".agents/skills/incident-summary"),
    );
    await writeFile(join(value.home, ".codex/skills/incident-summary"), "collision\n");
    const linked = await diagnoseProject(value.root, {
      executor: async () => commandResult(true),
      environment: {},
      homeDirectory: value.home,
      nodeVersion: "22.0.0",
    });
    expect(linked.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "collision.agents", status: "pass" }),
        expect.objectContaining({
          id: "collision.codex",
          status: "warning",
          message: expect.stringContaining("non-directory"),
        }),
      ]),
    );

    const homeFile = join(value.home, "not-a-directory");
    await writeFile(homeFile, "file\n");
    const uninspectable = await diagnoseProject(value.root, {
      executor: async () => commandResult(true),
      environment: {},
      homeDirectory: homeFile,
      nodeVersion: "invalid",
    });
    expect(uninspectable.checks.filter((entry) => entry.id.startsWith("collision."))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "collision.agents",
          status: "warning",
          message: expect.stringContaining("could not"),
        }),
        expect.objectContaining({
          id: "collision.codex",
          status: "warning",
          message: expect.stringContaining("could not"),
        }),
      ]),
    );
  });

  it("reports blocked local and gate state without legacy remote-provider checks", async () => {
    const value = await fixture();
    const config = await loadProjectConfig(value.root);
    const local = await checkProject(value.root);
    const report = await diagnoseProject(
      value.root,
      {
        evidence: { reviewEvidencePath: "review", evalEvidencePath: "eval", evalSource: "source" },
        executor: async () => ({ ...commandResult(true), exitCode: 1 }),
        environment: {},
        homeDirectory: value.home,
        nodeVersion: "20.0.0",
      },
      {
        loadConfig: async () => config,
        checkLocal: async () => ({ ...local, eligible: false }),
        checkGate: async () => gate(false),
      },
    );
    expect(report.checks.some((entry) => entry.id === "collision.remote")).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "project.readiness", status: "error" }),
        expect.objectContaining({ id: "command.git", status: "error" }),
        expect.objectContaining({ id: "evidence.tessl", status: "error" }),
      ]),
    );
  });
});
