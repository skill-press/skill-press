# Evidence and release gates

## Keep claims separate

- `check` produces deterministic diagnostics and local readiness.
- paired evaluation produces baseline/with-skill behavioral evidence.
- `eval-check` checks native paired measurements and source bindings, not execution honesty.
- legacy Tessl review and eval produce separate external Quality and Impact evidence.
- packaging produces hashes and provenance.
- submission produces a private retry journal and a canonical review resource.
- only a canonical published release plus its attestation supports a trusted-release claim.

One class never substitutes for another.

## Select the evidence protocol

| Actual evidence producer | `eval-check` options | `package`, `submit`, `status`, `doctor` |
| --- | --- | --- |
| Container paired `eval` | No profile flag | `--native` |
| Reviewed host `eval-text` | `--reviewed-text` | `--reviewed-text` |
| Reviewed host-model/isolated-Python `eval-tool` | `--reviewed-tool --image <reviewed-digest>` | `--reviewed-tool` |

Never infer a profile from passing scores or relabel evidence. For tool admission,
the fixed reviewed digest is
`python@sha256:05b2b8b732ecd268fee8727a369f936f022d1321b59befd13c30ede22769dcdc`.
The local tool checker requires that image explicitly; downstream gates fix it
without an `--image` option. Checking existing receipts runs no model or container.

```sh
skpress eval-check --reviewed-tool --project . \
  --image python@sha256:05b2b8b732ecd268fee8727a369f936f022d1321b59befd13c30ede22769dcdc \
  --training-evidence <training-evidence.json> \
  --holdout-evidence <holdout-evidence.json> --json
```

All profiles keep source/configuration/artifact and suite bindings. The two reviewed
profiles require private evidence files/directories (0600/0700 on Unix), rebuild a
local package and verify source at entry/exit. Text supports only SKILL.md and optional
LICENSE; scripts/resources require the tool profile. Local checks remain advisory,
and a downstream release gate plus independent curator corroboration are still needed.

## Container-native evaluation

Use complete source-bound training and holdout measurements from the paired sandbox runner:

```sh
skpress eval-check --project . \
  --training-evidence <training-evidence.json> \
  --holdout-evidence <holdout-evidence.json> --json
```

The checker recomputes scores and requires matching model/adapter, digest-pinned images,
supported isolation, complete suite/rubric bindings and fresh measured criterion scores. Policy
requires at least 0.9 success, 0.1 absolute improvement, three repetitions and age at most 168 hours;
stricter project settings apply. Per-run readiness is at least 90/100, judge criteria carry at least
65/100 weight, safety cases pass and no individual scenario regresses. Old evidence missing these
measurement fields is ineligible; do not retrofit it or fabricate judge scores.

The report always has `releaseAuthorized: false`. Hashes and author-supplied scores cannot prove
that a run happened or was honestly judged. The platform independently checks consistency and
requires curator corroboration through independent execution/review before publication. Activation
checks alone are not task-quality evidence. Synthetic test adapters only test the protocol.

For container-native receipts select `--native` for `package`, `submit`, `status` and `doctor`; their historical evidence flags
map `--review-evidence` to training and `--eval-evidence` to holdout. `--eval-source evals` binds
the source suite tree. Native failures never fall back to Tessl. Commit configuration, canonical
skill and evaluation inputs first; dirty/untracked/ignored release inputs block packaging. The
upload includes both suites and the rubric, including fixture text: use publishable synthetic
scenarios, never secrets or private user data. Holdout isolation protects evaluation, not eventual
submission confidentiality.

The same quality minima apply to reviewed text/tool admission. Readiness 100 or a
passing holdout cannot override training impact below 0.1. Report the actual issue
(for example `training:tool.impact.failed`), retain the failed evidence and improve
the underlying task capability before new measurements. Neither higher mean scores
nor successful parsing prove the required success-rate gain.

## Legacy Tessl compatibility only

The following historical protocol is not required for native admission. Do not invoke paid Tessl
evaluation for this project, mix protocols or label native scores as official Tessl scores.

Use the pinned official CLI. Quality review:

```sh
skpress tessl review --project . --workspace <workspace> \
  --executable <absolute-versioned-tessl-binary> --json
```

Impact evaluation:

```sh
skpress tessl eval --project . --source .skill-press/tessl-evals/<set> --runs <count> \
  --executable <absolute-versioned-tessl-binary> --json
```

Provider-resolved identities, the trusted executable digest, thresholds, run ID, raw output, source
commit, config digest, canonical tree, and scenario tree remain bound. Never enter a score manually.

The eval source must inject exactly the configured skill and no hidden dependency context. Skill
Press snapshots it under private content-addressed storage and rechecks original, snapshot, and
canonical digests after the provider run. Raw output stays under `.skill-press/tessl/` with private
permissions. A trusted version string without the signed executable digest is insufficient.

Every weighted checklist totals exactly 100 points and includes a uniquely named `critical_*`
criterion for its release invariants. Critical requirements are conjunctive: the evaluator assigns
zero if any listed invariant is violated. Tessl 0.101.0 names the contextual raw solution
`usage-spec`; its critical criterion must receive full credit even when the aggregate Impact score
would otherwise pass. Returned baseline and
contextual criterion names, weights, and order must match the exact current `criteria.json`
inventories; placeholder, missing, extra, reordered, or reweighted criteria fail closed.

### Legacy gate

`checkTesslReleaseGate` must receive the exact review evidence, eval evidence, and eval source. It
requires configured Quality and Impact minima, fresh eligible evidence, clean unchanged source,
matching canonical and scenario trees, valid raw command receipts, non-regressing Impact scenarios,
and the pinned official CLI.

If Tessl is unavailable, unauthenticated, incomplete, below threshold, or stale, report the exact
blocker. Do not relabel readiness or local behavioral delta as official Tessl evidence.

## Fail-closed sequence

When deciding if submission can proceed, lead with `ELIGIBLE` or `BLOCKED`, then preserve this order:

1. freeze one clean source commit and pass deterministic checks;
2. capture current paired training/holdout measurements and pass native checking;
3. deterministically package the same commit and retain provenance and digests;
4. run `skpress submit --dry-run` with the matching protocol flag to bind the canonical manifest without a remote mutation;
5. obtain separate authority for real submission with that same protocol, authenticate only to Skill Press, and
   persist its exact private retry journal;
6. report the server's review state without calling it published;
7. after publication, verify the immutable version, artifact digest, canonical URL, attestation,
   and current trust state.

If an earlier step is missing, stop there. Later steps are remediation, not completed facts. The
server independently reruns validation; a client gate report is advisory input, never self-awarded
trust.
