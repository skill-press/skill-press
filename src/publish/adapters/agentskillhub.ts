import type { CapturedCommandResult } from "../../process/capture.js";
import { readBoundCanonicalSkill } from "../projection.js";
import type {
  PublicationAdapter,
  PublicationContext,
  PublicationPreflight,
  PublicationVerification,
} from "../saga.js";
import { type PublicationAdapterRuntime, runProviderCommand, runProviderHttp } from "./command.js";

export interface AgentSkillHubPublicationAdapterOptions extends PublicationAdapterRuntime {
  readonly pollAttempts?: number;
  readonly pollIntervalMs?: number;
}

interface RepositoryIdentity {
  readonly owner: string;
  readonly name: string;
  readonly slug: string;
  readonly url: string;
}

type Inspection =
  | { readonly status: "absent" | "outdated" | "conflict" | "unavailable" }
  | { readonly status: "match"; readonly remoteId: string; readonly url: string };

const BASE_URL = "https://agentskillhub.dev";
const VERSION = /^\d{4}[.]\d{2}[.]\d{2}(?:[.]\d+)?$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const OWNER = /^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?$/u;
const REPOSITORY = /^[A-Za-z\d._-]{1,100}$/u;

function repository(input: string): RepositoryIdentity {
  const url = new URL(input);
  const parts = url.pathname
    .replace(/[.]git$/u, "")
    .split("/")
    .filter(Boolean);
  const [owner, name] = parts as [string | undefined, string | undefined];
  const canonical = `https://github.com/${owner}/${name}`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    parts.length !== 2 ||
    owner === undefined ||
    name === undefined ||
    !OWNER.test(owner) ||
    !REPOSITORY.test(name) ||
    (input !== canonical && input !== `${canonical}.git`)
  ) {
    throw new TypeError("Agent Skill Hub requires a canonical public GitHub repository URL");
  }
  return Object.freeze({
    owner,
    name,
    slug: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function json(body: string): Readonly<Record<string, unknown>> | null {
  try {
    return record(JSON.parse(body));
  } catch {
    return null;
  }
}

function detailUrl(target: RepositoryIdentity, skill: string): string {
  return `${BASE_URL}/api/v1/u/${encodeURIComponent(target.owner)}/skills/${encodeURIComponent(skill)}`;
}

function api(path: string): string {
  return `${BASE_URL}/api/v1${path}`;
}

function gitManifest(result: CapturedCommandResult, skillPath: string): Map<string, string> | null {
  if (result.status !== "passed" || result.exitCode !== 0 || result.signal !== null) return null;
  const prefix = `${skillPath}/`;
  const entries = new Map<string, string>();
  const lines = result.stdout.subarray(0, -1).toString("utf8").split("\0");
  if (result.stdout.at(-1) !== 0 || lines.length === 0) return null;
  for (const line of lines) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) (\d+)\t(.+)$/u.exec(line);
    if (match === null || !(match[4] as string).startsWith(prefix)) return null;
    const path = (match[4] as string).slice(prefix.length);
    if (path.length === 0 || entries.has(path)) return null;
    entries.set(path, `${match[2]}:${match[3]}`);
  }
  return entries.size > 0 ? entries : null;
}

function remoteManifest(value: unknown): Map<string, string> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const entries = new Map<string, string>();
  for (const item of value) {
    const entry = record(item);
    if (
      entry === null ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      typeof entry.gitBlobSha !== "string" ||
      !SHA1.test(entry.gitBlobSha) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      entries.has(entry.path)
    ) {
      return null;
    }
    entries.set(entry.path, `${entry.gitBlobSha}:${entry.size}`);
  }
  return entries;
}

function manifestsMatch(left: Map<string, string>, right: Map<string, string>): boolean {
  return (
    left.size === right.size && [...left].every(([path, identity]) => right.get(path) === identity)
  );
}

async function inspect(
  context: PublicationContext,
  target: RepositoryIdentity,
  runtime: PublicationAdapterRuntime,
): Promise<Inspection> {
  let canonical: Awaited<ReturnType<typeof readBoundCanonicalSkill>>;
  try {
    canonical = await readBoundCanonicalSkill(context);
  } catch {
    return Object.freeze({ status: "conflict" });
  }
  const response = await runProviderHttp(
    { method: "GET", url: detailUrl(target, context.skill.name) },
    runtime,
  );
  if (response.status === 404) return Object.freeze({ status: "absent" });
  if (response.status !== 200) return Object.freeze({ status: "unavailable" });
  const root = json(response.body);
  const skill = record(root?.skill);
  const latest = record(root?.latestVersion);
  if (
    skill === null ||
    latest === null ||
    skill.ownerUsername !== target.owner ||
    skill.slug !== context.skill.name ||
    skill.displaySlug !== `${target.owner}/${context.skill.name}` ||
    skill.name !== context.skill.name ||
    skill.sourceType !== "github" ||
    skill.sourceIdentifier !== target.slug ||
    skill.skillPath !== context.skill.path ||
    skill.defaultBranch !== "main" ||
    typeof latest.version !== "string" ||
    !VERSION.test(latest.version) ||
    typeof latest.commitSha !== "string" ||
    !SHA1.test(latest.commitSha) ||
    typeof latest.skillMdRaw !== "string"
  ) {
    return Object.freeze({ status: "conflict" });
  }
  const local = gitManifest(
    await runProviderCommand(
      context.root,
      ["git", "ls-tree", "-r", "-z", "--long", context.sourceCommit, "--", context.skill.path],
      runtime,
    ),
    context.skill.path,
  );
  const remote = remoteManifest(latest.fileManifest);
  if (local === null) return Object.freeze({ status: "unavailable" });
  if (remote === null) return Object.freeze({ status: "conflict" });
  if (latest.skillMdRaw !== canonical.skillMarkdown || !manifestsMatch(local, remote)) {
    return Object.freeze({ status: "outdated" });
  }
  return Object.freeze({
    status: "match",
    remoteId: `${target.owner}/${context.skill.name}@${latest.version}`,
    url: detailUrl(target, context.skill.name),
  });
}

async function analyze(
  context: PublicationContext,
  target: RepositoryIdentity,
  runtime: PublicationAdapterRuntime,
): Promise<"ready" | "conflict" | "unavailable"> {
  const response = await runProviderHttp(
    {
      method: "POST",
      url: api("/repos/analyze"),
      headers: Object.freeze({ "Content-Type": "application/json" }),
      body: JSON.stringify({ url: target.url }),
    },
    runtime,
  );
  if (response.status !== 200) return "unavailable";
  const value = json(response.body);
  if (
    value === null ||
    value.repoFullName !== target.slug ||
    value.defaultBranch !== "main" ||
    !Array.isArray(value.skills)
  ) {
    return "conflict";
  }
  const matches = value.skills.map(record).filter((skill) => skill?.path === context.skill.path);
  if (matches.length !== 1) return "conflict";
  const skill = matches[0] as Readonly<Record<string, unknown>>;
  return skill.slug === context.skill.name &&
    skill.name === context.skill.name &&
    typeof skill.description === "string" &&
    skill.description.length > 0 &&
    typeof skill.alreadyImported === "boolean"
    ? "ready"
    : "conflict";
}

function importSucceeded(body: string): boolean {
  const value = json(body);
  if (value === null) return false;
  const groups = [value.imported, value.updated, value.reused];
  return (
    groups.every(Array.isArray) &&
    Array.isArray(value.failed) &&
    value.failed.length === 0 &&
    groups.reduce((total, group) => total + (group as unknown[]).length, 0) === 1
  );
}

async function pause(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** Import a public GitHub skill through Agent Skill Hub's documented public repository API. */
export function createAgentSkillHubPublicationAdapter(
  options: AgentSkillHubPublicationAdapterOptions = {},
): PublicationAdapter {
  const pollAttempts = options.pollAttempts ?? 6;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (
    !Number.isSafeInteger(pollAttempts) ||
    pollAttempts < 1 ||
    pollAttempts > 20 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    pollIntervalMs > 5_000
  ) {
    throw new TypeError("Agent Skill Hub polling policy is invalid");
  }
  const runtime: PublicationAdapterRuntime = Object.freeze({
    ...(options.executor === undefined ? {} : { executor: options.executor }),
    ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
  });
  return Object.freeze({
    id: "agentskillhub-dev",
    capability: "publish",
    auth: Object.freeze([]),
    rollback:
      "public imports are provider snapshots; removal must be requested from Agent Skill Hub",
    steps: Object.freeze(["import-skill"]),
    preflight: async (context: PublicationContext): Promise<PublicationPreflight> => {
      let target: RepositoryIdentity;
      try {
        target = repository(context.project.repository);
      } catch {
        return Object.freeze({
          ok: false,
          code: "repository_invalid",
          message: "Agent Skill Hub imports only canonical public GitHub repositories",
        });
      }
      const existing = await inspect(context, target, runtime);
      if (existing.status === "match") {
        return Object.freeze({
          ok: true,
          code: "ready",
          message: "Agent Skill Hub snapshot already verified",
        });
      }
      if (existing.status === "conflict" || existing.status === "unavailable") {
        return Object.freeze({
          ok: false,
          code: existing.status === "conflict" ? "listing_conflict" : "provider_unavailable",
          message:
            existing.status === "conflict"
              ? "Agent Skill Hub listing conflicts with the configured source"
              : "Agent Skill Hub detail endpoint is unavailable",
        });
      }
      const analyzed = await analyze(context, target, runtime);
      return analyzed === "ready"
        ? Object.freeze({
            ok: true,
            code: "ready",
            message: "Agent Skill Hub import is ready; execute explicitly to mutate the registry",
          })
        : Object.freeze({
            ok: false,
            code: analyzed === "conflict" ? "analysis_conflict" : "provider_unavailable",
            message:
              analyzed === "conflict"
                ? "Agent Skill Hub analysis did not find the exact configured skill"
                : "Agent Skill Hub analysis endpoint is unavailable",
          });
    },
    execute: async (context: PublicationContext, step: string) => {
      if (step !== "import-skill") throw new Error("Unknown Agent Skill Hub publication step");
      const target = repository(context.project.repository);
      const existing = await inspect(context, target, runtime);
      if (existing.status === "match") {
        return Object.freeze({ remoteId: existing.remoteId, url: existing.url });
      }
      if (existing.status !== "absent" && existing.status !== "outdated") {
        throw new Error("Agent Skill Hub remote state conflicts or is unavailable");
      }
      if ((await analyze(context, target, runtime)) !== "ready") {
        throw new Error("Agent Skill Hub analysis changed before import");
      }
      const imported = await runProviderHttp(
        {
          method: "POST",
          url: api("/repos/import"),
          headers: Object.freeze({ "Content-Type": "application/json" }),
          body: JSON.stringify({ repoFullName: target.slug, selectedPaths: [context.skill.path] }),
        },
        runtime,
      );
      if (imported.status !== 200 || !importSucceeded(imported.body)) {
        throw new Error("Agent Skill Hub import failed");
      }
      return Object.freeze({ remoteId: `${target.owner}/${context.skill.name}` });
    },
    verify: async (context: PublicationContext): Promise<PublicationVerification> => {
      let target: RepositoryIdentity;
      try {
        target = repository(context.project.repository);
      } catch {
        return Object.freeze({ ok: false });
      }
      for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
        const result = await inspect(context, target, runtime);
        if (result.status === "match") {
          return Object.freeze({ ok: true, remoteId: result.remoteId, url: result.url });
        }
        if (result.status === "conflict") break;
        if (attempt + 1 < pollAttempts) await pause(pollIntervalMs);
      }
      return Object.freeze({ ok: false });
    },
  });
}
