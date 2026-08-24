# 013g ClawHub publication review

Date: 2026-08-24

Implementation commit: `c153092`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- publication through the official ClawHub CLI with fixed slug, owner, version, source, and file
  identity;
- explicit consent to ClawHub's irreversible MIT-0 distribution terms;
- complete private target projection without modifying canonical Agent Skill frontmatter;
- idempotent exact-version reuse and immutable conflict handling;
- bounded polling of asynchronous security review with exact public artifact verification.

The contract was checked against current ClawHub CLI 0.23.3 source, CLI and publishing guides,
skill format, API schemas, and verification endpoint implementation. SPDX's current MIT-0 text and
identifier were also checked before generating the target-only license file. A live unauthenticated
read-only lookup confirmed that `@mushanyoung/skillpress` is not currently present. The local
machine does not have the ClawHub CLI installed.

## Findings and fixes

Four release-significant boundaries were resolved before commit.

1. ClawHub applies MIT-0 to every published skill, while the canonical SkillPress skill is MIT.
   Publication now requires the exact `licenseConsent: "MIT-0"` constructor value and accepts only
   canonical MIT or MIT-0 inputs. It creates a private full-tree projection with MIT-0 frontmatter
   and license text; canonical files remain byte-for-byte unchanged.
2. A reusable projection initially had no exact-tree check, so an unexpected file inserted between
   retries could enter a provider upload. The projection now reconstructs and compares every file,
   byte, and executable bit, rejects symlinks and special files, and fails on altered or additional
   files.
3. Security review is asynchronous. The adapter distinguishes exact pending content from provider
   failure and terminal suspicious, malicious, or error states; verification polling is bounded
   and success requires a clean exact version rather than merely a successful upload response.
4. ClawHub generates `skill-card.md` after publication and excludes it from the source fingerprint.
   Public manifest verification now ignores only that provider-generated path, then checks the
   remaining count and recomputed fingerprint against the official dry-run plan. All other extra,
   missing, malformed, or changed files are conflicts.

No release-blocking implementation finding remained after these fixes.

- The official dry run must report the exact projection root, slug, display name, project version,
  file count, and 64-digit fingerprint before execution.
- Real execution rechecks the CLI version, owner identity, projection, remote version, and dry-run
  fingerprint immediately before mutation.
- Only explicit HTTP 404/not-found output is absence. Network, authentication, malformed JSON, and
  unexpected CLI output remain unavailable.
- Public verification requires exact owner, slug, display name, version, MIT-0 license, artifact
  manifest, clean security status, and non-adverse moderation state.

## Verification

- `npm run check`: pass; 78 test files and 1103 tests.
- Coverage: 96.02% statements, 94.38% branches, 99.70% functions, and 97.52% lines.
- ClawHub adapter coverage: 96.32% statements, 93.86% branches, 100% functions, and 99.18% lines.
- Projection coverage: 93.02% statements, 90.74% branches, 100% functions, and 100% lines.
- Fault injection covered missing consent, incompatible and malformed licenses, unsafe projection
  reuse, wrong CLI versions and identities, invalid dry-run output, immutable content/owner/license
  conflicts, malformed manifests, generated-card handling, provider failures, rejected scans,
  pending scans, execution-time state changes, unexpected publish output, and polling limits.

## Residual boundaries

- No live dry run or publication was performed because the official CLI is not installed and the
  user has not separately supplied the explicit rights confirmation required for an MIT-0 public
  grant. Installing/authenticating the CLI and granting that consent remain final-release steps.
- ClawHub version withdrawal is operationally reversible, but the public MIT-0 grant and reserved
  version cannot be revoked. The receipt and rollback text state that limitation explicitly.
