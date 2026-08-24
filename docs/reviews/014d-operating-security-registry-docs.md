# 014d operating, security, and registry documentation review

Date: 2026-08-24

Implementation commit: `5d4d72f`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- current CLI versus TypeScript API boundary;
- local development, paired evaluation, Tessl evidence, release gate, deterministic package,
  dry-run publication, execution, receipt recovery, and npm trusted-release operations;
- execution, filesystem, evidence, credential, CI, provider, rollback, and disclosure threat
  boundaries;
- exact capability, authentication, verification, status, and rollback semantics for all eight
  configured targets;
- local Markdown link integrity and documentation-to-configuration drift checks.

Current external references were rechecked against the official Node release table, npm trusted
publishing and provenance documentation, GitHub CLI/release documentation, Tessl CLI/plugin/public
lifecycle documentation, the catalog upstream repository, and provider public entrypoints.

## Findings and fixes

Three truthfulness issues were found and corrected before commit.

1. The earlier README said packaging/publication adapters consume the Tessl gate report, but their
   current public signatures do not. The README and runbook now state the real boundary: the
   operator calls `checkTesslReleaseGate`, requires `passed`, and only then invokes staging,
   packaging, and mutation APIs; those APIs never accept manual score inputs.
2. Catalog verification can prove an exact open pull request as well as an exact upstream merge.
   The registry guide initially described only the merged case. It now explains that saga status
   `verified` plus capability `submit` and a PR URL still means review-required, not published.
3. askill remote data contains exact identity/version/frontmatter and raw projected content, not a
   separate Git commit field. Its guide now describes the content as source-bound by local package
   provenance without claiming the provider stores a commit it does not expose.

The final review also confirmed that every named CLI command exists, every non-CLI release action
uses its real exported API, all adapter constructors are in configured order, auth descriptors are
names rather than values, derived/submitted/pending states are not promoted to publication, and
rollback text retains irreversible provider limits.

No release-blocking documentation finding remained.

## Verification

- Focused documentation contract suite: pass; 2 tests.
- Every local Markdown link in the README and three new guides resolves.
- All eight configured provider IDs and all receipt auth descriptors are covered by drift checks.
- `npm run check`: pass; 83 test files and 1154 tests.
- Coverage: 95.97% statements, 94.27% branches, 99.72% functions, and 97.50% lines.
