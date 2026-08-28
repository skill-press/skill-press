import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

import { isSafePathInput } from "../path-safety.js";

import {
  type CapabilityBriefIssue,
  ProjectCreationError,
  type ProjectCreationErrorKind,
} from "./errors.js";
import { INCOMPLETE_MARKER, snapshotRenderedProject } from "./manifest.js";
import { cleanupClaimedTarget, cleanupOwned } from "./owned-cleanup.js";
import {
  type FileMetadata,
  isErrno,
  type OwnedEntry,
  recordOwned,
  sameIdentity,
  verifyOwnedTree,
} from "./owned-tree.js";
import type { RenderedCapabilityProject, RenderedProjectFile } from "./render.js";

export type ProjectWritePhase = "stage-populated" | "before-complete" | "cleanup-marker-removed";

export interface ProjectWriteEvent {
  readonly phase: ProjectWritePhase;
  readonly root: string;
}

export interface ProjectWriteOptions {
  readonly onPhase?: (event: ProjectWriteEvent) => void | Promise<void>;
}

interface SnapshottedProjectWriteOptions {
  readonly onPhase?: (event: ProjectWriteEvent) => void | Promise<void>;
}

export interface CreatedCapabilityProject {
  readonly root: string;
  readonly skillPath: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

function issue(code: string, path: string, message: string): CapabilityBriefIssue {
  return { code, path, message };
}

function creationError(
  message: string,
  kind: ProjectCreationErrorKind,
  code: string,
  detail: string,
  cause?: unknown,
): ProjectCreationError {
  return new ProjectCreationError(message, kind, [issue(code, "/", detail)], cause);
}

function snapshotWriteOptions(value: unknown): SnapshottedProjectWriteOptions {
  let callback: unknown;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("options must be an object");
    }
    callback = (value as { readonly onPhase?: unknown }).onPhase;
  } catch {
    throw creationError(
      "Skill Press project write options are invalid.",
      "io",
      "create.options",
      "project write options must be a readable object",
    );
  }
  if (callback !== undefined && typeof callback !== "function") {
    throw creationError(
      "Skill Press project write options are invalid.",
      "io",
      "create.options",
      "onPhase must be a function when provided",
    );
  }
  return callback === undefined
    ? {}
    : { onPhase: callback as NonNullable<ProjectWriteOptions["onPhase"]> };
}

async function inspectSafeDirectory(path: string): Promise<FileMetadata> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const components = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  let metadata: FileMetadata;

  try {
    metadata = await lstat(current, { bigint: true });
    for (const component of components) {
      current = join(current, component);
      metadata = await lstat(current, { bigint: true });
      if (metadata.isSymbolicLink()) {
        throw creationError(
          "Refusing to create a project through a symbolic-link directory.",
          "unsafe-output",
          "create.output_symlink",
          "output parent path must not contain symbolic links",
        );
      }
    }
  } catch (error) {
    if (error instanceof ProjectCreationError) {
      throw error;
    }
    throw creationError(
      `Unable to inspect output parent ${absolute}.`,
      "unsafe-output",
      "create.output_parent",
      "output parent must already exist and be inspectable",
      error,
    );
  }

  if (!metadata.isDirectory()) {
    throw creationError(
      "Skill Press output parent must be a directory.",
      "unsafe-output",
      "create.output_parent",
      "output parent is not a directory",
    );
  }
  return metadata;
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    throw creationError(
      `Unable to inspect output path ${path}.`,
      "unsafe-output",
      "create.output_inspect",
      "output path cannot be safely inspected",
      error,
    );
  }
  throw creationError(
    `Refusing to overwrite existing output at ${path}.`,
    "unsafe-output",
    "create.output_exists",
    "output path already exists",
  );
}

async function emit(
  options: SnapshottedProjectWriteOptions,
  phase: ProjectWritePhase,
  root: string,
): Promise<void> {
  try {
    const callback = options.onPhase;
    if (callback !== undefined) {
      if (typeof callback !== "function") {
        throw new TypeError("onPhase must be a function");
      }
      await callback({ phase, root });
    }
  } catch {
    throw creationError(
      "A project write phase callback failed.",
      "io",
      "create.phase_callback",
      "project write phase callback failed",
    );
  }
}

async function createDirectories(
  root: string,
  directories: readonly string[],
  owned: OwnedEntry[],
): Promise<void> {
  for (const directory of directories) {
    const path = join(root, ...directory.split("/"));
    await mkdir(path, { mode: 0o700 });
    owned.push(await recordOwned(path, "directory"));
  }
}

async function populateStage(
  stage: string,
  files: readonly RenderedProjectFile[],
  directories: readonly string[],
  owned: OwnedEntry[],
): Promise<void> {
  await createDirectories(stage, directories, owned);
  for (const file of files) {
    const path = join(stage, ...file.path.split("/"));
    await writeFile(path, file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    owned.push(await recordOwned(path, "file"));
  }
}

export async function writeRenderedProject(
  project: RenderedCapabilityProject,
  output: string,
  options: ProjectWriteOptions = {},
): Promise<CreatedCapabilityProject> {
  if (!isSafePathInput(output)) {
    throw creationError(
      "Skill Press output must use an unambiguous Unicode path.",
      "unsafe-output",
      "create.output_unicode",
      "output path contains unsupported Unicode or control characters",
    );
  }
  const writeOptions = snapshotWriteOptions(options);
  const { skillPath, files, expectedFiles, directories } = snapshotRenderedProject(project);
  const target = resolve(output);
  const parent = dirname(target);
  const outputName = basename(target);
  if (outputName === "") {
    throw creationError(
      "A filesystem root cannot be used as a Skill Press output.",
      "unsafe-output",
      "create.output_root",
      "output must name a new child directory",
    );
  }

  const parentMetadata = await inspectSafeDirectory(parent);
  await assertAbsent(target);

  const stageOwned: OwnedEntry[] = [];
  const targetOwned: OwnedEntry[] = [];
  let stage = "";
  let marker = "";
  try {
    stage = await mkdtemp(join(parent, `.${outputName}.skill-press-stage-`));
    stageOwned.push(await recordOwned(stage, "directory"));
    await populateStage(stage, files, directories, stageOwned);
    await emit(writeOptions, "stage-populated", stage);
    if (!(await verifyOwnedTree(stage, stageOwned, expectedFiles, false))) {
      throw creationError(
        "Staged output changed before publication.",
        "unsafe-output",
        "create.output_changed",
        "staged tree does not exactly match the rendered manifest",
      );
    }

    const currentParent = await inspectSafeDirectory(parent);
    if (!sameIdentity(parentMetadata, currentParent)) {
      throw creationError(
        "Output parent changed while the project was staged.",
        "unsafe-output",
        "create.output_changed",
        "output parent identity changed during creation",
      );
    }

    try {
      await mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw creationError(
          `Refusing to overwrite existing output at ${target}.`,
          "unsafe-output",
          "create.output_exists",
          "output path was claimed by another process",
          error,
        );
      }
      throw error;
    }
    targetOwned.push(await recordOwned(target, "directory"));

    marker = join(target, INCOMPLETE_MARKER);
    await writeFile(marker, `${randomUUID()}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    targetOwned.push(await recordOwned(marker, "file"));
    await createDirectories(target, directories, targetOwned);

    for (const file of files) {
      const source = join(stage, ...file.path.split("/"));
      const destination = join(target, ...file.path.split("/"));
      await link(source, destination);
      targetOwned.push(await recordOwned(destination, "file"));
    }

    await emit(writeOptions, "before-complete", target);
    if (!(await verifyOwnedTree(target, targetOwned, expectedFiles, true))) {
      throw creationError(
        "Output changed before completion.",
        "unsafe-output",
        "create.output_changed",
        "output tree does not exactly match the rendered manifest",
      );
    }
    if (!(await cleanupOwned(stageOwned))) {
      throw creationError(
        "Unable to remove the owned staging tree safely.",
        "io",
        "create.stage_cleanup",
        "staging tree changed or could not be removed",
      );
    }
    stageOwned.splice(0);

    await unlink(marker);
    return {
      root: target,
      skillPath,
      files: files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    };
  } catch (error) {
    const targetClean = await cleanupClaimedTarget(targetOwned, marker, () =>
      emit(writeOptions, "cleanup-marker-removed", target),
    );
    const stageClean = await cleanupOwned(stageOwned);
    const cleanupIssues =
      targetClean && stageClean
        ? []
        : [
            issue(
              "create.incomplete_preserved",
              "/",
              "an owned path changed or contains unknown data; incomplete output was preserved",
            ),
          ];

    if (error instanceof ProjectCreationError) {
      throw new ProjectCreationError(
        error.message,
        error.kind,
        [...error.issues, ...cleanupIssues],
        error,
      );
    }
    throw new ProjectCreationError(
      "Unable to write the rendered Skill Press project.",
      "io",
      [issue("create.io", "/", "project files could not be written"), ...cleanupIssues],
      error,
    );
  }
}
