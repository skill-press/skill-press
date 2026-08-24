import { homedir } from "node:os";
import { join } from "node:path";

import type { CapturedCommandResult } from "../../process/capture.js";
import type {
  PublicationAdapter,
  PublicationContext,
  PublicationPreflight,
  PublicationVerification,
} from "../saga.js";
import {
  jsonRecord,
  passed,
  type PublicationAdapterRuntime,
  runProviderCommand as runCommand,
  text,
} from "./command.js";

function runProviderCommand(
  root: string,
  argv: readonly [string, ...string[]],
  runtime: PublicationAdapterRuntime,
) {
  return runCommand(
    root,
    argv,
    runtime,
    Object.freeze({
      ...(process.env.GH_TOKEN === undefined ? {} : { GH_TOKEN: process.env.GH_TOKEN }),
      ...(process.env.GITHUB_TOKEN === undefined ? {} : { GITHUB_TOKEN: process.env.GITHUB_TOKEN }),
      GH_CONFIG_DIR:
        process.env.GH_CONFIG_DIR ??
        join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh"),
      HOME: process.env.HOME ?? homedir(),
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
    }),
  );
}

interface GitHubRepository {
  readonly owner: string;
  readonly name: string;
  readonly slug: string;
  readonly url: string;
}

function repository(input: string): GitHubRepository {
  const url = new URL(input);
  const parts = url.pathname
    .replace(/[.]git$/u, "")
    .split("/")
    .filter(Boolean);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || parts.length !== 2) {
    throw new TypeError("GitHub publication requires a canonical GitHub repository URL.");
  }
  const [owner, name] = parts as [string, string];
  return Object.freeze({
    owner,
    name,
    slug: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
  });
}

function tag(context: PublicationContext): string {
  return `v${context.project.version}`;
}

function releaseUrl(context: PublicationContext, target: GitHubRepository): string {
  return `${target.url}/releases/tag/${encodeURIComponent(tag(context))}`;
}

function pushArguments(
  context: PublicationContext,
  target: GitHubRepository,
  reference: string,
  dryRun: boolean,
) {
  return [
    "git",
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!gh auth git-credential",
    "push",
    ...(dryRun ? ["--dry-run"] : []),
    `${target.url}.git`,
    `${context.sourceCommit}:${reference}`,
  ] as [string, ...string[]];
}

function assets(context: PublicationContext) {
  return Object.freeze([
    context.artifacts.skillArchive,
    context.artifacts.zipArchive,
    context.artifacts.checksums,
    context.artifacts.provenance,
  ]);
}

function assetNames(context: PublicationContext): readonly string[] {
  return assets(context).map((asset) => asset.name);
}

function assetPaths(context: PublicationContext): readonly string[] {
  return assetNames(context).map((name) => join(context.root, context.artifactsPath, name));
}

type RemoteReference =
  | { readonly status: "absent" | "unavailable" }
  | { readonly status: "present"; readonly commit: string };

async function remoteReference(
  context: PublicationContext,
  target: GitHubRepository,
  reference: string,
  runtime: PublicationAdapterRuntime,
): Promise<RemoteReference> {
  const result = await runProviderCommand(
    context.root,
    ["git", "ls-remote", "--exit-code", `${target.url}.git`, reference],
    runtime,
  );
  if (
    result.status === "failed" &&
    result.exitCode === 2 &&
    result.signal === null &&
    result.stdoutBytes === 0
  ) {
    return Object.freeze({ status: "absent" });
  }
  if (!passed(result)) return Object.freeze({ status: "unavailable" });
  const lines = text(result).split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) return Object.freeze({ status: "unavailable" });
  const fields = lines[0]?.split(/\s+/u) ?? [];
  const [commit, returnedReference] = fields;
  return fields.length === 2 &&
    returnedReference === reference &&
    /^[a-f0-9]{40}$/u.test(commit ?? "")
    ? Object.freeze({ status: "present", commit: commit as string })
    : Object.freeze({ status: "unavailable" });
}

type ReleaseInspection =
  | { readonly status: "absent" | "unavailable" }
  | { readonly status: "present"; readonly value: Readonly<Record<string, unknown>> };

function includedResponse(result: CapturedCommandResult): {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
} | null {
  const output = result.stdout.toString("utf8");
  const separator = /\r?\n\r?\n/u.exec(output);
  if (separator === null) return null;
  const headers = output.slice(0, separator.index);
  const statusLine = headers.split(/\r?\n/u)[0] ?? "";
  const match = /^HTTP\/[0-9.]+ ([0-9]{3})(?: |$)/u.exec(statusLine);
  if (match === null) return null;
  try {
    const value: unknown = JSON.parse(output.slice(separator.index + separator[0].length).trim());
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.freeze({
          status: Number(match[1]),
          body: value as Readonly<Record<string, unknown>>,
        })
      : null;
  } catch {
    return null;
  }
}

async function inspectRelease(
  context: PublicationContext,
  target: GitHubRepository,
  runtime: PublicationAdapterRuntime,
): Promise<ReleaseInspection> {
  const result = await runProviderCommand(
    context.root,
    [
      "gh",
      "api",
      "--include",
      `repos/${target.slug}/releases/tags/${encodeURIComponent(tag(context))}`,
    ],
    runtime,
  );
  const response = includedResponse(result);
  if (
    result.status === "failed" &&
    result.exitCode !== null &&
    result.exitCode !== 0 &&
    result.signal === null &&
    response?.status === 404 &&
    response.body.message === "Not Found" &&
    (response.body.status === "404" || response.body.status === 404)
  ) {
    return Object.freeze({ status: "absent" });
  }
  if (!passed(result) || response?.status !== 200) {
    return Object.freeze({ status: "unavailable" });
  }
  const body = response.body;
  if (
    !Array.isArray(body.assets) ||
    typeof body.draft !== "boolean" ||
    typeof body.prerelease !== "boolean" ||
    typeof body.tag_name !== "string" ||
    typeof body.html_url !== "string"
  ) {
    return Object.freeze({ status: "unavailable" });
  }
  return Object.freeze({
    status: "present",
    value: Object.freeze({
      assets: body.assets,
      isDraft: body.draft,
      isPrerelease: body.prerelease,
      tagName: body.tag_name,
      url: body.html_url,
    }),
  });
}

function releaseMatches(
  context: PublicationContext,
  target: GitHubRepository,
  value: Readonly<Record<string, unknown>> | null,
): value is Readonly<Record<string, unknown>> {
  if (
    value === null ||
    value.tagName !== tag(context) ||
    value.url !== releaseUrl(context, target) ||
    value.isDraft !== false ||
    value.isPrerelease !== false ||
    !Array.isArray(value.assets)
  ) {
    return false;
  }
  const remoteAssets = value.assets.flatMap((asset) => {
    if (asset === null || typeof asset !== "object" || Array.isArray(asset)) return [];
    const record = asset as Readonly<Record<string, unknown>>;
    return typeof record.name === "string" &&
      typeof record.digest === "string" &&
      typeof record.size === "number"
      ? [{ name: record.name, digest: record.digest, size: record.size }]
      : [];
  });
  const localAssets = assets(context);
  if (
    remoteAssets.length !== value.assets.length ||
    remoteAssets.length !== localAssets.length ||
    new Set(remoteAssets.map((asset) => asset.name)).size !== remoteAssets.length
  ) {
    return false;
  }
  return localAssets.every((local) =>
    remoteAssets.some(
      (remote) =>
        remote.name === local.name &&
        remote.digest === `sha256:${local.sha256}` &&
        remote.size === local.bytes,
    ),
  );
}

async function verifyGitHub(
  context: PublicationContext,
  target: GitHubRepository,
  runtime: PublicationAdapterRuntime,
): Promise<PublicationVerification> {
  const [branchCommit, tagCommit, releaseValue, repoResult] = await Promise.all([
    remoteReference(context, target, "refs/heads/main", runtime),
    remoteReference(context, target, `refs/tags/${tag(context)}`, runtime),
    inspectRelease(context, target, runtime),
    runProviderCommand(
      context.root,
      ["gh", "repo", "view", target.slug, "--json", "repositoryTopics,url"],
      runtime,
    ),
  ]);
  const repoValue = jsonRecord(repoResult);
  const topics = Array.isArray(repoValue?.repositoryTopics)
    ? repoValue.repositoryTopics.filter((value): value is string => typeof value === "string")
    : [];
  const ok =
    branchCommit.status === "present" &&
    branchCommit.commit === context.sourceCommit &&
    tagCommit.status === "present" &&
    tagCommit.commit === context.sourceCommit &&
    releaseValue.status === "present" &&
    releaseMatches(context, target, releaseValue.value) &&
    repoValue?.url === target.url &&
    topics.includes("agent-skills");
  return Object.freeze({
    ok,
    ...(ok ? { remoteId: `${target.slug}@${tag(context)}`, url: releaseUrl(context, target) } : {}),
  });
}

/** Publish exact GitHub source, discovery metadata, and a release with audited artifacts. */
export function createGitHubPublicationAdapter(
  runtime: PublicationAdapterRuntime = {},
): PublicationAdapter {
  return Object.freeze({
    id: "github",
    capability: "publish",
    auth: Object.freeze(["GH_TOKEN"]),
    rollback: "release and tag deletion are manual; published source history is retained",
    steps: Object.freeze(["publish-source", "configure-discovery", "publish-release"]),
    preflight: async (context: PublicationContext): Promise<PublicationPreflight> => {
      const target = repository(context.project.repository);
      const auth = await runProviderCommand(context.root, ["gh", "api", "user"], runtime);
      if (!passed(auth)) {
        return Object.freeze({
          ok: false,
          code: "auth_missing",
          message: "authenticate GitHub CLI or provide GH_TOKEN",
        });
      }
      const repoResult = await runProviderCommand(
        context.root,
        ["gh", "repo", "view", target.slug, "--json", "isPrivate,nameWithOwner,url"],
        runtime,
      );
      const repoValue = jsonRecord(repoResult);
      if (
        repoValue?.nameWithOwner !== target.slug ||
        repoValue.isPrivate !== false ||
        repoValue.url !== target.url
      ) {
        return Object.freeze({
          ok: false,
          code: "repository_unavailable",
          message: "configured GitHub repository must exist and be public",
        });
      }
      const push = await runProviderCommand(
        context.root,
        pushArguments(context, target, "refs/heads/main", true),
        runtime,
      );
      if (!passed(push)) {
        return Object.freeze({
          ok: false,
          code: "push_unavailable",
          message: "Git credentials cannot push the exact source commit to main",
        });
      }
      const tagReference = await remoteReference(
        context,
        target,
        `refs/tags/${tag(context)}`,
        runtime,
      );
      if (tagReference.status === "unavailable") {
        return Object.freeze({
          ok: false,
          code: "tag_unavailable",
          message: "GitHub release tag state could not be established safely",
        });
      }
      if (tagReference.status === "present" && tagReference.commit !== context.sourceCommit) {
        return Object.freeze({
          ok: false,
          code: "tag_conflict",
          message: "GitHub release tag points to a different immutable source commit",
        });
      }
      if (tagReference.status === "absent") {
        const tagPush = await runProviderCommand(
          context.root,
          pushArguments(context, target, `refs/tags/${tag(context)}`, true),
          runtime,
        );
        if (!passed(tagPush)) {
          return Object.freeze({
            ok: false,
            code: "tag_push_unavailable",
            message: "Git credentials cannot create the exact protected release tag",
          });
        }
      }
      const releaseState = await inspectRelease(context, target, runtime);
      if (releaseState.status === "unavailable") {
        return Object.freeze({
          ok: false,
          code: "release_unavailable",
          message: "GitHub release state could not be established safely",
        });
      }
      if (
        releaseState.status === "present" &&
        !releaseMatches(context, target, releaseState.value)
      ) {
        return Object.freeze({
          ok: false,
          code: "release_conflict",
          message: "GitHub release version conflicts with expected immutable assets",
        });
      }
      const validation = await runProviderCommand(
        context.root,
        ["gh", "skill", "publish", "--dry-run", context.root],
        runtime,
      );
      return passed(validation)
        ? Object.freeze({ ok: true, code: "ready", message: "GitHub publication is ready" })
        : Object.freeze({
            ok: false,
            code: "skill_invalid",
            message: "GitHub CLI skill validation failed",
          });
    },
    execute: async (context: PublicationContext, step: string) => {
      const target = repository(context.project.repository);
      if (step === "publish-source") {
        const branch = await remoteReference(context, target, "refs/heads/main", runtime);
        if (branch.status === "unavailable") throw new Error("GitHub source state is unavailable");
        if (branch.status !== "present" || branch.commit !== context.sourceCommit) {
          const result = await runProviderCommand(
            context.root,
            pushArguments(context, target, "refs/heads/main", false),
            runtime,
          );
          if (!passed(result)) throw new Error("GitHub source push failed");
        }
        return Object.freeze({ remoteId: context.sourceCommit, url: target.url });
      }
      if (step === "configure-discovery") {
        const result = await runProviderCommand(
          context.root,
          ["gh", "repo", "edit", target.slug, "--add-topic", "agent-skills"],
          runtime,
        );
        if (!passed(result)) throw new Error("GitHub discovery configuration failed");
        return Object.freeze({ remoteId: target.slug, url: target.url });
      }
      if (step !== "publish-release") throw new Error("Unknown GitHub publication step");
      const tagReference = `refs/tags/${tag(context)}`;
      const remoteTag = await remoteReference(context, target, tagReference, runtime);
      if (remoteTag.status === "unavailable") throw new Error("GitHub tag state is unavailable");
      if (remoteTag.status === "present" && remoteTag.commit !== context.sourceCommit) {
        throw new Error("GitHub release tag conflicts with the immutable source commit");
      }
      if (remoteTag.status === "absent") {
        const pushed = await runProviderCommand(
          context.root,
          pushArguments(context, target, tagReference, false),
          runtime,
        );
        if (!passed(pushed)) throw new Error("GitHub release tag push failed");
      }
      const existing = await inspectRelease(context, target, runtime);
      if (existing.status === "unavailable") throw new Error("GitHub release state is unavailable");
      if (existing.status === "present" && !releaseMatches(context, target, existing.value)) {
        throw new Error("GitHub release version conflicts with expected immutable assets");
      }
      if (existing.status === "absent") {
        const result = await runProviderCommand(
          context.root,
          [
            "gh",
            "release",
            "create",
            tag(context),
            ...assetPaths(context),
            "--repo",
            target.slug,
            "--verify-tag",
            "--title",
            `${context.project.name} ${context.project.version}`,
            "--generate-notes",
          ],
          runtime,
        );
        if (!passed(result)) throw new Error("GitHub release creation failed");
      }
      const final = await inspectRelease(context, target, runtime);
      if (final.status !== "present" || !releaseMatches(context, target, final.value)) {
        throw new Error("GitHub release verification failed");
      }
      return Object.freeze({
        remoteId: `${target.slug}@${tag(context)}`,
        url: releaseUrl(context, target),
      });
    },
    verify: async (context: PublicationContext) =>
      verifyGitHub(context, repository(context.project.repository), runtime),
  });
}
