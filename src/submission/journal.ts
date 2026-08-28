import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { Ajv, type ValidateFunction } from "ajv";

import type { SkillPressSubmissionReceipt } from "./generated-receipt.js";

export type SubmissionReceipt = SkillPressSubmissionReceipt;

export interface SubmissionJournalIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class SubmissionJournalError extends Error {
  readonly issues: readonly SubmissionJournalIssue[];

  constructor(message: string, issues: readonly SubmissionJournalIssue[]) {
    super(message);
    this.name = "SubmissionJournalError";
    this.issues = Object.freeze([...issues]);
  }
}

const RECEIPT_PATH = /^\.skill-press\/submissions\/([a-f0-9]{64})\/receipt[.]json$/u;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const receiptSchema = JSON.parse(
  await readFile(new URL("../../schemas/submission-receipt.schema.json", import.meta.url), "utf8"),
) as object;
const validateReceipt = new Ajv({ allErrors: true, strict: true }).compile(
  receiptSchema,
) as ValidateFunction<SkillPressSubmissionReceipt>;

function issue(code: string, path: string, message: string): SubmissionJournalIssue {
  return Object.freeze({ code, path, message });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function validSemantics(receipt: SubmissionReceipt): boolean {
  const expected = `.skill-press/submissions/${receipt.idempotencyKey}/receipt.json`;
  const releaseLocator =
    receipt.remote?.release === undefined
      ? null
      : /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)@(.+)$/u.exec(
          receipt.remote.release.locator,
        );
  const releasePath =
    releaseLocator === null
      ? null
      : `${encodeURIComponent(releaseLocator[1] as string)}/${encodeURIComponent(releaseLocator[2] as string)}/${encodeURIComponent(releaseLocator[3] as string)}`;
  const releaseValid =
    receipt.remote?.release === undefined ||
    (releaseLocator !== null &&
      releaseLocator[1] === receipt.registry.namespace &&
      releaseLocator[2] === receipt.bindings.skillName &&
      releaseLocator[3] === receipt.bindings.projectVersion &&
      receipt.remote.release.version === receipt.bindings.projectVersion &&
      receipt.remote.release.artifactSha256 === receipt.bindings.artifactSha256 &&
      receipt.remote.release.canonicalUrl === `https://skill-press.com/skills/${releasePath}` &&
      receipt.remote.release.attestationUrl ===
        `https://skill-press.com/attestations/${releasePath}`);
  const remoteValid =
    receipt.remote !== null &&
    receipt.remote.namespace === receipt.registry.namespace &&
    receipt.remote.url ===
      `https://skill-press.com/api/v1/submissions/${encodeURIComponent(receipt.remote.id)}` &&
    (receipt.remote.status === "published") === (receipt.remote.release !== undefined) &&
    releaseValid;
  if (receipt.dryRun) {
    return (
      receipt.operationStatus === "prepared" &&
      receipt.storagePath === null &&
      receipt.request.status === "pending" &&
      receipt.request.attempts === 0 &&
      receipt.remote === null &&
      receipt.errorCode === undefined
    );
  }
  if (receipt.storagePath !== expected) return false;
  if (receipt.operationStatus === "prepared") return false;
  if (receipt.operationStatus === "submitted") {
    return (
      receipt.request.status === "completed" &&
      receipt.request.attempts > 0 &&
      remoteValid &&
      receipt.errorCode === undefined
    );
  }
  if (receipt.operationStatus === "failed") {
    return (
      receipt.errorCode !== undefined &&
      ((receipt.request.status === "pending" && receipt.remote === null) ||
        (receipt.request.status === "completed" && receipt.request.attempts > 0 && remoteValid))
    );
  }
  return (
    receipt.request.status === "pending" &&
    receipt.remote === null &&
    receipt.errorCode === undefined
  );
}

function assertReceipt(receipt: SubmissionReceipt): void {
  if (!validateReceipt(receipt) || !validSemantics(receipt)) {
    throw new SubmissionJournalError("Submission receipt violated its contract.", [
      issue("submission.receipt.schema", "/receipt", "receipt shape or state is invalid"),
    ]);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new SubmissionJournalError("Submission storage is unsafe.", [
      issue("submission.storage.unsafe", "/storage", "storage must use private real directories"),
    ]);
  }
  await chmod(path, 0o700);
}

export function submissionReceiptPath(idempotencyKey: string): string {
  if (!/^[a-f0-9]{64}$/u.test(idempotencyKey)) {
    throw new SubmissionJournalError("Submission idempotency key is invalid.", [
      issue("submission.idempotency.invalid", "/idempotencyKey", "expected a SHA-256 digest"),
    ]);
  }
  return `.skill-press/submissions/${idempotencyKey}/receipt.json`;
}

export async function createSubmissionStorage(
  projectRoot: string,
  idempotencyKey: string,
): Promise<string> {
  const paths = [
    join(projectRoot, ".skill-press"),
    join(projectRoot, ".skill-press", "submissions"),
    join(projectRoot, ".skill-press", "submissions", idempotencyKey),
  ];
  for (const path of paths) await ensurePrivateDirectory(path);
  return submissionReceiptPath(idempotencyKey);
}

export async function submissionReceiptExists(
  projectRoot: string,
  idempotencyKey: string,
): Promise<boolean> {
  try {
    await lstat(join(projectRoot, submissionReceiptPath(idempotencyKey)));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function persistSubmissionReceipt(
  projectRoot: string,
  receipt: SubmissionReceipt,
): Promise<void> {
  assertReceipt(receipt);
  if (receipt.storagePath === null) {
    throw new SubmissionJournalError("Dry-run receipts are not persisted.", [
      issue("submission.receipt.dry_run", "/storagePath", "dry-run receipt has no storage path"),
    ]);
  }
  const destination = join(projectRoot, receipt.storagePath);
  const temporary = join(dirname(destination), `.receipt-${randomBytes(16).toString("hex")}`);
  await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

async function loadReceipt(root: string, receiptPath: string): Promise<SubmissionReceipt> {
  const match = RECEIPT_PATH.exec(receiptPath);
  if (match === null) {
    throw new SubmissionJournalError("Submission receipt path is invalid.", [
      issue("submission.receipt.path", "/receipt", "receipt must use private submission storage"),
    ]);
  }
  const absolute = join(root, receiptPath);
  for (const parent of [
    join(root, ".skill-press"),
    join(root, ".skill-press", "submissions"),
    dirname(absolute),
  ]) {
    const metadata = await lstat(parent);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      throw new SubmissionJournalError("Submission receipt storage is unsafe.", [
        issue(
          "submission.receipt.unsafe",
          "/receipt",
          "receipt parents must be private directories",
        ),
      ]);
    }
  }
  const before = await lstat(absolute);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > MAX_RECEIPT_BYTES ||
    (process.platform !== "win32" && (before.mode & 0o077) !== 0)
  ) {
    throw new SubmissionJournalError("Submission receipt is unsafe.", [
      issue("submission.receipt.unsafe", "/receipt", "receipt must be a private regular file"),
    ]);
  }
  let value: unknown;
  try {
    const bytes = await readFile(absolute);
    const after = await lstat(absolute);
    if (
      bytes.byteLength !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("receipt changed while read");
    }
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    value = undefined;
  }
  if (!validateReceipt(value) || !validSemantics(value)) {
    throw new SubmissionJournalError("Submission receipt is invalid.", [
      issue("submission.receipt.schema", "/receipt", "receipt does not satisfy its contract"),
    ]);
  }
  if (value.idempotencyKey !== match[1] || value.storagePath !== receiptPath) {
    throw new SubmissionJournalError("Submission receipt binding is invalid.", [
      issue(
        "submission.receipt.binding",
        "/receipt",
        "receipt path must match its idempotency key",
      ),
    ]);
  }
  return value;
}

/** Read a private local submission journal. It is not a trust attestation. */
export async function readSubmissionReceipt(
  projectDirectory: string,
  receiptPath: string,
): Promise<SubmissionReceipt> {
  const root = await realpath(resolve(projectDirectory));
  return freeze(structuredClone(await loadReceipt(root, receiptPath)));
}

export async function readMutableSubmissionReceipt(
  projectRoot: string,
  receiptPath: string,
): Promise<SubmissionReceipt> {
  return loadReceipt(projectRoot, receiptPath);
}
