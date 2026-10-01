# Native evaluation and submission

Skill Press is replacing mandatory Tessl evaluation with its own paired evaluation
and review path. Do not run paid Tessl evaluation for launch preparation.

Run paired measurements and check their consistency locally:

```sh
skpress eval --suite training --image <digest-pinned-image> --model <model> -- <adapter-argv...>
skpress eval --suite holdout --image <same-image> --model <same-model> -- <same-adapter-argv...>
skpress eval-check \
  --training-evidence .skill-press/runs/<training-run>/evidence.json \
  --holdout-evidence .skill-press/runs/<holdout-run>/evidence.json --json
```

Use an existing explicitly authorized execution backend. These commands do not
install a model, provide an adapter, authorize provider billing or call Tessl.
Default `eval-check` only reads local files. Adapter fixtures used in automated
tests are synthetic protocol tests, not real model-quality evidence.

New runs retain an `evaluationInputsSha256` digest over UTF-8
`JSON.stringify({ suite, rubric }) + "\n"`, using the complete parsed suite and
rubric as loaded by the CLI. This includes expected/forbidden behavior, categories
and rubric descriptions and weights, not just the prompts. Each passed leg retains
judge criterion IDs and scores, without rationale text that may contain secrets.
Historical schema-v1 evidence remains readable, but native checking rejects it
when these new measurement fields are absent. Do not retrofit old runs.

The checker recomputes weighted scores, success flags and aggregate results;
requires complete training and holdout suites, current source/config bindings,
matching model/adapter, digest-pinned images, supported network isolation, fresh
evidence and no custom executor. The native policy uses success fractions: at
least 0.9 success, at least 0.1 absolute improvement over baseline, at least three
repetitions and at most 168 hours age. Stricter project settings still apply.
Per-run readiness is at least 90/100. Judge criteria must carry at least 65/100
weight; activation-only scoring cannot stand in for task quality. Safety scenarios
must pass and no individual scenario may regress against baseline.

These are advisory consistency checks. Authors control uploaded data, including
judge scores; hashes do not prove honest execution or judging. In this protocol,
deterministic rubric criteria measure activation, not transcript quality.
Independent curator execution and review remain necessary.

`releaseAuthorized` is always `false` in this local report. Select the native
protocol explicitly when packaging or submitting; a failed native check never
falls back to Tessl:

```sh
skpress submit --native --dry-run \
  --review-evidence .skill-press/runs/<training-run>/evidence.json \
  --eval-evidence .skill-press/runs/<holdout-run>/evidence.json \
  --eval-source evals
```

The same evidence flags and `--native` work with `package`, `status` and `doctor`.
The historical flag names map review → training and eval → holdout. `doctor`
does not probe Tessl or require its credential in native mode. Omit `--dry-run`
only when authorized to submit to a deployed compatible registry.

Commit `skill-press.yaml`, the canonical skill and `evals` first. Dirty, untracked
or ignored files in these inputs block native packaging. The deterministic
`skillpress.native-evidence` envelope includes source commit/tree hashes, the
complete parsed config, both evaluation suites, rubric and measurement. Treat
all these inputs, including fixture text, as publishable: never include secrets
or private user data. The uploaded scores remain author-supplied claims.

The platform uses versioned `skillpress.native-review` policy v1, independently
checks the envelope schema and recomputes scores, then requires the existing
curator corroboration/independent-rerun decision before publication. This does
not attest that an uploaded model run actually happened. Legacy Tessl evidence
remains a separate compatibility protocol; mixed evidence is rejected.

Deployment needs the platform's forward `0008_native_review_policy.sql` migration
to retain historical reviews while admitting the native policy. Local tests use
synthetic scores and isolated persistence; they do not establish real model
quality, production migration safety or launch readiness.

The npm build retains JavaScript, runtime source maps and TypeScript declarations.
Declaration maps are not generated: their TypeScript sources are not distributed.
This keeps the expanded client within the existing 512-file package inventory
limit without changing that integrity boundary.

## Reviewed text experiments: local assessment only

For an operator-reviewed first-party text project, `eval-check --reviewed-text`
can assess the two source-bound manifests produced by the reviewed text harness:

```sh
skpress eval-check --reviewed-text --project ./candidate \
  --training-evidence ".skill-press/runs/<training-run>/evidence.json" \
  --holdout-evidence ".skill-press/runs/<holdout-run>/evidence.json" --json
```

Replace each run placeholder with the manifest's 64-character run ID. Paths are
relative to the project, not the shell directory. Each JSON file is at most 1 MiB;
use private directories (0700) and files (0600) on Unix. Complete training and
holdout manifests are separate files, not the combined experiment archive.
Commit the configuration, canonical skill and evals before measuring them.

The command reconstructs a private package under `.skill-press/staging/`, checks
current source at entry and exit, and verifies both suites against that package
and the current evaluation inputs. It invokes no models or project test commands.
Supported source content is SKILL.md and an optional LICENSE only; LICENSE is
bound into the full archive but treated as distribution metadata, not model
guidance. Scripts and reference resources require a different execution profile.
Normal project readiness still requires project and canonical-skill licenses.

An exit code of 0 means the advisory checks passed, not release admission:
`releaseEligible` and `releaseAuthorized` remain false, and `admissionIssues`
contains `text_profile_not_admitted`. Failed checks return 3; invalid options
return 2. These results cannot yet feed `submit --native` or replace curator
corroboration. Self-consistent hashes do not attest actual model execution.
The host-networked profile is never relabeled as network-none Docker.
