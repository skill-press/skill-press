import { describe, expect, it, vi } from "vitest";

import { runCli, type CliIo } from "../src/cli.js";
import { runAddCommand, runInstallCommand } from "../src/cli/install.js";
import { TrustedInstallError } from "../src/install/errors.js";
import type { TrustedInstallResult } from "../src/install/types.js";

function installed(changed = true): TrustedInstallResult {
  return {
    entry: {
      locator: "example/example-skill@1.2.3",
      namespace: "example",
      skill: "example-skill",
      version: "1.2.3",
      artifact: { sha256: "a".repeat(64), bytes: 1024 },
      attestation: { sha256: "b".repeat(64), keyId: "skill-press-p256-2026-08-01" },
      trust: {
        sequence: 2,
        status: "trusted",
        keyId: "skill-press-p256-2026-08-01",
        sha256: "c".repeat(64),
        updatedAt: "2026-08-27T12:00:00.000Z",
      },
      installedPath: ".agents/skills/example-skill",
    },
    lockPath: "/project/skill-lock.json",
    installedPath: "/project/.agents/skills/example-skill",
    changed,
  };
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  };
  return { io, stdout, stderr };
}

describe("trusted install CLI commands", () => {
  it("adds one exact locator and emits a stable non-secret JSON report", async () => {
    const output = capture();
    const add = vi.fn(async () => installed());
    const install = vi.fn(async () => []);

    await expect(
      runAddCommand(["--json", "example/example-skill@1.2.3", "--project", "/project"], output.io, {
        add,
        install,
      }),
    ).resolves.toBe(0);

    expect(add).toHaveBeenCalledWith({
      locator: "example/example-skill@1.2.3",
      projectRoot: "/project",
    });
    expect(install).not.toHaveBeenCalled();
    expect(JSON.parse(output.stdout.join(""))).toEqual({
      command: "add",
      ok: true,
      status: "installed",
      lockfile: "skill-lock.json",
      result: {
        locator: "example/example-skill@1.2.3",
        installedPath: ".agents/skills/example-skill",
        artifactSha256: "a".repeat(64),
        attestationSha256: "b".repeat(64),
        trust: installed().entry.trust,
        changed: true,
      },
    });
    expect(output.stdout.join("")).not.toContain("/project/.agents");
    expect(output.stderr).toEqual([]);
  });

  it("installs the complete lock and distinguishes verified from changed results", async () => {
    const output = capture();
    const add = vi.fn(async () => installed());
    const install = vi.fn(async () => [installed(false), installed(true)]);

    await expect(
      runInstallCommand(["--project", "/project"], output.io, { add, install }),
    ).resolves.toBe(0);

    expect(install).toHaveBeenCalledWith({ projectRoot: "/project" });
    expect(output.stdout.join("")).toContain("Verified: example/example-skill@1.2.3");
    expect(output.stdout.join("")).toContain("Installed skills: 2");
    expect(output.stderr).toEqual([]);
  });

  it("reports an empty lock as a successful no-op", async () => {
    const output = capture();
    const add = vi.fn(async () => installed());
    const install = vi.fn(async () => []);

    await expect(runInstallCommand(["--json"], output.io, { add, install })).resolves.toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      command: "install",
      ok: true,
      status: "verified",
      count: 0,
      changed: false,
      results: [],
    });
  });

  it("reports a verified add and rejects every unsafe common-option form", async () => {
    const verified = capture();
    const add = vi.fn(async () => installed(false));
    const install = vi.fn(async () => []);

    await expect(
      runAddCommand(["--json", "example/example-skill@1.2.3"], verified.io, { add, install }),
    ).resolves.toBe(0);
    expect(JSON.parse(verified.stdout.join(""))).toMatchObject({
      command: "add",
      status: "verified",
      result: { changed: false },
    });

    for (const args of [
      ["--json", "--json", "example/example-skill@1.2.3"],
      ["--project"],
      ["--project", "--json", "example/example-skill@1.2.3"],
      ["--project", `/${"x".repeat(4097)}`, "example/example-skill@1.2.3"],
      ["--project", "bad\0path", "example/example-skill@1.2.3"],
      ["--unknown", "example/example-skill@1.2.3"],
    ]) {
      const rejected = capture();
      await expect(runAddCommand(args, rejected.io, { add, install })).resolves.toBe(2);
    }
  });

  it("rejects ambiguous locators and command arguments before installation", async () => {
    const output = capture();
    const add = vi.fn(async () => installed());
    const install = vi.fn(async () => []);

    await expect(
      runAddCommand(["example/example-skill"], output.io, { add, install }),
    ).resolves.toBe(2);
    await expect(
      runAddCommand(["example/example-skill@1.2.3", "other/skill@1.0.0"], output.io, {
        add,
        install,
      }),
    ).resolves.toBe(2);
    await expect(
      runInstallCommand(["example/example-skill@1.2.3"], output.io, { add, install }),
    ).resolves.toBe(2);
    await expect(
      runInstallCommand(["--project", "/one", "--project", "/two"], output.io, {
        add,
        install,
      }),
    ).resolves.toBe(2);
    expect(add).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("maps fail-closed trust errors to exit 3 without exposing their causes", async () => {
    const output = capture();
    const error = new TrustedInstallError("trust_rejected", "The release is currently revoked.", {
      cause: new Error("secret backend detail"),
    });
    const add = vi.fn(async () => {
      throw error;
    });
    const install = vi.fn(async () => []);

    await expect(
      runAddCommand(["example/example-skill@1.2.3", "--json"], output.io, { add, install }),
    ).resolves.toBe(3);
    expect(JSON.parse(output.stderr.join(""))).toMatchObject({
      command: "add",
      ok: false,
      code: "trust_rejected",
      issues: [{ code: "install.trust_rejected", path: "/install" }],
    });
    expect(output.stderr.join("")).not.toContain("secret backend detail");
  });

  it("maps locked-install failures to the lockfile and keeps unexpected install failures generic", async () => {
    const locked = capture();
    const lockError = new TrustedInstallError("lock_rollback", "Trust sequence moved backwards.");
    const add = vi.fn(async () => installed());
    const installLocked = vi.fn(async () => {
      throw lockError;
    });
    await expect(
      runInstallCommand(["--json"], locked.io, { add, install: installLocked }),
    ).resolves.toBe(3);
    expect(JSON.parse(locked.stderr.join(""))).toMatchObject({
      code: "lock_rollback",
      issues: [{ path: "/skill-lock.json" }],
    });

    const internal = capture();
    const installUnexpected = vi.fn(async () => {
      throw new Error("secret internal detail");
    });
    await expect(
      runInstallCommand([], internal.io, { add, install: installUnexpected }),
    ).resolves.toBe(1);
    expect(internal.stderr.join("")).toContain("Skill Press could not install locked skills");
    expect(internal.stderr.join("")).not.toContain("secret internal detail");
  });

  it("returns exit 1 when output sinks fail", async () => {
    const add = vi.fn(async () => installed());
    const install = vi.fn(async () => [installed()]);
    const brokenStdout: CliIo = {
      stdout: async () => {
        throw new Error("closed stdout");
      },
      stderr: async () => undefined,
    };
    await expect(
      runAddCommand(["example/example-skill@1.2.3"], brokenStdout, { add, install }),
    ).resolves.toBe(1);
    await expect(runInstallCommand([], brokenStdout, { add, install })).resolves.toBe(1);

    const brokenStderr: CliIo = {
      stdout: async () => undefined,
      stderr: async () => {
        throw new Error("closed stderr");
      },
    };
    await expect(runAddCommand([], brokenStderr, { add, install })).resolves.toBe(1);
    const rejectedInstall = vi.fn(async () => {
      throw new TrustedInstallError("trust_rejected", "revoked");
    });
    await expect(
      runInstallCommand([], brokenStderr, { add, install: rejectedInstall }),
    ).resolves.toBe(1);
  });

  it("keeps unexpected failures generic and exposes both command help pages", async () => {
    const output = capture();
    const add = vi.fn(async () => {
      throw new Error("secret internal detail");
    });
    const install = vi.fn(async () => []);
    await expect(
      runAddCommand(["example/example-skill@1.2.3"], output.io, { add, install }),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("Skill Press could not add the skill");
    expect(output.stderr.join("")).not.toContain("secret internal detail");

    const help = capture();
    await expect(runCli(["add", "--help"], help.io)).resolves.toBe(0);
    await expect(runCli(["install", "--help"], help.io)).resolves.toBe(0);
    expect(help.stdout.join("")).toContain("skpress add <namespace>/<skill>@<version>");
    expect(help.stdout.join("")).toContain("skpress install [options]");
  });
});
