import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { Ajv, type ValidateFunction } from "ajv";

import { loadProjectConfig } from "../config/load.js";
import type { SkillPackageArtifacts } from "../package/archive.js";
import type { SkillPressPublicationReceipt } from "./generated-receipt.js";

export type PublicationCapability = "publish" | "submit" | "derived";
export type PublicationTargetStatus =
  | "planned"
  | "preflight_failed"
  | "running"
  | "failed"
  | "verified"
  | "derived";

export interface PublicationContext {
  readonly root: string;
  readonly project: {
    readonly name: string;
    readonly version: string;
    readonly repository: string;
  };
  readonly sourceCommit: string;
  readonly artifactSha256: string;
  readonly artifactsPath: string;
  readonly artifacts: {
    readonly skillArchive: PublicationArtifact;
    readonly zipArchive: PublicationArtifact;
    readonly checksums: PublicationArtifact;
    readonly provenance: PublicationArtifact;
  };
  readonly idempotencyKey: string;
}

export interface PublicationArtifact {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface PublicationPreflight {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
}

export interface PublicationStepResult {
  readonly remoteId?: string;
  readonly url?: string;
}

export interface PublicationVerification {
  readonly ok: boolean;
  readonly remoteId?: string;
  readonly url?: string;
}

export interface PublicationAdapter {
  readonly id: string;
  readonly capability: PublicationCapability;
  readonly auth: readonly string[];
  readonly rollback: string;
  readonly steps: readonly string[];
  readonly preflight: (context: PublicationContext) => Promise<PublicationPreflight>;
  readonly execute?: (context: PublicationContext, step: string) => Promise<PublicationStepResult>;
  readonly verify: (context: PublicationContext) => Promise<PublicationVerification>;
}

export interface PublicationStepReceipt {
  readonly id: string;
  status: "pending" | "completed";
  remoteId?: string;
  url?: string;
}

export interface PublicationTargetReceipt {
  readonly id: string;
  readonly capability: PublicationCapability;
  readonly auth: readonly string[];
  readonly rollback: string;
  preflight: PublicationPreflight;
  status: PublicationTargetStatus;
  readonly steps: PublicationStepReceipt[];
  remoteId?: string;
  url?: string;
  errorCode?: string;
}

export interface PublicationReceipt {
  readonly schemaVersion: 1;
  readonly receiptType: "skillpress.publication";
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly sourceCommit: string;
  readonly artifactSha256: string;
  readonly projectVersion: string;
  readonly execute: boolean;
  status: "dry_run" | "blocked" | "running" | "failed" | "completed";
  readonly createdAt: string;
  updatedAt: string;
  readonly targets: PublicationTargetReceipt[];
  storagePath: string | null;
}

export interface PublicationSagaOptions {
  readonly execute?: boolean;
  readonly resumeReceiptPath?: string;
  readonly now?: () => Date;
}

export interface PublicationSagaIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class PublicationSagaError extends Error {
  readonly issues: readonly PublicationSagaIssue[];

  constructor(message: string, issues: readonly PublicationSagaIssue[]) {
    super(message);
    this.name = "PublicationSagaError";
    this.issues = Object.freeze([...issues]);
  }
}

const RECEIPT_PATH = /^\.skillpress\/publications\/[a-f0-9]{64}\/receipt\.json$/u;
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/u;
const receiptSchema = JSON.parse(
  await readFile(new URL("../../schemas/publication-receipt.schema.json", import.meta.url), "utf8"),
) as object;
const validateReceipt = new Ajv({ allErrors: true, strict: true }).compile(
  receiptSchema,
) as ValidateFunction<SkillPressPublicationReceipt>;

function issue(code: string, path: string, message: string): PublicationSagaIssue {
  return Object.freeze({ code, path, message });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

async function publicationStorage(root: string, runId: string): Promise<string> {
  const privateRoot = join(root, ".skillpress");
  const parent = join(privateRoot, "publications");
  for (const path of [privateRoot, parent]) {
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    });
    const metadata = await lstat(path);
    if (!metadata.isDirectory()) {
      throw new PublicationSagaError("Publication storage is unsafe.", [
        issue("publish.storage.unsafe", "/storage", "storage must use real directories"),
      ]);
    }
    await chmod(path, 0o700);
  }
  const storage = join(parent, runId);
  await mkdir(storage, { mode: 0o700 });
  await chmod(storage, 0o700);
  return storage;
}

async function persist(root: string, receipt: PublicationReceipt): Promise<void> {
  if (!validateReceipt(receipt)) {
    throw new PublicationSagaError("Publication receipt violated its schema.", [
      issue("publish.receipt.schema", "/receipt", "internal publication receipt is invalid"),
    ]);
  }
  const destination = join(root, receipt.storagePath as string);
  const temporary = join(dirname(destination), `.receipt-${randomBytes(16).toString("hex")}`);
  await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

function adapterSnapshot(adapters: readonly PublicationAdapter[]): PublicationAdapter[] {
  const ids = new Set<string>();
  return adapters.map((adapter) => {
    if (
      !IDENTIFIER.test(adapter.id) ||
      ids.has(adapter.id) ||
      adapter.steps.length > 32 ||
      adapter.steps.some(
        (step, index) => !IDENTIFIER.test(step) || adapter.steps.indexOf(step) !== index,
      ) ||
      adapter.auth.length > 16 ||
      adapter.auth.some(
        (name, index) => !ENVIRONMENT_NAME.test(name) || adapter.auth.indexOf(name) !== index,
      ) ||
      adapter.rollback.length === 0 ||
      adapter.rollback.length > 280
    ) {
      throw new PublicationSagaError("Publication adapter contract is invalid.", [
        issue(
          "publish.adapter.invalid",
          "/adapters",
          "adapter IDs and steps must be bounded and unique",
        ),
      ]);
    }
    if (
      adapter.capability === "derived" &&
      (adapter.execute !== undefined || adapter.steps.length !== 0)
    ) {
      throw new PublicationSagaError("Derived adapters cannot mutate remote state.", [
        issue(
          "publish.adapter.derived",
          `/adapters/${adapter.id}`,
          "derived targets cannot execute steps",
        ),
      ]);
    }
    if (
      adapter.capability !== "derived" &&
      (adapter.execute === undefined || adapter.steps.length === 0)
    ) {
      throw new PublicationSagaError("Mutating adapter has no executable steps.", [
        issue(
          "publish.adapter.steps",
          `/adapters/${adapter.id}`,
          "publish and submit targets need steps",
        ),
      ]);
    }
    ids.add(adapter.id);
    return Object.freeze({
      ...adapter,
      auth: Object.freeze([...adapter.auth]),
      steps: Object.freeze([...adapter.steps]),
    });
  });
}

async function loadReceipt(root: string, path: string): Promise<PublicationReceipt> {
  if (!RECEIPT_PATH.test(path)) {
    throw new PublicationSagaError("Resume receipt path is invalid.", [
      issue(
        "publish.resume.path",
        "/resume",
        "resume path must identify private publication storage",
      ),
    ]);
  }
  const absolute = join(root, path);
  for (const parent of [
    join(root, ".skillpress"),
    join(root, ".skillpress", "publications"),
    dirname(absolute),
  ]) {
    const parentMetadata = await lstat(parent);
    if (!parentMetadata.isDirectory()) {
      throw new PublicationSagaError("Resume receipt is unsafe.", [
        issue("publish.resume.unsafe", "/resume", "receipt parents must be real directories"),
      ]);
    }
  }
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    throw new PublicationSagaError("Resume receipt is unsafe.", [
      issue("publish.resume.unsafe", "/resume", "receipt must be a private regular file"),
    ]);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(absolute, "utf8"));
  } catch {
    value = undefined;
  }
  if (!validateReceipt(value)) {
    throw new PublicationSagaError("Resume receipt is invalid.", [
      issue("publish.resume.schema", "/resume", "receipt shape is invalid"),
    ]);
  }
  return value;
}

function adapterBinding(adapter: PublicationAdapter): object {
  return {
    id: adapter.id,
    capability: adapter.capability,
    auth: adapter.auth,
    rollback: adapter.rollback,
    steps: adapter.steps,
  };
}

function receiptTargetMatchesAdapter(
  target: PublicationTargetReceipt,
  adapter: PublicationAdapter,
): boolean {
  return (
    target.id === adapter.id &&
    target.capability === adapter.capability &&
    target.auth.join("\0") === adapter.auth.join("\0") &&
    target.rollback === adapter.rollback &&
    target.steps.map((step) => step.id).join("\0") === adapter.steps.join("\0")
  );
}

/** Plan by default; execute and journal explicitly, with idempotent receipt-based resume. */
export async function runPublicationSaga(
  projectDirectory: string,
  artifacts: SkillPackageArtifacts & { readonly sourceCommit: string },
  inputAdapters: readonly PublicationAdapter[],
  options: PublicationSagaOptions = {},
): Promise<PublicationReceipt> {
  const root = await realpath(resolve(projectDirectory));
  const config = await loadProjectConfig(root);
  const adapters = adapterSnapshot(inputAdapters);
  const requested = config.publish.targets;
  if (
    adapters.length !== requested.length ||
    adapters.some((adapter) => !requested.includes(adapter.id as never))
  ) {
    throw new PublicationSagaError("Publication adapters do not match requested targets.", [
      issue(
        "publish.targets.mismatch",
        "/adapters",
        "provide exactly one adapter per configured target",
      ),
    ]);
  }
  const idempotencyKey = digest(
    `${JSON.stringify({
      sourceCommit: artifacts.sourceCommit,
      version: config.project.version,
      artifactSha256: artifacts.artifactSha256,
      adapters: adapters.map(adapterBinding),
    })}\n`,
  );
  const context: PublicationContext = Object.freeze({
    root,
    project: Object.freeze({
      name: config.project.name,
      version: config.project.version,
      repository: config.project.repository,
    }),
    sourceCommit: artifacts.sourceCommit,
    artifactSha256: artifacts.artifactSha256,
    artifactsPath: artifacts.artifactsPath,
    artifacts: Object.freeze({
      skillArchive: Object.freeze({
        name: artifacts.skillArchive,
        sha256: artifacts.artifactSha256,
        bytes: artifacts.artifactBytes,
      }),
      zipArchive: Object.freeze({
        name: artifacts.zipArchive,
        sha256: artifacts.artifactSha256,
        bytes: artifacts.artifactBytes,
      }),
      checksums: Object.freeze({
        name: artifacts.checksums,
        sha256: artifacts.checksumsSha256,
        bytes: artifacts.checksumsBytes,
      }),
      provenance: Object.freeze({
        name: artifacts.provenance,
        sha256: artifacts.provenanceSha256,
        bytes: artifacts.provenanceBytes,
      }),
    }),
    idempotencyKey,
  });
  const now = options.now ?? (() => new Date());
  let receipt: PublicationReceipt;
  if (options.resumeReceiptPath !== undefined) {
    if (!options.execute) {
      throw new PublicationSagaError("Resume requires explicit execution.", [
        issue("publish.resume.execute", "/resume", "set execute when resuming mutations"),
      ]);
    }
    receipt = await loadReceipt(root, options.resumeReceiptPath);
    if (
      receipt.idempotencyKey !== idempotencyKey ||
      receipt.sourceCommit !== artifacts.sourceCommit ||
      receipt.artifactSha256 !== artifacts.artifactSha256 ||
      receipt.projectVersion !== config.project.version ||
      receipt.execute !== true ||
      receipt.storagePath !== options.resumeReceiptPath ||
      receipt.targets.length !== adapters.length ||
      receipt.targets.some(
        (target, index) =>
          !receiptTargetMatchesAdapter(target, adapters[index] as PublicationAdapter),
      )
    ) {
      throw new PublicationSagaError("Resume receipt does not match current publication.", [
        issue("publish.resume.binding", "/resume", "receipt bindings and target order must match"),
      ]);
    }
    let resumeBlocked = false;
    for (let index = 0; index < adapters.length; index += 1) {
      const adapter = adapters[index] as PublicationAdapter;
      const target = receipt.targets[index] as PublicationTargetReceipt;
      if (target.status === "verified" || target.status === "derived") continue;
      target.preflight = await adapter.preflight(context);
      if (!target.preflight.ok) {
        target.status = "preflight_failed";
        resumeBlocked = true;
      }
    }
    if (resumeBlocked) {
      receipt.status = "blocked";
      receipt.updatedAt = now().toISOString();
      await persist(root, receipt);
      return freeze(structuredClone(receipt));
    }
  } else {
    const timestamp = now().toISOString();
    const runId = randomBytes(32).toString("hex");
    const targets: PublicationTargetReceipt[] = [];
    for (const adapter of adapters) {
      const preflight = await adapter.preflight(context);
      targets.push({
        id: adapter.id,
        capability: adapter.capability,
        auth: [...adapter.auth],
        rollback: adapter.rollback,
        preflight,
        status: preflight.ok ? "planned" : "preflight_failed",
        steps: adapter.steps.map((id) => ({ id, status: "pending" })),
      });
    }
    const blocked = targets.some((target) => !target.preflight.ok);
    receipt = {
      schemaVersion: 1,
      receiptType: "skillpress.publication",
      runId,
      idempotencyKey,
      sourceCommit: artifacts.sourceCommit,
      artifactSha256: artifacts.artifactSha256,
      projectVersion: config.project.version,
      execute: options.execute === true,
      status: options.execute === true ? (blocked ? "blocked" : "running") : "dry_run",
      createdAt: timestamp,
      updatedAt: timestamp,
      targets,
      storagePath: null,
    };
    if (!options.execute || blocked) return freeze(structuredClone(receipt));
    await publicationStorage(root, runId);
    receipt.storagePath = `.skillpress/publications/${runId}/receipt.json`;
    await persist(root, receipt);
  }
  receipt.status = "running";
  for (let index = 0; index < adapters.length; index += 1) {
    const adapter = adapters[index] as PublicationAdapter;
    const target = receipt.targets[index] as PublicationTargetReceipt;
    if (target.status === "verified" || target.status === "derived") continue;
    if (adapter.capability === "derived") {
      const verification = await adapter.verify(context);
      target.status = "derived";
      if (verification.remoteId !== undefined) target.remoteId = verification.remoteId;
      if (verification.url !== undefined) target.url = verification.url;
      receipt.updatedAt = now().toISOString();
      await persist(root, receipt);
      continue;
    }
    target.status = "running";
    try {
      for (const step of target.steps) {
        if (step.status === "completed") continue;
        const result = await (adapter.execute as NonNullable<PublicationAdapter["execute"]>)(
          context,
          step.id,
        );
        step.status = "completed";
        if (result.remoteId !== undefined) step.remoteId = result.remoteId;
        if (result.url !== undefined) step.url = result.url;
        receipt.updatedAt = now().toISOString();
        await persist(root, receipt);
      }
      const verification = await adapter.verify(context);
      if (!verification.ok) throw new Error("verification failed");
      target.status = "verified";
      if (verification.remoteId !== undefined) target.remoteId = verification.remoteId;
      if (verification.url !== undefined) target.url = verification.url;
    } catch {
      target.status = "failed";
      target.errorCode = "adapter_failed";
      receipt.status = "failed";
      receipt.updatedAt = now().toISOString();
      await persist(root, receipt);
      return freeze(structuredClone(receipt));
    }
    receipt.updatedAt = now().toISOString();
    await persist(root, receipt);
  }
  receipt.status = "completed";
  receipt.updatedAt = now().toISOString();
  await persist(root, receipt);
  return freeze(structuredClone(receipt));
}
