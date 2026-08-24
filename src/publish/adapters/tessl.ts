import { createHash } from "node:crypto";
import { constants, createReadStream, type Dirent } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import type { CapturedCommandResult } from "../../process/capture.js";
import { isTrustedTesslCli } from "../../tessl/trusted-cli.js";
import type {
  PublicationAdapter,
  PublicationContext,
  PublicationPreflight,
  PublicationVerification,
} from "../saga.js";
import { projectTesslPlugin } from "../projection.js";
import {
  jsonRecord,
  passed,
  type PublicationAdapterRuntime,
  runProviderCommand,
  text,
} from "./command.js";

export interface TesslPublicationAdapterOptions extends PublicationAdapterRuntime {
  readonly workspace: string;
  readonly executable?: string;
  readonly executableSha256?: string;
  readonly token?: string;
}

interface PackageFile {
  readonly bytes: Buffer;
  readonly executable: boolean;
}

type Inspection =
  | { readonly status: "absent" | "conflict" | "unavailable" }
  | { readonly status: "match"; readonly remoteId: string; readonly url: string };

const WORKSPACE = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u;
const CLI_VERSION = "0.99.0";
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 512;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function cleanTarString(bytes: Buffer): string {
  const zero = bytes.indexOf(0);
  return bytes.subarray(0, zero === -1 ? bytes.byteLength : zero).toString("utf8");
}

function tarNumber(bytes: Buffer): number | null {
  const value = cleanTarString(bytes).trim();
  if (!/^[0-7]+$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 8);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function safeArchivePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function tarChecksum(header: Buffer): boolean {
  const expected = tarNumber(header.subarray(148, 156));
  if (expected === null) return false;
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] as number);
  }
  return actual === expected;
}

function unpackArchive(bytes: Buffer): ReadonlyMap<string, PackageFile> | null {
  let archive: Buffer;
  try {
    archive = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    return null;
  }
  const files = new Map<string, PackageFile>();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    if (!tarChecksum(header)) return null;
    const name = cleanTarString(header.subarray(0, 100));
    const prefix = cleanTarString(header.subarray(345, 500));
    const path = prefix.length === 0 ? name : `${prefix}/${name}`;
    const mode = tarNumber(header.subarray(100, 108));
    const size = tarNumber(header.subarray(124, 136));
    const type = header[156] as number;
    if (
      !safeArchivePath(path) ||
      mode === null ||
      size === null ||
      size > MAX_UNPACKED_BYTES ||
      offset + size > archive.byteLength
    ) {
      return null;
    }
    if (type === 0 || type === 0x30) {
      if (files.size >= MAX_FILES || files.has(path)) return null;
      files.set(path, {
        bytes: Buffer.from(archive.subarray(offset, offset + size)),
        executable: (mode & 0o111) !== 0,
      });
    } else if (type !== 0x35 || size !== 0) {
      return null;
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended || files.size === 0 || archive.subarray(offset).some((byte) => byte !== 0)) {
    return null;
  }
  return files;
}

async function collectFiles(
  root: string,
  directory: string,
  files: Map<string, PackageFile>,
): Promise<boolean> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(join(root, directory), { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const path = directory.length === 0 ? entry.name : `${directory}/${entry.name}`;
    const absolute = join(root, ...path.split("/"));
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(absolute);
    } catch {
      return false;
    }
    if (metadata.isSymbolicLink()) return false;
    if (metadata.isDirectory()) {
      if (!(await collectFiles(root, path, files))) return false;
      continue;
    }
    if (!metadata.isFile() || files.size >= MAX_FILES) return false;
    try {
      files.set(path, {
        bytes: await readFile(absolute),
        executable: (metadata.mode & 0o111) !== 0,
      });
    } catch {
      return false;
    }
  }
  return true;
}

function sameFiles(
  expected: ReadonlyMap<string, PackageFile>,
  actual: ReadonlyMap<string, PackageFile>,
): boolean {
  return (
    expected.size === actual.size &&
    [...expected].every(([path, file]) => {
      const candidate = actual.get(path);
      return (
        candidate !== undefined &&
        candidate.executable === file.executable &&
        candidate.bytes.equals(file.bytes)
      );
    })
  );
}

function notFound(result: CapturedCommandResult): boolean {
  if (passed(result)) return false;
  try {
    const value: unknown = JSON.parse(result.stdout.toString("utf8"));
    return record(record(value)?.error)?.status === 404;
  } catch {
    return false;
  }
}

function tesslEnvironment(
  token: string | undefined,
  authenticated: boolean,
): Readonly<Record<string, string>> {
  return Object.freeze({
    NO_COLOR: "1",
    TESSL_AUTO_UPDATE_INTERVAL_MINUTES: "0",
    ...(authenticated && token !== undefined ? { TESSL_TOKEN: token } : {}),
  });
}

function runTessl(
  context: PublicationContext,
  executable: string,
  argv: readonly string[],
  token: string | undefined,
  authenticated: boolean,
  runtime: PublicationAdapterRuntime,
) {
  return runProviderCommand(
    context.root,
    [executable, ...argv],
    runtime,
    tesslEnvironment(token, authenticated),
  );
}

function remote(context: PublicationContext, workspace: string) {
  const remoteId = `${workspace}/${context.skill.name}@${context.project.version}`;
  return Object.freeze({
    remoteId,
    url: `https://tessl.io/registry/${workspace}/${context.skill.name}/${context.project.version}`,
  });
}

function archiveEndpoint(context: PublicationContext, workspace: string): string {
  return `/v1/tiles/${encodeURIComponent(workspace)}/${encodeURIComponent(
    context.skill.name,
  )}/versions/${encodeURIComponent(context.project.version)}/files`;
}

async function inspect(
  context: PublicationContext,
  workspace: string,
  executable: string,
  runtime: PublicationAdapterRuntime,
): Promise<Inspection> {
  let projected: Awaited<ReturnType<typeof projectTesslPlugin>>;
  try {
    projected = await projectTesslPlugin(context, workspace);
  } catch {
    return Object.freeze({ status: "unavailable" });
  }
  const result = await runTessl(
    context,
    executable,
    ["api", "--raw", "--header", "accept:application/gzip", archiveEndpoint(context, workspace)],
    undefined,
    false,
    runtime,
  );
  if (notFound(result)) return Object.freeze({ status: "absent" });
  if (!passed(result)) return Object.freeze({ status: "unavailable" });
  const expected = new Map<string, PackageFile>();
  if (!(await collectFiles(projected.root, "", expected))) {
    return Object.freeze({ status: "unavailable" });
  }
  const actual = unpackArchive(result.stdout);
  if (actual === null || !sameFiles(expected, actual)) {
    return Object.freeze({ status: "conflict" });
  }
  return Object.freeze({ status: "match", ...remote(context, workspace) });
}

function authenticatedIdentity(result: CapturedCommandResult, workspace: string): boolean {
  const identity = jsonRecord(result);
  const key = record(identity?.key);
  if (
    identity?.authenticated !== true ||
    identity.method !== "api-key" ||
    identity.source !== "TESSL_TOKEN" ||
    key === null ||
    (key.scope !== "workspace" && key.scope !== "org")
  ) {
    return false;
  }
  const keyWorkspace = record(key.workspace);
  return key.scope === "org" || keyWorkspace?.name === workspace;
}

function dryRunPassed(result: CapturedCommandResult): boolean {
  return (
    passed(result) &&
    Buffer.concat([result.stdout, result.stderr])
      .toString("utf8")
      .includes("Dry run complete — all pre-publish checks passed")
  );
}

async function supportedCli(
  context: PublicationContext,
  executable: string,
  executableSha256: string | undefined,
  runtime: PublicationAdapterRuntime,
): Promise<boolean> {
  const result = await runTessl(context, executable, ["--version"], undefined, false, runtime);
  if (!passed(result) || text(result) !== CLI_VERSION) return false;
  let digest = executableSha256;
  if (digest === undefined) {
    const candidates =
      executable.includes("/") || executable.includes("\\")
        ? [resolve(context.root, executable)]
        : (process.env.PATH ?? "")
            .split(delimiter)
            .filter((entry) => entry.length > 0)
            .map((entry) => join(entry, executable));
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        const path = await realpath(candidate);
        const metadata = await lstat(path);
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          metadata.size > MAX_EXECUTABLE_BYTES
        ) {
          continue;
        }
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
        digest = hash.digest("hex");
        break;
      } catch {
        // Try the next explicit PATH entry.
      }
    }
  }
  return digest !== undefined && isTrustedTesslCli(CLI_VERSION, digest);
}

async function preflight(
  context: PublicationContext,
  workspace: string,
  executable: string,
  executableSha256: string | undefined,
  token: string | undefined,
  runtime: PublicationAdapterRuntime,
): Promise<PublicationPreflight> {
  if (!(await supportedCli(context, executable, executableSha256, runtime))) {
    return Object.freeze({
      ok: false,
      code: "cli_unsupported",
      message: `official Tessl CLI ${CLI_VERSION} is required`,
    });
  }
  const existing = await inspect(context, workspace, executable, runtime);
  if (existing.status === "match") {
    return Object.freeze({ ok: true, code: "ready", message: "Tessl version already verified" });
  }
  if (existing.status === "conflict") {
    return Object.freeze({
      ok: false,
      code: "version_conflict",
      message: "Tessl immutable version content conflicts with this release",
    });
  }
  if (existing.status === "unavailable") {
    return Object.freeze({
      ok: false,
      code: "provider_unavailable",
      message: "Tessl could not verify the requested public plugin version",
    });
  }
  if (token === undefined) {
    return Object.freeze({
      ok: false,
      code: "auth_missing",
      message: "TESSL_TOKEN is required for Tessl publication",
    });
  }
  const identity = await runTessl(
    context,
    executable,
    ["auth", "whoami", "--json"],
    token,
    true,
    runtime,
  );
  if (!authenticatedIdentity(identity, workspace)) {
    return Object.freeze({
      ok: false,
      code: "auth_invalid",
      message: "Tessl API key identity or workspace scope is invalid",
    });
  }
  let projected: Awaited<ReturnType<typeof projectTesslPlugin>>;
  try {
    projected = await projectTesslPlugin(context, workspace);
  } catch {
    return Object.freeze({
      ok: false,
      code: "projection_invalid",
      message: "Tessl projection is not bound to the packaged canonical skill",
    });
  }
  const dryRun = await runTessl(
    context,
    executable,
    ["plugin", "publish", "--dry-run", "--skip-evals", "--verbose", projected.root],
    token,
    true,
    runtime,
  );
  return dryRunPassed(dryRun)
    ? Object.freeze({ ok: true, code: "ready", message: "Tessl publication is ready" })
    : Object.freeze({
        ok: false,
        code: "approval_or_validation_required",
        message: "Tessl dry run requires a publishable workspace and public approval",
      });
}

/** Publish and exactly verify a public Tessl plugin through the pinned official CLI. */
export function createTesslPublicationAdapter(
  options: TesslPublicationAdapterOptions,
): PublicationAdapter {
  const workspace = options.workspace;
  if (!WORKSPACE.test(workspace)) {
    throw new TypeError("Tessl workspace must be a canonical lowercase name");
  }
  const executable = options.executable ?? "tessl";
  if (executable.length === 0) throw new TypeError("Tessl executable is required");
  const executableSha256 = options.executableSha256;
  if (executableSha256 !== undefined && !SHA256.test(executableSha256)) {
    throw new TypeError("Tessl executable SHA-256 must be a lowercase digest");
  }
  const token = options.token ?? process.env.TESSL_TOKEN;
  if (token !== undefined && (token.length === 0 || token.trim() !== token)) {
    throw new TypeError("Tessl token must be non-empty and whitespace-stable");
  }
  const runtime: PublicationAdapterRuntime = Object.freeze({
    ...(options.executor === undefined ? {} : { executor: options.executor }),
    ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
  });
  return Object.freeze({
    id: "tessl",
    capability: "publish",
    auth: Object.freeze(["TESSL_TOKEN"]),
    rollback:
      "public Tessl plugins cannot become private; unpublish is limited to two days, then archive manually",
    steps: Object.freeze(["publish-plugin"]),
    preflight: (context: PublicationContext) =>
      preflight(context, workspace, executable, executableSha256, token, runtime),
    execute: async (context: PublicationContext, step: string) => {
      if (step !== "publish-plugin") throw new Error(`Unknown Tessl publication step: ${step}`);
      const ready = await preflight(
        context,
        workspace,
        executable,
        executableSha256,
        token,
        runtime,
      );
      if (!ready.ok) throw new Error(`Tessl publication preflight failed: ${ready.code}`);
      const existing = await inspect(context, workspace, executable, runtime);
      if (existing.status === "match") {
        return Object.freeze({ remoteId: existing.remoteId, url: existing.url });
      }
      if (existing.status !== "absent" || token === undefined) {
        throw new Error("Tessl publication state changed after preflight");
      }
      const projected = await projectTesslPlugin(context, workspace);
      const published = await runTessl(
        context,
        executable,
        ["plugin", "publish", "--skip-evals", projected.root],
        token,
        true,
        runtime,
      );
      const expected = remote(context, workspace);
      const output = Buffer.concat([published.stdout, published.stderr]).toString("utf8");
      if (
        !passed(published) ||
        !output.includes(`Published ${expected.remoteId} to ${expected.url}`)
      ) {
        throw new Error("Tessl did not confirm the exact public plugin version");
      }
      return expected;
    },
    verify: async (context: PublicationContext): Promise<PublicationVerification> => {
      if (!(await supportedCli(context, executable, executableSha256, runtime))) {
        return Object.freeze({ ok: false });
      }
      const existing = await inspect(context, workspace, executable, runtime);
      return existing.status === "match"
        ? Object.freeze({ ok: true, remoteId: existing.remoteId, url: existing.url })
        : Object.freeze({ ok: false });
    },
  });
}
