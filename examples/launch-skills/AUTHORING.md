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
For `release-notes`, [the checked-in eval inputs](release-notes-evals/) provide five
training cases (including missing-input and source-injection failures) and two
distinct holdout cases. Copy the three YAML files into that author's `evals/` before
committing. They are scenario inputs, not passing evidence; run the actual model
backend and retain failures. Keep holdout results out of skill optimization.
For `incident-handoff`, [its separate eval inputs](incident-handoff-evals/) provide
five training cases and two held-out tasks, including an observation-cutoff case.
Use only the chosen skill's directory; do not combine the suites. These inputs
are synthetic and have not yet produced recorded behavioral measurements.

```sh
skpress check --project ./candidate --json
skpress test --project ./candidate --json
```

Read each report, not only its exit code. `test` executes your declared commands;
an empty test run proves nothing about behavior. Missing evaluation evidence is
expected at this stage. Keep private `.skill-press/` state ignored.
Commit the exact configuration and canonical source before capturing evidence;
later edits invalidate evidence bound to those inputs.

## Evidence and dry-run submission

Use [native evaluation and submission](../../docs/NATIVE_EVALUATION.md) to capture
real training and holdout evidence through an explicitly authorized backend, then
run `eval-check`. Paid Tessl evaluation is not authorized and is not required by
native mode. Local walkthroughs and synthetic lifecycle fixtures are not substitutes.
Choose the protocol that actually produced your evidence. Source-bound, complete
reviewed host-text receipts use `--reviewed-text`; network-none container paired
evidence uses `--native`. Never relabel one as the other. Text admission supports
only SKILL.md and optional LICENSE, so it cannot evaluate `csv-quality-check`'s
Python script. No provider operation is performed automatically by this example.

`csv-quality-check-evals/` supplies five training cases, two holdout cases and a
rubric for script-assisted evaluation. Their aggregate expectations are checked
against the real profiler, including malformed input, multiline records,
semicolon/BOM handling and embedded instructions. This does not establish model
behavior: the actor must actually choose and use available tools, and baseline
must receive equivalent general computation access without the bundled skill.
The model-to-sandbox bridge is not implemented yet; neither `eval-text` nor the
script smoke test qualifies CSV for release. These developer-visible holdout
fixtures are regression inputs, not proof of an independently unseen evaluation.

For the two text-only skills, `skpress eval-text --project ./candidate --suite
training --dry-run --json` previews the model call count without inference.
After reviewing the first-party inputs, use `--reviewed-inputs --max-model-calls
<preview-count>` instead of `--dry-run`; repeat for `--suite holdout`. See the
linked guide for backend requirements, private checkpoints and cancellation limits.
Keep both returned `evidencePath` values. A quality failure remains a failure;
the command neither submits nor approves a release.

With the resulting real evidence paths, prepare without contacting the registry:

For reviewed text (`release-notes` or `incident-handoff`):

```sh
skpress eval-check --reviewed-text --project ./candidate \
  --training-evidence ".skill-press/runs/<training-run>/evidence.json" \
  --holdout-evidence ".skill-press/runs/<holdout-run>/evidence.json" --json

skpress submit --project ./candidate --reviewed-text --dry-run \
  --review-evidence ".skill-press/runs/<training-run>/evidence.json" \
  --eval-evidence ".skill-press/runs/<holdout-run>/evidence.json" \
  --eval-source evals --json
```

For container-native paired evidence (including executable skills):

```sh
skpress eval-check --project ./candidate \
  --training-evidence ".skill-press/runs/<training-run>/evidence.json" \
  --holdout-evidence ".skill-press/runs/<holdout-run>/evidence.json" --json

skpress submit --project ./candidate --native --dry-run \
  --review-evidence ".skill-press/runs/<training-run>/evidence.json" \
  --eval-evidence ".skill-press/runs/<holdout-run>/evidence.json" \
  --eval-source evals --json
```

Replace run placeholders with actual run IDs; paths are relative to the candidate
project. `review-evidence` maps to training, and `eval-evidence` maps to holdout. Use the same
evidence flags and selected `--native` or `--reviewed-text` protocol for `doctor`,
`package` and `status`. This uses the corresponding release gate and existing
packager; missing/stale/mismatched or quality-failed evidence
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
dry-run rejection have also been exercised. Complete source-bound release-notes
text measurements have run, but training gain was zero and the real dry-run is
blocked. Do not retry unchanged inputs until a pass appears, lower thresholds or
treat synthetic passing scores as permission to submit. The other candidates'
real behavioral qualification and independent corroboration remain unfinished.
Production deployment/admission is not established by local or CI success.
