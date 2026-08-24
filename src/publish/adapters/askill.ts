import { join } from "node:path";

import type { CapturedCommandResult } from "../../process/capture.js";
import type {
  PublicationAdapter,
  PublicationContext,
  PublicationPreflight,
  PublicationVerification,
} from "../saga.js";
import { projectSkillFrontmatter } from "../projection.js";
import {
  passed,
  type PublicationAdapterRuntime,
  runProviderCommand,
  runProviderHttp,
  text,
} from "./command.js";

export interface AskillPublicationAdapterOptions extends PublicationAdapterRuntime {
  readonly author: string;
  readonly executable?: string;
}

const AUTHOR = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/u;
const VERSION = /^(\d+)[.](\d+)[.](\d+)(?:[-+][0-9A-Za-z.-]+)?$/u;
const API_BASE_URL = "https://askill.sh/api/v1";

type Inspection =
  | { readonly status: "absent" | "older" | "conflict" | "unavailable" }
  | { readonly status: "match"; readonly remoteId: string; readonly url: string };

function supportedVersion(value: string): boolean {
  const match = VERSION.exec(value);
  if (match === null) return false;
  const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number];
  return major > 0 || minor > 1 || (minor === 1 && patch >= 15);
}

function jsonOutput(result: CapturedCommandResult): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(text(result));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function compareSemver(left: string, right: string): number | null {
  const semver = /^(\d+)[.](\d+)[.](\d+)(?:-([0-9A-Za-z.-]+))?(?:[+][0-9A-Za-z.-]+)?$/u;
  const a = semver.exec(left);
  const b = semver.exec(right);
  if (a === null || b === null) return null;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  const aPre = a[4]?.split(".");
  const bPre = b[4]?.split(".");
  if (aPre === undefined || bPre === undefined) {
    return aPre === undefined ? (bPre === undefined ? 0 : 1) : -1;
  }
  for (let index = 0; index < Math.max(aPre.length, bPre.length); index += 1) {
    const aPart = aPre[index];
    const bPart = bPre[index];
    if (aPart === undefined || bPart === undefined) return aPart === undefined ? -1 : 1;
    if (aPart === bPart) continue;
    const aNumber = /^\d+$/u.test(aPart);
    const bNumber = /^\d+$/u.test(bPart);
    if (aNumber && bNumber) return Number(aPart) < Number(bPart) ? -1 : 1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

function skillRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Readonly<Record<string, unknown>>;
  const skill = root.skill;
  return root.ok === true && skill !== null && typeof skill === "object" && !Array.isArray(skill)
    ? (skill as Readonly<Record<string, unknown>>)
    : null;
}

function frontmatter(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function listingUrl(skill: Readonly<Record<string, unknown>>): string | null {
  if ((typeof skill.id !== "string" && typeof skill.id !== "number") || skill.id === "") {
    return null;
  }
  const expected = `https://askill.sh/skills/${encodeURIComponent(String(skill.id))}`;
  return skill.url === expected ? expected : null;
}

function runAskill(
  context: PublicationContext,
  executable: string,
  argv: readonly string[],
  runtime: PublicationAdapterRuntime,
) {
  return runProviderCommand(
    context.root,
    [executable, ...argv],
    runtime,
    Object.freeze({ NO_COLOR: "1" }),
  );
}

async function inspectAskill(
  context: PublicationContext,
  author: string,
  executable: string,
  runtime: PublicationAdapterRuntime,
): Promise<Inspection> {
  let projected: Awaited<ReturnType<typeof projectSkillFrontmatter>>;
  try {
    projected = await projectSkillFrontmatter(context, "askill-sh", {
      slug: context.skill.name,
      version: context.project.version,
    });
  } catch {
    return Object.freeze({ status: "unavailable" });
  }
  const canonical = `@${author}/${context.skill.name}`;
  const result = await runAskill(context, executable, ["info", canonical, "--json"], runtime);
  const info = jsonOutput(result);
  if (!passed(result)) {
    const error = frontmatter(info?.error);
    return Object.freeze({
      status: error?.code === "SKILL_NOT_FOUND" ? "absent" : "unavailable",
    });
  }
  const skill = skillRecord(info);
  const metadata = frontmatter(skill?.frontmatter);
  const url = skill === null ? null : listingUrl(skill);
  if (
    skill === null ||
    metadata === null ||
    url === null ||
    skill.name !== context.skill.name ||
    typeof skill.owner !== "string" ||
    skill.owner.toLowerCase() !== author ||
    typeof skill.version !== "string" ||
    metadata.name !== context.skill.name ||
    metadata.slug !== context.skill.name ||
    metadata.version !== skill.version
  ) {
    return Object.freeze({ status: "conflict" });
  }
  const versionOrder = compareSemver(skill.version, context.project.version);
  if (versionOrder === null || versionOrder > 0) {
    return Object.freeze({ status: "conflict" });
  }
  if (versionOrder < 0) {
    return Object.freeze({ status: "older" });
  }
  const raw = await runProviderHttp(
    {
      method: "GET",
      url: `${API_BASE_URL}/skills/${encodeURIComponent(canonical)}/raw`,
      headers: Object.freeze({ "User-Agent": "skillpress" }),
    },
    runtime,
  );
  if (raw.status !== 200) return Object.freeze({ status: "unavailable" });
  return raw.body === projected.skillMarkdown
    ? Object.freeze({
        status: "match",
        remoteId: `${canonical}@${context.project.version}`,
        url,
      })
    : Object.freeze({ status: "conflict" });
}

async function verifyAskill(
  context: PublicationContext,
  author: string,
  executable: string,
  runtime: PublicationAdapterRuntime,
): Promise<PublicationVerification> {
  const inspected = await inspectAskill(context, author, executable, runtime);
  return inspected.status === "match"
    ? Object.freeze({
        ok: true,
        remoteId: inspected.remoteId,
        url: inspected.url,
      })
    : Object.freeze({ ok: false });
}

/** Publish an immutable, target-only SKILL.md projection through the official askill CLI. */
export function createAskillPublicationAdapter(
  options: AskillPublicationAdapterOptions,
): PublicationAdapter {
  const author = options.author.toLowerCase();
  if (!AUTHOR.test(author)) throw new TypeError("askill author must be a canonical GitHub login");
  const executable = options.executable ?? "askill";
  if (executable.length === 0) throw new TypeError("askill executable is required");
  const runtime: PublicationAdapterRuntime = Object.freeze({
    ...(options.executor === undefined ? {} : { executor: options.executor }),
    ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
  });
  return Object.freeze({
    id: "askill-sh",
    capability: "publish",
    auth: Object.freeze(["ASKILL_LOGIN"]),
    rollback: "askill versions are immutable; provider removal or a later version is manual",
    steps: Object.freeze(["publish-skill"]),
    preflight: async (context: PublicationContext): Promise<PublicationPreflight> => {
      let projected: Awaited<ReturnType<typeof projectSkillFrontmatter>>;
      try {
        projected = await projectSkillFrontmatter(context, "askill-sh", {
          slug: context.skill.name,
          version: context.project.version,
        });
      } catch {
        return Object.freeze({
          ok: false,
          code: "projection_invalid",
          message: "askill projection is not bound to the packaged canonical skill",
        });
      }
      const existing = await inspectAskill(context, author, executable, runtime);
      if (existing.status === "match") {
        return Object.freeze({
          ok: true,
          code: "ready",
          message: "askill version already verified",
        });
      }
      if (existing.status === "conflict") {
        return Object.freeze({
          ok: false,
          code: "version_conflict",
          message: "askill identity or immutable version conflicts with the release",
        });
      }
      if (existing.status === "unavailable") {
        return Object.freeze({
          ok: false,
          code: "provider_unavailable",
          message: "askill could not distinguish an absent skill from a provider failure",
        });
      }
      const version = await runAskill(context, executable, ["--version"], runtime);
      if (!passed(version) || !supportedVersion(text(version))) {
        return Object.freeze({
          ok: false,
          code: "cli_unsupported",
          message: "official askill CLI 0.1.15 or newer is required",
        });
      }
      const identity = await runAskill(context, executable, ["whoami", "--json"], runtime);
      const identityMatch = /^@([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?) \(token: [^)]+\)$/iu.exec(
        text(identity),
      );
      if (
        !passed(identity) ||
        identityMatch === null ||
        identityMatch[1]?.toLowerCase() !== author
      ) {
        return Object.freeze({
          ok: false,
          code: "auth_missing",
          message: `run askill login for @${author} before local publication`,
        });
      }
      const validation = await runAskill(
        context,
        executable,
        ["validate", join(projected.root, "SKILL.md"), "--json"],
        runtime,
      );
      return passed(validation)
        ? Object.freeze({ ok: true, code: "ready", message: "askill publication is ready" })
        : Object.freeze({
            ok: false,
            code: "projection_rejected",
            message: "official askill validation rejected the target projection",
          });
    },
    execute: async (context: PublicationContext, step: string) => {
      if (step !== "publish-skill") throw new Error("Unknown askill publication step");
      const existing = await inspectAskill(context, author, executable, runtime);
      if (existing.status === "match") {
        return Object.freeze({ remoteId: existing.remoteId, url: existing.url });
      }
      if (existing.status !== "absent" && existing.status !== "older") {
        throw new Error("askill remote state is unavailable or conflicts with this release");
      }
      const projected = await projectSkillFrontmatter(context, "askill-sh", {
        slug: context.skill.name,
        version: context.project.version,
      });
      const result = await runAskill(
        context,
        executable,
        ["publish", projected.root, "--json"],
        runtime,
      );
      const expected = `Published @${author}/${context.skill.name}@${context.project.version}`;
      if (!passed(result) || !text(result).includes(expected)) {
        throw new Error("askill publication failed or returned an unexpected identity");
      }
      return Object.freeze({
        remoteId: `@${author}/${context.skill.name}@${context.project.version}`,
      });
    },
    verify: async (context: PublicationContext) =>
      verifyAskill(context, author, executable, runtime),
  });
}
