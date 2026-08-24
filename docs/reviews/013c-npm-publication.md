# 013c npm publication review

Date: 2026-08-24

Implementation commit: `ef5b209bca9d11c0d11344cee476cb976ef00552`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- scoped package identity, repository, version, public-access, and provenance contract;
- GitHub Actions OIDC trusted-publisher preflight with exact repository and source-commit binding;
- package dry-run, registry reachability, immutable publish, and idempotent version reuse;
- registry signature, SLSA provenance, package subject, digest, source, builder, and transparency
  bundle verification;
- bounded provider HTTP and command transports with credential-specific environment projection.

The contract was checked against current official npm trusted-publishing, provenance, package-view,
and audit-signature documentation. npm 11.19.0 and Node 26.7.0 ran the real package dry-run.

## Findings and fixes

Two release-blocking verification findings were fixed before commit.

1. Presence of `dist.attestations` alone did not bind an existing immutable version to the current
   source commit. The verifier now reads the exact npm registry attestation endpoint and validates
   the SLSA subject, SHA-512, repository, resolved Git commit, GitHub-hosted builder, DSSE signature
   inventory, and transparency-log entry.
2. The first HTTP helper used `arrayBuffer()`, which retained an unbounded response before checking
   size. It now reads and cancels the response stream at the four-megabyte provider limit.

No release-blocking finding remained after those fixes.

- The only package identity accepted is `@mushanyoung/skillpress`; the occupied unscoped name is
  never a fallback.
- An unpublished version requires a GitHub Actions job whose repository and SHA match publication
  context and whose OIDC request variables are present. `NPM_TOKEN` is neither read nor passed.
- npm 11.5.1 or newer is required. Preflight performs registry ping and `npm pack --dry-run --json`.
- Execution uses `npm publish --access public`; trusted publishing automatically creates provenance,
  while package metadata also keeps provenance enabled.
- An existing version is reused only after its remote signature/provenance/source bindings verify.

## Verification

- `npm run check`: pass; 74 test files and 1022 tests.
- Coverage: 96.15% statements, 94.60% branches, 99.78% functions, and 97.47% lines; the npm
  adapter satisfied 96.19% statements and 94.73% branches.
- Real `npm pack --dry-run --json`: `@mushanyoung/skillpress@0.1.0`, 336 files, 1,506,174 unpacked
  bytes, required CLI entrypoint, schemas, license, and README present, and no tarball written.
- Fault injection covered local/token contexts, unsupported npm, registry/pack failures, malformed
  metadata, missing signatures, malformed and wrong-source attestations, publish failure, replay,
  and unknown steps.
- Remote `main` resolved to the exact implementation commit after push.

## Residual boundaries

- The package is not live yet. npm trusted publishing requires a configured publisher relationship
  and a GitHub-hosted workflow; the local machine intentionally cannot satisfy that preflight.
- The adapter validates the signed-bundle structure and source bindings supplied by npm. Phase 4's
  clean installed-package smoke must additionally run `npm audit signatures` so npm performs the
  cryptographic signature and provenance verification with current trust roots.
