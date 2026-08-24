# 015a lifecycle CLI completion and final local audit

Date: 2026-08-24

Audited implementation commits: `69a2866`, `c409ff9`

Reviewer: primary-agent adversarial audit. The active collaboration policy did not permit
commissioning a fresh review agent for this slice, so this record is not represented as an
independent review.

## Scope

- real CLI workflows for bounded improvement, gated packaging, publication dry-run/execute/resume,
  release status, and environment diagnosis;
- strict package reload, receipt read/semantic validation, source/evidence/artifact bindings, and
  fail-closed exit codes;
- separate author/reviewer/evaluator subprocesses, private request/response transport, holdout
  isolation, candidate validation, atomic acceptance, and rollback;
- self-host documentation, CLI help, generated schema/type drift, npm package contents, and the
  remaining external release boundary.

## Adversarial findings and fixes

The review found and corrected six release-significant issues before this record:

1. The accepted plan named five user workflows that were not exposed by the installed CLI.
   `improve`, `package`, `publish`, `status`, and `doctor` now have strict parsers, stable JSON and
   human output, documented exit codes, main-dispatch coverage, and package-root APIs where
   appropriate.
2. The first publication wrapper treated any dry-run receipt as success. It now returns blocked
   unless every target preflight is successful.
3. Packaging initially checked the Tessl gate only before artifact creation. The command now
   reopens and rechecks the gate after packaging and rejects a changed source commit.
4. JSON Schema alone allowed cross-field-incoherent receipts. Persisted and resumed receipts now
   enforce execution/storage/status, target/preflight, derived-step, completed, failed, and blocked
   invariants; mutation tests cover schema-valid forgeries.
5. Role request files initially lived below the project improvement run, which could expose prior
   evaluator holdout requests to a later author process. Every call now uses a fresh private system
   temporary directory that is removed in `finally`; author payload tests prove holdout scenario
   identifiers are absent.
6. A real self-host `doctor` run showed that `gh --version`, when invoked without a home directory,
   created `.local/state/gh/device-id` in the project. All probes now share an isolated private
   temporary HOME/XDG tree and remove it in `finally`; a regression test writes probe state there
   and proves the tree is gone after diagnosis.

The final audit also exercised permissive evidence/artifact files, unsafe parents, stale bindings,
divergent `.skill`/`.zip` bytes, malformed provider responses, role failure/abort, dirty Git input,
candidate tampering, live-project drift, receipt forgeries, output-sink failures, and credential
redaction. No release-blocking local implementation finding remains.

## Final local verification

- `npm run check`: pass; 89 test files and 1249 tests.
- Coverage: 96.11% statements, 94.39% branches, 99.67% functions, and 97.52% lines; every covered
  source file satisfies the repository's per-file 90% statement/branch threshold.
- `npm run security:audit`: pass; zero production dependency vulnerabilities.
- `npm run package:verify`: pass; 406 allowlisted files, 365,548-byte tarball, SHA-1
  `666627de548d9b66808dcc849641b7ef6e139d47`, SHA-512 integrity
  `sha512-u/ImheoGPXb3qWaRtc8F9V3amGFAleJCOL/08jA4InbLDcsH6CFI/5xRqqxvdowLiCf/zWepaQUjO/nR71Tw+w==`,
  lifecycle-disabled clean install, CLI version 0.1.0, and root API smoke.
- Final self-host `check`: eligible, readiness 100/100, zero diagnostics.
- Final self-host `test`: pass; the configured full quality command exited 0 with bounded output
  and SHA-256 stream receipts.
- Final self-host canonical staging at `c409ff947c874e921b16f254c02faef41c27520a`: five tracked
  files, skill SHA-256 `ef86ff914b4f2ea75a097797e54da5df28630b0d6e9cf054d74a942080182670`.
- Two final staging/package runs produced the same 14,168-byte skill archive with SHA-256
  `ce316dc2e52185cd19e38cd892b6ecf4c945b18bf7529478275529776769c6a3`; the strict package loader
  reopened and verified the complete inventory, checksums, provenance, and bytes.
- Self-host `status` correctly exits 3 with `status.evidence.missing`; `doctor` correctly exits 3
  for missing official evidence and unavailable Tessl/askill/ClawHub CLIs while reporting local
  Node, Git, Docker, npm, GitHub CLI, readiness, and collision checks without printing secrets or
  leaving project state.

## External release decision

The public GitHub `main` remains `5754a394adbe565e5eed72631eb3001cb058ed0b`, with no Actions run
and no GitHub Release. Seven implementation/documentation commits are ahead locally before this
record. SSH push authentication is unavailable. HTTPS push was also rejected because the active
OAuth token has `repo`, `read:org`, and `gist`, but not the `workflow` scope needed to add
`.github/workflows/ci.yml`. The npm registry returns 404 for
`@mushanyoung/skillpress@0.1.0`.

No tag, Release, npm publication, registry mutation, catalog pull request, or public plugin was
created. Current official Tessl Quality and Impact evidence does not exist, so the configured 90/90
gate cannot pass. npm trusted-publisher/environment setup and provider-specific identities,
credentials, approvals, and explicit publication authority also remain external prerequisites.
Local implementation is ready; public release and a fresh independent review remain fail-closed
rather than being inferred from hermetic tests.
