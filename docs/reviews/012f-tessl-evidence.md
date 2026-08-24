# 012f Tessl evidence review

Date: 2026-08-24

Implementation commit: `69a794845123b1331ca04142c28b31f274e780b7`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- signed-release Tessl CLI identity and no-shell bounded invocation;
- official skill lint, Quality review, eval submission, polling, and output parsing;
- canonical/config/eval-source Git and tree-digest bindings;
- private raw-output storage and schema-validated public evidence;
- `skillpress tessl review|eval` CLI contracts and failure classification.

## Findings and fixes

Four findings were fixed before commit.

1. The initial bridge called `tessl skill lint` directly on the canonical skill, but Tessl 0.99.0
   correctly rejects a standalone `SKILL.md` because lint checks publishable plugins. SkillPress now
   creates a private provider projection with `.tessl-plugin/plugin.json`, verifies the staged
   skill's complete tree digest before and after lint, and still runs Quality review against the
   canonical skill. Provider-only metadata never enters canonical source.
2. A pre-existing `.skillpress` symbolic link could have redirected private evidence outside the
   project even though the nested `tessl` directory itself was real. Both storage path components
   are now separately created, lstat-checked as real directories, and permission-normalized before
   a random run directory is created.
3. Hashing the trusted CLI only before execution would not detect an executable replacement during
   a long provider run. The executable digest is now rechecked after lint and again before evidence
   is accepted. Portable execution still cannot eliminate a malicious same-account swap and restore
   between those checks; this residual boundary is documented rather than hidden.
4. Completed eval output could repeat a scenario fingerprint and thereby weight one scenario more
   than once. Fingerprints must now be bounded, non-control strings and unique before aggregate
   Impact is calculated.

No release-blocking finding remained after those fixes.

- The public API has no manual score parameter. Quality comes only from the official review JSON;
  Impact comes only from paired provider assessment results bound to the submitted run.
- Custom executors and executable/version pairs outside the signed 0.99.0 pin are always explicit
  ineligibility reasons. Dirty or concurrently changed inputs cannot silently satisfy a later gate.
- Missing baselines and any per-scenario regression are retained as explicit eval ineligibility;
  malformed, duplicated, mismatched, failed, unknown, or timed-out provider output fails closed.
- Only `TESSL_TOKEN` is forwarded from ambient credentials. Raw bounded streams use private ignored
  storage; returned evidence contains digests and scenario fingerprint hashes, not provider prose,
  scenario text, or tokens.

## Verification

- `npm run check`: pass; 67 test files and 975 tests.
- Coverage: 96.06% statements, 94.67% branches, 99.75% functions, and 97.42% lines. Tessl evidence
  reached 96.62% statements and 93.61% branches; the CLI reached 96.41% statements and 93.57%
  branches; every measured deterministic source file passed its per-file 90% gates.
- Built self-host `check`: eligible and 100/100 with zero diagnostics.
- A real ECDSA-manifest-verified Tessl 0.99.0 macOS arm64 executable passed lint against the
  generated plugin projection. The subsequent official Quality review failed at the expected
  external boundary because this machine is not authenticated; SkillPress returned
  `tessl.review.failed`, emitted no score, and did not substitute local readiness.
- The feature commit was pushed and the remote branch resolved to the exact implementation SHA.

## Residual boundaries

- Live Quality and Impact receipts remain unavailable until `TESSL_TOKEN` or an authenticated
  provider identity and an accessible workspace are supplied. This blocks the live release gate,
  not implementation or hermetic verification.
- The trust pin is intentionally version-specific. Updating Tessl requires signature, archive, and
  extracted-executable verification plus parser contract review as documented in `docs/TESSL.md`.
- Same-account filesystem races cannot be fully eliminated with portable path-based Node.js APIs.
  Run evidence capture in a dedicated account or isolated CI job when the host contains untrusted
  same-account processes.
