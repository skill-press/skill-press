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
skillpress tessl review --project . --workspace <workspace> --json
```

Impact evaluation:

```sh
skillpress tessl eval --project . --source <eval-directory> --agent <agent> --model <model> --runs <count> --json
```

The commands retain bounded raw provider output in private `.skillpress/tessl/` storage. A trusted
version string alone is insufficient: the executable SHA-256 must match the signed-release trust
set.

## Apply the release gate

Use `checkTesslReleaseGate` with the exact review evidence path, eval evidence path, and current eval
source. A passing report requires all of the following:

- Quality and Impact meet the configured minima, normally 90;
- evidence is current and release-eligible;
- source commit, configuration, canonical skill, and eval scenarios are unchanged and clean;
- raw command receipts and provider outputs remain bound and valid;
- every Impact scenario is non-regressing;
- both captures used the pinned trusted Tessl CLI.

If Tessl is unavailable, unauthenticated, still scoring, below threshold, or not approved for public
publication, report the exact blocker. Do not rename local readiness as Quality, derive Impact from
local deltas, accept screenshots or hand-entered numbers as machine evidence, or weaken the gate.
