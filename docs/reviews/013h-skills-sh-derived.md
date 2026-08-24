# 013h skills.sh derived-status review

Date: 2026-08-24

Implementation commit: `b0b6989`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- derived skills.sh availability from the canonical public GitHub repository;
- exact binding between the packaged source commit and the public default-branch head and tree;
- optional authenticated verification of the current skills.sh detail response;
- read-only publication-saga behavior with no fabricated install or indexing operation;
- credential isolation between GitHub and Vercel OIDC requests.

The contract was checked against the current skills.sh documentation, API documentation, and the
official `vercel-labs/skills` source. The public API currently requires Vercel OIDC authentication;
an unauthenticated live read-only request returned HTTP 401.

## Findings and fixes

Five release-significant boundaries were resolved before commit.

1. skills.sh has no supported direct publication endpoint. Its listing and ranking are derived from
   real CLI installs, so the adapter has no execution step and retains the saga's `derived` status.
   It does not manufacture telemetry or treat a source repository as proof of a public listing.
2. Source readiness now requires an exact public, enabled, non-archived repository whose default
   branch resolves to the packaged commit. Every canonical file mode, blob hash, byte size, and path
   must match the recursive Git tree; extra or missing source files are conflicts.
3. The current detail API is OIDC-protected. Missing OIDC does not block verification of public
   source readiness, but it also cannot become listing success. When supplied, the response must
   match the exact source, slug, commit hash, file list, and file contents.
4. Recursive Git trees contain directory entries. The shared catalog comparison previously rejected
   all nested trees; it now permits tree records while still requiring an exact blob set and rejects
   gitlinks and other unexpected entry kinds.
5. Owner length, whitespace-wrapped credentials, missing staged files, malformed JSON, binary or
   oversized files, duplicate paths, unsafe paths, and token cross-leakage all fail closed.

No release-blocking implementation finding remained after these fixes.

## Verification

- `npm run check`: pass; 79 test files and 1124 tests.
- Coverage: 95.99% statements, 94.30% branches, 99.71% functions, and 97.50% lines.
- skills.sh adapter coverage: 94.00% statements, 91.66% branches, 100% functions, and 96.70% lines.
- Catalog adapter coverage after the nested-tree fix: 94.19% statements, 91.46% branches, 97.05%
  functions, and 96.65% lines.
- Fault injection covered source mismatch, remote head and tree changes, disabled repositories,
  malformed and unauthorized API responses, wrong identities and hashes, file-content changes,
  duplicate and unexpected files, unsafe Git output, credential rejection, credential isolation,
  absence of OIDC, and the no-mutation guarantee.

## Residual boundaries

- The current public listing could not be queried without a Vercel OIDC token. This is reported as
  unverifiable, never as absent or successful.
- Organic indexing depends on genuine user installs. SkillPress intentionally performs no synthetic
  install and makes no claim that a listing or ranking already exists.
