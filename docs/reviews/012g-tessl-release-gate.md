# 012g Tessl release-gate review

Date: 2026-08-24

Implementation commit: `31e766120ee1b2154e587f4a08f19cd1cc80b1fb`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Findings and fixes

The review fixed four release-integrity gaps before commit.

1. Invocation evidence initially omitted exit, signal, duration, and exact byte counts. Both Tessl
   schemas now bind those facts, and the gate verifies successful status, the combined output cap,
   raw lengths, raw hashes, and normalized official argv digests.
2. Trusting capture-time output parsing alone would make the release gate a restatement of an old
   result. The gate now independently reparses raw Quality review, eval submission, and completed
   scenario JSON, recomputes every score/delta/uplift value, and rejects type drift, duplicate or
   unsafe fingerprints, malformed pairings, and aggregate mismatch.
3. Digest equality catches most input drift but did not make current Git cleanliness explicit. The
   gate now checks relevant porcelain status and reports `release.git.dirty` independently from
   config, skill-tree, scenario-tree, and commit bindings.
4. A concurrent source change after the first digest pass could otherwise race the return. Git
   HEAD, relevant status, config bytes, canonical tree, and scenario tree are all sampled again
   after raw evidence verification. Any change fails `release.source.changed`.

No release-blocking finding remained.

- Evidence paths must use private, non-symlink `.skillpress/tessl/<run-id>/evidence.json` storage;
  arbitrary local score files are rejected before parsing.
- Timestamps must be current and not future-dated. Both evidence types must be eligible, use a
  signed-release pinned CLI identity, match current source, and satisfy configured thresholds.
- Quality requires official validation plus the configured minimum. Impact requires its configured
  minimum and nonnegative delta in every scenario.
- There is no manual score parameter. The filesystem-owner trust boundary and absence of detached
  provider signatures are stated explicitly in `docs/RELEASE_GATES.md`.

## Verification

- `npm run check`: pass; 68 test files and 985 tests.
- Coverage: 96.05% statements, 94.69% branches, 99.76% functions, and 97.42% lines. The release gate
  reached 95.54% statements and 95.31% branches; every deterministic file remained above 90%.
- Focused release cases cover a fully passing binding plus stale/future time, ineligibility,
  untrusted identity, low Quality/Impact, regression, dirty/changed config-skill-scenario-commit,
  raw and command tampering, malformed provider variants, unsafe paths/permissions, schema drift,
  missing Git HEAD, invalid clocks, workspace argv, validation failure, and absent baselines.
- Built self-host `check`: eligible and 100/100 with zero diagnostics.
- The feature commit was pushed and the remote main ref resolved to its exact SHA.

## External boundary

No authenticated live Tessl Quality or Impact evidence exists on this machine. The new release gate
therefore correctly remains unsatisfied for an actual SkillPress release; implementation tests do
not masquerade as provider evidence.
