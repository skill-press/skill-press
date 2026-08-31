---
name: skill-press
description: Use when the user asks to create or harden an Agent Skill; test, review, or evaluate it; package it reproducibly; publish or submit it through Skill Press; inspect status; install an approved release; or recover an exact failed submission. Do not use for ordinary writing, general application development, unrelated package publishing, or publishing an unreviewed skill to third-party marketplaces.
license: MIT
---

# Skill Press

Use Skill Press to author, validate, evaluate, package, submit, and install trusted Agent Skills.

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
3. Run `skpress check`, then trusted project commands with `skpress test` when the owner authorizes
   them. Proceed only when both commands exit `0` and their JSON reports contain `ok: true`; treat
   exit `3` or `ok: false` as blocked. On failure, fix manually or use bounded improvement, then
   rerun check, test, and training evaluation before testing the unchanged private holdout.
4. Use paired sandbox evaluation for behavioral evidence. Keep private holdout contents isolated
   from the authoring role.
5. Capture official Tessl Quality and Impact evidence without inventing scores or replacing them
   with local readiness.
6. Stage only clean tracked canonical files and create deterministic artifacts bound to the exact
   commit, configuration digest, skill digest, checksums, and provenance.
7. Use `skpress submit --dry-run ...` to prepare the exact canonical request locally. A plain
   `skpress submit ...` is a remote mutation to Skill Press and requires separate user authority.
8. Report submission review status exactly. `received`, `automated-review`, `curator-review`,
   `changes-requested`, `accepted`, `publication-blocked`, `rejected`, and `withdrawn` are not
   synonyms for `published`.

Common local gate:

```sh
skpress check --project . --json
skpress test --project . --json
```

When the owner authorizes the three role commands, run bounded improvement with separate evidence:

```sh
skpress improve --project . \
  --training-evidence <training-evidence.json> \
  --holdout-evidence <holdout-evidence.json> \
  --author-command <author> --reviewer-command <reviewer> \
  --evaluator-command <evaluator> --json
```

After official evidence passes, prepare without contacting the registry:

```sh
skpress submit --project . --dry-run \
  --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> --eval-source <eval-source> --json
```

## Trust and authority boundaries

- Creation, tests, external evaluation, packaging, and remote submission require separate authority.
- Read the token only from `SKILL_PRESS_TOKEN`; never place credentials or registry endpoints in
  configuration, arguments, artifacts, logs, or receipts.
- Skill Press independently validates submissions. Client-side passing checks and advisory
  evidence do not grant trust.
- A published version and artifact digest are immutable. Later `quarantined` or `revoked` trust
  state changes status, never bytes or history.
- Do not offer author-facing multi-publish. Future export is local and deterministic; future
  syndication may copy only an approved canonical release with its URL, digest, and attestation.
- Do not claim installation from the hosted registry until the installed CLI actually exposes a
  verified install command and the canonical API is available.

## Current interface

The CLI requires Node.js 22+; sandboxed evaluation also requires Docker or Podman. The production
registry, token issuer, immutable downloads, and verified install are not live. Until they are,
stop submission at `--dry-run` and do not substitute another publication target.

Commands: `init`, `check`, `test`, `eval`, `tessl`, `improve`, `package`, `submit`, `add`, `install`,
`status`, and `doctor`. Use `<command> --help` for advanced flags. Typed exports provide the same
lower-level validation, evaluation, packaging, and submission contracts.
