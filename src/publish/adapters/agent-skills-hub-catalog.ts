import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";

import type { CapturedCommandResult } from "../../process/capture.js";
import { readBoundCanonicalSkill } from "../projection.js";
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

export interface AgentSkillsHubCatalogAdapterOptions extends PublicationAdapterRuntime {
  readonly contributor: string;
}

interface SourceFile {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly gitBlobSha: string;
  readonly bytes: Buffer;
}

interface BranchInfo {
  readonly commitSha: string;
  readonly treeSha: string;
}

type CatalogState = "absent" | "match" | "conflict" | "unavailable";
type ForkState = "absent" | "ready" | "conflict" | "unavailable";

interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "OPEN" | "MERGED";
  readonly headRefOid: string;
}

const UPSTREAM = "agent-skills-hub/agent-skills-hub";
const UPSTREAM_URL = `https://github.com/${UPSTREAM}`;
const LOGIN = /^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?$/u;
const SHA1 = /^[a-f0-9]{40}$/u;

function ghEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(process.env.GH_TOKEN === undefined ? {} : { GH_TOKEN: process.env.GH_TOKEN }),
    ...(process.env.GITHUB_TOKEN === undefined ? {} : { GITHUB_TOKEN: process.env.GITHUB_TOKEN }),
    GH_CONFIG_DIR:
      process.env.GH_CONFIG_DIR ??
      join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh"),
    HOME: process.env.HOME ?? homedir(),
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  });
}

function runGh(
  context: PublicationContext,
  argv: readonly string[],
  runtime: PublicationAdapterRuntime,
) {
  return runProviderCommand(context.root, ["gh", ...argv], runtime, ghEnvironment());
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function jsonArray(result: CapturedCommandResult): readonly unknown[] | null {
  if (!passed(result)) return null;
  try {
    const value: unknown = JSON.parse(text(result));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function sha1Blob(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

async function sourceFiles(
  context: PublicationContext,
  runtime: PublicationAdapterRuntime,
): Promise<readonly SourceFile[] | null> {
  let canonical: Awaited<ReturnType<typeof readBoundCanonicalSkill>>;
  try {
    canonical = await readBoundCanonicalSkill(context);
  } catch {
    return null;
  }
  const result = await runProviderCommand(
    context.root,
    ["git", "ls-tree", "-r", "-z", "--long", context.sourceCommit, "--", context.skill.path],
    runtime,
  );
  if (!passed(result) || result.stdout.at(-1) !== 0) return null;
  const prefix = `${context.skill.path}/`;
  const files: SourceFile[] = [];
  for (const line of result.stdout.subarray(0, -1).toString("utf8").split("\0")) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) (\d+)\t(.+)$/u.exec(line);
    if (match === null || !(match[4] as string).startsWith(prefix)) return null;
    const path = (match[4] as string).slice(prefix.length);
    if (
      path.length === 0 ||
      posix.isAbsolute(path) ||
      path.split("/").includes("..") ||
      files.some((file) => file.path === path)
    ) {
      return null;
    }
    const bytes = await readFile(join(canonical.root, ...path.split("/")));
    if (bytes.byteLength !== Number(match[3]) || sha1Blob(bytes) !== match[2]) return null;
    files.push(
      Object.freeze({
        path,
        mode: match[1] as SourceFile["mode"],
        gitBlobSha: match[2] as string,
        bytes,
      }),
    );
  }
  return files.length > 0
    ? Object.freeze(
        [...files].sort((left, right) =>
          Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
        ),
      )
    : null;
}

function branchName(context: PublicationContext): string {
  return `skillpress/${context.skill.name}-v${context.project.version}-${context.sourceCommit.slice(0, 12)}`;
}

function branchInfo(value: Readonly<Record<string, unknown>> | null): BranchInfo | null {
  const commit = record(value?.commit);
  const nested = record(commit?.commit);
  const tree = record(nested?.tree);
  return typeof commit?.sha === "string" &&
    SHA1.test(commit.sha) &&
    typeof tree?.sha === "string" &&
    SHA1.test(tree.sha)
    ? Object.freeze({ commitSha: commit.sha, treeSha: tree.sha })
    : null;
}

async function upstreamBranch(
  context: PublicationContext,
  runtime: PublicationAdapterRuntime,
): Promise<BranchInfo | null> {
  return branchInfo(
    jsonRecord(await runGh(context, ["api", `repos/${UPSTREAM}/branches/main`], runtime)),
  );
}

function treeMatches(
  value: Readonly<Record<string, unknown>> | null,
  context: PublicationContext,
  files: readonly SourceFile[],
): CatalogState {
  if (value === null || value.truncated !== false || !Array.isArray(value.tree)) {
    return "unavailable";
  }
  const prefix = `skills/${context.skill.name}/`;
  const entries = value.tree
    .map(record)
    .filter((entry) => typeof entry?.path === "string" && entry.path.startsWith(prefix));
  if (entries.length === 0) return "absent";
  if (entries.some((entry) => entry?.type !== "blob" && entry?.type !== "tree")) {
    return "conflict";
  }
  const blobs = entries.filter((entry) => entry?.type === "blob");
  if (blobs.length !== files.length) return "conflict";
  return files.every((file) => {
    const expectedPath = `${prefix}${file.path}`;
    return blobs.some(
      (entry) =>
        entry?.path === expectedPath && entry.sha === file.gitBlobSha && entry.mode === file.mode,
    );
  })
    ? "match"
    : "conflict";
}

async function catalogState(
  context: PublicationContext,
  repository: string,
  treeish: string,
  files: readonly SourceFile[],
  runtime: PublicationAdapterRuntime,
): Promise<CatalogState> {
  const result = await runGh(
    context,
    ["api", `repos/${repository}/git/trees/${treeish}?recursive=1`],
    runtime,
  );
  if (!passed(result)) return "unavailable";
  return treeMatches(jsonRecord(result), context, files);
}

async function contributionState(
  context: PublicationContext,
  contributor: string,
  upstream: BranchInfo,
  commit: string,
  files: readonly SourceFile[],
  runtime: PublicationAdapterRuntime,
): Promise<CatalogState> {
  const forkRepository = `${contributor}/agent-skills-hub`;
  const tree = await catalogState(context, forkRepository, commit, files, runtime);
  if (tree !== "match") return tree;
  const comparison = jsonRecord(
    await runGh(
      context,
      [
        "api",
        `repos/${UPSTREAM}/compare/${encodeURIComponent(`${upstream.commitSha}...${contributor}:${branchName(context)}`)}`,
      ],
      runtime,
    ),
  );
  const commits = comparison?.commits;
  const changedFiles = comparison?.files;
  const relativePositionIsSafe =
    (comparison?.status === "ahead" && comparison.behind_by === 0) ||
    (comparison?.status === "diverged" &&
      Number.isSafeInteger(comparison.behind_by) &&
      (comparison.behind_by as number) > 0);
  if (
    comparison === null ||
    !relativePositionIsSafe ||
    comparison.ahead_by !== 1 ||
    comparison.total_commits !== 1 ||
    !Array.isArray(commits) ||
    commits.length !== 1 ||
    record(commits[0])?.sha !== commit ||
    !Array.isArray(changedFiles) ||
    changedFiles.length !== files.length
  ) {
    return "conflict";
  }
  return files.every((file) =>
    changedFiles.some((item) => {
      const entry = record(item);
      return (
        entry?.filename === `skills/${context.skill.name}/${file.path}` &&
        entry.status === "added" &&
        entry.sha === file.gitBlobSha
      );
    }),
  )
    ? "match"
    : "conflict";
}

async function forkState(
  context: PublicationContext,
  contributor: string,
  runtime: PublicationAdapterRuntime,
): Promise<ForkState> {
  const result = await runGh(
    context,
    [
      "repo",
      "view",
      `${contributor}/agent-skills-hub`,
      "--json",
      "isFork,parent,nameWithOwner,url",
    ],
    runtime,
  );
  if (!passed(result)) {
    const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`;
    return /HTTP 404/iu.test(output) ? "absent" : "unavailable";
  }
  const value = jsonRecord(result);
  const parent = record(value?.parent);
  return value?.isFork === true &&
    value.nameWithOwner === `${contributor}/agent-skills-hub` &&
    value.url === `https://github.com/${contributor}/agent-skills-hub` &&
    parent?.nameWithOwner === UPSTREAM
    ? "ready"
    : "conflict";
}

async function waitForFork(
  context: PublicationContext,
  contributor: string,
  runtime: PublicationAdapterRuntime,
): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = await forkState(context, contributor, runtime);
    if (state === "ready") return true;
    if (state === "conflict") return false;
    if (attempt < 5) await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

async function writeRequest(
  context: PublicationContext,
  label: string,
  value: unknown,
): Promise<string> {
  const root = join(
    context.root,
    ".skillpress",
    "projections",
    context.idempotencyKey,
    "agent-skills-hub-catalog",
    "requests",
  );
  const directories = [
    join(context.root, ".skillpress"),
    join(context.root, ".skillpress", "projections"),
    join(context.root, ".skillpress", "projections", context.idempotencyKey),
    join(
      context.root,
      ".skillpress",
      "projections",
      context.idempotencyKey,
      "agent-skills-hub-catalog",
    ),
    root,
  ];
  for (const directory of directories) {
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory()) throw new Error("Catalog request storage is unsafe");
    await chmod(directory, 0o700);
  }
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  const name = `${label}-${createHash("sha256").update(body).digest("hex")}.json`;
  const path = join(root, name);
  try {
    await writeFile(path, body, { flag: "wx", mode: 0o600 });
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const metadata = await lstat(path);
    if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("Catalog request storage is unsafe");
    }
    if (!(await readFile(path)).equals(body)) throw new Error("Catalog request binding changed");
  }
  await chmod(path, 0o600);
  return path;
}

async function postJson(
  context: PublicationContext,
  endpoint: string,
  label: string,
  value: unknown,
  runtime: PublicationAdapterRuntime,
): Promise<Readonly<Record<string, unknown>> | null> {
  const path = await writeRequest(context, label, value);
  return jsonRecord(
    await runGh(context, ["api", "--method", "POST", endpoint, "--input", path], runtime),
  );
}

async function forkBranchCommit(
  context: PublicationContext,
  contributor: string,
  runtime: PublicationAdapterRuntime,
): Promise<string | null> {
  const value = jsonRecord(
    await runGh(
      context,
      ["api", `repos/${contributor}/agent-skills-hub/git/ref/heads/${branchName(context)}`],
      runtime,
    ),
  );
  const object = record(value?.object);
  return typeof object?.sha === "string" && SHA1.test(object.sha) ? object.sha : null;
}

async function pullRequest(
  context: PublicationContext,
  contributor: string,
  expectedCommit: string,
  runtime: PublicationAdapterRuntime,
): Promise<PullRequest | null | "conflict"> {
  const values = jsonArray(
    await runGh(
      context,
      [
        "pr",
        "list",
        "--repo",
        UPSTREAM,
        "--state",
        "all",
        "--head",
        branchName(context),
        "--limit",
        "10",
        "--json",
        "number,url,state,isDraft,mergedAt,headRefName,headRefOid,headRepository,headRepositoryOwner,baseRefName",
      ],
      runtime,
    ),
  );
  if (values === null || values.length > 1) return "conflict";
  if (values.length === 0) return null;
  const value = record(values[0]);
  const headRepository = record(value?.headRepository);
  const headOwner = record(value?.headRepositoryOwner);
  if (
    value === null ||
    !Number.isSafeInteger(value.number) ||
    (value.number as number) < 1 ||
    value.url !== `${UPSTREAM_URL}/pull/${value.number}` ||
    value.isDraft !== false ||
    value.headRefName !== branchName(context) ||
    value.headRefOid !== expectedCommit ||
    headOwner?.login !== contributor ||
    headRepository?.nameWithOwner !== `${contributor}/agent-skills-hub` ||
    value.baseRefName !== "main" ||
    (value.state !== "OPEN" && value.state !== "MERGED")
  ) {
    return "conflict";
  }
  return Object.freeze({
    number: value.number as number,
    url: value.url,
    state: value.state,
    headRefOid: value.headRefOid,
  }) as PullRequest;
}

function mergedResult(context: PublicationContext): PublicationVerification {
  return Object.freeze({
    ok: true,
    remoteId: `${UPSTREAM}:skills/${context.skill.name}`,
    url: `${UPSTREAM_URL}/tree/main/skills/${context.skill.name}`,
  });
}

/** Submit the complete canonical skill to the curated Agent Skills Hub catalog by reviewable PR. */
export function createAgentSkillsHubCatalogAdapter(
  options: AgentSkillsHubCatalogAdapterOptions,
): PublicationAdapter {
  const contributor = options.contributor;
  if (!LOGIN.test(contributor)) throw new TypeError("Catalog contributor must be a GitHub login");
  const runtime: PublicationAdapterRuntime = Object.freeze({
    ...(options.executor === undefined ? {} : { executor: options.executor }),
    ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
  });
  return Object.freeze({
    id: "agent-skills-hub-catalog",
    capability: "submit",
    auth: Object.freeze(["GH_TOKEN"]),
    rollback: "close the pull request and delete the contribution branch manually",
    steps: Object.freeze(["prepare-fork", "publish-branch", "open-pull-request"]),
    preflight: async (context: PublicationContext): Promise<PublicationPreflight> => {
      const files = await sourceFiles(context, runtime);
      if (files === null) {
        return Object.freeze({
          ok: false,
          code: "source_invalid",
          message: "catalog submission source is not bound to the packaged commit",
        });
      }
      const identity = jsonRecord(await runGh(context, ["api", "user"], runtime));
      if (identity?.login !== contributor) {
        return Object.freeze({
          ok: false,
          code: "auth_missing",
          message: `authenticate gh as ${contributor} before catalog submission`,
        });
      }
      const upstream = await upstreamBranch(context, runtime);
      if (upstream === null) {
        return Object.freeze({
          ok: false,
          code: "provider_unavailable",
          message: "Agent Skills Hub upstream main branch is unavailable",
        });
      }
      const state = await catalogState(context, UPSTREAM, upstream.commitSha, files, runtime);
      if (state === "match") {
        return Object.freeze({
          ok: true,
          code: "ready",
          message: "Agent Skills Hub catalog already contains the exact skill",
        });
      }
      if (state !== "absent") {
        return Object.freeze({
          ok: false,
          code: state === "conflict" ? "catalog_conflict" : "provider_unavailable",
          message: "Agent Skills Hub catalog path is conflicting or unavailable",
        });
      }
      const fork = await forkState(context, contributor, runtime);
      return fork === "conflict" || fork === "unavailable"
        ? Object.freeze({
            ok: false,
            code: fork === "conflict" ? "fork_conflict" : "provider_unavailable",
            message: "existing catalog fork is conflicting or unavailable",
          })
        : Object.freeze({
            ok: true,
            code: "ready",
            message: "catalog contribution is ready; merge will require maintainer review",
          });
    },
    execute: async (context: PublicationContext, step: string) => {
      const files = await sourceFiles(context, runtime);
      if (files === null) throw new Error("Catalog source changed after preflight");
      const upstream = await upstreamBranch(context, runtime);
      if (upstream === null) throw new Error("Catalog upstream is unavailable");
      const upstreamState = await catalogState(
        context,
        UPSTREAM,
        upstream.commitSha,
        files,
        runtime,
      );
      if (upstreamState === "match") {
        return mergedResult(context);
      }
      if (upstreamState !== "absent") {
        throw new Error("Catalog upstream path conflicts or is unavailable");
      }
      const forkRepository = `${contributor}/agent-skills-hub`;
      if (step === "prepare-fork") {
        const state = await forkState(context, contributor, runtime);
        if (state === "absent") {
          const result = await runGh(
            context,
            ["repo", "fork", UPSTREAM, "--clone=false", "--remote=false"],
            runtime,
          );
          if (!passed(result)) throw new Error("Catalog fork creation failed");
        } else if (state !== "ready") {
          throw new Error("Catalog fork conflicts or is unavailable");
        }
        if (!(await waitForFork(context, contributor, runtime))) {
          throw new Error("Catalog fork could not be verified");
        }
        return Object.freeze({
          remoteId: forkRepository,
          url: `https://github.com/${forkRepository}`,
        });
      }
      if (step === "publish-branch") {
        if ((await forkState(context, contributor, runtime)) !== "ready") {
          throw new Error("Catalog fork is unavailable");
        }
        const existingCommit = await forkBranchCommit(context, contributor, runtime);
        if (existingCommit !== null) {
          const state = await contributionState(
            context,
            contributor,
            upstream,
            existingCommit,
            files,
            runtime,
          );
          if (state !== "match") throw new Error("Catalog contribution branch conflicts");
          return Object.freeze({ remoteId: `${forkRepository}#${branchName(context)}` });
        }
        const blobs = [];
        for (const file of files) {
          const created = await postJson(
            context,
            `repos/${forkRepository}/git/blobs`,
            `blob-${createHash("sha256").update(file.path).digest("hex")}`,
            { content: file.bytes.toString("base64"), encoding: "base64" },
            runtime,
          );
          if (typeof created?.sha !== "string" || created.sha !== file.gitBlobSha) {
            throw new Error("Catalog contribution blob creation failed");
          }
          blobs.push({
            path: `skills/${context.skill.name}/${file.path}`,
            mode: file.mode,
            type: "blob",
            sha: created.sha,
          });
        }
        const tree = await postJson(
          context,
          `repos/${forkRepository}/git/trees`,
          "tree",
          { base_tree: upstream.treeSha, tree: blobs },
          runtime,
        );
        if (typeof tree?.sha !== "string" || !SHA1.test(tree.sha)) {
          throw new Error("Catalog contribution tree creation failed");
        }
        const commit = await postJson(
          context,
          `repos/${forkRepository}/git/commits`,
          "commit",
          {
            message: `feat: add ${context.skill.name} skill`,
            tree: tree.sha,
            parents: [upstream.commitSha],
          },
          runtime,
        );
        if (typeof commit?.sha !== "string" || !SHA1.test(commit.sha)) {
          throw new Error("Catalog contribution commit creation failed");
        }
        const reference = await postJson(
          context,
          `repos/${forkRepository}/git/refs`,
          "reference",
          { ref: `refs/heads/${branchName(context)}`, sha: commit.sha },
          runtime,
        );
        const object = record(reference?.object);
        if (object?.sha !== commit.sha)
          throw new Error("Catalog contribution branch creation failed");
        if (
          (await contributionState(context, contributor, upstream, commit.sha, files, runtime)) !==
          "match"
        ) {
          throw new Error("Catalog contribution branch verification failed");
        }
        return Object.freeze({ remoteId: `${forkRepository}#${branchName(context)}` });
      }
      if (step === "open-pull-request") {
        const commit = await forkBranchCommit(context, contributor, runtime);
        if (commit === null) throw new Error("Catalog contribution branch is unavailable");
        const state = await contributionState(
          context,
          contributor,
          upstream,
          commit,
          files,
          runtime,
        );
        if (state !== "match") throw new Error("Catalog contribution branch conflicts");
        const existing = await pullRequest(context, contributor, commit, runtime);
        if (existing === "conflict") throw new Error("Catalog pull request conflicts");
        if (existing !== null) {
          if (existing.state !== "OPEN") throw new Error("Catalog merged state is inconsistent");
          return Object.freeze({ remoteId: `${UPSTREAM}#${existing.number}`, url: existing.url });
        }
        const result = await runGh(
          context,
          [
            "pr",
            "create",
            "--repo",
            UPSTREAM,
            "--base",
            "main",
            "--head",
            `${contributor}:${branchName(context)}`,
            "--title",
            `feat: add ${context.skill.name} skill`,
            "--body",
            `Adds the complete ${context.skill.name} skill from ${context.project.repository} at ${context.sourceCommit}. Generated by SkillPress; maintainer review is required.`,
          ],
          runtime,
        );
        if (!passed(result) || !text(result).startsWith(`${UPSTREAM_URL}/pull/`)) {
          throw new Error("Catalog pull request creation failed");
        }
        return Object.freeze({ url: text(result) });
      }
      throw new Error("Unknown Agent Skills Hub catalog publication step");
    },
    verify: async (context: PublicationContext): Promise<PublicationVerification> => {
      const files = await sourceFiles(context, runtime);
      const upstream = files === null ? null : await upstreamBranch(context, runtime);
      if (files === null || upstream === null) return Object.freeze({ ok: false });
      if ((await catalogState(context, UPSTREAM, upstream.commitSha, files, runtime)) === "match") {
        return mergedResult(context);
      }
      const commit = await forkBranchCommit(context, contributor, runtime);
      if (commit === null) return Object.freeze({ ok: false });
      if (
        (await contributionState(context, contributor, upstream, commit, files, runtime)) !==
        "match"
      ) {
        return Object.freeze({ ok: false });
      }
      const pr = await pullRequest(context, contributor, commit, runtime);
      return pr === null || pr === "conflict" || pr.state !== "OPEN"
        ? Object.freeze({ ok: false })
        : Object.freeze({ ok: true, remoteId: `${UPSTREAM}#${pr.number}`, url: pr.url });
    },
  });
}
