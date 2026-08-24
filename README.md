# SkillPress

SkillPress builds, evaluates, packages, and publishes production-grade Agent Skills. It combines
an installable skill with a typed CLI so open-ended authoring stays agent-friendly while quality,
testing, provenance, and publication gates remain deterministic and auditable.

The project is under active development. The future npm package is
`@mushanyoung/skillpress`; the unscoped `skillpress` name belongs to a different project and will
not be used.

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
[`schemas/capability-brief.schema.json`](schemas/capability-brief.schema.json). Exit codes are `0`
for success, `1` for unexpected I/O/internal failure, `2` for usage, `3` for an invalid brief, and
`4` for an unsafe or already-existing output.

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
```

`check` reports a local readiness score and fails closed on invalid canonical skills, missing
licenses or scenario inputs, and project identity mismatches. It never reports a Tessl score.
`test` explicitly runs the configured argv without a shell, confines configured working
directories to the project tree, bounds output and time, and retains only byte counts and digests.
It is a local project-test runner, not the sandbox for untrusted behavioral evaluation.

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

This repository self-hosts the same contract through `skillpress.yaml`, `skills/skillpress`, and
the paired `evals/training.yaml` and private-authoring-boundary `evals/holdout.yaml` inputs.

See [the reviewed implementation plan](docs/PLAN.md) for architecture, security boundaries,
registry capabilities, and the small-commit delivery sequence.

## License

MIT
