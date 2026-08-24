# 013a publication saga review

Date: 2026-08-24

Implementation commits: `a3ad8b7619ffa28fb9544ec40ec3a0a8bd721242`,
`054f718c33cdd82efcd047d025e8fd2e80efba2a`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- default dry-run planning and explicit execution;
- publish, submit, and derived capability boundaries;
- target preflight, ordered steps, verification, and fail-closed completion;
- private atomic receipt journaling and idempotent resume;
- authoritative receipt schema and adapter-contract binding.

## Findings and fixes

Two release-blocking recovery findings were fixed after the initial implementation.

1. Receipt loading originally performed only a shallow object/array check. A syntactically valid
   but malformed step status could reach resume logic. Receipts are now validated against a strict
   JSON Schema both before every persistence and after every load.
2. The idempotency key originally bound target IDs but not their executable contracts. It now binds
   capability, auth names, rollback contract, and ordered step IDs; resume also checks the complete
   snapshot, execution flag, storage path, source commit, version, and artifact digest.

No release-blocking finding remained after those fixes.

- Dry-run never invokes an adapter's execute callback and never creates a publication journal.
- Mutating targets cannot omit steps or execution, while derived targets cannot expose either.
- Completed steps are persisted atomically with mode 0600 and skipped during resume. Every
  unfinished target reruns preflight before any further mutation.
- Resume accepts only the fixed private journal path, real parent directories, and a private regular
  receipt file. Provider exception text is not copied into receipts.
- A target is successful only after adapter verification; derived status is distinct and never
  described as published.

## Verification

- `npm run check`: pass; 71 test files and 1004 tests.
- Coverage: 96.13% statements, 94.64% branches, 99.77% functions, and 97.44% lines; publication
  saga coverage was 98.18% statements and 93.63% branches.
- Recovery fault injection covered partial execution, preflight regression, schema corruption,
  adapter-contract substitution, unsafe modes, artifact mismatch, and verified replay.
- Remote `main` resolved to the exact final implementation commit after push.

## Residual boundaries

- A mode-0600 local receipt is a private recovery journal, not a cryptographic provider receipt.
  Provider adapters must capture and verify provider identifiers without persisting credentials.
- Node does not expose an openat-style directory capability. The code rejects symbolic parent
  entries at load time, but cannot claim filesystem-transaction guarantees against a privileged
  concurrent attacker.
