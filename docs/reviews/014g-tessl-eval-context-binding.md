# Tessl eval context binding review

Date: 2026-08-27

## Decision

PASS after hardening. Release evidence must prove that Tessl evaluated the complete current
canonical skill inside the exact private eval source used for the run. A stable run ID, score,
command digest, and scenario-source digest are insufficient if the provider-visible plugin context
is not independently bound.

## Findings

The original bridge submitted a Tessl plugin source but did not prove that its embedded
`skills/<configured-name>` tree equaled the canonical skill. A plugin could also carry extra skills,
docs, rules, or dependencies. A later snapshot-only design would have moved the positional source
away from its linked Tessl project identity.

The corrected 0.101.0 invocation retains the linked source as the positional project source, passes
a private snapshot as explicit `--context`, and narrows it with `--skill`. Tessl 0.101.0 uses the
explicit context in preference to the positional plugin's implicit context.

A second review found that a fixed snapshot pathname and locally editable command receipts could
allow old provider output to be rebound to changed original and snapshot contents. Provider JSON
does not echo a local tree digest, so the snapshot pathname itself is now content-addressed by the
complete capture-time eval-source SHA-256. The release gate derives that pathname from the current
source digest rather than from an evidence claim.

## Implemented contract

- The eval source root contains only `.tessl-plugin`, `evals`, `skills`, and optional `tessl.json`.
- Plugin metadata is private and metadata-only; there is exactly one configured skill.
- An optional `tessl.json` is vendored and has an empty dependency map.
- The embedded skill validates and its complete tree digest equals the canonical skill digest.
- Capture copies the full source to
  `.skillpress/tessl/<run>/eval-plugin-<source-sha256>` and verifies the copy.
- `eval run` binds `--force`, the content-addressed `--context`, configured `--skill`, optional
  provider selections, run count, and the original linked positional source.
- Capture and release replay require start `context.definition`, final
  `evalRunFixtures.context`, and final `metadata.cliInvocation` to echo the exact request.
- Original source, snapshot, canonical skill, Git/config inputs, CLI executable, raw outputs, and
command receipts are checked again after capture and at the release gate.

As documented in the repository security model, this proves consistency against untrusted provider
output and accidental or partial local drift; it does not prove that a hostile repository owner did
not deliberately rewrite the implementation, every private raw file, and every local hash. Tessl
0.101.0 does not provide a detached provider signature, and same-account hostile processes are
outside the local evidence-storage boundary.

## Verification

- Full repository coverage gate: 92 test files and 1,317 tests passed; the new inspector reached
  94.28% statements, 92% branches, and 93.93% lines.
- Formatting, lint, type checking, generated-file checks, diff checks, and production dependency
  audit passed.
- Independent test, implementation, and release audits exercised extra context, source and snapshot
  drift, missing selectors, provider-echo drift, and old-score laundering. The final release audit
  reported PASS with no release or supply-chain blocker.

The complete repository coverage run is intentionally performed from the signed clean commit,
because self-host recovery tests reject dirty canonical skill inputs by design.
