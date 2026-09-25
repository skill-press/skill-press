import type { CliExitCode, CliIo } from "../cli.js";
import {
  createCanonicalDiscoveryClient,
  DiscoveryClientError,
  type SkillPressDiscoveryClient,
} from "../discovery/client.js";

export const DISCOVER_HELP = `Discover published releases in the canonical Skill Press registry.

Usage:
  skpress discover [name-or-namespace] [--json]

Options:
  --json       Emit one stable JSON object
  -h, --help   Show this help

The optional query matches part of an exact locator, ignoring case. All pages are
collected and the complete snapshot digest is verified before any results appear.
Trust labels describe the feed, not permission to install: add checks fresh signed
trust separately. Quarantined and revoked releases are shown without install hints.
No credentials, local project or account are required. The registry must be online.
`;

export async function runDiscoverCommand(
  args: readonly string[],
  io: CliIo,
  createClient: () => SkillPressDiscoveryClient = createCanonicalDiscoveryClient,
): Promise<CliExitCode> {
  const json = args.includes("--json");
  const positional = args.filter((value) => value !== "--json");
  const query = positional[0] ?? "";
  const usage =
    args.filter((value) => value === "--json").length > 1 ||
    positional.length > 1 ||
    query.startsWith("-") ||
    query.length > 256 ||
    /[\p{Cc}\p{Cf}]/u.test(query) ||
    (positional.length === 1 && query.trim().length === 0);

  async function failure(code: string, message: string, exitCode: CliExitCode) {
    try {
      await io.stderr(
        json
          ? `${JSON.stringify({ command: "discover", ok: false, code, message })}\n`
          : `discover: ${message}\n`,
      );
      return exitCode;
    } catch {
      return 1 as const;
    }
  }

  if (usage) {
    return failure(
      "usage",
      "Use skpress discover [name-or-namespace] [--json]. Run 'skpress discover --help' for details.",
      2,
    );
  }
  try {
    const snapshot = await createClient().collect();
    const releases = snapshot.releases.filter((release) =>
      release.locator.toLowerCase().includes(query.trim().toLowerCase()),
    );
    const human =
      releases.length === 0
        ? snapshot.totalEntries === 0
          ? "No published skills yet. Try again after the first release.\n"
          : "No matching skills. Run 'skpress discover' to list all published releases.\n"
        : `${releases
            .map(
              (release) =>
                `${release.locator} [${release.trust.status}]\n  ${release.canonicalUrl}\n${
                  release.trust.status === "trusted"
                    ? `  Install: skpress add ${release.locator}\n`
                    : "  Installation withheld by the reported trust status.\n"
                }`,
            )
            .join(
              "",
            )}Found ${releases.length} of ${snapshot.totalEntries} published releases. Installation rechecks current signed trust.\n`;
    try {
      await io.stdout(
        json
          ? `${JSON.stringify({
              command: "discover",
              ok: true,
              query: query.trim(),
              snapshot: snapshot.snapshot,
              generatedAt: snapshot.generatedAt,
              totalEntries: snapshot.totalEntries,
              count: releases.length,
              releases,
            })}\n`
          : human,
      );
      return 0;
    } catch {
      return 1;
    }
  } catch (error) {
    if (error instanceof DiscoveryClientError) {
      return failure(
        error.code,
        `${error.message} No discovery results were accepted. Retry later; if this persists, report the error code ${error.code}.`,
        3,
      );
    }
    return failure("internal", "Skill Press could not discover releases.", 1);
  }
}
