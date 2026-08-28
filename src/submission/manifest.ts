import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { Ajv, type ValidateFunction } from "ajv";

import { loadProjectConfig } from "../config/load.js";
import { digestBoundedTree } from "../evidence/tree-digest.js";
import type { LoadedSkillPackageArtifacts } from "../package/archive.js";
import { isSafePathInput } from "../path-safety.js";
import type { SkillPressSubmissionManifest } from "./generated-manifest.js";

export interface SubmissionEvidencePaths {
  readonly reviewEvidencePath: string;
  readonly evalEvidencePath: string;
  readonly evalSource: string;
}

export interface PreparedSubmissionPayload {
  readonly manifest: SkillPressSubmissionManifest;
  readonly manifestBytes: Buffer;
  readonly manifestSha256: string;
  readonly idempotencyKey: string;
  readonly artifactBytes: Buffer;
  readonly provenanceBytes: Buffer;
  readonly checksumsBytes: Buffer;
  readonly reviewEvidenceBytes: Buffer;
  readonly evalEvidenceBytes: Buffer;
}

export interface SubmissionManifestIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class SubmissionManifestError extends Error {
  readonly issues: readonly SubmissionManifestIssue[];

  constructor(message: string, issues: readonly SubmissionManifestIssue[]) {
    super(message);
    this.name = "SubmissionManifestError";
    this.issues = Object.freeze([...issues]);
  }
}

const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_PROVENANCE_BYTES = 64 * 1024;
const MAX_CHECKSUMS_BYTES = 1024;
const ARTIFACTS_PATH = /^\.skill-press\/staging\/[a-f0-9]{64}\/artifacts$/u;
const EVIDENCE_PATH = /^\.skill-press\/tessl\/[a-f0-9]{64}\/evidence[.]json$/u;
const manifestSchema = JSON.parse(
  await readFile(new URL("../../schemas/submission-manifest.schema.json", import.meta.url), "utf8"),
) as object;
const validateManifest = new Ajv({ allErrors: true, strict: true }).compile(
  manifestSchema,
) as ValidateFunction<SkillPressSubmissionManifest>;

function issue(code: string, path: string, message: string): SubmissionManifestIssue {
  return Object.freeze({ code, path, message });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameMetadata(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function readStableFile(path: string, label: string, maximum = MAX_PAYLOAD_BYTES) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximum) {
    throw new SubmissionManifestError("Submission payload is unsafe.", [
      issue(
        "submission.payload.unsafe",
        `/payload/${label}`,
        "payload must be a bounded regular file",
      ),
    ]);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (bytes.byteLength !== before.size || !sameMetadata(before, after)) {
    throw new SubmissionManifestError("Submission payload changed while it was read.", [
      issue(
        "submission.payload.changed",
        `/payload/${label}`,
        "payload must remain stable while read",
      ),
    ]);
  }
  return bytes;
}

function confinedPath(root: string, input: string, label: string): string {
  if (
    !isSafePathInput(input) ||
    input.includes("\\") ||
    isAbsolute(input) ||
    input
      .split("/")
      .some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new SubmissionManifestError("Submission path is unsafe.", [
      issue("submission.path.unsafe", label, "path must be a normalized project-relative path"),
    ]);
  }
  const absolute = resolve(root, input);
  const bounded = relative(root, absolute);
  if (
    bounded === "" ||
    bounded === ".." ||
    bounded.startsWith(`..${sep}`) ||
    isAbsolute(bounded) ||
    bounded.split(sep).join("/") !== input
  ) {
    throw new SubmissionManifestError("Submission path is unsafe.", [
      issue("submission.path.unsafe", label, "path must remain inside the project"),
    ]);
  }
  return absolute;
}

async function canonicalProjectPath(root: string, input: string, label: string): Promise<string> {
  const absolute = confinedPath(root, input, label);
  if ((await realpath(absolute)) !== absolute) {
    throw new SubmissionManifestError("Submission path traverses a symbolic link.", [
      issue("submission.path.symlink", label, "path must not traverse symbolic links"),
    ]);
  }
  return absolute;
}

function payload<N extends string, T extends "application/zip" | "application/json" | "text/plain">(
  name: N,
  bytes: Buffer,
  mediaType: T,
): { readonly name: N; readonly sha256: string; readonly bytes: number; readonly mediaType: T } {
  return {
    name,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    mediaType,
  };
}

/** Build deterministic submission metadata and exact upload bytes from a verified package. */
export async function prepareSkillSubmission(
  projectDirectory: string,
  artifacts: LoadedSkillPackageArtifacts,
  evidence: SubmissionEvidencePaths,
): Promise<PreparedSubmissionPayload> {
  const root = await realpath(resolve(projectDirectory));
  const config = await loadProjectConfig(root);
  if (config.project.name !== config.skill.name) {
    throw new SubmissionManifestError("Submission project identity is inconsistent.", [
      issue(
        "submission.project.identity",
        "/skill/name",
        "project.name and skill.name must identify the same canonical skill",
      ),
    ]);
  }
  if (!ARTIFACTS_PATH.test(artifacts.artifactsPath)) {
    throw new SubmissionManifestError("Submission artifact storage is unsafe.", [
      issue(
        "submission.artifact.path",
        "/package",
        "artifact storage must use the private content-addressed staging path",
      ),
    ]);
  }
  if (
    artifacts.skillArchive !== `${config.skill.name}-${config.project.version}.skill` ||
    artifacts.provenance !== "provenance.json" ||
    artifacts.checksums !== "SHA256SUMS"
  ) {
    throw new SubmissionManifestError("Submission package filenames are invalid.", [
      issue(
        "submission.artifact.name",
        "/package",
        "package filenames must match the canonical inventory",
      ),
    ]);
  }
  if (
    !EVIDENCE_PATH.test(evidence.reviewEvidencePath) ||
    !EVIDENCE_PATH.test(evidence.evalEvidencePath)
  ) {
    throw new SubmissionManifestError("Submission evidence paths are invalid.", [
      issue(
        "submission.evidence.path",
        "/evidence",
        "evidence must use private content-addressed Tessl storage",
      ),
    ]);
  }
  await canonicalProjectPath(root, artifacts.artifactsPath, "/package");
  const artifactPath = await canonicalProjectPath(
    root,
    `${artifacts.artifactsPath}/${artifacts.skillArchive}`,
    "/package/artifact",
  );
  const provenancePath = await canonicalProjectPath(
    root,
    `${artifacts.artifactsPath}/${artifacts.provenance}`,
    "/package/provenance",
  );
  const checksumsPath = await canonicalProjectPath(
    root,
    `${artifacts.artifactsPath}/${artifacts.checksums}`,
    "/package/checksums",
  );
  const reviewEvidencePath = await canonicalProjectPath(
    root,
    evidence.reviewEvidencePath,
    "/evidence/review",
  );
  const evalEvidencePath = await canonicalProjectPath(
    root,
    evidence.evalEvidencePath,
    "/evidence/evaluation",
  );
  const [artifactBytes, provenanceBytes, checksumsBytes, reviewEvidenceBytes, evalEvidenceBytes] =
    await Promise.all([
      readStableFile(artifactPath, "artifact"),
      readStableFile(provenancePath, "provenance", MAX_PROVENANCE_BYTES),
      readStableFile(checksumsPath, "checksums", MAX_CHECKSUMS_BYTES),
      readStableFile(reviewEvidencePath, "review-evidence", 1024 * 1024),
      readStableFile(evalEvidencePath, "eval-evidence", 1024 * 1024),
    ]);
  const evalSource = await canonicalProjectPath(root, evidence.evalSource, "/evidence/evalSource");
  const evalSourceSha256 = await digestBoundedTree(evalSource);
  if (
    artifactBytes.byteLength !== artifacts.artifactBytes ||
    sha256(artifactBytes) !== artifacts.artifactSha256 ||
    provenanceBytes.byteLength !== artifacts.provenanceBytes ||
    sha256(provenanceBytes) !== artifacts.provenanceSha256 ||
    checksumsBytes.byteLength !== artifacts.checksumsBytes ||
    sha256(checksumsBytes) !== artifacts.checksumsSha256
  ) {
    throw new SubmissionManifestError("Submission package bindings changed.", [
      issue(
        "submission.package.binding",
        "/package",
        "package bytes must match verified artifacts",
      ),
    ]);
  }
  const manifest: SkillPressSubmissionManifest = {
    schemaVersion: 1,
    manifestType: "skillpress.submission-manifest",
    configSchemaVersion: 2,
    project: {
      name: config.project.name,
      version: config.project.version,
      repository: config.project.repository,
      license: config.project.license,
      author: config.project.author,
    },
    registry: {
      namespace: config.registry.namespace,
    },
    skill: {
      name: config.skill.name,
      path: config.skill.path,
      risk: config.skill.risk,
    },
    source: {
      commit: artifacts.sourceCommit,
      projectConfigSha256: artifacts.projectConfigSha256,
      skillSha256: artifacts.skillSha256,
    },
    package: {
      artifact: payload(artifacts.skillArchive, artifactBytes, "application/zip"),
      provenance: payload(artifacts.provenance, provenanceBytes, "application/json"),
      checksums: payload(artifacts.checksums, checksumsBytes, "text/plain"),
    },
    evidence: {
      advisory: true,
      review: payload("review-evidence.json", reviewEvidenceBytes, "application/json"),
      evaluation: payload("eval-evidence.json", evalEvidenceBytes, "application/json"),
      evalSource: evidence.evalSource,
      evalSourceSha256,
    },
    serverValidationRequired: true,
    tool: { name: "@skill-press/cli" },
  };
  if (!validateManifest(manifest)) {
    throw new SubmissionManifestError("Submission manifest violated its schema.", [
      issue("submission.manifest.schema", "/manifest", "generated manifest is invalid"),
    ]);
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const manifestSha256 = sha256(manifestBytes);
  const idempotencyKey = sha256(`skillpress.submission.v1\0${manifestBytes.toString("utf8")}`);
  return Object.freeze({
    manifest: Object.freeze(structuredClone(manifest)),
    manifestBytes,
    manifestSha256,
    idempotencyKey,
    artifactBytes,
    provenanceBytes,
    checksumsBytes,
    reviewEvidenceBytes,
    evalEvidenceBytes,
  });
}
