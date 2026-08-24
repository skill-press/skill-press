# 013i Tessl publication review

Date: 2026-08-24

Implementation commit: `deb6fa1`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- target-only projection of the complete canonical Agent Skill into Tessl's current plugin format;
- public workspace and version identity, authorization, validation, and approval preflight;
- official CLI dry-run and immutable public plugin publication;
- exact remote package download and byte, path, file-count, and executable-mode verification;
- retry safety, credential isolation, pinned CLI trust, and rollback limits.

The implementation was checked against the current Tessl CLI and configuration references,
public-plugin and registry lifecycle guides, the official 0.99.0 CLI help, signed release hashes,
and the bundled official CLI implementation. The plan's original `tile.json` terminology is now
obsolete: current Tessl 0.99.0 publishes `.tessl-plugin/plugin.json`, while retaining `/v1/tiles`
as an internal API route for compatibility.

The official darwin-arm64 archive was downloaded to private temporary storage, matched its
published archive checksum, and produced the already pinned executable SHA-256. Read-only live API
checks downloaded a known public plugin archive and returned an explicit structured 404 for
`mushanyoung/skillpress@0.1.0`.

## Findings and fixes

Six release-significant boundaries were resolved before commit.

1. Tessl's manifest generation changed from tiles to plugins. SkillPress now creates an idempotent
   private projection containing `.tessl-plugin/plugin.json` plus the complete canonical tree at
   `skills/<name>`, with `private: false`; canonical files remain unchanged.
2. A version/name lookup alone cannot prove content identity after a crash. Verification uses the
   official CLI's raw API path to download the exact immutable version, safely parses bounded gzip
   and ustar content, and compares every path, byte, file count, and executable bit.
3. Public visibility is irreversible. The adapter requires an exact successful official dry run
   for the configured public workspace, then states the two-day unpublish window and later manual
   archive boundary in its rollback contract.
4. Version output alone does not establish CLI provenance. Publication now requires both Tessl CLI
   0.99.0 and an executable SHA-256 from the signed-release trust set. Test executors must inject an
   explicit trusted digest; production resolves and hashes the executable itself.
5. Public verification does not need publication credentials, so `TESSL_TOKEN` is withheld from
   version and archive-download commands. Authenticated identity, dry-run, and publish commands
   receive only the explicit token and a non-updating, colorless environment.
6. Archive and retry handling now rejects traversal, absolute and backslash paths, duplicates,
   links, special/PAX entries, invalid checksums, gzip bombs, unexpected files, executable-mode
   changes, malformed provider responses, changed projection storage, and mutation-time state
   races.

No release-blocking implementation finding remained after these fixes.

## Verification

- `npm run check`: pass; 80 test files and 1148 tests.
- Coverage: 95.97% statements, 94.27% branches, 99.72% functions, and 97.50% lines.
- Tessl adapter coverage: 94.24% statements, 92.44% branches, 100% functions, and 97.10% lines.
- Projection coverage: 94.57% statements, 92.12% branches, 100% functions, and 100% lines.
- Fault injection covered untrusted and wrong CLI binaries, missing and malformed credentials,
  workspace-scope mismatch, missing public approval, provider errors, malformed manifests, unsafe
  projection reuse, altered package trees, hostile tar headers, execution-time conflicts, bad
  publication output, exact idempotent reuse, and credential non-disclosure.

## Residual boundaries

- No live publication was attempted. This machine has no installed Tessl CLI or `TESSL_TOKEN`, and
  the required current Quality and Impact evidence and first-public-workspace approval have not
  been obtained.
- Tessl moderation and automatic evaluation happen after publication. SkillPress never maps local
  readiness to Tessl Quality or Impact and will not bypass the separate external release gate.
