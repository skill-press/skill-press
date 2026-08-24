import { realpathSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { renderCheckHelp, renderCreateHelp, renderHelp, runCli } from "../src/cli.js";
import { ProjectCreationError } from "../src/create/errors.js";
import { VERSION } from "../src/version.js";

const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];

function captureIo(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly io: {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

describe("SkillPress CLI scaffold", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });

  async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(temporaryRoot, "skillpress-cli-test-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  it.each([{ args: [] }, { args: ["--help"] }, { args: ["-h"] }, { args: ["help"] }])(
    "renders help for $args",
    async ({ args }) => {
      const capture = captureIo();

      await expect(runCli(args, capture.io)).resolves.toBe(0);
      expect(capture.stdout).toEqual([renderHelp()]);
      expect(capture.stderr).toEqual([]);
      expect(renderHelp()).toContain("SkillPress");
    },
  );

  it.each([{ args: ["--version"] }, { args: ["-v"] }])(
    "renders the package version for $args",
    async ({ args }) => {
      const capture = captureIo();

      await expect(runCli(args, capture.io)).resolves.toBe(0);
      expect(capture.stdout).toEqual([`${VERSION}\n`]);
      expect(capture.stderr).toEqual([]);
    },
  );

  it.each([["--help"], ["-h"]])("renders create help for %s", async (flag) => {
    const capture = captureIo();

    await expect(runCli(["create", flag as string], capture.io)).resolves.toBe(0);
    expect(capture.stdout).toEqual([renderCreateHelp()]);
    expect(capture.stderr).toEqual([]);
  });

  it.each([["--help"], ["-h"]])("renders check help for %s", async (flag) => {
    const capture = captureIo();

    await expect(runCli(["check", flag as string], capture.io)).resolves.toBe(0);
    expect(capture.stdout).toEqual([renderCheckHelp()]);
    expect(capture.stderr).toEqual([]);
  });

  it("rejects an unknown command", async () => {
    const capture = captureIo();

    await expect(runCli(["not-a-command"], capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toContain("Unknown command.");
    expect(capture.stderr.join("")).not.toContain("not-a-command");
  });

  it.each([
    ["--help", "extra"],
    ["-h", "extra"],
    ["help", "extra"],
    ["--version", "extra"],
    ["-v", "extra"],
  ])("rejects trailing arguments for the top-level shortcut %s", async (shortcut, extra) => {
    const capture = captureIo();

    await expect(runCli([shortcut as string, extra as string], capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(capture.stderr[0]).toContain("does not accept additional arguments");
  });

  it.each([
    { args: ["bad\nFORGED"] },
    { args: ["\u001b[31mFORGED\u001b[0m"] },
    { args: ["bad\u202eFORGED"] },
    { args: ["create", "bad\nFORGED"] },
    { args: ["create", "\u001b[31mFORGED\u001b[0m"] },
  ])("never reflects untrusted command tokens from $args", async ({ args }) => {
    const capture = captureIo();

    await expect(runCli(args, capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(capture.stderr[0]).not.toContain("FORGED");
    expect(capture.stderr[0]).not.toContain("\u001b");
    expect(capture.stderr[0]).not.toContain("\u202e");
  });

  it.each([
    { args: ["create"], message: "requires both" },
    { args: ["create", "--brief"], message: "requires a path" },
    {
      args: ["create", "--brief", briefPath, "--brief", briefPath, "--output", "out"],
      message: "only once",
    },
    {
      args: ["create", "--brief", briefPath, "--output", "out", "--output", "other"],
      message: "only once",
    },
    {
      args: ["create", "--brief", briefPath, "--output", "out", "--json", "--json"],
      message: "only once",
    },
    {
      args: ["create", "--brief", briefPath, "--output", "out", "positional"],
      message: "Unknown create argument.",
    },
    {
      args: ["create", "--brief", "bad\npath", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", "bad\u0085path", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", "bad\u2028path", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", "bad\u202epath", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", "bad\u200bpath", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", `bad${String.fromCodePoint(0x10ffff)}path`, "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", "bad\ufdd0path", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", "bad\ufffepath", "--output", "out"],
      message: "unambiguous Unicode path",
    },
    {
      args: ["create", "--brief", `bad${String.fromCodePoint(0x10fffe)}path`, "--output", "out"],
      message: "unambiguous Unicode path",
    },
  ])("returns usage exit 2 for $message", async ({ args, message }) => {
    const capture = captureIo();

    await expect(runCli(args, capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(capture.stderr[0]).toContain(message);
  });

  it("creates a project and reports only rendered facts", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const capture = captureIo();

    await expect(
      runCli(["create", "--brief", briefPath, "--output", output], capture.io),
    ).resolves.toBe(0);

    expect(capture.stderr).toEqual([]);
    expect(capture.stdout).toEqual([
      `Created ${output}\nCanonical skill: ${join(output, "skills/incident-summary")}\nFiles: 7\n`,
    ]);
    await expect(
      readFile(join(output, "skills/incident-summary/SKILL.md"), "utf8"),
    ).resolves.toContain("name: incident-summary");
  });

  it("rejects an unpaired-surrogate output path before creating an alias on disk", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "bad\ud800name");
    const capture = captureIo();

    await expect(
      runCli(["create", "--brief", briefPath, "--output", output], capture.io),
    ).resolves.toBe(2);

    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(capture.stderr[0]).toContain("unambiguous Unicode path");
    expect(await readdir(parent)).toEqual([]);
  });

  it("emits one stable JSON success object", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const capture = captureIo();

    await expect(
      runCli(["create", "--json", "--output", output, "--brief", briefPath], capture.io),
    ).resolves.toBe(0);

    expect(capture.stderr).toEqual([]);
    expect(capture.stdout).toHaveLength(1);
    expect(JSON.parse(capture.stdout[0] as string)).toMatchObject({
      ok: true,
      command: "create",
      root: output,
      skillPath: "skills/incident-summary",
      files: expect.arrayContaining([
        expect.objectContaining({ path: "skills/incident-summary/SKILL.md" }),
      ]),
    });
  });

  it("checks a generated project in human and JSON modes", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const creation = captureIo();
    await expect(
      runCli(["create", "--brief", briefPath, "--output", output], creation.io),
    ).resolves.toBe(0);

    const human = captureIo();
    await expect(runCli(["check", "--project", output], human.io)).resolves.toBe(0);
    expect(human.stderr).toEqual([]);
    expect(human.stdout).toHaveLength(1);
    expect(human.stdout[0]).toContain("Readiness: 100/100");
    expect(human.stdout[0]).toContain("Status: pass");

    const json = captureIo();
    await expect(runCli(["check", "--json", "--project", output], json.io)).resolves.toBe(0);
    expect(json.stderr).toEqual([]);
    expect(JSON.parse(json.stdout[0] as string)).toMatchObject({
      command: "check",
      schemaVersion: 1,
      ok: true,
      eligible: true,
      score: 100,
      minimum: 90,
    });
  });

  it("returns the complete failed check report with exit 3", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    await runCli(["create", "--brief", briefPath, "--output", output], captureIo().io);
    const skillPath = join(output, "skills/incident-summary/SKILL.md");
    const skill = await readFile(skillPath, "utf8");
    await writeFile(skillPath, skill.replace("# Incident Summary", "# TODO: finish title"));
    const capture = captureIo();

    await expect(runCli(["check", "--project", output, "--json"], capture.io)).resolves.toBe(3);

    expect(capture.stderr).toEqual([]);
    const report = JSON.parse(capture.stdout[0] as string) as Record<string, unknown>;
    expect(report).toMatchObject({ command: "check", ok: false, eligible: false, score: 40 });
    expect(JSON.stringify(report)).not.toContain(skillPath);

    const human = captureIo();
    await expect(runCli(["check", "--project", output], human.io)).resolves.toBe(3);
    expect(human.stderr).toEqual([]);
    expect(human.stdout[0]).toContain("Eligible: no");
    expect(human.stdout[0]).toContain("Status: fail");
  });

  it("reports an invalid project configuration as a stable command error", async () => {
    const project = await temporaryDirectory();
    const capture = captureIo();

    await expect(runCli(["check", "--project", project, "--json"], capture.io)).resolves.toBe(3);

    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(JSON.parse(capture.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "project.invalid",
      issues: [expect.objectContaining({ code: "config.read" })],
    });
  });

  it("does not render terminal-unsafe diagnostic paths in human output", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    await runCli(["create", "--brief", briefPath, "--output", output], captureIo().io);
    await writeFile(join(output, "skills/incident-summary/bad\nFORGED.env"), "secret=false\n");
    const capture = captureIo();

    await expect(runCli(["check", "--project", output], capture.io)).resolves.toBe(3);

    expect(capture.stderr).toEqual([]);
    expect(capture.stdout.join("")).toContain("skill resource tree cannot be validated safely");
    expect(capture.stdout.join("")).toContain("skills/incident-summary/.");
    expect(capture.stdout.join("")).not.toContain("FORGED");
    expect(capture.stdout.join("")).not.toContain("\nFORGED");
  });

  it.each([
    { args: ["check", "--project"], message: "requires a path" },
    { args: ["check", "--project", ".", "--project", "."], message: "only once" },
    { args: ["check", "--json", "--json"], message: "only once" },
    { args: ["check", "extra"], message: "Unknown check argument" },
  ])("rejects invalid check arguments: $message", async ({ args, message }) => {
    const capture = captureIo();

    await expect(runCli(args, capture.io)).resolves.toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toContain(message);
  });

  it("classifies invalid briefs as exit 3", async () => {
    const parent = await temporaryDirectory();
    const invalidBrief = join(parent, "invalid.yaml");
    const output = join(parent, "project");
    await writeFile(invalidBrief, "schemaVersion: 1\nname: partial\n", { mode: 0o600 });
    const capture = captureIo();

    await expect(
      runCli(["create", "--brief", invalidBrief, "--output", output, "--json"], capture.io),
    ).resolves.toBe(3);

    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(JSON.parse(capture.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "brief.invalid",
      issues: expect.arrayContaining([expect.objectContaining({ code: "brief.schema.required" })]),
    });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies existing outputs as exit 4 without changing them", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    await writeFile(output, "sentinel", { mode: 0o600 });
    const capture = captureIo();

    await expect(
      runCli(["create", "--brief", briefPath, "--output", output, "--json"], capture.io),
    ).resolves.toBe(4);

    expect(capture.stdout).toEqual([]);
    expect(JSON.parse(capture.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "create.unsafe_output",
      issues: [expect.objectContaining({ code: "create.output_exists" })],
    });
    await expect(readFile(output, "utf8")).resolves.toBe("sentinel");
  });

  it.runIf(process.platform !== "win32")("classifies staging I/O failures as exit 1", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "x".repeat(240));
    const capture = captureIo();

    await expect(
      runCli(["create", "--brief", briefPath, "--output", output, "--json"], capture.io),
    ).resolves.toBe(1);

    expect(capture.stdout).toEqual([]);
    expect(JSON.parse(capture.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "create.io",
      issues: [expect.objectContaining({ code: "create.io" })],
    });
  });

  it("does not attempt a second emission when success output itself fails", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const stderr: string[] = [];

    await expect(
      runCli(["create", "--brief", briefPath, "--output", output, "--json"], {
        stdout: () => {
          throw new Error("sensitive adapter detail");
        },
        stderr: (text) => stderr.push(text),
      }),
    ).resolves.toBe(1);

    expect(stderr).toEqual([]);
    await expect(lstat(output)).resolves.toMatchObject({});
  });

  it("does not classify a forged output-adapter error as a SkillPress domain error", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const stderr: string[] = [];
    const forged = new ProjectCreationError("attacker-controlled message", "unsafe-output", [
      { code: "attacker.issue", path: "/secret", message: "attacker-controlled detail" },
    ]);

    await expect(
      runCli(["create", "--brief", briefPath, "--output", output, "--json"], {
        stdout: () => {
          throw forged;
        },
        stderr: (text) => stderr.push(text),
      }),
    ).resolves.toBe(1);

    expect(stderr).toEqual([]);
    await expect(lstat(output)).resolves.toMatchObject({});
  });

  it("snapshots runtime arguments without using their iterator", async () => {
    const capture = captureIo();
    const args = new Proxy(["--version"], {
      get: (target, property, receiver) => {
        if (property === Symbol.iterator) {
          throw new Error("iterator must not be used");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(runCli(args, capture.io)).resolves.toBe(0);
    expect(capture.stdout).toEqual([`${VERSION}\n`]);
    expect(capture.stderr).toEqual([]);
  });

  it("uses an immutable argument snapshot across create awaits", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const args = ["create", "--brief", briefPath, "--output", output, "--json"];
    const capture = captureIo();

    const operation = runCli(args, capture.io);
    args.splice(0, args.length, "--version");

    await expect(operation).resolves.toBe(0);
    expect(JSON.parse(capture.stdout[0] as string)).toMatchObject({
      ok: true,
      command: "create",
      root: output,
    });
    await expect(lstat(output)).resolves.toMatchObject({});
  });

  it("normalizes malformed or hostile public runtime inputs", async () => {
    const capture = captureIo();
    let poison: object;
    poison = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw poison;
        },
      },
    );
    const hostileArgs = new Proxy(["--version"], {
      get: (target, property, receiver) => {
        if (property === "0") {
          throw poison;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const invalidArgs = [null, 42, ["--version", 42], new Array(65).fill("x"), hostileArgs];

    for (const args of invalidArgs) {
      await expect(runCli(args as unknown as readonly string[], capture.io)).resolves.toBe(2);
    }
    expect(capture.stderr).toHaveLength(invalidArgs.length);
    expect(capture.stderr.join("")).not.toContain("poison");

    await expect(
      runCli(
        ["--version"],
        new Proxy(
          {},
          {
            get: () => {
              throw poison;
            },
          },
        ) as typeof capture.io,
      ),
    ).resolves.toBe(1);
    await expect(
      runCli(["--version"], {
        stdout: "invalid",
        stderr: "invalid",
      } as unknown as typeof capture.io),
    ).resolves.toBe(1);
  });

  it("preserves explicit JSON mode when the argument snapshot exceeds a bound", async () => {
    for (const args of [
      ["create", "--json", ...new Array(63).fill("unknown")],
      ["create", "--json", "x".repeat(64 * 1024 + 1)],
    ]) {
      const capture = captureIo();

      await expect(runCli(args, capture.io)).resolves.toBe(2);
      expect(capture.stdout).toEqual([]);
      expect(capture.stderr).toHaveLength(1);
      expect(JSON.parse(capture.stderr[0] as string)).toMatchObject({
        ok: false,
        code: "usage",
        issues: [{ code: "cli.usage" }],
      });
    }
  });

  it.each(["throw", "reject"])(
    "never emits a second record after a success sink accepts data then %s",
    async (failureMode) => {
      const parent = await temporaryDirectory();
      const cases = [
        { args: ["--help"], output: undefined },
        { args: ["--version"], output: undefined },
        {
          args: ["create", "--brief", briefPath, "--output", join(parent, `${failureMode}-human`)],
          output: join(parent, `${failureMode}-human`),
        },
        {
          args: [
            "create",
            "--brief",
            briefPath,
            "--output",
            join(parent, `${failureMode}-json`),
            "--json",
          ],
          output: join(parent, `${failureMode}-json`),
        },
      ];

      for (const entry of cases) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const failure = new Error("late output failure");
        const exitCode = await runCli(entry.args, {
          stdout: (text) => {
            stdout.push(text);
            if (failureMode === "throw") {
              throw failure;
            }
            return Promise.reject(failure);
          },
          stderr: (text) => {
            stderr.push(text);
          },
        });

        expect(exitCode).toBe(1);
        expect(stdout).toHaveLength(1);
        expect(stderr).toEqual([]);
        if (entry.output !== undefined) {
          await expect(lstat(entry.output)).resolves.toMatchObject({});
        }
      }
    },
  );

  it("returns a stable code when an output sink itself throws", async () => {
    const forged = new ProjectCreationError("attacker-controlled", "unsafe-output", [
      { code: "attacker.issue", path: "/", message: "attacker-controlled" },
    ]);
    const errors: string[] = [];

    await expect(
      runCli(["--version"], {
        stdout: () => {
          throw forged;
        },
        stderr: (text) => errors.push(text),
      }),
    ).resolves.toBe(1);
    expect(errors).toEqual([]);
    await expect(
      runCli(["unknown"], {
        stdout: () => undefined,
        stderr: () => {
          throw forged;
        },
      }),
    ).resolves.toBe(2);
  });

  it("uses process stdout when no IO adapter is supplied", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli(["--version"])).resolves.toBe(0);
    expect(write).toHaveBeenCalledWith(`${VERSION}\n`);
  });

  it("uses process stderr when no IO adapter is supplied", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runCli(["not-a-command"])).resolves.toBe(2);
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Unknown command."));
  });
});
