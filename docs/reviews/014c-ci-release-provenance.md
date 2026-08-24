# 014c CI and release provenance review

Date: 2026-08-24

Implementation commit: `424edce`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- GitHub Actions CI coverage for Node.js 22, 24, and 26;
- immutable action references, least privilege, credential persistence, cache behavior, and fork
  safety;
- npm package dry run, actual tarball identity and integrity, file allowlist, size bounds, clean
  installation, CLI smoke, and library export smoke;
- release-event, tag, package identity, repository, runtime, and source-commit binding;
- npm trusted publishing through GitHub OIDC with automatic public-package provenance;
- production dependency audit on the newest supported Node.js runner.

The workflow design was checked against the current official Node release table, npm trusted
publishing documentation, GitHub OIDC reference, and the official checkout/setup-node releases.
The pinned action commits resolve to checkout v7.0.1 and setup-node v7.0.0. npm currently requires
npm 11.5.1 or newer and Node.js 22.14.0 or newer for trusted publishing; the release verifier
enforces both instead of assuming the runner image satisfies them.

## Findings and fixes

Two defense-in-depth gaps were found during review and fixed before the implementation commit.

1. The first package verifier compared the actual tarball's file list to the dry run but did not
   repeat the name/version identity comparison. Actual and dry-run package name, version, ID, and
   ordered file manifest must now all agree before installation.
2. The plan calls for release/security checks on the newest supported runtime. A production-only
   high-severity npm audit was added to Node 26 CI and the release job; the current locked runtime
   dependency graph reports zero vulnerabilities.

The final review confirmed these additional boundaries:

- Pull requests receive only `contents: read`; checkout credentials are not persisted; package
  manager caching is disabled; and both official actions are fixed to full commit hashes.
- npm publication responds only to a non-prerelease GitHub Release in the canonical repository,
  checks out its exact tag, runs all gates again, and uses a protected `npm` environment.
- Only the publish job receives `id-token: write`. The workflow contains no npm token or GitHub
  secret reference, and the release verifier rejects `NODE_AUTH_TOKEN` or `NPM_TOKEN`.
- The package verifier accepts only documented release roots, rejects traversal, backslashes,
  duplicates, unexpected files, and oversized archives, and validates both npm's SHA-1 and
  SHA-512 integrity values before a script-disabled clean install.
- A temporary clone tagged at the implementation commit passed the release verifier with Node
  26.7.0 and npm 11.19.0, proving that the tag-to-HEAD check works independently of the active
  development worktree.

No release-blocking workflow or package-verification finding remained.

## Verification

- CI contract suite: pass; 2 tests.
- `npm run package:verify`: pass; 364 package files, clean install, CLI 0.1.0, and library exports.
- `npm run security:audit`: pass; zero production vulnerabilities.
- `npm run check`: pass; 82 test files and 1152 tests.
- Coverage: 95.97% statements, 94.27% branches, 99.72% functions, and 97.50% lines.

## External activation boundary

The workflow is release-ready but was not allowed to publish during implementation. Before the
first npm release, the owner must create/protect the GitHub `npm` environment and configure npm's
trusted publisher for `mushanyoung/skillpress`, workflow filename `release.yml`, environment
`npm`, and the `npm publish` action. A formal release remains blocked by the separate current Tessl
Quality and Impact evidence gate.
