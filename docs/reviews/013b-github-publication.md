# 013b GitHub publication review

Date: 2026-08-24

Implementation commit: `bad2a788729dff1a10054da07ebfde9564f8ce6a`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- GitHub identity, authentication, public-repository, and native Agent Skill preflight;
- exact source commit publication and `agent-skills` discovery topic;
- versioned release creation with deterministic package, ZIP, checksums, and provenance assets;
- remote commit, tag, topic, release-state, asset-size, and asset-digest verification;
- no-shell bounded command execution and provider-specific environment projection.

The command contract was checked against the current official GitHub CLI documentation for
`gh skill publish`, `gh release create`, and `gh release view`. A real GitHub CLI 2.98.0 preflight
authenticated as `mushanyoung`, resolved the configured public repository, and passed native skill
validation without mutating the repository.

## Findings and fixes

One release-blocking verification finding was fixed before commit. The first verifier matched asset
names only. GitHub's current release JSON exposes SHA-256 digests and byte sizes, so the final
adapter carries those bindings for all four artifacts and requires exact remote matches.

No release-blocking finding remained after that fix.

- Source publication uses a non-force push of the exact source commit. A different remote main
  fails rather than being overwritten.
- Native `gh skill publish --dry-run` validates repository layout and Agent Skills metadata. The
  adapter uses `gh release create` for execution because the native skill command does not promise
  to attach SkillPress checksum and provenance assets.
- A pre-existing matching release is reused. A release under the same version with incomplete or
  different immutable assets is a conflict and is never clobbered.
- Final verification requires remote main and version tag to equal the source commit, a published
  non-prerelease release, the discovery topic, and every exact asset digest and byte count.
- Commands use explicit argv, bounded output, and only GitHub token variables; provider output and
  exception details are not copied into the publication receipt.

## Verification

- `npm run check`: pass; 73 test files and 1014 tests.
- Coverage: 96.15% statements, 94.61% branches, 99.78% functions, and 97.46% lines; the GitHub
  adapter satisfied 97.22% statements and 90.54% branches.
- Fault injection covered missing auth, private repository, native validation failure, malformed
  provider JSON and refs, push/config/release failures, immutable conflicts, replay, and unknown
  steps.
- Remote `main` resolved to the exact implementation commit after push.

## Residual boundaries

- The authenticated live check was preflight-only. No release or tag was created because Phase 4
  release gates, including current Tessl evidence, are not yet satisfied.
- HTTPS Git source push depends on the user's configured Git credential helper. GitHub CLI auth may
  be valid while Git credentials are not; execution preserves that failure instead of embedding a
  token in argv or a remote URL.
