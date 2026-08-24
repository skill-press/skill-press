# 013d askill publication review

Date: 2026-08-24

Implementation commit: `226088d`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- immutable askill versions published through the official CLI;
- target-only `slug` and `version` projection without canonical frontmatter changes;
- package-provenance and staged-tree rebinding before projection;
- exact provider identity, listing metadata, and public raw-content verification;
- idempotent reuse, prior-version upgrades, immutable conflicts, and provider-failure handling.

The contract was checked against askill's current official publishing guide, CLI implementation,
API client, and documented JSON response schema. All provider commands include `--json` where
supported so the official CLI does not enter its startup auto-update path during publication.

## Findings and fixes

Three release-blocking findings were fixed before commit.

1. A failed `askill info` command was initially treated as an absent skill. The adapter now accepts
   absence only when the official JSON error code is exactly `SKILL_NOT_FOUND`; malformed output,
   transport failure, or any other provider error blocks preflight.
2. Existing listings initially had only a boolean verified/not-verified state. The adapter now
   distinguishes an older publishable version, an exact content match, an immutable conflict, and
   an unavailable provider. Semver ordering includes prerelease identifiers.
3. The first older-version implementation retained an exact-version condition and incorrectly
   classified legitimate upgrades as conflicts. A focused adversarial test exposed the condition;
   it was removed and stable/prerelease ordering cases were added.

No release-blocking finding remained after those fixes.

- Projection reads only the packaged private canonical snapshot after checking the provenance file
  hash, source commit, skill identity, and staged-tree digest.
- Projection storage is private and idempotent. Existing mismatched content or non-directory path
  components fail closed; the canonical `SKILL.md` remains byte-for-byte unchanged.
- `askill whoami --json` must resolve to the configured GitHub login before a new local publish.
- Execution accepts the exact `Published @author/slug@version` identity and never treats a
  conflicting immutable version as reusable.
- Verification requires the official JSON listing and exact raw projected `SKILL.md` bytes from
  askill's public API.

## Verification

- `npm run check`: pass; 75 test files and 1036 tests.
- Coverage: 96.15% statements, 94.54% branches, 99.78% functions, and 97.47% lines.
- askill adapter coverage: 95.79% statements, 91.97% branches, 100% functions, and 96.19% lines.
- projection coverage: 96.61% statements, 94.44% branches, 100% functions, and 100% lines.
- Fault injection covered bad provenance, changed staging, malformed frontmatter, unsafe storage,
  unsupported CLI versions, wrong identities, provider failures, malformed JSON, invalid listing
  URLs, raw-content mismatches, semver conflicts, failed publication, and resume-safe reuse.

## Residual boundaries

- The current machine has no `askill` executable, so live login, projection validation, and
  publication remain an explicit provider preflight for Phase 4.
- askill versions are immutable and the provider does not expose a content digest in listing
  metadata. SkillPress therefore binds success to the exact public raw content as well as the
  listing identity and version.
