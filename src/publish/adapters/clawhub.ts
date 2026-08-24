import { createHash } from "node:crypto";

import type { CapturedCommandResult } from "../../process/capture.js";
import { projectClawHubSkill } from "../projection.js";
import type {
  PublicationAdapter,
  PublicationContext,
  PublicationPreflight,
  PublicationVerification,
} from "../saga.js";
import { passed, type PublicationAdapterRuntime, runProviderCommand, text } from "./command.js";

export interface ClawHubPublicationAdapterOptions extends PublicationAdapterRuntime {
  readonly owner: string;
  readonly licenseConsent: "MIT-0";
  readonly executable?: string;
  readonly verificationAttempts?: number;
  readonly verificationIntervalMs?: number;
}

interface PublishPlan {
  readonly fingerprint: string;
  readonly fileCount: number;
}

type Inspection =
  | { readonly status: "absent" | "conflict" | "pending" | "rejected" | "unavailable" }
  | { readonly status: "match"; readonly remoteId: string; readonly url: string };

const OWNER = /^[a-z\d](?:[a-z\d._-]{0,62}[a-z\d])?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MINIMUM_CLI = [0, 23, 3] as const;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function jsonOutput(result: CapturedCommandResult): Readonly<Record<string, unknown>> | null {
  try {
    return record(JSON.parse(text(result)));
  } catch {
    return null;
  }
}

function supportedVersion(value: string): boolean {
  const match = /^(\d+)[.](\d+)[.](\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(value);
  if (match === null) return false;
  const actual = match.slice(1, 4).map(Number);
  for (let index = 0; index < MINIMUM_CLI.length; index += 1) {
    if (actual[index] !== MINIMUM_CLI[index]) {
      return (actual[index] as number) > (MINIMUM_CLI[index] as number);
    }
  }
  return true;
}

function clawHubEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(process.env.CLAWHUB_CONFIG_PATH === undefined
      ? {}
      : { CLAWHUB_CONFIG_PATH: process.env.CLAWHUB_CONFIG_PATH }),
    ...(process.env.CLAWDHUB_CONFIG_PATH === undefined
      ? {}
      : { CLAWDHUB_CONFIG_PATH: process.env.CLAWDHUB_CONFIG_PATH }),
    NO_COLOR: "1",
  });
}

function runClawHub(
  context: PublicationContext,
  executable: string,
  argv: readonly string[],
  runtime: PublicationAdapterRuntime,
) {
  return runProviderCommand(
    context.root,
    [executable, "--no-input", ...argv],
    runtime,
    clawHubEnvironment(),
  );
}

function publicationArguments(
  context: PublicationContext,
  owner: string,
  projectedRoot: string,
  dryRun: boolean,
): readonly string[] {
  return [
    "skill",
    "publish",
    projectedRoot,
    "--slug",
    context.skill.name,
    "--name",
    context.project.name,
    "--owner",
    owner,
    "--version",
    context.project.version,
    "--changelog",
    `SkillPress ${context.project.version}`,
    "--tags",
    "latest",
    "--source-repo",
    context.project.repository,
    "--source-commit",
    context.sourceCommit,
    "--source-ref",
    context.sourceCommit,
    "--source-path",
    context.skill.path,
    ...(dryRun ? ["--dry-run"] : []),
    "--json",
  ];
}

function outputMatchesPublication(
  value: Readonly<Record<string, unknown>> | null,
  context: PublicationContext,
  projectedRoot: string,
): value is Readonly<Record<string, unknown>> & {
  readonly fingerprint: string;
  readonly fileCount: number;
} {
  return (
    value?.ok === true &&
    value.slug === context.skill.name &&
    value.displayName === context.project.name &&
    value.folder === projectedRoot &&
    value.version === context.project.version &&
    Number.isSafeInteger(value.fileCount) &&
    (value.fileCount as number) > 0 &&
    typeof value.fingerprint === "string" &&
    SHA256.test(value.fingerprint)
  );
}

async function publishPlan(
  context: PublicationContext,
  owner: string,
  executable: string,
  runtime: PublicationAdapterRuntime,
): Promise<PublishPlan | null> {
  let projected: Awaited<ReturnType<typeof projectClawHubSkill>>;
  try {
    projected = await projectClawHubSkill(context);
  } catch {
    return null;
  }
  const result = await runClawHub(
    context,
    executable,
    publicationArguments(context, owner, projected.root, true),
    runtime,
  );
  const value = jsonOutput(result);
  return passed(result) &&
    outputMatchesPublication(value, context, projected.root) &&
    value.status === "would-publish"
    ? Object.freeze({ fingerprint: value.fingerprint, fileCount: value.fileCount })
    : null;
}

function manifestFingerprint(value: unknown, expectedCount: number): string | null {
  if (!Array.isArray(value)) return null;
  const paths = new Set<string>();
  const files: Array<{ readonly path: string; readonly sha256: string }> = [];
  for (const item of value) {
    const file = record(item);
    if (file?.path === "skill-card.md") continue;
    if (
      typeof file?.path !== "string" ||
      file.path.length === 0 ||
      file.path.startsWith("/") ||
      file.path.split("/").includes("..") ||
      paths.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 0 ||
      typeof file.sha256 !== "string" ||
      !SHA256.test(file.sha256)
    ) {
      return null;
    }
    paths.add(file.path);
    files.push({ path: file.path, sha256: file.sha256 });
  }
  if (files.length !== expectedCount) return null;
  files.sort((left, right) => left.path.localeCompare(right.path));
  return createHash("sha256")
    .update(files.map((file) => `${file.path}:${file.sha256}`).join("\n"))
    .digest("hex");
}

function absentOutput(result: CapturedCommandResult): boolean {
  const combined = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`;
  return /(?:HTTP 404|Skill not found|Version not found)/iu.test(combined);
}

async function inspectClawHub(
  context: PublicationContext,
  owner: string,
  executable: string,
  plan: PublishPlan,
  runtime: PublicationAdapterRuntime,
): Promise<Inspection> {
  const result = await runClawHub(
    context,
    executable,
    [
      "inspect",
      `@${owner}/${context.skill.name}`,
      "--version",
      context.project.version,
      "--files",
      "--json",
    ],
    runtime,
  );
  const value = jsonOutput(result);
  if (!passed(result) || value === null) {
    return Object.freeze({ status: absentOutput(result) ? "absent" : "unavailable" });
  }
  const skill = record(value.skill);
  const version = record(value.version);
  const publisher = record(value.owner);
  if (
    skill?.slug !== context.skill.name ||
    skill.displayName !== context.project.name ||
    publisher?.handle !== owner ||
    version?.version !== context.project.version ||
    version.license !== "MIT-0" ||
    manifestFingerprint(version.files, plan.fileCount) !== plan.fingerprint
  ) {
    return Object.freeze({ status: "conflict" });
  }
  const moderation = record(value.moderation);
  if (
    moderation?.isSuspicious === true ||
    moderation?.isMalwareBlocked === true ||
    moderation?.verdict === "suspicious" ||
    moderation?.verdict === "malicious"
  ) {
    return Object.freeze({ status: "rejected" });
  }
  const security = record(version.security);
  if (
    security?.status === "pending" ||
    security?.status === "queued" ||
    security?.status === "running"
  ) {
    return Object.freeze({ status: "pending" });
  }
  if (
    security?.status !== "clean" ||
    security.passed === false ||
    security.hasWarnings === true ||
    (security.passed !== true && security.hasWarnings !== false)
  ) {
    return Object.freeze({ status: "rejected" });
  }
  return Object.freeze({
    status: "match",
    remoteId: `@${owner}/${context.skill.name}@${context.project.version}`,
    url: `https://clawhub.ai/${owner}/skills/${context.skill.name}`,
  });
}

async function identityMatches(
  context: PublicationContext,
  owner: string,
  executable: string,
  runtime: PublicationAdapterRuntime,
): Promise<boolean> {
  const result = await runClawHub(context, executable, ["whoami"], runtime);
  return (
    passed(result) &&
    new RegExp(`^(?:OK[.] )?@?${owner.replaceAll(".", "\\.")}[.]?$`, "iu").test(text(result))
  );
}

/** Publish a complete target projection only after explicit consent to ClawHub's MIT-0 terms. */
export function createClawHubPublicationAdapter(
  options: ClawHubPublicationAdapterOptions,
): PublicationAdapter {
  const owner = options.owner.toLowerCase();
  if (!OWNER.test(owner)) throw new TypeError("ClawHub owner must be a canonical handle");
  if (options.licenseConsent !== "MIT-0") {
    throw new TypeError("ClawHub publication requires explicit MIT-0 license consent");
  }
  const executable = options.executable ?? "clawhub";
  if (executable.length === 0) throw new TypeError("ClawHub executable is required");
  const verificationAttempts = options.verificationAttempts ?? 60;
  const verificationIntervalMs = options.verificationIntervalMs ?? 5_000;
  if (
    !Number.isSafeInteger(verificationAttempts) ||
    verificationAttempts < 1 ||
    verificationAttempts > 120
  ) {
    throw new TypeError("ClawHub verification attempts must be between 1 and 120");
  }
  if (
    !Number.isSafeInteger(verificationIntervalMs) ||
    verificationIntervalMs < 0 ||
    verificationIntervalMs > 30_000
  ) {
    throw new TypeError("ClawHub verification interval must be between 0 and 30000ms");
  }
  const runtime: PublicationAdapterRuntime = Object.freeze({
    ...(options.executor === undefined ? {} : { executor: options.executor }),
    ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
  });

  return Object.freeze({
    id: "clawhub",
    capability: "publish",
    auth: Object.freeze(["CLAWHUB_LOGIN", "CLAWHUB_MIT0_CONSENT"]),
    rollback:
      "withdraw the ClawHub version manually; its MIT-0 grant and version remain irreversible",
    steps: Object.freeze(["publish-skill"]),
    preflight: async (context: PublicationContext): Promise<PublicationPreflight> => {
      try {
        await projectClawHubSkill(context);
      } catch {
        return Object.freeze({
          ok: false,
          code: "projection_invalid",
          message: "ClawHub MIT-0 projection is not safely bound to the packaged skill",
        });
      }
      const version = await runClawHub(context, executable, ["--cli-version"], runtime);
      if (!passed(version) || !supportedVersion(text(version))) {
        return Object.freeze({
          ok: false,
          code: "cli_unsupported",
          message: "official ClawHub CLI 0.23.3 or newer is required",
        });
      }
      const plan = await publishPlan(context, owner, executable, runtime);
      if (plan === null) {
        return Object.freeze({
          ok: false,
          code: "projection_rejected",
          message: "official ClawHub dry run rejected or changed the target projection",
        });
      }
      const existing = await inspectClawHub(context, owner, executable, plan, runtime);
      if (existing.status === "match" || existing.status === "pending") {
        return Object.freeze({
          ok: true,
          code: "ready",
          message:
            existing.status === "match"
              ? "ClawHub version already passed security verification"
              : "exact ClawHub version is awaiting security verification",
        });
      }
      if (existing.status === "conflict" || existing.status === "rejected") {
        return Object.freeze({
          ok: false,
          code: existing.status === "conflict" ? "version_conflict" : "security_rejected",
          message: "ClawHub version conflicts with this release or failed security review",
        });
      }
      if (existing.status === "unavailable") {
        return Object.freeze({
          ok: false,
          code: "provider_unavailable",
          message: "ClawHub could not distinguish absence from a provider failure",
        });
      }
      return (await identityMatches(context, owner, executable, runtime))
        ? Object.freeze({
            ok: true,
            code: "ready",
            message: "ClawHub publication is ready with explicit MIT-0 consent",
          })
        : Object.freeze({
            ok: false,
            code: "auth_missing",
            message: `run clawhub login for @${owner} before publication`,
          });
    },
    execute: async (context: PublicationContext, step: string) => {
      if (step !== "publish-skill") throw new Error("Unknown ClawHub publication step");
      const projected = await projectClawHubSkill(context);
      const plan = await publishPlan(context, owner, executable, runtime);
      if (plan === null) throw new Error("ClawHub projection changed or failed its dry run");
      const existing = await inspectClawHub(context, owner, executable, plan, runtime);
      if (existing.status === "match") {
        return Object.freeze({ remoteId: existing.remoteId, url: existing.url });
      }
      if (existing.status === "pending") {
        return Object.freeze({
          remoteId: `@${owner}/${context.skill.name}@${context.project.version}`,
          url: `https://clawhub.ai/${owner}/skills/${context.skill.name}`,
        });
      }
      if (existing.status !== "absent") {
        throw new Error("ClawHub remote version is unavailable, conflicting, or rejected");
      }
      const version = await runClawHub(context, executable, ["--cli-version"], runtime);
      if (!passed(version) || !supportedVersion(text(version))) {
        throw new Error("ClawHub CLI changed after preflight");
      }
      if (!(await identityMatches(context, owner, executable, runtime))) {
        throw new Error("ClawHub publisher identity changed after preflight");
      }
      const result = await runClawHub(
        context,
        executable,
        publicationArguments(context, owner, projected.root, false),
        runtime,
      );
      const value = jsonOutput(result);
      if (
        !passed(result) ||
        !outputMatchesPublication(value, context, projected.root) ||
        value.fingerprint !== plan.fingerprint ||
        value.fileCount !== plan.fileCount ||
        (value.status !== "published" &&
          value.status !== "pending-publication" &&
          value.status !== "submitted")
      ) {
        throw new Error("ClawHub publication failed or returned an unexpected identity");
      }
      return Object.freeze({
        remoteId: `@${owner}/${context.skill.name}@${context.project.version}`,
        url: `https://clawhub.ai/${owner}/skills/${context.skill.name}`,
      });
    },
    verify: async (context: PublicationContext): Promise<PublicationVerification> => {
      const plan = await publishPlan(context, owner, executable, runtime);
      if (plan === null) return Object.freeze({ ok: false });
      for (let attempt = 0; attempt < verificationAttempts; attempt += 1) {
        const inspected = await inspectClawHub(context, owner, executable, plan, runtime);
        if (inspected.status === "match") {
          return Object.freeze({
            ok: true,
            remoteId: inspected.remoteId,
            url: inspected.url,
          });
        }
        if (inspected.status !== "pending") return Object.freeze({ ok: false });
        if (attempt + 1 < verificationAttempts && verificationIntervalMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, verificationIntervalMs));
        }
      }
      return Object.freeze({ ok: false });
    },
  });
}
