import { createHash } from "node:crypto";
import { dirname } from "node:path";

import { type CapabilityBriefIssue, ProjectCreationError } from "./errors.js";
import type { RenderedCapabilityProject, RenderedProjectFile } from "./render.js";

export const INCOMPLETE_MARKER = ".skill-press-incomplete";
export const MAX_RENDERED_BYTES = 2 * 1024 * 1024;
export const MAX_RENDERED_FILES = 1024;
export const MAX_RENDERED_PATH_BYTES = 512;
export const MAX_RENDERED_PATH_DEPTH = 16;
export const MAX_RENDERED_PATH_SEGMENT_BYTES = 200;
export const MAX_TOTAL_PATH_BYTES = 64 * 1024;

const SAFE_PROJECT_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const SAFE_SKILL_PATH = /^skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const WINDOWS_RESERVED_SEGMENT = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\.|$)/iu;

export interface ExpectedRenderedFile {
  readonly bytes: number;
  readonly sha256: string;
}

export interface RenderedProjectSnapshot {
  readonly skillPath: string;
  readonly files: readonly RenderedProjectFile[];
  readonly directories: readonly string[];
  readonly expectedFiles: ReadonlyMap<string, ExpectedRenderedFile>;
}

interface PortableTreeNode {
  readonly kind: "directory" | "file";
  readonly exactPath: string;
}

function issue(code: string, message: string): CapabilityBriefIssue {
  return { code, path: "/", message };
}

function manifestError(code: string, message: string, detail: string): never {
  throw new ProjectCreationError(message, "io", [issue(code, detail)]);
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function compareAscii(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isPortablePath(path: string): boolean {
  if (path.length > MAX_RENDERED_PATH_BYTES || !SAFE_PROJECT_PATH.test(path)) {
    return false;
  }
  const segments = path.split("/");
  return (
    segments[0]?.toLowerCase() !== INCOMPLETE_MARKER &&
    Buffer.byteLength(path, "utf8") <= MAX_RENDERED_PATH_BYTES &&
    segments.length <= MAX_RENDERED_PATH_DEPTH &&
    segments.every(
      (segment) =>
        !segment.endsWith(".") &&
        !WINDOWS_RESERVED_SEGMENT.test(segment) &&
        Buffer.byteLength(segment, "utf8") <= MAX_RENDERED_PATH_SEGMENT_BYTES,
    )
  );
}

function directoriesFor(files: readonly RenderedProjectFile[]): readonly string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let parent = dirname(file.path);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  return [...directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth === 0 ? compareAscii(left, right) : depth;
  });
}

function readProjectShape(project: RenderedCapabilityProject): {
  readonly skillPath: string;
  readonly files: readonly unknown[];
} {
  if (project === null || typeof project !== "object") {
    manifestError(
      "create.manifest_type",
      "Rendered project must be an object.",
      "rendered project has an invalid runtime type",
    );
  }

  let skillPath: unknown;
  let files: unknown;
  let filesAreArray = false;
  try {
    skillPath = project.skillPath;
    files = project.files;
    filesAreArray = Array.isArray(files);
  } catch {
    manifestError(
      "create.manifest_type",
      "Rendered project could not be read safely.",
      "rendered project fields must be inert data properties",
    );
  }
  if (typeof skillPath !== "string" || !filesAreArray) {
    manifestError(
      "create.manifest_type",
      "Rendered project fields have invalid runtime types.",
      "skillPath must be a string and files must be an array",
    );
  }
  return { skillPath, files: files as readonly unknown[] };
}

function snapshotFile(value: unknown): RenderedProjectFile {
  if (value === null || typeof value !== "object") {
    manifestError(
      "create.manifest_type",
      "Rendered project file must be an object.",
      "rendered file has an invalid runtime type",
    );
  }

  let path: unknown;
  let content: unknown;
  let digest: unknown;
  try {
    const record = value as Record<string, unknown>;
    path = record.path;
    content = record.content;
    digest = record.sha256;
  } catch {
    manifestError(
      "create.manifest_type",
      "Rendered project file could not be read safely.",
      "rendered file fields must be inert data properties",
    );
  }
  if (typeof path !== "string" || typeof content !== "string" || typeof digest !== "string") {
    manifestError(
      "create.manifest_type",
      "Rendered project manifest fields must be strings.",
      "rendered path, content, and digest must be strings",
    );
  }
  return Object.freeze({ path, content, sha256: digest });
}

function readFileCount(files: readonly unknown[]): number {
  let count: unknown;
  try {
    count = files.length;
  } catch {
    manifestError(
      "create.manifest_type",
      "Rendered project file count could not be read safely.",
      "files must be a finite inert array",
    );
  }
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_RENDERED_FILES
  ) {
    manifestError(
      "create.manifest_file_count",
      "Rendered project has an invalid file count.",
      `rendered project must contain 1 to ${MAX_RENDERED_FILES} files`,
    );
  }
  return count;
}

function readFileAt(files: readonly unknown[], index: number): unknown {
  try {
    return files[index];
  } catch {
    manifestError(
      "create.manifest_type",
      "Rendered project file could not be indexed safely.",
      "files must be a finite inert array",
    );
  }
}

function buildSnapshot(project: RenderedCapabilityProject): RenderedProjectSnapshot {
  const shape = readProjectShape(project);
  if (!SAFE_SKILL_PATH.test(shape.skillPath) || !isPortablePath(shape.skillPath)) {
    manifestError(
      "create.manifest_skill_path",
      "Rendered project has an unsafe canonical skill path.",
      "skillPath must be a portable relative project path",
    );
  }
  const fileCount = readFileCount(shape.files);
  const files: RenderedProjectFile[] = [];
  for (let index = 0; index < fileCount; index += 1) {
    files.push(snapshotFile(readFileAt(shape.files, index)));
  }

  const tree = new Map<string, PortableTreeNode>();
  const exactPaths = new Set<string>();
  let totalBytes = 0;
  let totalPathBytes = 0;
  for (const file of files) {
    if (!isPortablePath(file.path)) {
      manifestError(
        "create.manifest_path",
        "Rendered project contains an unsafe or duplicate path.",
        "rendered paths must be unique and portable across supported platforms",
      );
    }
    totalPathBytes += Buffer.byteLength(file.path, "utf8");
    if (totalPathBytes > MAX_TOTAL_PATH_BYTES) {
      manifestError(
        "create.manifest_path",
        "Rendered project contains an unsafe or duplicate path.",
        "rendered paths must be unique and portable across supported platforms",
      );
    }
    const segments = file.path.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      const exactPath = segments.slice(0, index + 1).join("/");
      const portableKey = exactPath.toLowerCase();
      const kind = index === segments.length - 1 ? "file" : "directory";
      const existing = tree.get(portableKey);
      if (
        existing !== undefined &&
        (kind === "file" || existing.kind !== kind || existing.exactPath !== exactPath)
      ) {
        manifestError(
          "create.manifest_path",
          "Rendered project contains an unsafe or duplicate path.",
          "rendered paths must not contain file-directory or case-folded aliases",
        );
      }
      tree.set(portableKey, { kind, exactPath });
    }

    if (file.content.length > MAX_RENDERED_BYTES) {
      manifestError(
        "create.manifest_too_large",
        "Rendered project exceeds the write budget.",
        `rendered files exceed ${MAX_RENDERED_BYTES} bytes`,
      );
    }
    totalBytes += Buffer.byteLength(file.content, "utf8");
    if (totalBytes > MAX_RENDERED_BYTES) {
      manifestError(
        "create.manifest_too_large",
        "Rendered project exceeds the write budget.",
        `rendered files exceed ${MAX_RENDERED_BYTES} bytes`,
      );
    }
    if (Buffer.from(file.content, "utf8").toString("utf8") !== file.content) {
      manifestError(
        "create.manifest_encoding",
        "Rendered project contains text that cannot round-trip through UTF-8.",
        "rendered file content contains invalid Unicode",
      );
    }
    if (sha256(file.content) !== file.sha256) {
      manifestError(
        "create.manifest_digest",
        "Rendered project digest does not match its content.",
        "rendered file digest does not match its snapshotted content",
      );
    }
    exactPaths.add(file.path);
  }

  files.sort((left, right) => compareAscii(left.path, right.path));

  if (!exactPaths.has(`${shape.skillPath}/SKILL.md`)) {
    manifestError(
      "create.manifest_skill",
      "Rendered project does not contain its canonical skill.",
      "canonical SKILL.md is absent from the rendered manifest",
    );
  }

  const expectedFiles = new Map(
    files.map(
      (file) =>
        [
          file.path,
          { bytes: Buffer.byteLength(file.content, "utf8"), sha256: file.sha256 },
        ] as const,
    ),
  );
  return Object.freeze({
    skillPath: shape.skillPath,
    files: Object.freeze(files),
    directories: Object.freeze(directoriesFor(files)),
    expectedFiles,
  });
}

export function snapshotRenderedProject(
  project: RenderedCapabilityProject,
): RenderedProjectSnapshot {
  return buildSnapshot(project);
}
