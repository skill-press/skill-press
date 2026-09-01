# ADR 002: Decouple CLI releases from Skill distribution

- Status: Accepted
- Date: 2026-08-31
- Scope: npm CLI and Skill Press registry release lifecycles

## Context

`@skill-press/cli` is the developer tool used to build, verify, submit, and install Skills. A Skill
archive is a separately versioned, immutable product artifact that is evaluated and distributed by
the Skill Press registry.

The initial npm workflow required the GitHub Release for every CLI version to contain an exact set
of self-hosted Skill assets derived from the npm package version. This coupled operational CLI
patches to unrelated Skill archive versions and would require repeated Skill evaluation even when
Skill bytes did not change. The v0.1.0 provenance propagation incident exposed this coupling: a
safe verifier fix needs a new immutable npm version, while the self-hosted Skill remains unchanged.

## Decision

CLI and Skill releases have independent versions and release gates.

- A protected `v<package-version>` GitHub Release triggers only the npm CLI release workflow.
- That workflow verifies the tagged source, repository identity, complete quality gates, exact npm
  package inventory, tarball digests, Trusted Publisher provenance, and npm signatures.
- It does not require or publish user-facing Skill archives.
- Skill archives remain governed by `skill-press.yaml`, fresh eligible evaluation evidence, the
  Skill release gate, immutable registry submission, and curator or policy review.
- Unchanged Skill bytes are not re-evaluated merely because the CLI receives a patch release.
- GitHub Release assets may be used for CLI release notes or diagnostics, but they are not the
  canonical Skill distribution channel.

## Consequences

CLI bugs can be fixed with normal semantic versions without manufacturing a matching Skill
version. Skill evaluation remains content-addressed and meaningful. Production deployment
manifests bind the exact CLI publication receipt they actually consume, while Skill publication
continues on its own immutable lifecycle.

The public repository keeps the Skill archive verifier for explicit Skill release or migration
checks, but the npm Trusted Publisher workflow no longer invokes it.
