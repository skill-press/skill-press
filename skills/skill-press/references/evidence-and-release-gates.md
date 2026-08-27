# Evidence and release gates

## Keep claims separate

- `check` produces deterministic diagnostics and local readiness.
- paired evaluation produces baseline/with-skill behavioral evidence.
- Tessl review and eval produce external Quality and Impact evidence.
- packaging produces hashes and provenance.
- submission produces a private retry journal and a canonical review resource.
- only a canonical published release plus its attestation supports a trusted-release claim.

One class never substitutes for another.

## Capture official Tessl evidence

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

## Apply the gate

`checkTesslReleaseGate` must receive the exact review evidence, eval evidence, and eval source. It
requires configured Quality and Impact minima, fresh eligible evidence, clean unchanged source,
matching canonical and scenario trees, valid raw command receipts, non-regressing Impact scenarios,
and the pinned official CLI.

If Tessl is unavailable, unauthenticated, incomplete, below threshold, or stale, report the exact
blocker. Do not relabel readiness or local behavioral delta as official Tessl evidence.

## Fail-closed sequence

When deciding if submission can proceed, lead with `ELIGIBLE` or `BLOCKED`, then preserve this order:

1. freeze one clean source commit and pass deterministic checks;
2. capture current official Quality and paired Impact and reject regression;
3. deterministically package the same commit and retain provenance and digests;
4. run `skpress submit --dry-run` to bind the canonical manifest without a remote mutation;
5. obtain separate authority for plain `skpress submit`, authenticate only to Skill Press, and
   persist its exact private retry journal;
6. report the server's review state without calling it published;
7. after publication, verify the immutable version, artifact digest, canonical URL, attestation,
   and current trust state.

If an earlier step is missing, stop there. Later steps are remediation, not completed facts. The
server independently reruns validation; a client gate report is advisory input, never self-awarded
trust.
