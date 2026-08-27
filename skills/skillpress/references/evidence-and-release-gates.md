# Evidence and release gates

## Evidence classes

Keep these claims distinct:

- `check` produces deterministic diagnostics and a local readiness score.
- paired sandbox evaluation produces baseline/with-skill behavioral evidence and measured deltas.
- Tessl review and eval produce external Quality and Impact evidence.
- packaging produces content hashes and provenance.
- publication produces a target receipt plus remote verification.

One class never substitutes for another.

## Capture official Tessl evidence

Use the pinned official CLI binary. Quality review:

```sh
skillpress tessl review --project . --workspace <workspace> \
  --executable <absolute-versioned-tessl-binary> --json
```

Impact evaluation:

```sh
skillpress tessl eval --project . --source .skillpress/tessl-evals/<set> --runs <count> \
  --executable <absolute-versioned-tessl-binary> --json
```

Add `--agent` and/or `--model` only when the workspace plan permits explicit selection. The
provider-resolved identities, pinned executable digest, configured thresholds, run ID, and raw
paired results remain part of the evidence binding.

The eval source must be a Tessl plugin whose only injectable content is a valid
`skills/<configured-skill-name>` tree that exactly matches the canonical skill. Tessl evaluates
plugin content, so capture rejects extra skills/docs/rules, snapshots the complete source into
content-addressed private evidence storage, and also rejects any non-empty project dependency map
that could inject hidden context. The private manifest must explicitly declare that sole skill so
Tessl packages it into the plugin context. SkillPress verifies both tree digests, passes the snapshot
as explicit context, and explicitly selects the configured skill. The linked source remains the
positional project source so its Tessl identity is preserved. A temporary nested Git boundary keeps
the complete source inside ignored private storage while preventing Tessl 0.101.0 from excluding the
declared skill; it is removed after every attempt. Provider start and result output must agree on the
exact submitted context or its content-addressed basename normalization and echo the full invocation.
After the provider run and at the release gate, capture repeats the
original/snapshot/canonical checks.

The commands retain bounded raw provider output in private `.skillpress/tessl/` storage. A trusted
version string alone is insufficient: the executable SHA-256 must match the signed-release trust
set. Quality and Impact capture always force fresh provider results; evidence from cached output
created for an older skill context is rejected at the release gate.

## Apply the release gate

Use `checkTesslReleaseGate` with the exact review evidence path, eval evidence path, and current eval
source. A passing report requires all of the following:

- Quality and Impact meet the configured minima, normally 90;
- evidence is current and release-eligible;
- source commit, configuration, canonical skill, embedded eval skill, and eval scenarios are
  unchanged, mutually bound, and clean;
- raw command receipts and provider outputs remain bound and valid;
- every Impact scenario is non-regressing;
- both captures used the pinned trusted Tessl CLI.

If Tessl is unavailable, unauthenticated, still scoring, below threshold, or not approved for public
publication, report the exact blocker. Do not rename local readiness as Quality, derive Impact from
local deltas, accept screenshots or hand-entered numbers as machine evidence, or weaken the gate.

## Fail-closed release decision sequence

When asked whether a release can proceed, lead with `ELIGIBLE` or `BLOCKED`. Include an evidence
inventory that explicitly names the exact source commit, configuration, canonical and scenario-tree
bindings; pinned trusted CLI version and executable digest; configured Quality/Impact thresholds;
and official run IDs, raw evidence paths, scores, validation, eligibility, and regression status.
Mark every unavailable item as missing rather than omitting it.

Then preserve this order explicitly, even when an early blocker makes later steps hypothetical. Do
not compress deterministic packaging, source push plus CI, or the complete provider dry run into a
generic preflight:

1. freeze one clean source commit and pass deterministic checks;
2. capture official Quality and paired Impact with the pinned trusted CLI, meet the configured
   thresholds, and reject every regressing scenario;
3. deterministically package that same commit and retain its provenance and digests;
4. when a configured target requires a public source/CI checkpoint, obtain explicit authority and
   satisfy that target's branch and CI contract without creating a version tag or formal Release;
   the current self-host target set requires the exact source commit on public `main`, with `main`
   as the default branch and every required CI check passing; otherwise record this step as not
   applicable rather than introducing an unrelated mutation;
5. run an initial all-target provider dry run, resolve collisions, identities, credentials,
   first-public provider approvals, license consent, and capability blockers, obtaining separate
   explicit authority before any remediation that mutates provider or account state; then rerun a
   fresh complete all-target dry run until every target preflight succeeds;
6. have the user review that fresh plan and obtain separate explicit authority for the publication
   saga, then execute without reordering targets and preserve the private resumable receipt; the
   current self-host plan places GitHub last, where `publish-release` creates the version tag and
   formal Release only after earlier targets succeed;
7. verify every remote result before reporting `published`.

If any step is missing, stop at that step. List later steps as remediation, not as completed facts.
