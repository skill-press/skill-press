# 013e Agent Skill Hub publication review

Date: 2026-08-24

Implementation commit: `e642acb`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- public GitHub repository analysis through the documented Agent Skill Hub API;
- explicit unauthenticated import only during the saga execute path;
- exact repository, default branch, skill path, provider slug, and identity checks;
- idempotent reuse and bounded post-import visibility polling;
- public listing verification against canonical bytes and a complete Git blob manifest.

The endpoint paths and response contracts were checked against the current official publishing and
API guides. A real read-only production analyze request found `mushanyoung/skillpress`, default
branch `main`, and `skills/skillpress` with the expected name and slug; it reported
`alreadyImported:false`.

## Findings and fixes

Three release-significant boundaries were resolved in the implementation.

1. Agent Skill Hub intentionally reuses a date-based version when the skill file manifest is
   unchanged. Verification therefore cannot require the provider's `commitSha` to equal a newer
   repository commit that changed only unrelated files. The adapter compares every provider
   `fileManifest` path, Git blob SHA, and size to `git ls-tree` at the packaged source commit, and
   separately compares the exact raw `SKILL.md`.
2. A listing from the expected source can legitimately contain older skill bytes and needs an
   update import. Identity, owner, source, path, branch, and malformed-contract failures are
   conflicts; exact-source content or manifest differences are classified as outdated and may
   proceed through analyze/import.
3. Public import does not require a bearer token but is still a remote mutation. Analyze and detail
   requests are the only dry-run operations. `POST /repos/import` is reachable only from the
   explicit adapter execute step, and grouped results must contain exactly one success and no
   failures before the step is journaled.

No release-blocking finding remained after these checks.

- Canonical GitHub URLs reject credentials, query strings, fragments, malformed owners, and
  noncanonical paths.
- Analyze must return exactly one configured skill path with the expected provider-generated slug,
  non-empty description, repository identity, and `main` default branch.
- Provider and JSON failures never become absence. Only detail HTTP 404 is treated as an absent
  listing, and analyze must still confirm the repository contract.
- Verification polling is bounded to a validated attempt count and interval; identity conflicts
  terminate polling immediately.

## Verification

- `npm run check`: pass; 76 test files and 1043 tests.
- Coverage: 96.11% statements, 94.54% branches, 99.79% functions, and 97.48% lines.
- Agent Skill Hub adapter coverage: 93.93% statements, 94.44% branches, 100% functions, and 98.23%
  lines.
- Fault injection covered malformed repository URLs, unavailable detail and analyze endpoints,
  slug collisions, conflicting identities, malformed JSON and Git manifests, outdated content,
  grouped import failures, changed analysis, unknown steps, eventual visibility, and polling limits.

## Residual boundaries

- The live analyze request was read-only. Import was not executed during this slice because it is
  an unauthenticated public registry mutation and belongs to the final explicit release run.
- Agent Skill Hub manages provider versions as dates rather than consuming SkillPress semver. The
  receipt records the verified provider version while the full manifest binds it to the packaged
  skill content.
