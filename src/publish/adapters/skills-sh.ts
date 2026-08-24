import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { readBoundCanonicalSkill } from "../projection.js";
import type {
  PublicationAdapter,
  PublicationContext,
  PublicationPreflight,
  PublicationVerification,
} from "../saga.js";
import {
  passed,
  type PublicationAdapterRuntime,
  runProviderCommand,
  runProviderHttp,
} from "./command.js";

export interface SkillsShDerivedAdapterOptions extends PublicationAdapterRuntime {
  readonly source: string;
  readonly githubToken?: string;
  readonly oidcToken?: string;
}

interface SourceFile {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly gitBlobSha: string;
  readonly contents: string;
}

const SOURCE =
  /^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?\/[A-Za-z\d](?:[A-Za-z\d._-]{0,98}[A-Za-z\d])?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GITHUB_API = "https://api.github.com";
const SKILLS_SH = "https://skills.sh";

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function parseRecord(body: string): Readonly<Record<string, unknown>> | null {
  try {
    return record(JSON.parse(body));
  } catch {
    return null;
  }
}

function gitBlob(bytes: Buffer): string {
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
  const payload = result.stdout.subarray(0, -1);
  if (payload.byteLength === 0) return null;
  const files: SourceFile[] = [];
  for (const line of payload.toString("utf8").split("\0")) {
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
    let bytes: Buffer;
    try {
      bytes = await readFile(join(canonical.root, ...path.split("/")));
    } catch {
      return null;
    }
    const contents = bytes.toString("utf8");
    if (
      bytes.byteLength > 2 * 1024 * 1024 ||
      !Buffer.from(contents, "utf8").equals(bytes) ||
      bytes.byteLength !== Number(match[3]) ||
      gitBlob(bytes) !== match[2]
    ) {
      return null;
    }
    files.push({
      path,
      mode: match[1] as SourceFile["mode"],
      gitBlobSha: match[2] as string,
      contents,
    });
  }
  return Object.freeze(
    files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))),
  );
}

function githubHeaders(token: string | undefined): Readonly<Record<string, string>> {
  return Object.freeze({
    Accept: "application/vnd.github+json",
    "User-Agent": "skillpress",
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    "X-GitHub-Api-Version": "2022-11-28",
  });
}

async function githubGet(
  path: string,
  token: string | undefined,
  runtime: PublicationAdapterRuntime,
) {
  return runProviderHttp(
    { method: "GET", url: `${GITHUB_API}/${path}`, headers: githubHeaders(token) },
    runtime,
  );
}

function remoteTreeMatches(
  value: Readonly<Record<string, unknown>> | null,
  context: PublicationContext,
  files: readonly SourceFile[],
): boolean {
  if (value?.truncated !== false || !Array.isArray(value.tree)) return false;
  const prefix = `${context.skill.path}/`;
  const relevant = value.tree
    .map(record)
    .filter(
      (entry) =>
        typeof entry?.path === "string" &&
        (entry.path === context.skill.path || entry.path.startsWith(prefix)),
    );
  if (
    relevant.some((entry) => entry?.type !== "tree" && entry?.type !== "blob") ||
    !relevant.some((entry) => entry?.type === "tree" && entry.path === context.skill.path)
  ) {
    return false;
  }
  const blobs = relevant.filter((entry) => entry?.type === "blob");
  return (
    blobs.length === files.length &&
    files.every((file) =>
      blobs.some(
        (entry) =>
          entry?.path === `${prefix}${file.path}` &&
          entry.sha === file.gitBlobSha &&
          entry.mode === file.mode,
      ),
    )
  );
}

async function publicSourceReady(
  context: PublicationContext,
  source: string,
  githubToken: string | undefined,
  runtime: PublicationAdapterRuntime,
): Promise<boolean> {
  if (context.project.repository.replace(/[.]git$/u, "") !== `https://github.com/${source}`) {
    return false;
  }
  const files = await sourceFiles(context, runtime);
  if (files === null) return false;
  const repositoryResult = await githubGet(`repos/${source}`, githubToken, runtime);
  const repository = repositoryResult.status === 200 ? parseRecord(repositoryResult.body) : null;
  if (
    repository?.full_name !== source ||
    repository.html_url !== `https://github.com/${source}` ||
    repository.private !== false ||
    repository.archived !== false ||
    repository.disabled !== false ||
    typeof repository.default_branch !== "string" ||
    repository.default_branch.length === 0
  ) {
    return false;
  }
  const branchResult = await githubGet(
    `repos/${source}/branches/${encodeURIComponent(repository.default_branch)}`,
    githubToken,
    runtime,
  );
  const branch = branchResult.status === 200 ? parseRecord(branchResult.body) : null;
  if (record(branch?.commit)?.sha !== context.sourceCommit) return false;
  const treeResult = await githubGet(
    `repos/${source}/git/trees/${context.sourceCommit}?recursive=1`,
    githubToken,
    runtime,
  );
  return (
    treeResult.status === 200 && remoteTreeMatches(parseRecord(treeResult.body), context, files)
  );
}

function listingUrl(source: string, skill: string): string {
  return `${SKILLS_SH}/${source}/${skill}`;
}

async function verifyListing(
  context: PublicationContext,
  source: string,
  oidcToken: string | undefined,
  runtime: PublicationAdapterRuntime,
): Promise<PublicationVerification> {
  const url = listingUrl(source, context.skill.name);
  if (oidcToken === undefined) return Object.freeze({ ok: false, url });
  const files = await sourceFiles(context, runtime);
  if (files === null) return Object.freeze({ ok: false, url });
  const response = await runProviderHttp(
    {
      method: "GET",
      url: `${SKILLS_SH}/api/v1/skills/${source}/${context.skill.name}`,
      headers: Object.freeze({
        Accept: "application/json",
        Authorization: `Bearer ${oidcToken}`,
        "User-Agent": "skillpress",
      }),
    },
    runtime,
  );
  const value = response.status === 200 ? parseRecord(response.body) : null;
  const remoteFiles = value?.files;
  if (
    value?.id !== `${source}/${context.skill.name}` ||
    value.source !== source ||
    value.slug !== context.skill.name ||
    !Number.isSafeInteger(value.installs) ||
    (value.installs as number) < 0 ||
    typeof value.hash !== "string" ||
    !SHA256.test(value.hash) ||
    !Array.isArray(remoteFiles) ||
    remoteFiles.length !== files.length
  ) {
    return Object.freeze({ ok: false, url });
  }
  const exact = files.every((file) =>
    remoteFiles.some((item) => {
      const remote = record(item);
      return remote?.path === file.path && remote.contents === file.contents;
    }),
  );
  return exact
    ? Object.freeze({ ok: true, remoteId: `${source}/${context.skill.name}`, url })
    : Object.freeze({ ok: false, url });
}

/** Track a public GitHub source and organic skills.sh listing without remote mutation. */
export function createSkillsShDerivedAdapter(
  options: SkillsShDerivedAdapterOptions,
): PublicationAdapter {
  const source = options.source;
  if (!SOURCE.test(source) || source.includes("..")) {
    throw new TypeError("skills.sh source must be owner/repository");
  }
  const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const oidcToken = options.oidcToken ?? process.env.VERCEL_OIDC_TOKEN;
  if (
    githubToken !== undefined &&
    (githubToken.length === 0 || githubToken.trim() !== githubToken)
  ) {
    throw new TypeError("GitHub token cannot be empty");
  }
  if (oidcToken !== undefined && (oidcToken.length === 0 || oidcToken.trim() !== oidcToken)) {
    throw new TypeError("Vercel OIDC token cannot be empty");
  }
  const runtime: PublicationAdapterRuntime = Object.freeze({
    ...(options.executor === undefined ? {} : { executor: options.executor }),
    ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
  });
  return Object.freeze({
    id: "skills-sh",
    capability: "derived",
    auth: Object.freeze([]),
    rollback: "no remote mutation; change or remove the public GitHub source to affect indexing",
    steps: Object.freeze([]),
    preflight: async (context: PublicationContext): Promise<PublicationPreflight> =>
      (await publicSourceReady(context, source, githubToken, runtime))
        ? Object.freeze({
            ok: true,
            code: "ready",
            message:
              oidcToken === undefined
                ? "public GitHub source is exact; organic skills.sh status requires Vercel OIDC"
                : "public GitHub source is exact and skills.sh listing verification is available",
          })
        : Object.freeze({
            ok: false,
            code: "source_unavailable",
            message: "public GitHub default branch is not the exact packaged skill source",
          }),
    verify: async (context: PublicationContext): Promise<PublicationVerification> => {
      if (!(await publicSourceReady(context, source, githubToken, runtime))) {
        return Object.freeze({ ok: false, url: listingUrl(source, context.skill.name) });
      }
      return verifyListing(context, source, oidcToken, runtime);
    },
  });
}
