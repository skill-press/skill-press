# Native evaluation and submission

Skill Press is replacing mandatory Tessl evaluation with its own paired evaluation
and review path. Do not run paid Tessl evaluation for launch preparation.

Choose the producer's protocol before using the commands below: container `eval`
uses default `eval-check` and `--native` downstream; `eval-text` uses
`--reviewed-text`; `eval-tool` uses `--reviewed-tool` (and an explicit reviewed
`--image` for its local checker). These are distinct receipts, not interchangeable
flags. For scripts/resources, start with [public tool evaluation](#public-tool-evaluation)
and [tool submission](#reviewed-tool-submission). Existing complete evidence can
be checked without running a model again.

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

## Reviewed execution profiles

The internal `runReviewedPythonTool` primitive prepares the script-assisted CSV
path. It is used by the public `eval-tool` evaluator and separate reviewed-tool
admission described below; calling this primitive alone is not qualifying evidence.
It stages only supplied text bytes, never caller-provided host paths, and executes
Python through the existing pinned Docker runner. `/skill` and `/input` are
read-only; `/tmp` and `/output` each have an 8 MiB tmpfs limit, with no writable
host bind. Each call is stateless, runs as UID 65532 without network, and has a
30-second execution timeout and 64 KiB output limit. The timeout does not cover
all staging/cleanup time and does not implement caller-requested cancellation.
The trusted caller must choose a reviewed image digest and check execution status
and forced-cleanup results; image-name validation is not a trust allowlist.

The existing CSV sandbox smoke script now exercises this primitive's real profiler,
empty baseline skill mount, read-only/network boundaries, tmpfs capacity and output
overflow cleanup. It uses fixed test Python, not model-generated actions, so it
does not establish model tool use. `runReviewedToolActor` now connects the existing
host ChatGPT adapter to this primitive using an explicit JSON action protocol.
Tool actor v2 additionally uses Codex's `--output-schema` with one fixed, private
schema and records its digest. It still strictly parses the response locally;
refusal, malformed output or provider/schema failure never enables a fallback.
The old v1 pilot's plain-text final response remains retained as a failed run.
`runReviewedToolPair` now runs observed metadata selection, equal-tool baseline
and selected-skill actors, and fresh judges that see actual Python code/results.
It reuses the existing rubric parser and weighted-score calculation, with at most
11 serial model calls per pair. Every selection, actor step/result and judge
response is checkpointed before continuing; malformed output is retained and
neither provider nor persistence failures are retried. `runReviewedToolSuite`
applies the configured repetitions/readiness, suppresses partial-run aggregates
and reports a separate tool-profile manifest. These internal helpers alone do not
establish prepared-project artifact binding or server admission; do not submit their
results as text-v1 or infer release eligibility from their scores.
`prepareReviewedToolProject` now stages the complete canonical skill tree,
preserves exact UTF-8 resource bytes, and binds configuration, both suites,
rubric and verified release archive. `runPreparedReviewedToolSuite` snapshots
that reviewed preparation and verifies source/resources/artifacts at entry and
exit, not between individual calls. Missing, added or changed prepared resources
are rejected against a fresh canonical staging. This removes the missing-artifact
binding flag only after exit verification. The measurement helper accepts a
reviewed caller image; the separate tool submission gate below restricts admission
to the server-reviewed image. Binary resources are unsupported by this byte-staged text interface.
See [Codex structured outputs](https://learn.chatgpt.com/docs/non-interactive-mode).
It permits at most three tool requests/four model attempts, records each prompt,
response and actual tool result, and never sends expected/forbidden behaviors to
the actor. Baseline receives the same interpreter without skill files. Normal
Python exits 1/2 may be interpreted by the model; Docker startup/reserved or other
unsupported exits, signal termination, infrastructure failure, invalid
responses, failed cleanup and exhausted limits stop the run without automatic
retry. A persistence callback receives isolated copies and can stop the run by
failing. Abort signals reach model calls and stop subsequent tool requests; an
already-running container still relies on its timeout. This is harness-mediated
tool use, not native Codex tool execution or a claim that host inference is offline.
Source-bound trajectories, paired scoring and explicit reviewed-tool admission
are implemented in the current candidate, as described below. This does not
establish qualifying real quality or production availability. Text-v1 evidence
continues to reject script-bearing skills.

### Reviewed text evaluation

Generate receipts with the public `eval-text` command after committing and reviewing
the first-party skill, both suites and rubric. Preview does not invoke models:

```sh
skpress eval-text --project ./candidate --suite training --dry-run --json
skpress eval-text --project ./candidate --suite holdout --dry-run --json
```

Only after reviewing those inputs and the displayed call counts, run each suite
with an explicit cap (these examples assume five training/two holdout scenarios
and three repetitions; use your preview's count):

```sh
skpress eval-text --project ./candidate --suite training --reviewed-inputs --max-model-calls 75 --json
skpress eval-text --project ./candidate --suite holdout --reviewed-inputs --max-model-calls 30 --json
```

This uses the existing reviewed Codex CLI 0.160.0 backend, `gpt-6.1-sol` / medium,
forced ChatGPT login, without Tessl or API-billing fallback. Calls are serial,
five per pair; the cap bounds harness calls, not provider-internal retries.
Only SKILL.md and optional LICENSE are supported. This is host-networked execution
for reviewed first-party inputs, not an untrusted-code sandbox. No project test
command is executed. Progress goes to stderr; the final report on stdout supplies
`evidencePath`. Prompts and answers remain in private, Git-ignored files under
`.skill-press/runs/`, with per-pair checkpoints retained on failure. SIGINT/SIGTERM
requests cancellation without guaranteeing remote cancellation. No automatic retry
or resume is performed; do not rerun unchanged quality failures to chase a pass.
Exit 0 means this suite passed advisory checks (or preview is ready), not publication
approval. Both suites and subsequent admission checks remain required.

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
contains `release_gate_required`. Failed checks return 3; invalid options
return 2. These results cannot feed `submit --native` or replace curator
corroboration. Self-consistent hashes do not attest actual model execution.
The host-networked profile is never relabeled as network-none Docker.

### Versioned text wire contract and submission

`schemas/reviewed-text-evidence.schema.json` describes complete, source-bound
text measurements. `schemas/reviewed-text-envelope.schema.json` wraps one
measurement with both evaluation suites and the rubric, using the distinct
`skillpress.reviewed-text-evidence` discriminator. Unknown versions, unknown
fields, incomplete checkpoints and mixed container/text identities are rejected.
Structural validation does not establish source consistency, quality or execution;
the receiving side must also recompute those claims and require curator verification.

The exported `prepareReviewedTextEvidence(project, paths, now?)` prepares
deterministic `reviewBytes` (training) and `evaluationBytes` (holdout), each bounded
to the existing 1 MiB upload limit including the complete evaluation inputs. It
uses the same private-file loader, fresh source/package binding and assessment as
the local command, with Git checks at entry/exit. It performs no model invocation,
project test execution, network upload or release authorization. Inspect its
`report`: structurally valid evidence can still fail quality/readiness, and all
reports retain `release_gate_required`. Invalid wire structure or excessive
encoded size throws instead of producing upload bytes. This API prepares the
contract without granting submission or publication permission by itself.

Use the distinct text gate for submission preparation:

```sh
skpress package --reviewed-text --project ./candidate \
  --review-evidence ".skill-press/runs/<training-run>/evidence.json" \
  --eval-evidence ".skill-press/runs/<holdout-run>/evidence.json" --eval-source evals
skpress submit --reviewed-text --project ./candidate \
  --review-evidence ".skill-press/runs/<training-run>/evidence.json" \
  --eval-evidence ".skill-press/runs/<holdout-run>/evidence.json" --eval-source evals --dry-run
```

`status` and `doctor` accept the same protocol/evidence options. Text inspection
does not require Tessl or a container runtime. These commands do not invoke a
model or execute project test commands. Removing `--dry-run` requests a real
authenticated submission to the canonical service; it is not a deployment or
publication command. Do that only when the intended service supports the policy
and the operator has approved the submission.

The local `skillpress.reviewed-text-release` gate recomputes both suites and
readiness, and checks source/package bindings again when preparing upload bytes.
Failed, stale, malformed or mixed-profile evidence blocks before upload. The server
must support `skillpress.text-review` v1 and migration 0010, recompute against the
actual uploaded ZIP and require explicit curator approval with independently
obtained corroboration. The current candidate has local/CI support; this does not
mean the production service is deployed.

Original measurements retain their producer-era `releaseEligible:false` and
`text_profile_not_admitted` markers unchanged. The new gate evaluates those
advisory receipts under an explicit admission policy; it does not turn historical
markers into execution attestation or grant release authorization. Quality failures
remain failures. A passing synthetic lifecycle is not actual launch-skill quality.

## Public tool evaluation

`eval-tool` exposes the existing reviewed first-party tool evaluator. Preview
before executing; review every skill resource, both suites and the rubric.

```bash
skpress eval-tool --project ./candidate --suite training --dry-run --json
# After reviewing inputs, use the previewed maximum (15 pairs would require 165):
skpress eval-tool --project ./candidate --suite training \
  --reviewed-inputs --max-model-calls 165 --json
```

Run holdout separately with its own preview. The fixed image matches the tool
submission policy below. Each pair permits at most eleven explicit model calls;
the cap does not measure provider-internal retries. The host model is networked,
while Python uses the existing Docker isolation and resource/time limits. This
does not authorize unreviewed third-party inputs. Only existing ChatGPT entitlement
is used, with fixed gpt-6.1-sol/medium; no paid Tessl/API fallback or automatic retry.
Dry-run invokes neither models nor containers, though it prepares a local package.

Selection, actor steps/results and judges are written under a private ignored
checkpoint directory before continuing, followed by private pair records and
canonical `.skill-press/runs/<run-id>/evidence.json`. Progress contains stage/counts,
not answers or prompts. SIGINT/SIGTERM forwards cancellation and prevents subsequent
calls; provider-side cancellation is not guaranteed. Keep partial checkpoints after
failure. Source changes, persistence errors and incomplete execution cannot produce
a passed report. Exit 0 is preview readiness or advisory suite success; 3 means
blocked/incomplete. Both suites and independent curator acceptance are still needed.
No submission, publication or deployment is performed by this command.

## Reviewed tool submission

Check existing source-bound tool evidence locally before submission preparation:

```bash
skpress eval-check --reviewed-tool --project ./candidate \
  --image python@sha256:05b2b8b732ecd268fee8727a369f936f022d1321b59befd13c30ede22769dcdc \
  --training-evidence .skill-press/runs/<training-run>/evidence.json \
  --holdout-evidence .skill-press/runs/<holdout-run>/evidence.json --json
```

This does not run or pull the image. It checks the reviewed digest rather than
inferring it from uploaded receipts. Keep source and receipts unchanged; source
updates require new evidence, not changing the recorded source ID. A training
impact failure remains blocking even when readiness and holdout pass.
Without `--json`, `eval-check`, `package` and `submit` retain the issue codes in
their output; reviewed text/tool impact failures also explain that the measured
success-rate gain is insufficient and that unchanged retries are not a remedy.
`--json` retains the existing machine-readable reports and exit codes.

For reviewed first-party tool measurements, `package`, `submit`, `status` and
`doctor` accept `--reviewed-tool` instead of `--native` or `--reviewed-text`.
The release gate requires `--eval-source evals` and fixes the interpreter to
`python@sha256:05b2b8b732ecd268fee8727a369f936f022d1321b59befd13c30ede22769dcdc`.
It does not accept a custom image or infer one from uploaded receipts.

```bash
skpress package --reviewed-tool --project ./candidate \
  --review-evidence .skill-press/runs/<training-run>/evidence.json \
  --eval-evidence .skill-press/runs/<holdout-run>/evidence.json --eval-source evals
skpress submit --reviewed-tool --project ./candidate --dry-run \
  --review-evidence .skill-press/runs/<training-run>/evidence.json \
  --eval-evidence .skill-press/runs/<holdout-run>/evidence.json --eval-source evals
```

The gate reuses bounded private ingestion, exact source/resource/archive checks
and paired quality assessment; failed quality, stale or mixed receipts cannot
fall back to text/native/Tessl. Upload preparation rechecks the exact package and
emits distinct tool envelopes. These commands perform no model or container
execution; doctor does not require Docker or Tessl for checking existing receipts.
Server support requires `skillpress.tool-review@1` and migration 0011. Local/CI
support does not establish production deployment. Independent corroboration and
explicit curator acceptance remain mandatory; original advisory markers remain
unchanged. Real launch candidates still need qualifying quality results.
