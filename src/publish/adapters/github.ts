import { join } from "node:path";

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
  runProviderCommand,
  text,
} from "./command.js";

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

async function remoteCommit(
  context: PublicationContext,
  target: GitHubRepository,
  reference: string,
  runtime: PublicationAdapterRuntime,
): Promise<string | null> {
  const result = await runProviderCommand(
    context.root,
    ["git", "ls-remote", "--exit-code", `${target.url}.git`, reference],
    runtime,
  );
  if (!passed(result)) return null;
  const [commit, returnedReference] = text(result).split(/\s+/u);
  return returnedReference === reference && /^[a-f0-9]{40}$/u.test(commit ?? "")
    ? (commit as string)
    : null;
}

async function release(
  context: PublicationContext,
  target: GitHubRepository,
  runtime: PublicationAdapterRuntime,
): Promise<Readonly<Record<string, unknown>> | null> {
  const result = await runProviderCommand(
    context.root,
    [
      "gh",
      "release",
      "view",
      tag(context),
      "--repo",
      target.slug,
      "--json",
      "assets,isDraft,isPrerelease,tagName,url",
    ],
    runtime,
  );
  return jsonRecord(result);
}

function releaseMatches(
  context: PublicationContext,
  value: Readonly<Record<string, unknown>> | null,
): value is Readonly<Record<string, unknown>> {
  if (
    value === null ||
    value.tagName !== tag(context) ||
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
  return assets(context).every((local) =>
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
    remoteCommit(context, target, "refs/heads/main", runtime),
    remoteCommit(context, target, `refs/tags/${tag(context)}`, runtime),
    release(context, target, runtime),
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
    branchCommit === context.sourceCommit &&
    tagCommit === context.sourceCommit &&
    releaseMatches(context, releaseValue) &&
    topics.includes("agent-skills");
  const url = releaseValue?.url;
  return Object.freeze({
    ok,
    ...(typeof url === "string" ? { url } : {}),
    ...(ok ? { remoteId: `${target.slug}@${tag(context)}` } : {}),
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
      if (repoValue?.nameWithOwner !== target.slug || repoValue.isPrivate !== false) {
        return Object.freeze({
          ok: false,
          code: "repository_unavailable",
          message: "configured GitHub repository must exist and be public",
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
        if (
          (await remoteCommit(context, target, "refs/heads/main", runtime)) !== context.sourceCommit
        ) {
          const result = await runProviderCommand(
            context.root,
            ["git", "push", `${target.url}.git`, `${context.sourceCommit}:refs/heads/main`],
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
      const existing = await release(context, target, runtime);
      if (existing !== null && !releaseMatches(context, existing)) {
        throw new Error("GitHub release version conflicts with expected immutable assets");
      }
      if (existing === null) {
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
            "--target",
            context.sourceCommit,
            "--title",
            `${context.project.name} ${context.project.version}`,
            "--generate-notes",
          ],
          runtime,
        );
        if (!passed(result)) throw new Error("GitHub release creation failed");
      }
      const value = await release(context, target, runtime);
      const url = value?.url;
      return Object.freeze({
        remoteId: `${target.slug}@${tag(context)}`,
        ...(typeof url === "string" ? { url } : {}),
      });
    },
    verify: async (context: PublicationContext) =>
      verifyGitHub(context, repository(context.project.repository), runtime),
  });
}
