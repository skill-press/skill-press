import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliIo } from "../src/cli.js";
import { runDiscoverCommand } from "../src/cli/discovery.js";
import { computeDiscoverySnapshotSha256 } from "../src/discovery/client.js";
import type { Release } from "../src/discovery/generated-feed.js";

function release(
  skill: string,
  status: "trusted" | "quarantined" | "revoked" = "trusted",
): Release {
  return {
    releaseState: "published",
    locator: `example/${skill}@1.0.0`,
    namespace: "example",
    skill,
    version: "1.0.0",
    artifactSha256: "a".repeat(64),
    canonicalUrl: `https://skill-press.com/skills/example/${skill}/1.0.0`,
    attestationUrl: `https://skill-press.com/attestations/example/${skill}/1.0.0`,
    publishedAt: "2026-09-24T10:00:00.000Z",
    trust: { status, sequence: 1, updatedAt: "2026-09-24T10:00:00.000Z" },
    mirrors: [],
  };
}

function page(entries: Release[], all = entries, nextCursor: string | null = null) {
  return {
    schemaVersion: 1,
    feedType: "skillpress.discovery-feed",
    snapshot: computeDiscoverySnapshotSha256(all),
    generatedAt: "2026-09-24T11:00:00.000Z",
    totalEntries: all.length,
    entries,
    nextCursor,
  };
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (value) => {
      stdout.push(value);
    },
    stderr: (value) => {
      stderr.push(value);
    },
  };
  return { stdout, stderr, io };
}

function serve(body: unknown) {
  const fetcher = vi.fn(async () => Response.json(body));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

afterEach(() => vi.unstubAllGlobals());

describe("discovery CLI", () => {
  it("shows help without contacting the registry", async () => {
    const fetcher = serve(null);
    for (const args of [["--help"], ["discover", "--help"], ["discover", "-h"]]) {
      const output = capture();
      expect(await runCli(args, output.io)).toBe(0);
      expect(output.stdout.join("")).toContain("discover");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("collects every page before filtering and gives exact installation hints", async () => {
    const entries = [release("csv-check"), release("release-notes")];
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(page(entries.slice(0, 1), entries, "cursor_1234567890")))
      .mockResolvedValueOnce(Response.json(page(entries.slice(1), entries)));
    vi.stubGlobal("fetch", fetcher);
    const output = capture();
    expect(await runCli(["discover", " CSV "], output.io)).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://skill-press.com/api/v1/discovery?limit=50");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(output.stdout.join("")).toContain("skpress add example/csv-check@1.0.0");
    expect(output.stdout.join("")).not.toContain("release-notes");
    expect(output.stdout.join("")).toContain("Found 1 of 2");
    expect(output.stderr).toEqual([]);
  });

  it("retains trust labels without offering installation for withheld releases", async () => {
    serve(page([release("held", "quarantined"), release("removed", "revoked")]));
    const output = capture();
    expect(await runCli(["discover"], output.io)).toBe(0);
    expect(output.stdout.join("")).toContain("[quarantined]");
    expect(output.stdout.join("")).toContain("[revoked]");
    expect(output.stdout.join("")).not.toContain("skpress add");
  });

  it("returns machine-readable results with snapshot provenance", async () => {
    const entries = [release("csv-check")];
    serve(page(entries));
    const output = capture();
    expect(await runCli(["discover", "--json"], output.io)).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      command: "discover",
      ok: true,
      query: "",
      count: 1,
      totalEntries: 1,
      snapshot: computeDiscoverySnapshotSha256(entries),
      releases: entries,
    });
  });

  it("distinguishes an empty registry from an unmatched query", async () => {
    serve(page([]));
    const empty = capture();
    expect(await runCli(["discover"], empty.io)).toBe(0);
    expect(empty.stdout.join("")).toContain("No published skills yet");
    serve(page([release("csv-check")]));
    const unmatched = capture();
    expect(await runCli(["discover", "missing"], unmatched.io)).toBe(0);
    expect(unmatched.stdout.join("")).toContain("No matching skills");
  });

  it.each([
    ["--json", "--json"],
    ["one", "two"],
    ["--endpoint"],
    ["--help", "--json"],
    ["x".repeat(257)],
    ["bad\u001bquery"],
    [" "],
    [""],
  ])("rejects invalid arguments before fetching: %j", async (...args) => {
    const fetcher = serve(null);
    const output = capture();
    expect(await runCli(["discover", ...args], output.io)).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.stdout).toEqual([]);
  });

  it("rejects an invalid snapshot with no partial results", async () => {
    serve({ ...page([release("csv-check")]), snapshot: "b".repeat(64) });
    const output = capture();
    expect(await runCli(["discover", "--json"], output.io)).toBe(3);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr.join(""))).toMatchObject({
      ok: false,
      code: "snapshot_invalid",
    });
  });

  it("reports unavailable registry and does not leak transport details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private transport details")));
    const output = capture();
    expect(await runCli(["discover"], output.io)).toBe(3);
    expect(output.stderr.join("")).toContain("Retry later");
    expect(output.stderr.join("")).not.toContain("private transport details");
  });

  it("handles unexpected errors and output failures", async () => {
    const output = capture();
    expect(
      await runDiscoverCommand([], output.io, () => {
        throw new Error("private");
      }),
    ).toBe(1);
    expect(output.stderr.join("")).not.toContain("private");
    serve(page([]));
    const broken: CliIo = {
      stdout: () => {
        throw new Error("closed");
      },
      stderr: () => {
        throw new Error("closed");
      },
    };
    expect(await runCli(["discover"], broken)).toBe(1);
    expect(await runCli(["discover", "--bad"], broken)).toBe(1);
    expect(await runCli(["discover", "--help"], broken)).toBe(1);
  });
});
