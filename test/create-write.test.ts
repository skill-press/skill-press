import { createHash } from "node:crypto";
import { readdirSync, realpathSync, symlinkSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ProjectCreationError } from "../src/create/errors.js";
import { loadCapabilityBrief } from "../src/create/load.js";
import {
  type RenderedCapabilityProject,
  type RenderedProjectFile,
  renderCapabilityProject,
} from "../src/create/render.js";
import {
  type ProjectWriteOptions,
  type ProjectWritePhase,
  writeRenderedProject,
} from "../src/create/write.js";

const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));
const temporaryRoot = realpathSync(tmpdir());
const READ_TEST_BYTES = 70 * 1024;
const temporaryDirectories: string[] = [];
let rendered: RenderedCapabilityProject;

beforeAll(async () => {
  rendered = renderCapabilityProject(await loadCapabilityBrief(briefPath));
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(temporaryRoot, "skillpress-write-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function expectCreationIssue(
  operation: Promise<unknown>,
  code: string,
): Promise<ProjectCreationError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectCreationError);
    const creationError = error as ProjectCreationError;
    expect(creationError.issues.map((entry) => entry.code)).toContain(code);
    return creationError;
  }
  throw new Error(`Expected project creation issue: ${code}`);
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("transactional project writing", () => {
  it("writes exactly the rendered manifest and removes private transaction state", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");

    const result = await writeRenderedProject(rendered, output);

    expect(result.root).toBe(output);
    expect(result.skillPath).toBe("skills/incident-summary");
    expect(result.files).toEqual(
      rendered.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    );
    for (const file of rendered.files) {
      await expect(readFile(join(output, ...file.path.split("/")), "utf8")).resolves.toBe(
        file.content,
      );
    }
    expect(await readdir(output)).not.toContain(".skillpress-incomplete");
    expect((await readdir(parent)).filter((name) => name.includes("skillpress-stage"))).toEqual([]);

    if (process.platform !== "win32") {
      expect((await stat(output)).mode & 0o777).toBe(0o755);
      expect((await stat(join(output, "skillpress.yaml"))).mode & 0o777).toBe(0o644);
    }
  });

  it.each(["file", "empty-directory", "nonempty-directory"])(
    "refuses to overwrite an existing %s",
    async (kind) => {
      const parent = await temporaryDirectory();
      const output = join(parent, "project");
      if (kind === "file") {
        await writeFile(output, "sentinel", { flag: "wx" });
      } else {
        await mkdir(output);
        if (kind === "nonempty-directory") {
          await writeFile(join(output, "sentinel"), "keep", { flag: "wx" });
        }
      }

      const error = await expectCreationIssue(
        writeRenderedProject(rendered, output),
        "create.output_exists",
      );

      expect(error.kind).toBe("unsafe-output");
      if (kind === "file") {
        await expect(readFile(output, "utf8")).resolves.toBe("sentinel");
      } else if (kind === "nonempty-directory") {
        await expect(readFile(join(output, "sentinel"), "utf8")).resolves.toBe("keep");
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses final and intermediate symbolic links without touching their targets",
    async () => {
      const parent = await temporaryDirectory();
      const actual = await temporaryDirectory();
      await writeFile(join(actual, "sentinel"), "keep", { flag: "wx" });
      const finalLink = join(parent, "final-link");
      const parentLink = join(parent, "parent-link");
      symlinkSync(actual, finalLink);
      symlinkSync(actual, parentLink);

      await expectCreationIssue(writeRenderedProject(rendered, finalLink), "create.output_exists");
      await expectCreationIssue(
        writeRenderedProject(rendered, join(parentLink, "child")),
        "create.output_symlink",
      );
      await expect(readFile(join(actual, "sentinel"), "utf8")).resolves.toBe("keep");
    },
  );

  it("allows only one concurrent creator to claim an output", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");

    const results = await Promise.allSettled([
      writeRenderedProject(rendered, output),
      writeRenderedProject(rendered, output),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "create.output_exists" })]),
      }),
    });
    await expect(readFile(join(output, "skillpress.yaml"), "utf8")).resolves.toContain(
      "schemaVersion: 1",
    );
    expect(await readdir(output)).not.toContain(".skillpress-incomplete");
  });

  it.each<ProjectWritePhase>(["stage-populated", "before-complete"])(
    "rolls back only owned paths after a %s failure",
    async (failurePhase) => {
      const parent = await temporaryDirectory();
      const output = join(parent, "project");

      const error = await expectCreationIssue(
        writeRenderedProject(rendered, output, {
          onPhase: ({ phase }) => {
            if (phase === failurePhase) {
              throw new Error(`injected ${phase} failure`);
            }
          },
        }),
        "create.phase_callback",
      );

      expect(error.kind).toBe("io");
      await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(parent)).filter((name) => name.includes("skillpress-stage"))).toEqual(
        [],
      );
    },
  );

  it("normalizes hostile phase callback failures without exposing injected diagnostics", async () => {
    const parent = await temporaryDirectory();
    let poison: object;
    poison = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw poison;
        },
      },
    );
    const forged = new ProjectCreationError("attacker-controlled message", "unsafe-output", [
      { code: "attacker.issue", path: "/secret", message: "attacker-controlled detail" },
    ]);
    const hostileOptions: ProjectWriteOptions[] = [
      {
        onPhase: () => {
          throw forged;
        },
      },
      {
        onPhase: () => {
          throw poison;
        },
      },
      {
        onPhase: (() =>
          // biome-ignore lint/suspicious/noThenProperty: this regression intentionally supplies a hostile thenable.
          Object.defineProperty({}, "then", {
            get: () => {
              throw poison;
            },
          })) as unknown as ProjectWriteOptions["onPhase"],
      },
    ];

    for (const [index, options] of hostileOptions.entries()) {
      const output = join(parent, `project-${index}`);
      const error = await expectCreationIssue(
        writeRenderedProject(rendered, output, options),
        "create.phase_callback",
      );

      expect(error.message).toBe("A project write phase callback failed.");
      expect(error.kind).toBe("io");
      expect(error.issues).toEqual([
        {
          code: "create.phase_callback",
          path: "/",
          message: "project write phase callback failed",
        },
      ]);
      expect((error.cause as Error | undefined)?.cause).toBeUndefined();
      await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("snapshots and validates runtime options before any filesystem write", async () => {
    const parent = await temporaryDirectory();
    let poison: object;
    poison = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw poison;
        },
      },
    );
    let entriesObservedByGetter: string[] | undefined;
    const throwingGetter = Object.defineProperty({}, "onPhase", {
      get: () => {
        entriesObservedByGetter = readdirSync(parent);
        throw poison;
      },
    }) as ProjectWriteOptions;
    const invalidOptions = [42, null, [], { onPhase: "not-a-function" }, throwingGetter] as const;

    for (const [index, options] of invalidOptions.entries()) {
      await expectCreationIssue(
        writeRenderedProject(
          rendered,
          join(parent, `project-${index}`),
          options as unknown as ProjectWriteOptions,
        ),
        "create.options",
      );
      expect(readdirSync(parent)).toEqual([]);
    }
    expect(entriesObservedByGetter).toEqual([]);
  });

  it("preserves unknown target data under an incomplete marker", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");

    const error = await expectCreationIssue(
      writeRenderedProject(rendered, output, {
        onPhase: async ({ phase, root }) => {
          if (phase === "before-complete") {
            await writeFile(join(root, "foreign-sentinel"), "preserve", { flag: "wx" });
            throw new Error("injected foreign data");
          }
        },
      }),
      "create.incomplete_preserved",
    );

    expect(error.kind).toBe("io");
    await expect(readFile(join(output, "foreign-sentinel"), "utf8")).resolves.toBe("preserve");
    await expect(readFile(join(output, ".skillpress-incomplete"), "utf8")).resolves.toMatch(
      /^[0-9a-f-]+\n$/u,
    );
  });

  it("rejects an exact-tree violation even when the phase hook returns normally", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");

    const error = await expectCreationIssue(
      writeRenderedProject(rendered, output, {
        onPhase: async ({ phase, root }) => {
          if (phase === "before-complete") {
            await writeFile(join(root, "foreign-sentinel"), "preserve", { flag: "wx" });
          }
        },
      }),
      "create.output_changed",
    );

    expect(error.kind).toBe("unsafe-output");
    expect(error.issues.map((entry) => entry.code)).toContain("create.incomplete_preserved");
    await expect(readFile(join(output, "foreign-sentinel"), "utf8")).resolves.toBe("preserve");
    expect(await readdir(output)).toContain(".skillpress-incomplete");
  });

  it("preserves same-inode content changes under the incomplete marker", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");

    const error = await expectCreationIssue(
      writeRenderedProject(rendered, output, {
        onPhase: async ({ phase, root }) => {
          if (phase === "before-complete") {
            const path = join(root, "skillpress.yaml");
            const original = await readFile(path, "utf8");
            const replacement = `${original.startsWith("x") ? "y" : "x"}${original.slice(1)}`;
            expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
            await writeFile(path, replacement, { flag: "w" });
          }
        },
      }),
      "create.output_changed",
    );

    expect(error.kind).toBe("unsafe-output");
    expect(error.issues.map((entry) => entry.code)).toContain("create.incomplete_preserved");
    await expect(readFile(join(output, "skillpress.yaml"), "utf8")).resolves.not.toBe(
      rendered.files.find((file) => file.path === "skillpress.yaml")?.content,
    );
    await expect(lstat(join(output, ".skillpress-incomplete"))).resolves.toMatchObject({});
  });

  it("preserves a truncated owned file under the incomplete marker", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");

    const error = await expectCreationIssue(
      writeRenderedProject(rendered, output, {
        onPhase: async ({ phase, root }) => {
          if (phase === "before-complete") {
            await writeFile(join(root, "skillpress.yaml"), "short\n", { flag: "w" });
          }
        },
      }),
      "create.output_changed",
    );

    expect(error.kind).toBe("unsafe-output");
    expect(error.issues.map((entry) => entry.code)).toContain("create.incomplete_preserved");
    await expect(readFile(join(output, "skillpress.yaml"), "utf8")).resolves.toBe("short\n");
    await expect(lstat(join(output, ".skillpress-incomplete"))).resolves.toMatchObject({});
  });

  it("preserves a replaced target inode under the incomplete marker", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");

    const error = await expectCreationIssue(
      writeRenderedProject(rendered, output, {
        onPhase: async ({ phase, root }) => {
          if (phase === "before-complete") {
            const path = join(root, "skillpress.yaml");
            await unlink(path);
            await writeFile(path, "foreign replacement\n", { flag: "wx" });
          }
        },
      }),
      "create.output_changed",
    );

    expect(error.issues.map((entry) => entry.code)).toContain("create.incomplete_preserved");
    await expect(readFile(join(output, "skillpress.yaml"), "utf8")).resolves.toBe(
      "foreign replacement\n",
    );
    await expect(lstat(join(output, ".skillpress-incomplete"))).resolves.toMatchObject({});
  });

  it.runIf(process.platform !== "win32")(
    "does not follow a replacement symlink during final verification",
    async () => {
      const parent = await temporaryDirectory();
      const output = join(parent, "project");
      const external = join(parent, "external-secret");
      await writeFile(external, "must not be read or changed\n", { mode: 0o600 });
      await chmod(external, 0o000);

      const error = await (async () => {
        try {
          return await expectCreationIssue(
            writeRenderedProject(rendered, output, {
              onPhase: async ({ phase, root }) => {
                if (phase === "before-complete") {
                  const path = join(root, "skillpress.yaml");
                  await unlink(path);
                  symlinkSync(external, path);
                }
              },
            }),
            "create.output_changed",
          );
        } finally {
          await chmod(external, 0o600);
        }
      })();

      expect(error.kind).toBe("unsafe-output");
      expect(error.issues.map((entry) => entry.code)).toContain("create.incomplete_preserved");
      await expect(readFile(external, "utf8")).resolves.toBe("must not be read or changed\n");
      await expect(lstat(join(output, "skillpress.yaml"))).resolves.toMatchObject({});
      expect((await lstat(join(output, "skillpress.yaml"))).isSymbolicLink()).toBe(true);
    },
  );

  it("reports a missing owned file instead of treating it as safely cleaned", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");

    const error = await expectCreationIssue(
      writeRenderedProject(rendered, output, {
        onPhase: async ({ phase, root }) => {
          if (phase === "before-complete") {
            await unlink(join(root, "skillpress.yaml"));
          }
        },
      }),
      "create.output_changed",
    );

    expect(error.issues.map((entry) => entry.code)).toContain("create.incomplete_preserved");
    await expect(lstat(join(output, ".skillpress-incomplete"))).resolves.toMatchObject({});
  });

  it("detects unknown staging data before writing anything to the target", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");

    const error = await expectCreationIssue(
      writeRenderedProject(rendered, output, {
        onPhase: async ({ phase, root }) => {
          if (phase === "stage-populated") {
            await writeFile(join(root, "foreign-sentinel"), "preserve", { flag: "wx" });
          }
        },
      }),
      "create.output_changed",
    );

    expect(error.issues.map((entry) => entry.code)).toContain("create.incomplete_preserved");
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    const stage = (await readdir(parent)).find((name) => name.includes("skillpress-stage"));
    expect(stage).toBeDefined();
    await expect(readFile(join(parent, stage as string, "foreign-sentinel"), "utf8")).resolves.toBe(
      "preserve",
    );
  });

  it("blocks completion when staging changes after target population", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    let stage = "";

    const error = await expectCreationIssue(
      writeRenderedProject(rendered, output, {
        onPhase: async ({ phase, root }) => {
          if (phase === "stage-populated") {
            stage = root;
          }
          if (phase === "before-complete") {
            await writeFile(join(stage, "foreign-sentinel"), "preserve", { flag: "wx" });
          }
        },
      }),
      "create.stage_cleanup",
    );

    expect(error.issues.map((entry) => entry.code)).toContain("create.incomplete_preserved");
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(stage, "foreign-sentinel"), "utf8")).resolves.toBe("preserve");
  });

  it.runIf(process.platform !== "win32")(
    "detects a staged intermediate symlink before any target write escapes",
    async () => {
      const parent = await temporaryDirectory();
      const external = await temporaryDirectory();
      const output = join(parent, "project");

      const error = await expectCreationIssue(
        writeRenderedProject(rendered, output, {
          onPhase: async ({ phase, root }) => {
            if (phase === "stage-populated") {
              await rename(join(root, "skills"), join(parent, "owned-skills-moved"));
              symlinkSync(external, join(root, "skills"));
            }
          },
        }),
        "create.output_changed",
      );

      expect(error.issues.map((entry) => entry.code)).toContain("create.incomplete_preserved");
      await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(external)).toEqual([]);
    },
  );

  it("restores the incomplete marker if cleanup loses a directory race", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");

    const error = await expectCreationIssue(
      writeRenderedProject(rendered, output, {
        onPhase: async ({ phase, root }) => {
          if (phase === "before-complete") {
            throw new Error("force rollback");
          }
          if (phase === "cleanup-marker-removed") {
            await writeFile(join(root, "foreign-sentinel"), "preserve", { flag: "wx" });
          }
        },
      }),
      "create.incomplete_preserved",
    );

    expect(error.kind).toBe("io");
    await expect(readFile(join(output, "foreign-sentinel"), "utf8")).resolves.toBe("preserve");
    await expect(readFile(join(output, ".skillpress-incomplete"), "utf8")).resolves.toMatch(
      /^[0-9a-f-]+\n$/u,
    );
  });

  it("detects a parent directory identity change and reports the moved stage", async () => {
    const parent = await temporaryDirectory();
    const movedParent = `${parent}-moved`;
    temporaryDirectories.push(movedParent);
    const output = join(parent, "project");

    const error = await expectCreationIssue(
      writeRenderedProject(rendered, output, {
        onPhase: async ({ phase, root }) => {
          if (phase === "stage-populated") {
            await rename(parent, movedParent);
            await mkdir(parent);
            await rename(join(movedParent, basename(root)), root);
          }
        },
      }),
      "create.output_changed",
    );

    expect(error.kind).toBe("unsafe-output");
    expect(error.issues.map((entry) => entry.code)).not.toContain("create.incomplete_preserved");
    expect((await readdir(movedParent)).some((name) => name.includes("skillpress-stage"))).toBe(
      false,
    );
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses a synchronous immutable manifest snapshot across filesystem awaits", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const mutableFiles = rendered.files.map((file) => ({ ...file }));
    const mutableProject = { skillPath: rendered.skillPath, files: mutableFiles };
    const expected = mutableFiles.map((file) => ({ path: file.path, sha256: file.sha256 }));
    const mutableFirst = mutableFiles[0] as RenderedProjectFile & {
      path: string;
      content: string;
      sha256: string;
    };

    const operation = writeRenderedProject(mutableProject, output);
    mutableProject.skillPath = "skills/mutated";
    mutableFirst.path = "../escape";
    mutableFirst.content = "x".repeat(3 * 1024 * 1024);
    mutableFirst.sha256 = "0".repeat(64);
    mutableFiles.splice(1);

    await expect(operation).resolves.toMatchObject({
      skillPath: "skills/incident-summary",
      files: expected,
    });
    await expect(lstat(join(parent, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(output, ".gitignore"), "utf8")).resolves.toBe(
      rendered.files[0]?.content,
    );
  });

  it("writes bounded empty and multi-buffer files without changing their bytes", async () => {
    const parent = await temporaryDirectory();
    const output = join(parent, "project");
    const large = "x".repeat(READ_TEST_BYTES);
    const project: RenderedCapabilityProject = {
      ...rendered,
      files: [
        ...rendered.files,
        { path: "assets/empty.txt", content: "", sha256: digest("") },
        { path: "assets/large.txt", content: large, sha256: digest(large) },
      ],
    };

    const result = await writeRenderedProject(project, output);

    expect(result.files).toHaveLength(rendered.files.length + 2);
    await expect(readFile(join(output, "assets/empty.txt"), "utf8")).resolves.toBe("");
    await expect(readFile(join(output, "assets/large.txt"), "utf8")).resolves.toBe(large);
  });

  it("requires an existing safe parent and refuses a filesystem root", async () => {
    const parent = await temporaryDirectory();
    const parentFile = join(parent, "regular-file");
    await writeFile(parentFile, "not a directory", { mode: 0o600 });

    await expectCreationIssue(
      writeRenderedProject(rendered, join(parent, "missing", "project")),
      "create.output_parent",
    );
    await expectCreationIssue(
      writeRenderedProject(rendered, parseRoot(parent)),
      "create.output_root",
    );
    await expectCreationIssue(
      writeRenderedProject(rendered, join(parentFile, "project")),
      "create.output_parent",
    );
    await expectCreationIssue(
      writeRenderedProject(rendered, join(parent, "x".repeat(300))),
      "create.output_inspect",
    );
  });

  it.each([
    "bad\ud800name",
    "bad\ufdd0name",
    "bad\ufffename",
    `bad${String.fromCodePoint(0x10fffe)}name`,
    `bad${String.fromCodePoint(0x10ffff)}name`,
    "bad\u202ename",
  ])("rejects an unsafe output path before any filesystem call: %j", async (name) => {
    const parent = await temporaryDirectory();

    await expectCreationIssue(
      writeRenderedProject(rendered, join(parent, name as string)),
      "create.output_unicode",
    );
    expect(await readdir(parent)).toEqual([]);
  });

  it("rejects a whitespace-only output before resolving it against the current directory", async () => {
    await expectCreationIssue(writeRenderedProject(rendered, "   "), "create.output_unicode");
  });
});

function parseRoot(path: string): string {
  return parse(path).root;
}
