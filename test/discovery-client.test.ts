import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import {
  computeDiscoverySnapshotSha256,
  createCanonicalDiscoveryClient,
  DEFAULT_DISCOVERY_MAX_ENTRIES,
  DEFAULT_DISCOVERY_MAX_MIRRORS,
  DEFAULT_DISCOVERY_MAX_PAGES,
  DEFAULT_DISCOVERY_PAGE_SIZE,
  DISCOVERY_SNAPSHOT_DOMAIN,
  DiscoveryClientError,
  type DiscoveryCollectionRequest,
  MAX_DISCOVERY_COLLECTION_BYTES,
  MAX_DISCOVERY_COLLECTION_DURATION_MS,
  MAX_DISCOVERY_MAX_ENTRIES,
  MAX_DISCOVERY_MAX_MIRRORS,
  MAX_DISCOVERY_MAX_PAGES,
  MAX_DISCOVERY_PAGE_SIZE,
  MAX_DISCOVERY_RESPONSE_BYTES,
  SKILL_PRESS_DISCOVERY_URL,
} from "../src/discovery/client.js";
import type { Mirror, Release, SkillPressDiscoveryFeed } from "../src/discovery/generated-feed.js";

const GENERATED_AT = "2026-08-27T12:00:00.000Z";
const CURSOR_A = "cursor_A_1234567";
const CURSOR_B = "cursor_B_1234567";

function releaseUrls(namespace: string, skill: string, version: string) {
  const path = `${encodeURIComponent(namespace)}/${encodeURIComponent(skill)}/${encodeURIComponent(version)}`;
  return {
    canonicalUrl: `https://skill-press.com/skills/${path}`,
    attestationUrl: `https://skill-press.com/attestations/${path}`,
  };
}

function mirrorFor(
  release: Pick<Release, "locator" | "artifactSha256" | "canonicalUrl" | "attestationUrl">,
  id = "mirror_12345678",
  kind: "listing" | "artifact" = "listing",
): Mirror {
  const base = {
    projectionType: "skillpress.mirror-projection" as const,
    id,
    operator: "skill-press" as const,
    provider: "github" as const,
    url: `https://github.com/skill-press/mirrors/releases/download/${id}/skill.skill`,
    verifiedAt: "2026-08-27T11:30:00.000Z",
    source: {
      locator: release.locator,
      artifactSha256: release.artifactSha256,
      canonicalUrl: release.canonicalUrl,
      attestationUrl: release.attestationUrl,
    },
  };
  return kind === "artifact"
    ? {
        ...base,
        mirrorKind: "artifact",
        artifactSha256: release.artifactSha256,
      }
    : { ...base, mirrorKind: "listing" };
}

function validRelease(
  namespace = "example",
  skill = "example-skill",
  version = "1.2.3",
  digestCharacter = "b",
  mirrorKind: "listing" | "artifact" = "listing",
): Release {
  const urls = releaseUrls(namespace, skill, version);
  const value: Release = {
    releaseState: "published",
    locator: `${namespace}/${skill}@${version}`,
    namespace,
    skill,
    version,
    artifactSha256: digestCharacter.repeat(64),
    ...urls,
    publishedAt: "2026-08-27T10:00:00.000Z",
    trust: {
      status: "trusted",
      sequence: 3,
      updatedAt: "2026-08-27T11:00:00.000Z",
    },
    mirrors: [],
  };
  value.mirrors.push(mirrorFor(value, `mirror_${namespace}_12345678`, mirrorKind));
  return value;
}

function feed(
  entries: Release[] = [validRelease()],
  overrides: Partial<SkillPressDiscoveryFeed> = {},
  fullSnapshotEntries: readonly Release[] = entries,
): SkillPressDiscoveryFeed {
  return {
    schemaVersion: 1,
    feedType: "skillpress.discovery-feed",
    snapshot: computeDiscoverySnapshotSha256(fullSnapshotEntries),
    generatedAt: GENERATED_AT,
    totalEntries: fullSnapshotEntries.length,
    entries,
    nextCursor: null,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fetchSequence(values: readonly Response[]) {
  const pending = [...values];
  return vi.fn(async () => pending.shift() as Response) as unknown as typeof globalThis.fetch;
}

describe("canonical discovery snapshot", () => {
  it("uses the domain-separated SHA-256 of fully normalized releases", () => {
    const alpha = validRelease("alpha", "format", "2.0.0+build.1", "c", "artifact");
    const zeta = validRelease("zeta", "lint", "1.0.0", "d");
    alpha.mirrors.push(mirrorFor(alpha, "mirror_alpha_00000001"));
    alpha.mirrors.reverse();

    const digest = computeDiscoverySnapshotSha256([zeta, alpha]);
    const reorderedAlpha = {
      mirrors: [...alpha.mirrors].reverse(),
      trust: { ...alpha.trust },
      publishedAt: alpha.publishedAt,
      attestationUrl: alpha.attestationUrl,
      canonicalUrl: alpha.canonicalUrl,
      artifactSha256: alpha.artifactSha256,
      version: alpha.version,
      skill: alpha.skill,
      namespace: alpha.namespace,
      locator: alpha.locator,
      releaseState: alpha.releaseState,
    } as Release;

    expect(computeDiscoverySnapshotSha256([reorderedAlpha, zeta])).toBe(digest);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe("64057c43fb03ae66f974a0cea04ecaaa14c913986d6fc344e621c834b5713e9a");
    expect(DISCOVERY_SNAPSHOT_DOMAIN).toBe("skillpress.discovery-snapshot.v1\n");
    expect(
      createHash("sha256")
        .update(`${DISCOVERY_SNAPSHOT_DOMAIN}not-the-normalized-array`, "utf8")
        .digest("hex"),
    ).not.toBe(digest);
  });

  it("accepts the maximum locator length shared by release contracts", async () => {
    const namespace = "n".repeat(64);
    const skill = "s".repeat(64);
    const version = `1.0.0+${"a".repeat(122)}`;
    const value = validRelease(namespace, skill, version);

    expect(value.locator).toHaveLength(258);
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([value]))]),
      }).listPage(),
    ).resolves.toMatchObject({ entries: [{ locator: value.locator }] });
  });
});

describe("canonical discovery client", () => {
  it("uses only the fixed public endpoint and returns a normalized, deeply frozen page", async () => {
    const alpha = validRelease("alpha", "format", "2.0.0+build.1", "c", "artifact");
    const zeta = validRelease("zeta", "lint", "1.0.0", "d");
    const mirrorA = mirrorFor(alpha, "mirror_alpha_a");
    const mirrorB = mirrorFor(alpha, "mirror_alpha_b", "artifact");
    alpha.mirrors = [mirrorB, mirrorA];
    const full = [zeta, alpha];
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(init?.headers).toEqual({
        accept: "application/json",
        "cache-control": "no-store",
        "skill-press-protocol-version": "1",
      });
      expect(init?.headers).not.toHaveProperty("authorization");
      expect(init?.body).toBeUndefined();
      return jsonResponse(feed([zeta, alpha, structuredClone(alpha)], {}, full));
    }) as unknown as typeof globalThis.fetch;
    const client = createCanonicalDiscoveryClient({ fetcher, pageSize: 4, timeoutMs: 5_000 });

    const page = await client.listPage();

    expect(fetcher).toHaveBeenCalledWith(
      `${SKILL_PRESS_DISCOVERY_URL}?limit=4`,
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    expect(page.totalEntries).toBe(2);
    expect(page.entries.map(({ locator }) => locator)).toEqual([
      "alpha/format@2.0.0+build.1",
      "zeta/lint@1.0.0",
    ]);
    expect(page.entries[0]?.canonicalUrl).toContain("2.0.0%2Bbuild.1");
    expect(page.entries[0]?.mirrors.map(({ id }) => id)).toEqual([
      "mirror_alpha_a",
      "mirror_alpha_b",
    ]);
    expect(page.entries[0]?.mirrors[1]).toMatchObject({
      mirrorKind: "artifact",
      artifactSha256: "c".repeat(64),
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.entries)).toBe(true);
    expect(Object.isFrozen(page.entries[0]?.mirrors[0]?.source)).toBe(true);
    expect(() => (page.entries as Release[]).push(validRelease())).toThrow();
  });

  it("always collects from the origin and rejects caller-supplied collection cursors", async () => {
    const fetcher = vi.fn(async () => jsonResponse(feed([]))) as unknown as typeof globalThis.fetch;
    const client = createCanonicalDiscoveryClient({ fetcher });
    const unsafe = { cursor: CURSOR_A } as unknown as DiscoveryCollectionRequest;

    await expect(client.collect(unsafe)).rejects.toMatchObject({
      code: "client_configuration_invalid",
    });
    expect(fetcher).not.toHaveBeenCalled();

    await expect(client.collect()).resolves.toMatchObject({ totalEntries: 0, releases: [] });
    expect(fetcher).toHaveBeenCalledWith(
      `${SKILL_PRESS_DISCOVERY_URL}?limit=${DEFAULT_DISCOVERY_PAGE_SIZE}`,
      expect.any(Object),
    );
  });

  it("paginates one stable full snapshot and deterministically deduplicates page overlap", async () => {
    const alpha = validRelease("alpha", "alpha-skill", "1.0.0", "c");
    const beta = validRelease("beta", "beta-skill", "2.0.0", "d", "artifact");
    const full = [beta, alpha];
    const fetcher = fetchSequence([
      jsonResponse(feed([alpha], { nextCursor: CURSOR_A }, full)),
      jsonResponse(feed([structuredClone(alpha), beta], {}, full)),
    ]);
    const client = createCanonicalDiscoveryClient({ fetcher });

    const snapshot = await client.collect({ limit: 2, maxEntries: 10, maxPages: 3 });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      `${SKILL_PRESS_DISCOVERY_URL}?limit=2`,
      expect.objectContaining({ redirect: "error" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `${SKILL_PRESS_DISCOVERY_URL}?limit=2&cursor=${CURSOR_A}`,
      expect.objectContaining({ redirect: "error" }),
    );
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      snapshotType: "skillpress.discovery-snapshot",
      snapshot: computeDiscoverySnapshotSha256(full),
      generatedAt: GENERATED_AT,
      totalEntries: 2,
    });
    expect(snapshot.releases.map(({ locator }) => locator)).toEqual([
      "alpha/alpha-skill@1.0.0",
      "beta/beta-skill@2.0.0",
    ]);
    expect(snapshot.mirrors.map(({ source }) => source.locator)).toEqual([
      "alpha/alpha-skill@1.0.0",
      "beta/beta-skill@2.0.0",
    ]);
    expect(Object.isFrozen(snapshot.releases[0]?.trust)).toBe(true);
    expect(Object.isFrozen(snapshot.mirrors)).toBe(true);
  });

  it("allows listPage to consume an opaque canonical cursor", async () => {
    const fetcher = fetchSequence([jsonResponse(feed([]))]);
    const page = await createCanonicalDiscoveryClient({ fetcher }).listPage({ cursor: CURSOR_A });

    expect(fetcher).toHaveBeenCalledWith(
      `${SKILL_PRESS_DISCOVERY_URL}?limit=${DEFAULT_DISCOVERY_PAGE_SIZE}&cursor=${CURSOR_A}`,
      expect.any(Object),
    );
    expect(page.entries).toEqual([]);
  });

  it("rejects a full feed whose canonical snapshot digest does not match", async () => {
    const value = validRelease();
    const client = createCanonicalDiscoveryClient({
      fetcher: fetchSequence([
        jsonResponse(feed([value], { snapshot: "f".repeat(64), totalEntries: 1 })),
      ]),
    });

    await expect(client.collect()).rejects.toMatchObject({ code: "snapshot_invalid" });
  });

  it("rejects early terminal pages, emitted rows beyond total, and cursors after total", async () => {
    const alpha = validRelease("alpha");
    const beta = validRelease("beta");
    const full = [alpha, beta];
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([alpha], {}, full))]),
      }).collect(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });

    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([alpha, beta], { totalEntries: 1 }, [alpha]))]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });

    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed(full, { nextCursor: CURSOR_A }, full))]),
      }).collect(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });
  });

  it("rejects invalid client, page, cursor, and collection bounds before network access", async () => {
    expect(() => createCanonicalDiscoveryClient({ timeoutMs: 0 })).toThrowError(
      DiscoveryClientError,
    );
    expect(() => createCanonicalDiscoveryClient({ timeoutMs: 120_001 })).toThrowError(
      DiscoveryClientError,
    );
    expect(() => createCanonicalDiscoveryClient({ collectionTimeoutMs: 0 })).toThrow(
      "collection timeout",
    );
    expect(() =>
      createCanonicalDiscoveryClient({
        collectionTimeoutMs: MAX_DISCOVERY_COLLECTION_DURATION_MS + 1,
      }),
    ).toThrow("collection timeout");
    expect(() => createCanonicalDiscoveryClient({ pageSize: MAX_DISCOVERY_PAGE_SIZE + 1 })).toThrow(
      "Discovery page size",
    );
    expect(() =>
      createCanonicalDiscoveryClient({ fetcher: "invalid" as unknown as typeof globalThis.fetch }),
    ).toThrow("valid fetch implementation");

    const fetcher = vi.fn(async () => jsonResponse(feed())) as unknown as typeof globalThis.fetch;
    const client = createCanonicalDiscoveryClient({ fetcher });
    await expect(client.listPage({ cursor: "short" })).rejects.toMatchObject({
      code: "cursor_invalid",
    });
    await expect(client.listPage({ limit: 0 })).rejects.toMatchObject({
      code: "client_configuration_invalid",
    });
    await expect(client.collect({ maxPages: 0 })).rejects.toMatchObject({
      code: "client_configuration_invalid",
    });
    await expect(client.collect({ maxPages: MAX_DISCOVERY_MAX_PAGES + 1 })).rejects.toMatchObject({
      code: "client_configuration_invalid",
    });
    await expect(
      client.collect({ maxEntries: MAX_DISCOVERY_MAX_ENTRIES + 1 }),
    ).rejects.toMatchObject({ code: "client_configuration_invalid" });
    await expect(
      client.collect({ maxMirrors: MAX_DISCOVERY_MAX_MIRRORS + 1 }),
    ).rejects.toMatchObject({ code: "client_configuration_invalid" });
    await expect(
      client.collect({ maxBytes: MAX_DISCOVERY_COLLECTION_BYTES + 1 }),
    ).rejects.toMatchObject({ code: "client_configuration_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(DEFAULT_DISCOVERY_MAX_PAGES).toBe(100);
    expect(DEFAULT_DISCOVERY_MAX_ENTRIES).toBe(256);
    expect(DEFAULT_DISCOVERY_MAX_MIRRORS).toBe(2_048);
  });

  it("rejects unavailable, redirected, rejected, non-JSON, invalid UTF-8, and invalid JSON responses", async () => {
    const unavailable = createCanonicalDiscoveryClient({
      fetcher: (async () => {
        throw new Error("offline");
      }) as typeof globalThis.fetch,
    });
    await expect(unavailable.listPage()).rejects.toMatchObject({ code: "registry_unavailable" });

    for (const response of [
      Object.defineProperty(jsonResponse(feed()), "redirected", { value: true }),
      Object.defineProperty(jsonResponse(feed()), "url", {
        value: "https://attacker.invalid/discovery",
      }),
      Object.defineProperty(jsonResponse(feed()), "type", { value: "opaqueredirect" }),
    ]) {
      await expect(
        createCanonicalDiscoveryClient({ fetcher: fetchSequence([response]) }).listPage(),
      ).rejects.toMatchObject({ code: "redirect_rejected" });
    }

    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse({ error: true }, 503)]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "registry_rejected" });
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([new Response("{}", { status: 200 })]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_invalid" });
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([
          new Response(Uint8Array.from([0xc3, 0x28]), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_invalid" });
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([
          new Response("not-json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_invalid" });
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([
          new Response(null, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_invalid" });
  });

  it("cancels rejected status and content-type response bodies", async () => {
    const cancellation = vi.fn();
    const response = (status: number, contentType: string) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([0x7b]));
          },
          cancel: cancellation,
        }),
        { status, headers: { "content-type": contentType } },
      );

    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([response(429, "application/json")]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "registry_rejected" });
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([response(200, "text/plain")]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_invalid" });
    expect(cancellation).toHaveBeenCalledTimes(2);

    const cancellationFailure = new Response(
      new ReadableStream({
        cancel() {
          throw new Error("cancel failed");
        },
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([cancellationFailure]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "registry_rejected" });
  });

  it("bounds per-page and cumulative response buffering", async () => {
    const oversized = new Response(Buffer.alloc(MAX_DISCOVERY_RESPONSE_BYTES + 1, 0x20), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await expect(
      createCanonicalDiscoveryClient({ fetcher: fetchSequence([oversized]) }).listPage(),
    ).rejects.toMatchObject({ code: "response_oversized" });

    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([]))]),
      }).collect({ maxBytes: 1 }),
    ).rejects.toMatchObject({ code: "collection_limit_exceeded" });
  });

  it("maps interrupted response streams to unavailability", async () => {
    const interrupted = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([0x7b]));
          controller.error(new Error("disconnected"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    await expect(
      createCanonicalDiscoveryClient({ fetcher: fetchSequence([interrupted]) }).listPage(),
    ).rejects.toMatchObject({ code: "registry_unavailable" });
  });

  it("enforces one total collection deadline and cancels an unread late response", async () => {
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(2);
    const cancellation = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancellation }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const client = createCanonicalDiscoveryClient({
      collectionTimeoutMs: 1,
      fetcher: fetchSequence([response]),
    });

    await expect(client.collect()).rejects.toMatchObject({
      code: "collection_deadline_exceeded",
    });
    expect(cancellation).toHaveBeenCalledOnce();
    clock.mockRestore();
  });

  it("rejects schema violations, invalid calendar times, and excess page entries", async () => {
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse({ ...feed(), unexpected: true })]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });

    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([
          jsonResponse(feed([], { generatedAt: "2026-02-30T12:00:00.000Z" })),
        ]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });

    const alpha = validRelease("alpha");
    const beta = validRelease("beta");
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([alpha, beta]))]),
      }).listPage({ limit: 1 }),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });
  });

  it("rejects a numeric prerelease identifier with a leading zero", async () => {
    const value = validRelease("example", "example-skill", "1.2.3-01");
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([value]))]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });
  });

  it.each([
    ["namespace binding", (value: Release) => (value.namespace = "different")],
    ["skill binding", (value: Release) => (value.skill = "different")],
    ["version binding", (value: Release) => (value.version = "9.9.9")],
    ["canonical URL", (value: Release) => (value.canonicalUrl += "/wrong")],
    ["attestation URL", (value: Release) => (value.attestationUrl += "/wrong")],
    ["published time", (value: Release) => (value.publishedAt = "2026-02-30T10:00:00.000Z")],
    ["trust ordering", (value: Release) => (value.trust.updatedAt = "2026-08-27T09:00:00.000Z")],
    ["future trust", (value: Release) => (value.trust.updatedAt = "2026-08-27T13:00:00.000Z")],
  ])("rejects a release with inconsistent %s", async (_label, mutate) => {
    const value = validRelease();
    mutate(value);
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([value]))]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });
  });

  it.each([
    ["a different host", "https://example.com/skill-press/mirrors/item"],
    ["a GitHub subdomain", "https://api.github.com/skill-press/mirrors/item"],
    ["a different owner", "https://github.com/attacker/mirrors/item"],
    ["a query", "https://github.com/skill-press/mirrors/item?redirect=1"],
    ["a fragment", "https://github.com/skill-press/mirrors/item#redirect"],
    ["userinfo", "https://user@github.com/skill-press/mirrors/item"],
    ["a port", "https://github.com:8443/skill-press/mirrors/item"],
    ["an IP", "https://127.0.0.1/skill-press/mirrors/item"],
    ["encoded path ambiguity", "https://github.com/skill-press/mirrors/%2Fitem"],
    ["a trailing slash", "https://github.com/skill-press/mirrors/"],
    ["a double slash", "https://github.com/skill-press/mirrors//item"],
    ["non-canonical host casing", "https://GITHUB.com/skill-press/mirrors/item"],
    ["an oversized URL", `https://github.com/skill-press/${"a".repeat(400)}`],
  ])("rejects a GitHub mirror URL with %s", async (_label, url) => {
    const value = validRelease();
    (value.mirrors[0] as Mirror).url = url;
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([value]))]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });
  });

  it.each([
    [
      "invalid verification time",
      (mirror: Mirror) => (mirror.verifiedAt = "2026-02-30T11:30:00.000Z"),
    ],
    [
      "pre-publication verification",
      (mirror: Mirror) => (mirror.verifiedAt = "2026-08-27T09:00:00.000Z"),
    ],
    ["future verification", (mirror: Mirror) => (mirror.verifiedAt = "2026-08-27T13:00:00.000Z")],
    ["locator mismatch", (mirror: Mirror) => (mirror.source.locator = "other/skill@1.0.0")],
    ["digest mismatch", (mirror: Mirror) => (mirror.source.artifactSha256 = "e".repeat(64))],
    ["release URL mismatch", (mirror: Mirror) => (mirror.source.canonicalUrl += "/wrong")],
    ["attestation URL mismatch", (mirror: Mirror) => (mirror.source.attestationUrl += "/wrong")],
  ])("rejects a mirror with %s", async (_label, mutate) => {
    const value = validRelease();
    mutate(value.mirrors[0] as Mirror);
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([value]))]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });
  });

  it("requires artifact mirrors to carry the exact release artifact digest", async () => {
    const valid = validRelease("artifact", "skill", "1.0.0", "c", "artifact");
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([valid]))]),
      }).collect(),
    ).resolves.toMatchObject({ totalEntries: 1 });

    const missing = validRelease("missing", "skill", "1.0.0", "d", "artifact");
    delete (missing.mirrors[0] as Mirror).artifactSha256;
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([missing]))]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });

    const mismatch = validRelease("mismatch", "skill", "1.0.0", "e", "artifact");
    (mismatch.mirrors[0] as Mirror).artifactSha256 = "f".repeat(64);
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([mismatch]))]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });

    const listing = validRelease("listing");
    (listing.mirrors[0] as Mirror).artifactSha256 = listing.artifactSha256;
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([listing]))]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });
  });

  it("enforces mirror ID uniqueness within a release and across one page", async () => {
    const duplicate = validRelease("duplicate");
    duplicate.mirrors.push(structuredClone(duplicate.mirrors[0] as Mirror));
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([duplicate]))]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "feed_conflict" });

    const alpha = validRelease("alpha");
    const beta = validRelease("beta");
    (beta.mirrors[0] as Mirror).id = (alpha.mirrors[0] as Mirror).id;
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([alpha, beta]))]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "feed_conflict" });
  });

  it("enforces mirror ID uniqueness and URL source binding across pages", async () => {
    const alpha = validRelease("alpha");
    const beta = validRelease("beta");
    const full = [alpha, beta];
    (beta.mirrors[0] as Mirror).id = (alpha.mirrors[0] as Mirror).id;
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([
          jsonResponse(feed([alpha], { nextCursor: CURSOR_A }, full)),
          jsonResponse(feed([beta], {}, full)),
        ]),
      }).collect(),
    ).rejects.toMatchObject({ code: "feed_conflict" });

    const first = validRelease("first");
    const second = validRelease("second");
    (second.mirrors[0] as Mirror).url = (first.mirrors[0] as Mirror).url;
    const urlFull = [first, second];
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([
          jsonResponse(feed([first], { nextCursor: CURSOR_A }, urlFull)),
          jsonResponse(feed([second], {}, urlFull)),
        ]),
      }).collect(),
    ).rejects.toMatchObject({ code: "feed_conflict" });
  });

  it("rejects one-page mirror URLs bound to conflicting sources", async () => {
    const alpha = validRelease("alpha");
    const beta = validRelease("beta");
    (beta.mirrors[0] as Mirror).url = (alpha.mirrors[0] as Mirror).url;
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([alpha, beta]))]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "feed_conflict" });
  });

  it("allows distinct IDs for one mirror URL only when provenance is identical", async () => {
    const value = validRelease("same-source");
    const second = mirrorFor(value, "mirror_same_source_2");
    second.url = (value.mirrors[0] as Mirror).url;
    value.mirrors.push(second);
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([value]))]),
      }).collect(),
    ).resolves.toMatchObject({ totalEntries: 1, mirrors: [{}, {}] });
  });

  it("rejects conflicting duplicate releases while deduplicating exact page rows", async () => {
    const original = validRelease();
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([
          jsonResponse(feed([original, structuredClone(original)], {}, [original])),
        ]),
      }).listPage(),
    ).resolves.toMatchObject({ entries: [{ locator: original.locator }] });

    const changed = structuredClone(original);
    changed.trust.sequence += 1;
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([original, changed]))]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "feed_conflict" });
  });

  it("rejects cursor repetition, cursor cycles, and cursor pages without progress", async () => {
    const one = validRelease();
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([
          jsonResponse(feed([one], { nextCursor: CURSOR_A, totalEntries: 2 }, [one])),
        ]),
      }).listPage({ cursor: CURSOR_A }),
    ).rejects.toMatchObject({ code: "cursor_cycle" });

    const alpha = validRelease("alpha");
    const beta = validRelease("beta");
    const charlie = validRelease("charlie");
    const full = [alpha, beta, charlie, validRelease("delta")];
    const cycle = createCanonicalDiscoveryClient({
      fetcher: fetchSequence([
        jsonResponse(feed([alpha], { nextCursor: CURSOR_A }, full)),
        jsonResponse(feed([beta], { nextCursor: CURSOR_B }, full)),
        jsonResponse(feed([charlie], { nextCursor: CURSOR_A }, full)),
      ]),
    });
    await expect(cycle.collect()).rejects.toMatchObject({ code: "cursor_cycle" });

    const stalled = createCanonicalDiscoveryClient({
      fetcher: fetchSequence([
        jsonResponse(feed([], { nextCursor: CURSOR_A, totalEntries: 1 }, [alpha])),
      ]),
    });
    await expect(stalled.collect()).rejects.toMatchObject({
      code: "response_contract_invalid",
    });

    const duplicateOnly = createCanonicalDiscoveryClient({
      fetcher: fetchSequence([
        jsonResponse(feed([alpha], { nextCursor: CURSOR_A }, [alpha, beta])),
        jsonResponse(feed([alpha], { nextCursor: CURSOR_B }, [alpha, beta])),
      ]),
    });
    await expect(duplicateOnly.collect()).rejects.toMatchObject({
      code: "response_contract_invalid",
    });
  });

  it("rejects snapshot metadata changes and release conflicts across pages", async () => {
    const first = validRelease("alpha");
    const second = validRelease("beta");
    const full = [first, second];
    const snapshotChanged = createCanonicalDiscoveryClient({
      fetcher: fetchSequence([
        jsonResponse(feed([first], { nextCursor: CURSOR_A }, full)),
        jsonResponse(feed([second], { snapshot: "f".repeat(64) }, full)),
      ]),
    });
    await expect(snapshotChanged.collect()).rejects.toMatchObject({ code: "snapshot_changed" });

    const timeChanged = createCanonicalDiscoveryClient({
      fetcher: fetchSequence([
        jsonResponse(feed([first], { nextCursor: CURSOR_A }, full)),
        jsonResponse(feed([second], { generatedAt: "2026-08-27T12:01:00.000Z" }, full)),
      ]),
    });
    await expect(timeChanged.collect()).rejects.toMatchObject({ code: "snapshot_changed" });

    const totalChanged = createCanonicalDiscoveryClient({
      fetcher: fetchSequence([
        jsonResponse(feed([first], { nextCursor: CURSOR_A }, full)),
        jsonResponse(feed([second], { totalEntries: 3 }, full)),
      ]),
    });
    await expect(totalChanged.collect()).rejects.toMatchObject({ code: "snapshot_changed" });

    const changed = structuredClone(first);
    changed.trust.sequence += 1;
    const conflict = createCanonicalDiscoveryClient({
      fetcher: fetchSequence([
        jsonResponse(feed([first], { nextCursor: CURSOR_A }, full)),
        jsonResponse(feed([changed, second], {}, full)),
      ]),
    });
    await expect(conflict.collect()).rejects.toMatchObject({ code: "feed_conflict" });
  });

  it("enforces entry, mirror, and page budgets", async () => {
    const alpha = validRelease("alpha");
    const beta = validRelease("beta");
    const full = [alpha, beta];
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed(full))]),
      }).collect({ maxEntries: 1 }),
    ).rejects.toMatchObject({ code: "collection_limit_exceeded" });

    alpha.mirrors.push(mirrorFor(alpha, "mirror_alpha_extra"));
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([alpha]))]),
      }).collect({ maxMirrors: 1 }),
    ).rejects.toMatchObject({ code: "collection_limit_exceeded" });

    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([
          jsonResponse(feed([full[0] as Release], { nextCursor: CURSOR_A }, full)),
        ]),
      }).collect({ maxPages: 1 }),
    ).rejects.toMatchObject({ code: "collection_limit_exceeded" });
  });

  it("rejects pages above the launch snapshot and per-release mirror contract", async () => {
    const oversizedTotal = feed([], { totalEntries: 257 }, []);
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(oversizedTotal)]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });

    const release = validRelease("mirror-limit");
    for (let index = 1; index < 9; index += 1) {
      release.mirrors.push(mirrorFor(release, `mirror_limit_${String(index).padStart(8, "0")}`));
    }
    await expect(
      createCanonicalDiscoveryClient({
        fetcher: fetchSequence([jsonResponse(feed([release]))]),
      }).listPage(),
    ).rejects.toMatchObject({ code: "response_contract_invalid" });
  });
});
