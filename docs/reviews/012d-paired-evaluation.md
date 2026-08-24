# 012d paired evaluation review

Date: 2026-08-24

Implementation commit: `f58889c4805144c3049d015ee386659cbb8750de`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- strict sandbox-adapter result and paired-evidence schemas;
- private run storage and canonical skill snapshot/digest staging;
- matched baseline/with-skill repetitions and typed fixture requests;
- adapter request, model, criterion, and loaded-skill binding;
- local rubric scoring, behavioral success/delta gates, transcript redaction, and raw retention;
- `skillpress eval` human and JSON workflows.

## Findings and fixes

Three findings were fixed before commit.

1. The first real smoke used a multiline source string as one command argument. The sandbox policy
   correctly rejected its control characters. The smoke was rewritten as a fixed one-line argv;
   the policy was not weakened.
2. A fixed container UID could create a mode-0600 result that a non-root host caller could not read
   on rootful Linux. The runner now pre-creates the sole result file, writable only during the
   container run, then restores mode 0600 immediately afterward.
3. A sandbox-policy rejection occurred after input permissions became read-only, leaving a partial
   run inconvenient to remove. Every pre-execution rejection now restores private owner-writable
   modes before propagating the error.

No release-blocking finding remained after those fixes.

- Both variants receive the same prompt and fixture. The adapter never receives expected or
  forbidden behavior, rubric thresholds, or any holdout outside the explicitly selected suite.
- Every request has a unique SHA-256. A result is invalid unless it echoes that exact digest, run
  id, variant, and model; reports no skill for baseline; and reports the exact staged skill digest
  for with-skill. This proves the pinned adapter consumed the complete request and attested the
  mounted snapshot. It does not claim to prove that a model reasoned about every fixture field.
- Judge criteria must exactly match the rubric's judge criterion IDs. Deterministic activation is
  calculated by SkillPress and cannot be self-awarded by the adapter.
- Engine failure, malformed/extra/oversized result files, missing criteria, digest mismatch,
  timeout, output overflow, cleanup failure, unpinned images, and custom executors all fail closed.
- Raw result and engine output for baseline and with-skill remain under mode-0700 ignored storage.
  Public evidence contains byte counts, digests, and bounded excerpts with registered secret,
  common token/key/private-key, and email redaction.
- `evidenceEligible` means the local paired evidence is eligible to be considered by a later
  release gate. It is not an overall release decision and cannot stand in for Tessl evidence.

## Verification

- `npm run check`: pass; 63 test files and 866 tests.
- Coverage: 96.02% statements, 94.77% branches, 99.71% functions, 97.44% lines. The paired runner
  reached 95.63% statements and 92.20% branches; every measured deterministic source file passed
  the per-file 90% gates.
- Hermetic paired tests cover three repetitions, exact setup transfer, hidden holdout prompts,
  request/digest binding, raw-versus-redacted transcripts, storage modes, nested executable skill
  resources, oversized files, adapter protocol faults, engine faults, and CLI usage failures.
- Real Docker 29.4.0 API and CLI runs used the pinned Python image. The CLI evidence at
  `.skillpress/runs/c60061ee102fb8127fa00c64e212def2fab293c6a79e52f0064ffc6ad3c486a3`
  recorded baseline 0%, with-skill 100%, impact delta 1.0, three repetitions, exact loaded digest
  `882871148eee4616d0cfd797383ff680d4dbd95570db173e3dab1784026c3c48`, and no ineligibility
  reason.
- Built self-host `check`: eligible and 100/100 with zero diagnostics.
- Remote `main` resolved to the exact implementation commit after push.

## Residual boundaries

- Local judge scores remain local behavioral evidence. They are neither Tessl Quality nor Tessl
  Impact, and the future release gate must require current official Tessl receipts independently.
- Staging validates both source and copy and binds all later work to the copied digest. As already
  documented for local creation, a malicious process with the same OS account is outside this
  filesystem isolation boundary; the staged snapshot, not a mutable source path, is what runs.
- The pinned adapter image is a user-supplied integration contract. Provider-specific model and
  judge adapters need their own live evidence and credential preflights.
