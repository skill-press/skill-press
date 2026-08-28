import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";

import { Ajv, type ValidateFunction } from "ajv";

import type { Mirror, Release, SkillPressDiscoveryFeed } from "./generated-feed.js";

export const SKILL_PRESS_DISCOVERY_URL = "https://skill-press.com/api/v1/discovery" as const;
export const DISCOVERY_SNAPSHOT_DOMAIN = "skillpress.discovery-snapshot.v1\n" as const;
export const DEFAULT_DISCOVERY_PAGE_SIZE = 50;
export const MAX_DISCOVERY_PAGE_SIZE = 100;
export const MAX_DISCOVERY_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_DISCOVERY_MAX_PAGES = 100;
export const MAX_DISCOVERY_MAX_PAGES = 100;
export const DEFAULT_DISCOVERY_MAX_ENTRIES = 256;
export const MAX_DISCOVERY_MAX_ENTRIES = 256;
export const DEFAULT_DISCOVERY_MAX_MIRRORS = 2_048;
export const MAX_DISCOVERY_MAX_MIRRORS = 2_048;
export const MAX_DISCOVERY_COLLECTION_BYTES = 4 * 1024 * 1024;
export const MAX_DISCOVERY_COLLECTION_DURATION_MS = 120_000;
export const MAX_MIRROR_URL_LENGTH = 384;

export type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type SkillPressDiscoveryPage = DeepReadonly<SkillPressDiscoveryFeed>;
export type SkillPressDiscoveryRelease = DeepReadonly<Release>;
export type SkillPressMirrorProjection = DeepReadonly<Mirror>;

export interface SkillPressDiscoverySnapshot {
  readonly schemaVersion: 1;
  readonly snapshotType: "skillpress.discovery-snapshot";
  readonly snapshot: string;
  readonly generatedAt: string;
  readonly totalEntries: number;
  readonly releases: readonly SkillPressDiscoveryRelease[];
  readonly mirrors: readonly SkillPressMirrorProjection[];
}

export interface DiscoveryPageRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

/** A full collection always begins at the canonical feed origin, never at a caller cursor. */
export interface DiscoveryCollectionRequest {
  readonly limit?: number;
  readonly maxPages?: number;
  readonly maxEntries?: number;
  readonly maxMirrors?: number;
  readonly maxBytes?: number;
}

export interface CanonicalDiscoveryClientOptions {
  readonly fetcher?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly collectionTimeoutMs?: number;
  readonly pageSize?: number;
}

export interface SkillPressDiscoveryClient {
  readonly listPage: (request?: DiscoveryPageRequest) => Promise<SkillPressDiscoveryPage>;
  readonly collect: (request?: DiscoveryCollectionRequest) => Promise<SkillPressDiscoverySnapshot>;
}

export type DiscoveryClientErrorCode =
  | "client_configuration_invalid"
  | "cursor_invalid"
  | "registry_unavailable"
  | "registry_rejected"
  | "redirect_rejected"
  | "response_oversized"
  | "response_invalid"
  | "response_contract_invalid"
  | "cursor_cycle"
  | "snapshot_changed"
  | "snapshot_invalid"
  | "feed_conflict"
  | "collection_limit_exceeded"
  | "collection_deadline_exceeded";

export class DiscoveryClientError extends Error {
  readonly code: DiscoveryClientErrorCode;

  constructor(code: DiscoveryClientErrorCode, message: string) {
    super(message);
    this.name = "DiscoveryClientError";
    this.code = code;
  }
}

interface FetchedDiscoveryPage {
  readonly page: SkillPressDiscoveryPage;
  readonly bodyBytes: number;
}

const feedSchema = JSON.parse(
  await readFile(new URL("../../schemas/discovery-feed.schema.json", import.meta.url), "utf8"),
) as object;
const validateFeed = new Ajv({ allErrors: true, strict: true }).compile(
  feedSchema,
) as ValidateFunction<SkillPressDiscoveryFeed>;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{16,512}$/u;
const LOCATOR_PATTERN = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)@(.+)$/u;
const GITHUB_MIRROR_PATH =
  /^\/skill-press\/[A-Za-z0-9._~!$&'()*+,;=:@-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@-]+)*$/u;
const SKILL_PRESS_ORIGIN = "https://skill-press.com";

function configuredInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new DiscoveryClientError(
      "client_configuration_invalid",
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return resolved;
}

function cursorFrom(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!CURSOR_PATTERN.test(value)) {
    throw new DiscoveryClientError(
      "cursor_invalid",
      "The Skill Press discovery cursor is invalid.",
    );
  }
  return value;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort; the response is rejected regardless.
  }
}

async function boundedBody(response: Response): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_DISCOVERY_RESPONSE_BYTES) {
      await reader.cancel();
      throw new DiscoveryClientError(
        "response_oversized",
        "Skill Press returned an oversized discovery response.",
      );
    }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks);
}

function canonicalTimestamp(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null;
  return milliseconds;
}

function expectedReleaseUrls(namespace: string, skill: string, version: string) {
  const path = `${encodeURIComponent(namespace)}/${encodeURIComponent(skill)}/${encodeURIComponent(version)}`;
  return {
    canonicalUrl: `${SKILL_PRESS_ORIGIN}/skills/${path}`,
    attestationUrl: `${SKILL_PRESS_ORIGIN}/attestations/${path}`,
  } as const;
}

function isAllowedGitHubMirrorUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    value.length <= MAX_MIRROR_URL_LENGTH &&
    url.origin === "https://github.com" &&
    url.hostname === "github.com" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.href === value &&
    GITHUB_MIRROR_PATH.test(url.pathname)
  );
}

function canonicalMirrorShape(value: DeepReadonly<Mirror>): Mirror {
  const source = {
    locator: value.source.locator,
    artifactSha256: value.source.artifactSha256,
    canonicalUrl: value.source.canonicalUrl,
    attestationUrl: value.source.attestationUrl,
  };
  return value.mirrorKind === "artifact"
    ? {
        projectionType: value.projectionType,
        id: value.id,
        operator: value.operator,
        provider: value.provider,
        mirrorKind: "artifact",
        url: value.url,
        verifiedAt: value.verifiedAt,
        artifactSha256: value.artifactSha256,
        source,
      }
    : {
        projectionType: value.projectionType,
        id: value.id,
        operator: value.operator,
        provider: value.provider,
        mirrorKind: "listing",
        url: value.url,
        verifiedAt: value.verifiedAt,
        source,
      };
}

function canonicalReleaseShape(value: DeepReadonly<Release>): Release {
  const trust =
    value.trust.reasonCode === undefined
      ? {
          status: value.trust.status,
          sequence: value.trust.sequence,
          updatedAt: value.trust.updatedAt,
        }
      : {
          status: value.trust.status,
          sequence: value.trust.sequence,
          updatedAt: value.trust.updatedAt,
          reasonCode: value.trust.reasonCode,
        };
  return {
    releaseState: value.releaseState,
    locator: value.locator,
    namespace: value.namespace,
    skill: value.skill,
    version: value.version,
    artifactSha256: value.artifactSha256,
    canonicalUrl: value.canonicalUrl,
    attestationUrl: value.attestationUrl,
    publishedAt: value.publishedAt,
    trust,
    mirrors: value.mirrors
      .map(canonicalMirrorShape)
      .sort((left, right) => compareText(left.id, right.id)),
  };
}

/** Hash the fully normalized release array used by discovery snapshot version 1. */
export function computeDiscoverySnapshotSha256(
  releases: readonly SkillPressDiscoveryRelease[],
): string {
  const normalized = releases
    .map(canonicalReleaseShape)
    .sort((left, right) => compareText(left.locator, right.locator));
  return createHash("sha256")
    .update(DISCOVERY_SNAPSHOT_DOMAIN, "utf8")
    .update(JSON.stringify(normalized), "utf8")
    .digest("hex");
}

function mirrorFingerprint(mirror: DeepReadonly<Mirror>): string {
  return JSON.stringify(canonicalMirrorShape(mirror));
}

function mirrorSourceFingerprint(mirror: DeepReadonly<Mirror>): string {
  return JSON.stringify([
    mirror.source.locator,
    mirror.source.artifactSha256,
    mirror.source.canonicalUrl,
    mirror.source.attestationUrl,
  ]);
}

function releaseFingerprint(release: DeepReadonly<Release>): string {
  return JSON.stringify(canonicalReleaseShape(release));
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeRelease(value: Release, generatedAt: number): Release {
  const locator = LOCATOR_PATTERN.exec(value.locator);
  if (locator === null) {
    throw new DiscoveryClientError(
      "response_contract_invalid",
      "Skill Press returned a discovery release with an invalid locator.",
    );
  }
  const [, namespace, skill, version] = locator;
  const urls = expectedReleaseUrls(namespace as string, skill as string, version as string);
  const publishedAt = canonicalTimestamp(value.publishedAt);
  const trustUpdatedAt = canonicalTimestamp(value.trust.updatedAt);
  if (
    namespace !== value.namespace ||
    skill !== value.skill ||
    version !== value.version ||
    value.canonicalUrl !== urls.canonicalUrl ||
    value.attestationUrl !== urls.attestationUrl ||
    publishedAt === null ||
    trustUpdatedAt === null ||
    publishedAt > trustUpdatedAt ||
    trustUpdatedAt > generatedAt
  ) {
    throw new DiscoveryClientError(
      "response_contract_invalid",
      "Skill Press returned a discovery release with inconsistent canonical bindings.",
    );
  }

  const mirrors = new Map<string, Mirror>();
  for (const mirror of value.mirrors) {
    const verifiedAt = canonicalTimestamp(mirror.verifiedAt);
    const artifactBindingIsValid =
      mirror.mirrorKind === "listing" || mirror.artifactSha256 === value.artifactSha256;
    if (
      mirror.operator !== "skill-press" ||
      mirror.provider !== "github" ||
      !isAllowedGitHubMirrorUrl(mirror.url) ||
      verifiedAt === null ||
      verifiedAt < publishedAt ||
      verifiedAt > generatedAt ||
      !artifactBindingIsValid ||
      mirror.source.locator !== value.locator ||
      mirror.source.artifactSha256 !== value.artifactSha256 ||
      mirror.source.canonicalUrl !== value.canonicalUrl ||
      mirror.source.attestationUrl !== value.attestationUrl
    ) {
      throw new DiscoveryClientError(
        "response_contract_invalid",
        "Skill Press returned an invalid or unbound mirror projection.",
      );
    }
    if (mirrors.has(mirror.id)) {
      throw new DiscoveryClientError(
        "feed_conflict",
        `Skill Press repeated mirror projection ID ${mirror.id}.`,
      );
    }
    mirrors.set(mirror.id, canonicalMirrorShape(mirror));
  }
  return canonicalReleaseShape({
    ...value,
    mirrors: [...mirrors.values()],
  });
}

function normalizeFeed(value: unknown, requestedLimit: number): SkillPressDiscoveryFeed {
  if (!validateFeed(value)) {
    throw new DiscoveryClientError(
      "response_contract_invalid",
      "Skill Press returned a page that violated the discovery feed contract.",
    );
  }
  if (value.entries.length > requestedLimit) {
    throw new DiscoveryClientError(
      "response_contract_invalid",
      "Skill Press returned more discovery releases than requested.",
    );
  }
  const generatedAt = canonicalTimestamp(value.generatedAt);
  if (generatedAt === null) {
    throw new DiscoveryClientError(
      "response_contract_invalid",
      "Skill Press returned a discovery page with an invalid generation time.",
    );
  }

  const releases = new Map<string, { readonly release: Release; readonly fingerprint: string }>();
  for (const candidate of value.entries) {
    const release = normalizeRelease(candidate, generatedAt);
    const fingerprint = releaseFingerprint(release);
    const existing = releases.get(release.locator);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new DiscoveryClientError(
          "feed_conflict",
          `Skill Press returned conflicting release ${release.locator}.`,
        );
      }
      continue;
    }
    releases.set(release.locator, { release, fingerprint });
  }
  if (releases.size > value.totalEntries) {
    throw new DiscoveryClientError(
      "response_contract_invalid",
      "Skill Press returned more releases than the discovery snapshot declares.",
    );
  }

  const mirrorIds = new Map<string, string>();
  const mirrorUrls = new Map<string, string>();
  const entries = [...releases.values()]
    .map(({ release }) => release)
    .sort((left, right) => compareText(left.locator, right.locator));
  for (const release of entries) {
    for (const mirror of release.mirrors) {
      const fingerprint = mirrorFingerprint(mirror);
      if (mirrorIds.has(mirror.id)) {
        throw new DiscoveryClientError(
          "feed_conflict",
          `Skill Press repeated global mirror projection ID ${mirror.id}.`,
        );
      }
      mirrorIds.set(mirror.id, fingerprint);
      const source = mirrorSourceFingerprint(mirror);
      const existingSource = mirrorUrls.get(mirror.url);
      if (existingSource !== undefined && existingSource !== source) {
        throw new DiscoveryClientError(
          "feed_conflict",
          `Skill Press bound mirror URL ${mirror.url} to conflicting releases.`,
        );
      }
      mirrorUrls.set(mirror.url, source);
    }
  }

  return {
    schemaVersion: 1,
    feedType: "skillpress.discovery-feed",
    snapshot: value.snapshot,
    generatedAt: value.generatedAt,
    totalEntries: value.totalEntries,
    entries,
    nextCursor: value.nextCursor,
  };
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function requestUrl(cursor: string | undefined, limit: number): string {
  const url = new URL(SKILL_PRESS_DISCOVERY_URL);
  url.searchParams.set("limit", String(limit));
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  return url.href;
}

function deadlineError(): DiscoveryClientError {
  return new DiscoveryClientError(
    "collection_deadline_exceeded",
    "Skill Press discovery exceeded the total collection deadline.",
  );
}

function timeoutWithinDeadline(timeoutMs: number, deadline: number | undefined): number {
  if (deadline === undefined) return timeoutMs;
  const remaining = deadline - performance.now();
  if (!(remaining > 0)) throw deadlineError();
  return Math.min(timeoutMs, Math.max(1, Math.ceil(remaining)));
}

function assertBeforeDeadline(deadline: number | undefined): void {
  if (deadline !== undefined && !(performance.now() < deadline)) throw deadlineError();
}

/** Create the read-only discovery client. Its registry origin cannot be configured. */
export function createCanonicalDiscoveryClient(
  options: CanonicalDiscoveryClientOptions = {},
): SkillPressDiscoveryClient {
  const candidateFetcher = options.fetcher ?? globalThis.fetch;
  if (typeof candidateFetcher !== "function") {
    throw new DiscoveryClientError(
      "client_configuration_invalid",
      "A valid fetch implementation is required for Skill Press discovery.",
    );
  }
  const fetcher =
    options.fetcher === undefined ? candidateFetcher.bind(globalThis) : candidateFetcher;
  const timeoutMs = configuredInteger(options.timeoutMs, 30_000, 1, 120_000, "Discovery timeout");
  const collectionTimeoutMs = configuredInteger(
    options.collectionTimeoutMs,
    MAX_DISCOVERY_COLLECTION_DURATION_MS,
    1,
    MAX_DISCOVERY_COLLECTION_DURATION_MS,
    "Discovery collection timeout",
  );
  const defaultPageSize = configuredInteger(
    options.pageSize,
    DEFAULT_DISCOVERY_PAGE_SIZE,
    1,
    MAX_DISCOVERY_PAGE_SIZE,
    "Discovery page size",
  );

  const fetchPage = async (
    request: DiscoveryPageRequest = {},
    deadline?: number,
  ): Promise<FetchedDiscoveryPage> => {
    const cursor = cursorFrom(request.cursor);
    const limit = configuredInteger(
      request.limit,
      defaultPageSize,
      1,
      MAX_DISCOVERY_PAGE_SIZE,
      "Discovery page limit",
    );
    const url = requestUrl(cursor, limit);
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "skill-press-protocol-version": "1",
        },
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(timeoutWithinDeadline(timeoutMs, deadline)),
      });
    } catch (error) {
      if (error instanceof DiscoveryClientError) throw error;
      if (deadline !== undefined && !(performance.now() < deadline)) throw deadlineError();
      throw new DiscoveryClientError(
        "registry_unavailable",
        "The canonical Skill Press discovery feed is unavailable.",
      );
    }
    if (deadline !== undefined && !(performance.now() < deadline)) {
      await cancelResponseBody(response);
      throw deadlineError();
    }
    if (
      response.redirected ||
      (response.url !== "" && response.url !== url) ||
      response.type === "opaqueredirect"
    ) {
      await cancelResponseBody(response);
      throw new DiscoveryClientError(
        "redirect_rejected",
        "Skill Press discovery refused a redirected response.",
      );
    }
    if (response.status !== 200) {
      await cancelResponseBody(response);
      throw new DiscoveryClientError(
        "registry_rejected",
        `Skill Press rejected the discovery request with HTTP ${response.status}.`,
      );
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") {
      await cancelResponseBody(response);
      throw new DiscoveryClientError(
        "response_invalid",
        "Skill Press discovery did not return JSON.",
      );
    }

    let body: Buffer;
    try {
      body = await boundedBody(response);
    } catch (error) {
      if (error instanceof DiscoveryClientError) throw error;
      throw new DiscoveryClientError(
        "registry_unavailable",
        "The Skill Press discovery response was interrupted.",
      );
    }
    assertBeforeDeadline(deadline);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new DiscoveryClientError(
        "response_invalid",
        "Skill Press discovery returned invalid UTF-8.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DiscoveryClientError(
        "response_invalid",
        "Skill Press discovery returned invalid JSON.",
      );
    }
    const page = deepFreeze(normalizeFeed(parsed, limit));
    if (cursor !== undefined && page.nextCursor === cursor) {
      throw new DiscoveryClientError(
        "cursor_cycle",
        "Skill Press discovery returned a repeated cursor.",
      );
    }
    return { page, bodyBytes: body.byteLength };
  };

  const listPage = async (request: DiscoveryPageRequest = {}): Promise<SkillPressDiscoveryPage> =>
    (await fetchPage(request)).page;

  const collect = async (
    request: DiscoveryCollectionRequest = {},
  ): Promise<SkillPressDiscoverySnapshot> => {
    if (Object.hasOwn(request, "cursor")) {
      throw new DiscoveryClientError(
        "client_configuration_invalid",
        "A full discovery collection cannot begin from a cursor.",
      );
    }
    const limit = configuredInteger(
      request.limit,
      defaultPageSize,
      1,
      MAX_DISCOVERY_PAGE_SIZE,
      "Discovery page limit",
    );
    const maxPages = configuredInteger(
      request.maxPages,
      DEFAULT_DISCOVERY_MAX_PAGES,
      1,
      MAX_DISCOVERY_MAX_PAGES,
      "Discovery page budget",
    );
    const maxEntries = configuredInteger(
      request.maxEntries,
      DEFAULT_DISCOVERY_MAX_ENTRIES,
      1,
      MAX_DISCOVERY_MAX_ENTRIES,
      "Discovery entry budget",
    );
    const maxMirrors = configuredInteger(
      request.maxMirrors,
      DEFAULT_DISCOVERY_MAX_MIRRORS,
      1,
      MAX_DISCOVERY_MAX_MIRRORS,
      "Discovery mirror budget",
    );
    const maxBytes = configuredInteger(
      request.maxBytes,
      MAX_DISCOVERY_COLLECTION_BYTES,
      1,
      MAX_DISCOVERY_COLLECTION_BYTES,
      "Discovery byte budget",
    );
    const deadline = performance.now() + collectionTimeoutMs;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    const releases = new Map<
      string,
      { readonly release: SkillPressDiscoveryRelease; readonly fingerprint: string }
    >();
    const mirrors = new Map<string, SkillPressMirrorProjection>();
    const mirrorUrls = new Map<string, string>();
    let snapshot: string | undefined;
    let generatedAt: string | undefined;
    let totalEntries: number | undefined;
    let totalBytes = 0;

    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      assertBeforeDeadline(deadline);
      const fetched = await fetchPage(
        cursor === undefined ? { limit } : { cursor, limit },
        deadline,
      );
      totalBytes += fetched.bodyBytes;
      if (totalBytes > maxBytes) {
        throw new DiscoveryClientError(
          "collection_limit_exceeded",
          "Skill Press discovery exceeded the configured cumulative byte budget.",
        );
      }
      const { page } = fetched;
      const releasesBeforePage = releases.size;
      if (snapshot === undefined) {
        snapshot = page.snapshot;
        generatedAt = page.generatedAt;
        totalEntries = page.totalEntries;
        if (totalEntries > maxEntries) {
          throw new DiscoveryClientError(
            "collection_limit_exceeded",
            "The discovery snapshot exceeds the configured entry budget.",
          );
        }
      } else if (
        page.snapshot !== snapshot ||
        page.generatedAt !== generatedAt ||
        page.totalEntries !== totalEntries
      ) {
        throw new DiscoveryClientError(
          "snapshot_changed",
          "The Skill Press discovery snapshot changed during pagination.",
        );
      }

      for (const release of page.entries) {
        const fingerprint = releaseFingerprint(release);
        const existing = releases.get(release.locator);
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            throw new DiscoveryClientError(
              "feed_conflict",
              `Skill Press returned conflicting release ${release.locator}.`,
            );
          }
          continue;
        }
        if (releases.size >= maxEntries || releases.size >= (totalEntries as number)) {
          throw new DiscoveryClientError(
            "response_contract_invalid",
            "Skill Press returned more releases than the snapshot declares.",
          );
        }

        for (const mirror of release.mirrors) {
          if (mirrors.has(mirror.id)) {
            throw new DiscoveryClientError(
              "feed_conflict",
              `Skill Press repeated global mirror projection ID ${mirror.id}.`,
            );
          }
          const source = mirrorSourceFingerprint(mirror);
          const existingSource = mirrorUrls.get(mirror.url);
          if (existingSource !== undefined && existingSource !== source) {
            throw new DiscoveryClientError(
              "feed_conflict",
              `Skill Press bound mirror URL ${mirror.url} to conflicting releases.`,
            );
          }
          if (mirrors.size >= maxMirrors) {
            throw new DiscoveryClientError(
              "collection_limit_exceeded",
              "Skill Press discovery exceeded the configured mirror budget.",
            );
          }
          mirrors.set(mirror.id, mirror);
          mirrorUrls.set(mirror.url, source);
        }
        releases.set(release.locator, { release, fingerprint });
      }

      if (page.nextCursor === null) {
        if (releases.size !== totalEntries) {
          throw new DiscoveryClientError(
            "response_contract_invalid",
            "Skill Press discovery ended before its declared total was collected.",
          );
        }
        assertBeforeDeadline(deadline);
        const normalizedReleases = [...releases.values()]
          .map(({ release }) => release)
          .sort((left, right) => compareText(left.locator, right.locator));
        const computedSnapshot = computeDiscoverySnapshotSha256(normalizedReleases);
        if (computedSnapshot !== snapshot) {
          throw new DiscoveryClientError(
            "snapshot_invalid",
            "Skill Press discovery returned a snapshot digest that did not bind the full feed.",
          );
        }
        const result: SkillPressDiscoverySnapshot = {
          schemaVersion: 1,
          snapshotType: "skillpress.discovery-snapshot",
          snapshot: computedSnapshot,
          generatedAt: generatedAt as string,
          totalEntries,
          releases: normalizedReleases,
          mirrors: [...mirrors.values()].sort((left, right) => compareText(left.id, right.id)),
        };
        assertBeforeDeadline(deadline);
        return deepFreeze(result);
      }
      if (releases.size === releasesBeforePage) {
        throw new DiscoveryClientError(
          "response_contract_invalid",
          "Skill Press discovery returned a cursor without making progress.",
        );
      }
      if (releases.size >= (totalEntries as number)) {
        throw new DiscoveryClientError(
          "response_contract_invalid",
          "Skill Press discovery returned a cursor after reaching its declared total.",
        );
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new DiscoveryClientError(
          "cursor_cycle",
          "Skill Press discovery returned a cursor cycle.",
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new DiscoveryClientError(
      "collection_limit_exceeded",
      "Skill Press discovery exceeded the configured page budget.",
    );
  };

  return Object.freeze({ listPage, collect });
}
