# Tessl evidence contract

SkillPress treats Tessl Quality and Impact as external evidence. It does not translate local
readiness, local paired evaluation, or a user-supplied number into a Tessl score.

## Authentication and commands

Install and authenticate the official Tessl CLI, then check the active identity:

```bash
tessl login
tessl auth whoami --json
```

For a non-interactive SkillPress run, the pinned 0.99.0 CLI creates a bounded-lifetime publisher
key with `tessl api-key create --workspace <workspace> --name <name> --role publisher
--expiry-date <ISO-8601>`; export the value shown once as `TESSL_TOKEN` in the shell that starts
SkillPress. Do not use the newer documentation's `tessl auth token` spelling with the pinned CLI.
This is the only ambient credential variable forwarded to the provider subprocess; the interactive
login store and home directory are intentionally not forwarded. Interactive login remains useful
for direct Tessl CLI administration. Never paste the value into chat or commit it; rotate it after
release. Automatic CLI updates are disabled for captured runs with the official
`TESSL_AUTO_UPDATE_INTERVAL_MINUTES=0` setting so the executable digest stays stable.

SkillPress 0.1.0 pins Tessl CLI 0.99.0 and invokes these no-shell argv sequences:

```text
tessl --version
tessl skill lint <private-plugin-projection/.tessl-plugin/plugin.json>
tessl review run quality --json [--workspace <workspace>] --threshold 0 <canonical-skill>
tessl eval run --json [--agent <agent>] [--model <model>] --runs <count> <eval-source>
tessl eval view --json <run-id>
```

Agent and model selection are optional. When omitted, Tessl selects the workspace defaults and
SkillPress binds the resolved agent/model returned by the provider plus the exact flag-free command
digest. This supports plans that do not permit explicit model selection without weakening evidence.
Keep generated or holdout scenario sources under the ignored `.skillpress/tessl-evals/<set>` path;
the complete private tree is still digested before and after capture and again at the release gate.

The lint command requires Tessl plugin context, so SkillPress creates a private temporary plugin
manifest and copies the canonical skill into it, verifies that the copied skill has the same full
tree digest, runs lint, then verifies the digest again. The generated provider manifest never
enters the canonical skill or a commit.

The review bridge reads `review.reviewScore` and `validation.overallPassed` from the official JSON
result. The eval bridge binds the returned run ID, agent, model, and scenario count to its request,
then computes each baseline and with-context percentage from the returned assessment criteria.
Impact is the mean with-context percentage; its baseline, delta, and uplift ratio remain separate.

## Trust and freshness

The executable itself is SHA-256 checked against every platform binary extracted from Tessl's
ECDSA-signed 0.99.0 release manifest. A version string alone is not trusted. To update the pin:

1. download the new release manifest and detached signature from `install.tessl.io`;
2. verify that signature using the public key shipped by the official installer;
3. verify each release archive against the signed manifest;
4. extract each supported executable and record its SHA-256 in `src/tessl/trusted-cli.ts`;
5. update parser contract tests against the new CLI's actual JSON output and command help;
6. review and commit the pin as an explicit supply-chain change.

Before and after a provider run, SkillPress binds evidence to Git HEAD, `skillpress.yaml`, the
complete canonical skill tree, and (for Impact) the complete eval-source tree. Symlinks, special
files, unsafe paths, oversized trees, relevant dirty state, or concurrent source changes fail
closed or make evidence ineligible. A later release gate must independently recompute the same
bindings and reject stale evidence.

## Storage and privacy

Raw version, lint, review, submission, and completed-result streams are bounded and written under
`.skillpress/tessl/<random-id>/` with directory mode `0700` and file mode `0600`. That directory is
ignored by Git and must not enter a package. The schema-validated `evidence.json` exposes only
provider facts, hashes, aggregate scores, scenario fingerprint hashes, and eligibility reasons.
It does not expose provider prose, scenario text, or credentials. Only `TESSL_TOKEN` is forwarded
to Tessl from the ambient environment.

## External boundary

Provider authentication, workspace access, service availability, and actual scores are external
facts. If they are unavailable, SkillPress reports the provider error and preserves the 90-point
release gate. Tests with a custom or digest-untrusted executable prove parsing and failure behavior
but are always marked ineligible.
