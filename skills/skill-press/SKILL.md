---
name: skill-press
description: Use when the user asks to create or harden an Agent Skill, verify readiness, run behavioral or Tessl evaluation, reproducibly package a skill, submit it to Skill Press for review, inspect submission status, or recover an exact failed submission. Do not use for ordinary writing, general application development, unrelated package publishing, or publishing an unreviewed skill to third-party marketplaces.
license: MIT
---

# Skill Press

Use Skill Press for the quality-controlled Agent Skill lifecycle. Skill Press is the canonical
review and trust boundary; GitHub is source infrastructure, npm distributes the CLI, and other
catalogs may only provide discovery or controlled mirrors of an already approved immutable release.

## Choose the operating path

- For creation, hardening, tests, or behavioral improvement, read
  [authoring and evaluation](references/authoring-and-evaluation.md).
- Before making a quality, score, or release-eligibility claim, read
  [evidence and release gates](references/evidence-and-release-gates.md).
- For packaging, canonical submission, status, or recovery, read
  [submission and recovery](references/submission-and-recovery.md).

Read only the references needed for the current request.

## Shared workflow

1. Resolve the project from `skill-press.yaml` and its configured `skill.path`. Reject the legacy
   `skillpress.yaml` filename rather than silently combining old and new state.
2. Keep one portable canonical skill tree. Registry identity, review state, mirrors, and runtime
   projections never belong in `SKILL.md` frontmatter.
3. Run `skpress check --project <root> --json`, then trusted project commands with
   `skpress test --project <root> --json` when the owner authorizes them.
4. Use paired sandbox evaluation for behavioral evidence. Improve only from training failures and
   keep private holdout contents isolated from the authoring role.
5. Capture official Tessl Quality and Impact evidence without inventing scores or replacing them
   with local readiness.
6. Stage only clean tracked canonical files and create deterministic artifacts bound to the exact
   commit, configuration digest, skill digest, checksums, and provenance.
7. Use `skpress submit --dry-run ...` to prepare the exact canonical request locally. A plain
   `skpress submit ...` is a remote mutation to Skill Press and requires separate user authority.
8. Report submission review status exactly. `received`, `automated-review`, `curator-review`,
   `changes-requested`, `accepted`, `publication-blocked`, `rejected`, and `withdrawn` are not
   synonyms for `published`.

## Trust and authority boundaries

- Creation, project tests, external evaluation, packaging, and remote submission are separate
  authorities. A request for one does not imply the next.
- The token comes only from `SKILL_PRESS_TOKEN`; never put credentials or registry endpoints in
  project configuration, command arguments, artifacts, logs, or receipts.
- Skill Press independently validates submissions. Client-side passing checks and advisory
  evidence do not grant trust.
- A published version and artifact digest are immutable. Later `quarantined` or `revoked` trust
  state changes status, never bytes or history.
- Do not offer author-facing multi-publish. Future export is local and deterministic; future
  syndication may copy only an approved canonical release with its URL, digest, and attestation.
- Do not claim installation from the hosted registry until the installed CLI actually exposes a
  verified install command and the canonical API is available.

## Current interface

The CLI requires Node.js 22 or newer; sandboxed evaluation additionally requires Docker or Podman.
The production registry backend, account and token issuer, immutable downloads, and verified
installation are not live yet. Until they are, stop canonical submission at `--dry-run`; do not
substitute a third-party publication target.
The CLI exposes `init`, `check`, `test`, `eval`, `tessl`, `improve`, `package`, `submit`, `add`,
`install`, `status`, and `doctor`. Run the installed command's `--help` before constructing optional
arguments. The typed package exports the lower-level validation, evaluation, packaging, and
submission contracts.
