import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";

const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const staleBuildPath = fileURLToPath(new URL("../dist/stale-build-output.js", import.meta.url));
const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));

function invokeBin(...args: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: {},
    timeout: 5_000,
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("compiled Skill Press binary", () => {
  it("prints help as a real process", () => {
    const result = invokeBin("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  });

  it("prints the package version as a real process", () => {
    const result = invokeBin("--version");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${VERSION}\n`);
    expect(result.stderr).toBe("");
  });

  it("returns the usage exit code for an incomplete init command", () => {
    const result = invokeBin("init");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires both --brief and --output");
  });

  it("rejects trailing top-level arguments without reflecting them", () => {
    const result = invokeBin("--version", "FORGED");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("does not accept additional arguments");
    expect(result.stderr).not.toContain("FORGED");
  });

  it("creates a real project from the compiled binary", () => {
    const parent = mkdtempSync(join(realpathSync(tmpdir()), "skillpress-bin-test-"));
    const output = join(parent, "project");
    try {
      const result = invokeBin("init", "--brief", briefPath, "--output", output, "--json");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        command: "init",
        root: output,
        skillPath: "skills/incident-summary",
      });
      expect(readFileSync(join(output, "skills/incident-summary/SKILL.md"), "utf8")).toContain(
        "name: incident-summary",
      );
    } finally {
      rmSync(parent, { recursive: true });
    }
  });

  it("removes stale output before rebuilding", () => {
    writeFileSync(staleBuildPath, "stale\n", { encoding: "utf8", mode: 0o600 });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(npm, ["run", "build"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: process.env,
      timeout: 30_000,
    });

    if (result.error !== undefined) {
      throw result.error;
    }

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(staleBuildPath)).toBe(false);
    expect(existsSync(binPath)).toBe(true);
  });
});
