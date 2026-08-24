# 013f Agent Skills Hub catalog review

Date: 2026-08-24

Implementation commit: `8c70781`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- reviewed submission to the curated `agent-skills-hub/agent-skills-hub` GitHub catalog;
- exact upstream, contributor, fork, branch, commit, pull-request, and canonical-content binding;
- atomic Git Data API branch construction without changing the contributor fork's default branch;
- complete canonical skill-tree contribution, including supporting files and executable modes;
- idempotent reuse of an existing exact branch or open pull request.

The workflow and repository layout were checked against the current upstream README,
`CONTRIBUTING.md`, strict validator entry point, and current GitHub CLI command contracts. Catalog
merge is maintainer-controlled, so this target is correctly represented as `submit`, never as a
direct publication capability.

## Findings and fixes

Four release-significant boundaries were fixed before this review was closed.

1. `gh pr list --head` accepts a branch name, not the `owner:branch` form accepted by `gh pr
   create`. Listing now uses the branch alone and separately verifies `headRepositoryOwner` and
   `headRepository`, preventing both missed idempotent reuse and cross-fork branch confusion.
2. Safe provider subprocesses intentionally receive a minimal environment, which originally
   omitted GitHub CLI's stored-auth location. Both GitHub-backed adapters now pass an explicit
   `GH_CONFIG_DIR` while still limiting token propagation to GitHub token variables.
3. Verifying only the contributed skill subtree could accept a branch containing unrelated
   changes. The adapter now requires exactly one contribution commit and an exact changed-file
   list of added canonical files with matching Git blob SHAs. A branch that has fallen behind
   upstream remains usable only when it has exactly one unique, exact contribution commit.
4. An upstream path could become occupied after preflight. Execute now rechecks the current
   upstream tree and proceeds only when the path remains absent; an exact upstream merge is reused,
   while collisions and provider failures stop before branch construction. A stale merged PR is
   not accepted when the current catalog no longer contains the exact tree.

No release-blocking finding remained after these fixes.

- Fork absence is recognized only from an explicit GitHub HTTP 404; authentication, transport, and
  malformed-response failures remain unavailable.
- Source bytes are rebound to the packaged source commit by provenance, bounded-tree digest,
  `git ls-tree`, byte length, and Git blob SHA before any provider operation.
- All Git Data API request bodies are content-addressed, private, and revalidated on reuse; unsafe
  directory or file replacements fail closed.
- Pull requests must be non-draft, target upstream `main`, originate from the configured fork and
  deterministic branch, and point at the exact verified contribution commit.

## Verification

- `npm run check`: pass; 77 test files and 1089 tests.
- Coverage: 96.07% statements, 94.45% branches, 99.70% functions, and 97.47% lines.
- Catalog adapter coverage: 94.53% statements, 92.21% branches, 96.96% functions, and 97.10%
  lines.
- Fault injection covered malformed Git trees, changed provenance, upstream races, fork identity
  collisions, non-404 lookup failures, every Git Data API construction stage, extra or changed
  contribution files, invalid compare graphs, forged PR owners/repositories/commits, stale merged
  PRs, unknown steps, and idempotent request reuse.

## Residual boundaries

- No fork, branch, or pull request was created during this implementation slice. Those are public
  remote mutations and remain part of the final explicit release run.
- Maintainer review and merge are external to SkillPress. A successful receipt for this adapter
  proves an exact open submission or exact current upstream content; it does not claim that an open
  pull request has already been published by the catalog.
