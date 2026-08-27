import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { ProjectCreationError } from "../src/create/errors.js";
import {
  MAX_RENDERED_BYTES,
  MAX_RENDERED_FILES,
  snapshotRenderedProject,
} from "../src/create/manifest.js";
import { loadCapabilityBrief } from "../src/create/load.js";
import {
  type RenderedCapabilityProject,
  type RenderedProjectFile,
  renderCapabilityProject,
} from "../src/create/render.js";

const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));
let rendered: RenderedCapabilityProject;

beforeAll(async () => {
  rendered = renderCapabilityProject(await loadCapabilityBrief(briefPath));
});

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function emptyFile(path: string): RenderedProjectFile {
  return { path, content: "", sha256: digest("") };
}

function withExtraFile(file: RenderedProjectFile): RenderedCapabilityProject {
  return { ...rendered, files: [...rendered.files, file] };
}

function expectManifestIssue(
  project: RenderedCapabilityProject,
  code: string,
): ProjectCreationError {
  try {
    snapshotRenderedProject(project);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectCreationError);
    const creationError = error as ProjectCreationError;
    expect(creationError.issues.map((entry) => entry.code)).toContain(code);
    return creationError;
  }
  throw new Error(`Expected manifest issue: ${code}`);
}

describe("rendered project manifest snapshots", () => {
  it("creates a sorted immutable snapshot with exact budgets and directories", () => {
    const sourceFiles = [...rendered.files].reverse().map((file) => ({ ...file }));
    const project = { ...rendered, files: sourceFiles };

    const snapshot = snapshotRenderedProject(project);

    expect(snapshot.skillPath).toBe("skills/incident-summary");
    expect(snapshot.files.map((file) => file.path)).toEqual(
      rendered.files.map((file) => file.path).sort(),
    );
    expect(snapshot.directories).toEqual(["evals", "skills", "skills/incident-summary"]);
    expect(snapshot.expectedFiles.get("skill-press.yaml")).toEqual({
      bytes: Buffer.byteLength(
        rendered.files.find((file) => file.path === "skill-press.yaml")?.content ?? "",
      ),
      sha256: rendered.files.find((file) => file.path === "skill-press.yaml")?.sha256,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.files)).toBe(true);
    expect(snapshot.files.every((file) => Object.isFrozen(file))).toBe(true);

    const first = sourceFiles[0] as RenderedProjectFile & { path: string; content: string };
    first.path = "mutated";
    first.content = "mutated";
    expect(snapshot.files.some((file) => file.path === "mutated")).toBe(false);
  });

  it("rejects malformed manifests without filesystem access", () => {
    const cases = [
      {
        name: "null project",
        project: null as unknown as RenderedCapabilityProject,
        code: "create.manifest_type",
      },
      {
        name: "wrong project fields",
        project: { skillPath: 42, files: {} } as unknown as RenderedCapabilityProject,
        code: "create.manifest_type",
      },
      {
        name: "unsafe skill path",
        project: { ...rendered, skillPath: "../skill" },
        code: "create.manifest_skill_path",
      },
      {
        name: "reserved skill path",
        project: { ...rendered, skillPath: "skills/CON" },
        code: "create.manifest_skill_path",
      },
      {
        name: "nested skill path",
        project: { ...rendered, skillPath: "skills/group/skill" },
        code: "create.manifest_skill_path",
      },
      {
        name: "empty files",
        project: { ...rendered, files: [] },
        code: "create.manifest_file_count",
      },
      {
        name: "too many files",
        project: {
          ...rendered,
          files: Array.from({ length: MAX_RENDERED_FILES + 1 }, (_, index) =>
            emptyFile(`many/file-${index}.txt`),
          ),
        },
        code: "create.manifest_file_count",
      },
      {
        name: "non-object file",
        project: {
          ...rendered,
          files: [...rendered.files, null],
        } as unknown as RenderedCapabilityProject,
        code: "create.manifest_type",
      },
      {
        name: "non-string file field",
        project: withExtraFile({
          path: 42,
          content: "invalid",
          sha256: digest("invalid"),
        } as unknown as RenderedProjectFile),
        code: "create.manifest_type",
      },
      {
        name: "duplicate path",
        project: {
          ...rendered,
          files: [...rendered.files, rendered.files[0] as RenderedProjectFile],
        },
        code: "create.manifest_path",
      },
      {
        name: "case-folded duplicate path",
        project: withExtraFile(emptyFile("license")),
        code: "create.manifest_path",
      },
      {
        name: "case-folded parent alias",
        project: withExtraFile(emptyFile("Skills/other.txt")),
        code: "create.manifest_path",
      },
      {
        name: "file-directory collision",
        project: withExtraFile(emptyFile("LICENSE/child.txt")),
        code: "create.manifest_path",
      },
      {
        name: "traversal path",
        project: withExtraFile(emptyFile("../escape")),
        code: "create.manifest_path",
      },
      {
        name: "reserved transaction path",
        project: withExtraFile(emptyFile(".skill-press-incomplete/child")),
        code: "create.manifest_path",
      },
      {
        name: "case-folded transaction path",
        project: withExtraFile(emptyFile(".SKILL-PRESS-INCOMPLETE/child")),
        code: "create.manifest_path",
      },
      {
        name: "Windows reserved path",
        project: withExtraFile(emptyFile("assets/NUL.txt")),
        code: "create.manifest_path",
      },
      {
        name: "trailing-dot path",
        project: withExtraFile(emptyFile("assets/name.")),
        code: "create.manifest_path",
      },
      {
        name: "oversized segment",
        project: withExtraFile(emptyFile(`${"x".repeat(201)}.txt`)),
        code: "create.manifest_path",
      },
      {
        name: "excessive depth",
        project: withExtraFile(emptyFile(`${"a/".repeat(16)}file.txt`)),
        code: "create.manifest_path",
      },
      {
        name: "total path budget",
        project: {
          ...rendered,
          files: [
            ...rendered.files,
            ...Array.from({ length: 400 }, (_, index) =>
              emptyFile(`paths/${String(index).padStart(3, "0")}-${"x".repeat(170)}.txt`),
            ),
          ],
        },
        code: "create.manifest_path",
      },
      {
        name: "invalid Unicode content",
        project: withExtraFile({ path: "bad.txt", content: "\uD800", sha256: digest("\uD800") }),
        code: "create.manifest_encoding",
      },
      {
        name: "oversized content",
        project: withExtraFile({
          path: "large.txt",
          content: "x".repeat(MAX_RENDERED_BYTES),
          sha256: digest("x".repeat(MAX_RENDERED_BYTES)),
        }),
        code: "create.manifest_too_large",
      },
      {
        name: "digest mismatch",
        project: {
          ...rendered,
          files: [{ ...(rendered.files[0] as RenderedProjectFile), sha256: "0".repeat(64) }],
        },
        code: "create.manifest_digest",
      },
      {
        name: "missing canonical skill",
        project: { ...rendered, skillPath: "skills/missing" },
        code: "create.manifest_skill",
      },
      {
        name: "wrong-case canonical filename",
        project: {
          ...rendered,
          files: rendered.files.map((file) =>
            file.path.endsWith("/SKILL.md")
              ? { ...file, path: file.path.replace("SKILL", "skill") }
              : file,
          ),
        },
        code: "create.manifest_skill",
      },
    ];

    for (const { project, code } of cases) {
      expectManifestIssue(project, code);
    }
  });

  it("normalizes throwing project and file accessors into stable manifest errors", () => {
    const throwingProject = Object.defineProperty({}, "skillPath", {
      get: () => {
        throw new Error("secret project getter detail");
      },
    }) as RenderedCapabilityProject;
    const throwingFile = Object.defineProperty({}, "path", {
      get: () => {
        throw new Error("secret file getter detail");
      },
    }) as RenderedProjectFile;
    const throwingArray = new Proxy([...rendered.files], {
      get: (target, property, receiver) => {
        if (property === "length") {
          throw new Error("secret array getter detail");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const throwingIterator = new Proxy([...rendered.files], {
      get: (target, property, receiver) => {
        if (property === Symbol.iterator) {
          throw new Error("array iterator must not be used");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const projectError = expectManifestIssue(throwingProject, "create.manifest_type");
    const fileError = expectManifestIssue(
      { ...rendered, files: [...rendered.files, throwingFile] },
      "create.manifest_type",
    );
    const arrayError = expectManifestIssue(
      { ...rendered, files: throwingArray },
      "create.manifest_type",
    );
    expect(() => snapshotRenderedProject({ ...rendered, files: throwingIterator })).not.toThrow();

    expect(projectError.issues[0]?.message).not.toContain("secret");
    expect(fileError.issues[0]?.message).not.toContain("secret");
    expect(arrayError.issues[0]?.message).not.toContain("secret");
    expect(projectError.cause).toBeUndefined();
    expect(fileError.cause).toBeUndefined();
    expect(arrayError.cause).toBeUndefined();
  });

  it("normalizes an accessor that throws a hostile proxy", () => {
    let poison: object;
    poison = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw poison;
        },
      },
    );
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw poison;
        },
      },
    ) as RenderedCapabilityProject;

    expect(expectManifestIssue(hostile, "create.manifest_type").cause).toBeUndefined();
  });

  it("does not trust a caller-forged project creation error", () => {
    const forged = new ProjectCreationError("attacker text", "io", [
      { code: "evil", path: "/", message: "secret" },
    ]);
    const hostile = Object.defineProperty({}, "skillPath", {
      get: () => {
        throw forged;
      },
    }) as RenderedCapabilityProject;

    const error = expectManifestIssue(hostile, "create.manifest_type");

    expect(error).not.toBe(forged);
    expect(error.message).not.toContain("attacker");
    expect(error.issues).not.toContainEqual(expect.objectContaining({ code: "evil" }));
    expect(error.cause).toBeUndefined();
  });

  it("does not replay a previously issued and mutated manifest error", () => {
    const prior = expectManifestIssue(
      null as unknown as RenderedCapabilityProject,
      "create.manifest_type",
    );
    Object.defineProperty(prior, "issues", {
      configurable: true,
      value: [{ code: "evil", path: "/", message: "secret" }],
    });
    prior.message = "attacker text";
    const hostile = Object.defineProperty({}, "skillPath", {
      get: () => {
        throw prior;
      },
    }) as RenderedCapabilityProject;

    const error = expectManifestIssue(hostile, "create.manifest_type");

    expect(error).not.toBe(prior);
    expect(error.message).not.toContain("attacker");
    expect(error.issues).not.toContainEqual(expect.objectContaining({ code: "evil" }));
    expect(error.cause).toBeUndefined();
  });
});
