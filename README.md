# SkillPress

SkillPress builds, evaluates, packages, and publishes production-grade Agent Skills. It combines
an installable skill with a typed CLI so open-ended authoring stays agent-friendly while quality,
testing, provenance, and publication gates remain deterministic and auditable.

The project is under active development. The npm package identity is `@mushanyoung/skillpress`;
the unscoped `skillpress` name belongs to a different project and will not be used.

```bash
npm install
npm run build
node dist/bin.js --help
```

Create accepts a complete, strictly validated capability brief and refuses partial TODO-style
scaffolds:

```bash
skillpress create --brief capability-brief.yaml --output ./my-skill
skillpress create --brief capability-brief.yaml --output ./my-skill --json
```

The brief contract is defined by
[`schemas/capability-brief.schema.json`](schemas/capability-brief.schema.json). All command exit
codes, including the `create`-only unsafe-output code, are documented in the
[operating runbook](docs/OPERATIONS.md#exit-codes).

The project writer accepts only a bounded, snapshotted rendered manifest. The destination must not
exist: SkillPress claims it atomically, never overwrites an existing path, and keeps an incomplete
marker if unknown concurrent data prevents safe rollback.
The output parent and other processes running as the same operating-system account are a trust
boundary during creation; portable Node.js does not expose the directory-relative filesystem
primitives needed to sandbox a malicious same-account process. Run untrusted work in the isolated
runner introduced by the evaluation workflow, not alongside `create` in the same account.

Run the deterministic local gates from a project root:

```bash
skillpress check --project .
skillpress test --project .
skillpress eval --project . --image <image@sha256:digest> --model <model> -- <adapter-argv...>
skillpress tessl review --project . --workspace <workspace>
skillpress tessl eval --project . --source .skillpress/tessl-evals/<set>
```

The CLI also exposes the complete gated workflow:

```bash
skillpress improve --training-evidence <training-evidence.json> \
  --holdout-evidence <holdout-evidence.json> \
  --author-command <author> --reviewer-command <reviewer> --evaluator-command <evaluator>
skillpress package --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> --eval-source .skillpress/tessl-evals/<set>
skillpress status --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> --eval-source .skillpress/tessl-evals/<set> \
  --artifacts <private-artifacts-directory>
skillpress doctor --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> --eval-source .skillpress/tessl-evals/<set>
skillpress publish --artifacts <private-artifacts-directory> \
  --review-evidence <review-evidence.json> --eval-evidence <eval-evidence.json> \
  --eval-source .skillpress/tessl-evals/<set>
```

Keep generated or holdout Tessl scenarios under the ignored private
`.skillpress/tessl-evals/` tree. Add `--agent` and/or `--model` only when the workspace plan permits
explicit selection; omitting them uses the provider defaults.

`publish` is a non-mutating dry run unless `--execute` is supplied. Resume an executed partial run
with `--execute --resume <private-receipt.json>`. Run each command with `--help` for provider
identity and executable options; ClawHub additionally requires explicit `--accept-clawhub-mit0`.
The configured local saga publishes seven skill-registry targets; npm is deliberately released by
the separate protected GitHub Actions trusted-publishing workflow after the GitHub target succeeds.

`check` reports a local readiness score and fails closed on invalid canonical skills, missing or
invalid scenario/rubric inputs, and project identity mismatches. Scenario suites reject duplicate
or leaked holdout cases after Unicode-aware normalization; rubric weights must total exactly 100.
It never reports a Tessl score.
`test` explicitly runs the configured argv without a shell, confines configured working
directories to the project tree, bounds output and time, and retains only byte counts and digests.
It is a local project-test runner, not the sandbox for untrusted behavioral evaluation.

`eval` runs the same selected scenario without and with the staged canonical skill in separate
Docker or Podman containers. It requires a digest-pinned adapter image by default, disables
networking, applies explicit CPU/memory/PID/filesystem/output/time limits, and verifies that the
adapter consumed the exact request digest and loaded the staged skill digest. Raw baseline and
with-skill results remain under ignored, private `.skillpress/runs/` storage; the returned evidence
contains hashes and redacted excerpts. Local behavioral evidence remains distinct from Tessl
Quality and Impact evidence.

`tessl review` invokes the official `tessl skill lint` and `tessl review run quality --json`
commands. `tessl eval` invokes the official paired `tessl eval run --json` workflow, polls its run
identifier with `tessl eval view --json`, and derives Impact only from the returned scenario
assessments. Omit `--agent` and `--model` to use Tessl's provider defaults when a workspace plan
does not permit explicit model selection. The resolved provider identities remain bound in the
evidence. There is no flag or API for entering scores by hand. Raw bounded provider output is
stored with private permissions under ignored `.skillpress/tessl/` directories; public evidence
retains command/output digests, source bindings, scores, and eligibility reasons.

Evidence is release-ineligible when relevant Git inputs are dirty or change during a run, when a
scenario baseline is absent or regresses, when a test executor is injected, or when the Tessl
executable does not match a digest from the signed pinned release. SkillPress currently trusts
official Tessl CLI 0.99.0. Authenticate it with `tessl auth login`, then confirm the identity with
`tessl auth whoami --json`. See [the Tessl evidence contract](docs/TESSL.md) for the exact commands,
pin update procedure, and failure boundaries.

Before packaging, the operator must call `checkTesslReleaseGate`, which reopens the private evidence
and raw streams, reparses provider results, and rebinds them to current clean Git inputs and
configured thresholds. See [the release-gate contract](docs/RELEASE_GATES.md). The staging,
packaging, and publication APIs do not accept score flags, and remote mutation must not begin
unless the returned gate report passed.

The `improve` command and library export `runBoundedImprovement` coordinate the improvement
lifecycle. Three explicit role commands receive schema-versioned request/response files in fresh
private temporary directories and run without a shell. The author receives only the current
candidate, frozen training scenarios, measured training failures, and remaining budgets; holdout
inputs are delivered only to the evaluator. A proposal is a complete canonical-skill snapshot
limited to `SKILL.md`, `LICENSE`, `assets/`, `references/`, and `scripts/`; SkillPress then enforces
review, deterministic validation, measurable training improvement, and only afterward holdout
non-regression. Accepted candidates replace the canonical tree with a private rollback backup.
The loop stops on repeated non-improvement or iteration, token, cost, and wall-time limits. Its
schema-validated report records digests and metrics, never candidate contents or holdout prompts.

The package also exposes the strict canonical-skill validator used by later readiness and release
gates:

```js
import { validateAgentSkill } from "@mushanyoung/skillpress";

const report = await validateAgentSkill("./skills/my-skill", { expectedName: "my-skill" });
```

Validation creates a bounded resource-tree observation and rechecks it before publishing a result,
without executing the skill. It also checks every retained regular resource-file basename for conventional environment- or credential-like names without reading unlinked contents. It recursively analyzes only local Markdown files reached by
CommonMark links; local images and non-Markdown links are existence-checked, while code spans, bare
paths, and raw HTML are not followed. External URLs are not fetched, and fragment anchors are not
validated. Within already-read Markdown bodies, validation also rejects placeholders found in
analyzer-authorized visible text; code spans and blocks, raw HTML, link or image destinations,
and machine identifiers are excluded. Strictly parsed, decoded `description` and `compatibility`
string values are also checked as complete semantic fields; raw YAML syntax, field names, and
`name`, `license`, `allowed-tools`, and `metadata` values remain excluded. Missing, unsafe,
ambiguous, unreadable, or over-budget resources produce deterministic errors. An `ok: true` report
may still contain portability or target-specific warnings; it is not a readiness score, an
evaluation result, or a publication receipt.

SkillPress distinguishes local readiness from Tessl's official Quality and Impact scores. It will
only report the latter when current Tessl evidence exists, and the release profile defaults to a
minimum of 90 for both.

This repository self-hosts the same contract through `skillpress.yaml`, `skills/skillpress`, the
paired `evals/training.yaml` and private-authoring-boundary `evals/holdout.yaml` inputs, and
`evals/rubric.yaml`.

Operational references:

- [operating and recovery runbook](docs/OPERATIONS.md);
- [security and trust-boundary model](docs/SECURITY.md);
- [registry capability and rollback guide](docs/REGISTRIES.md);
- [reviewed implementation plan](docs/PLAN.md).

## License

MIT
