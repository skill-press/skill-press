# 014e final self-host and release audit

Date: 2026-08-24

Audited local commit: `492c816`

Reviewer: primary-agent adversarial audit. The active collaboration policy prohibited creating a
new review subagent, so this is not represented as an independent review.

## Completed local release evidence

- Self-host `skillpress check --project . --json`: pass, eligible, local readiness 100/100, zero
  diagnostics.
- Self-host `skillpress test --project . --json`: pass; the configured complete repository gate
  exited 0 with bounded output and recorded stream digests.
- `npm run check`: pass; 83 test files and 1154 tests.
- Coverage: 95.97% statements, 94.27% branches, 99.72% functions, and 97.50% lines.
- `npm run security:audit`: pass; zero production dependency vulnerabilities.
- `npm run package:verify`: pass; 364 allowlisted files, 323,808-byte npm tarball, matching SHA-1
  and SHA-512 integrity, script-disabled clean install, CLI 0.1.0, and expected library exports.
- Canonical self-host staging: five tracked files, skill SHA-256
  `9135686ee992324ae3cf0c7ea0d2fc81cfd16eea881a24d31971cd95e0f87f57`.
- Deterministic skill artifact: 12,559 bytes, SHA-256
  `6a6f5d86f896e0b6c6ece5fc74eebafc546773868bbb6c3e67017a66b8a70f2a`, with source-bound
  checksums and package provenance retained in private staging.
- Docker 29.4.0 is available for sandboxed paired evaluation. No eligible live agent adapter/model
  invocation was available, so no local mock was relabeled as external behavior evidence.

## Read-only remote audit

| Target | Observed state | Release decision |
| --- | --- | --- |
| GitHub | public canonical repository exists; remote `main` is `5754a39`; no tag, Release, or Actions run | blocked: local CI/documentation implementation and review commits are not remote |
| npm | `@mushanyoung/skillpress@0.1.0` returns registry 404 | not published |
| Tessl | signed-release-pinned CLI 0.99.0 executable SHA-256 matches the trust set; exact public version archive endpoint returns structured 404 | not published; no Quality/Impact evidence |
| skills.sh | exact detail API returns 401 without Vercel OIDC | derived listing unverified; no write was attempted |
| askill.sh | exact public API record returns 404; official CLI/login unavailable | not published |
| agentskillhub.dev | exact public detail record returns 404 | not imported |
| Agent Skills Hub catalog | upstream path returns 404 and no matching PR exists | not submitted |
| ClawHub | public route responds, but no official CLI/login is available to inspect exact owner/version/files/security state | unverified; a web route alone is not publication proof |

No repository `GH_TOKEN`, `GITHUB_TOKEN`, `TESSL_TOKEN`, npm OIDC variables, or Vercel OIDC token is
present. The local `gh` stored OAuth token has `repo`, `read:org`, and `gist`, but not `workflow`.
HTTPS push was therefore rejected when it encountered the new workflow files. The configured SSH
remote has no usable key in this environment. This is an authentication-scope blocker, not a code
or test failure.

## Fail-closed release decision

No public release mutation was authorized by the available evidence.

1. Current official Tessl Quality and Impact evidence does not exist, so the configured 90/90
   release gate cannot pass.
2. The final source, CI, and documentation commits are not visible on remote `main` because the
   GitHub token lacks workflow-file authority.
3. npm trusted publisher/environment configuration and GitHub release/tag protection require
   owner-side activation; local npm OIDC variables are correctly absent.
4. askill and ClawHub require official CLI login/identity, Tessl requires token/workspace approval,
   skills.sh verification requires Vercel OIDC, and the catalog requires an explicit public PR.

Creating a tag, GitHub Release, npm version, registry import, fork/PR, or public plugin under these
conditions would violate the accepted plan. The implementation is release-ready; live publication
remains intentionally blocked until these external identities, approvals, and scores are supplied.
