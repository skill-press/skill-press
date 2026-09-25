# Preparing one launch skill for submission

Work on one skill per author project. The three folders in this repository are
source candidates, not three releases of the CLI's own `skill-press.yaml` project.
Do not run package at the CLI repository root expecting to submit another skill.

## Create and populate the author project

Start from the [complete brief example](../../test/fixtures/create/complete-brief.yaml).
Set the skill name, real repository/author, requested namespace and license to the
intended candidate. Replace its incident scenarios with tasks for the chosen skill
and actual test commands. Do not copy example identities as proof of namespace
ownership. Use a new destination:

```sh
skpress init --brief ./capability-brief.yaml --output ./candidate
```

For the already-authored launch candidates, replace the generated
`candidate/skills/<name>/` instructions with the corresponding tracked source
folder under this repository's `skills/`. Include `scripts/profile.py` for
`csv-quality-check`; copying just SKILL.md loses that capability. Keep the MIT
license and align `project.name`, `skill.name` and `skill.path` in the generated
configuration. The source folder name must match its frontmatter name.

Use the [sample inputs](README.md) for a first run. CSV tests should assert the
actual aggregate counts and unchanged source bytes; the bundled script requires
Python 3.10+. For text skills, retain the actual generated report and assess it
against the supplied records, including missing evidence and misleading input.
Do not replace behavioral review with tests that merely search for headings.
Add separate evaluation scenarios for the project's training and holdout suites.

```sh
skpress check --project ./candidate --json
skpress test --project ./candidate --json
skpress doctor --project ./candidate --json
```

Read each report, not only its exit code. `test` executes your declared commands;
an empty test run proves nothing about behavior. `doctor` may correctly report
missing external tooling/evidence. Keep private `.skill-press/` state ignored.
Commit the exact configuration and canonical source before capturing evidence;
later edits invalidate evidence bound to those inputs.

## Evidence and dry-run submission

Use [the existing operations guide](../../docs/OPERATIONS.md#capture-official-tessl-evidence)
to capture actual official evidence with approved provider access and the pinned
executable. Local walkthroughs and synthetic lifecycle fixtures are not substitutes.
No paid/provider operation is performed automatically by this example.

With the resulting real evidence paths, prepare without contacting the registry:

```sh
skpress submit --project ./candidate --dry-run \
  --review-evidence /absolute/path/to/review-evidence.json \
  --eval-evidence /absolute/path/to/eval-evidence.json \
  --eval-source .skill-press/tessl-evals/your-set --json
```

This uses the existing release gate and packager; missing/stale/mismatched evidence
must block. After preparation, inspect `skpress status --help` to bind status to
the exact artifact directory and private submission receipt. Status is local;
it does not query a live reviewer queue. Preserve the receipt for exact retries.
Remove `--dry-run` only after service availability, account authority and separate
submission approval are established. A successful submission enters review; it
does not mean the skill is published or trusted.

## What has been exercised here

The checked-in `test/launch-skills.test.ts` copies each actual source tree into an
isolated Git author project, stages clean tracked files with the real CLI staging
implementation, packages them and loads/verifies the resulting artifacts. This
tests source/packager compatibility, not the external evidence gate. The separate
platform lifecycle tests actual source bytes with synthetic provider inputs.
The sample `init`, local `check`, test-command execution and missing-evidence
dry-run rejection have also been exercised. Real provider scoring and production
admission remain future release work, not completed local evidence.
