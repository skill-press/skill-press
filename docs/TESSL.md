# Tessl evidence contract

Skill Press treats Tessl Quality and Impact as external evidence. It never translates local
readiness, local paired evaluation, curator opinion, or a user-supplied number into a Tessl score.

Tessl is an evidence provider, not a Skill Press publication target. Capturing a Tessl result does
not submit, accept, publish, trust, quarantine, or revoke an Agent Skill.

## Authentication and pinned executable

Skill Press currently trusts official Tessl CLI 0.101.0 by executable digest. Install the official
CLI, authenticate, and inspect the active identity:

```bash
tessl login
tessl auth whoami --json
```

For a non-interactive captured run, create a bounded-lifetime key with the pinned CLI:

```bash
tessl api-key create --workspace <workspace> --name <name> --role publisher \
  --expiry-date <YYYY-MM-DDT00:00:00Z>
```

Export the value shown once as `TESSL_TOKEN` in the shell that starts Skill Press. Do not use the
newer documentation's `tessl auth token` spelling with pinned CLI 0.101.0; that command is not
available in this version. Never paste the token into chat or commit it. Rotate it after the
bounded evidence or release window.

Automatic updates are disabled for captured runs:

```bash
export TESSL_AUTO_UPDATE_INTERVAL_MINUTES=0
```

Pass `--executable <absolute-versioned-binary>` to `skpress tessl review` and
`skpress tessl eval`. The path must identify the extracted 0.101.0 executable whose SHA-256 is in
the signed trust set, not an installer, shim, or auto-updating launcher. A version string alone is
not trusted.

## Exact provider commands

Skill Press invokes these no-shell argv shapes:

```text
tessl --version
tessl skill lint <private-plugin-projection/.tessl-plugin/plugin.json>
tessl review run quality --json --force [--workspace <workspace>] --threshold 0 <canonical-skill>
tessl eval run --json --force --context <private-eval-snapshot> --skill <configured-name> [--agent <agent>] [--model <model>] --runs <count> <linked-eval-source>
tessl eval view --json <run-id>
```

Every official Quality and Impact capture uses `--force` so an older provider cache cannot satisfy
the release gate for changed source.

Agent and model selection are optional. When omitted, Tessl selects workspace defaults; Skill
Press binds the resolved agent and model returned by the provider plus the exact command digest
without selection flags. This supports plans that do not permit explicit model selection without
weakening evidence identity.

## Quality capture

Run:

```bash
skpress tessl review --project . --workspace <workspace> \
  --executable <absolute-versioned-binary> --json
```

The lint command needs Tessl plugin context, so Skill Press creates a private temporary plugin
manifest and copies the complete canonical skill into it. It verifies the full tree digest before
and after lint. The generated manifest never enters canonical source, the package, or Git.

The review bridge reads `review.reviewScore` and `validation.overallPassed` only from the official
JSON result. Raw output is bounded and hashed. There is no CLI option or library API for entering a
Quality score manually.

## Impact capture

Keep a private linked Tessl eval project under:

```text
.skill-press/tessl-evals/<set>
```

Run:

```bash
skpress tessl eval --project . \
  --source .skill-press/tessl-evals/<set> \
  --executable <absolute-versioned-binary> \
  [--agent <agent>] [--model <model>] [--runs <count>] \
  --json
```

The eval source must contain a real `.tessl-plugin/plugin.json`, evaluation scenarios, and exactly
one injectable `skills/<configured-skill-name>` tree. Its manifest must declare exactly:

```json
{
  "skills": ["skills/<configured-skill-name>"]
}
```

Additional skills, docs/rules context, hidden plugin content, symlinks, unsafe paths, and special
files are rejected. If the source has `tessl.json`, it must represent a vendored project with an
empty dependency map; provider dependencies cannot supply undisclosed evaluation context.

Because Tessl injects plugin content into the paired run, Skill Press validates the embedded skill
and requires its complete tree digest to equal the canonical skill. It copies the complete source
into a content-addressed private evidence directory, rechecks that snapshot, passes it as explicit
`--context`, and narrows activation with the explicit `--skill` selector. The original linked
source remains the final positional argument so Tessl retains its registered project identity.

For the duration of the provider command, Skill Press creates a temporary nested Git boundary in
the evidence-run directory. This prevents Tessl 0.101.0 from inheriting the outer `.gitignore`
entry that protects `.skill-press/`. The boundary must be removed successfully before evidence is
persisted, and the later release gate rejects residual boundary metadata.

Provider start and completed-result JSON must echo the same context path, accepting only the exact
argv path or Tessl's documented content-addressed basename normalization. Final
`metadata.cliInvocation` must equal the complete submitted argv. Original, snapshot, and embedded
canonical skill are checked before capture, after capture, and again at release-gate time.

The eval bridge binds returned run ID, resolved agent and model, repetitions, and scenario count to
its request. It computes each baseline and with-context percentage from returned assessment
criteria. Impact is the mean with-context percentage; baseline, delta, and uplift remain separate.
Required scenario non-regression is enforced independently.

## Executable trust and pin updates

The executable is SHA-256 checked against supported-platform binaries extracted from Tessl's
ECDSA-signed 0.101.0 release manifest. To update the pin:

1. download the new release manifest and detached signature from the official Tessl distribution;
2. verify the signature using the public key shipped by the official installer;
3. verify every supported release archive against the signed manifest;
4. extract each supported executable and record its SHA-256 in `src/tessl/trusted-cli.ts`;
5. update parser and command contract tests against actual CLI output and help;
6. independently review and commit the change as an explicit supply-chain update.

Do not trust a new version because its output looks compatible. Command syntax, provider JSON,
context packaging, cache behavior, and authentication storage are part of the reviewed contract.

## Source binding and freshness

Before and after a provider run, Skill Press binds evidence to:

- current Git HEAD and release-relevant clean state;
- exact `skill-press.yaml` bytes;
- the complete canonical skill tree;
- the trusted Tessl executable digest and exact command digest;
- raw stdout/stderr byte counts and SHA-256 values;
- for Impact, the complete original eval source, its private snapshot, and the exclusive embedded
  canonical skill.

Symlinks, special files, unsafe paths, oversized trees, relevant dirty state, concurrent changes,
malformed output, unexpected identity, or a residual nested Git boundary fail closed or make the
evidence ineligible. A later `checkTesslReleaseGate` independently recomputes the same bindings and
rejects stale evidence according to `quality.evidenceMaxAgeHours`.

## Process isolation and storage

Every Tessl subprocess receives a fresh private temporary HOME, USERPROFILE, XDG, and AppData
boundary plus only explicit provider variables required for the command. The interactive login
store is not forwarded. Only `TESSL_TOKEN` is copied from the ambient environment.

The temporary home is removed after the command. Raw version, lint, review, submission, and result
streams are bounded and written beneath:

```text
.skill-press/tessl/<random-id>/
```

On POSIX systems, directories use mode `0700` and sensitive files use `0600`. The tree is ignored
by Git and excluded from release packages. Schema-validated `evidence.json` retains provider facts,
command and output hashes, source bindings, aggregate scores, scenario fingerprints, and
eligibility reasons. It does not expose credentials, provider prose, or scenario prompts.

## Submission and service boundary

The deterministic Skill Press submission manifest includes current Tessl Quality and Impact
evidence and their digests. It marks them `advisory: true` and sets
`serverValidationRequired: true`.

Client evidence is necessary for the current local release gate, but it is not a curator decision
or registry attestation. The future registry must independently validate the submitted archive and
apply the service's current automated and human review policy. The production registry backend is
not live yet, so no current Tessl capture can be described as a live Skill Press publication.

## External failure boundary

Tessl authentication, workspace access, plan capabilities, service availability, and actual
scores are external facts. If they are unavailable, Skill Press reports the failure and preserves
the configured minimums. Tests with a fake, custom, or digest-untrusted executable prove parsing
and failure behavior only; their evidence is always release-ineligible.

Tessl currently does not provide a detached signature over the captured CLI result. The local
contract detects accidental or inconsistent tampering and blocks manual score substitution, but it
does not cryptographically prove that a hostile repository/filesystem owner is honest. Stronger
service-side assurance requires a future provider-signed receipt or independent online
verification.
