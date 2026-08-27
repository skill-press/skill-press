# Tessl evidence contract

SkillPress treats Tessl Quality and Impact as external evidence. It does not translate local
readiness, local paired evaluation, or a user-supplied number into a Tessl score.

## Authentication and commands

Install and authenticate the official Tessl CLI, then check the active identity:

```bash
tessl login
tessl auth whoami --json
```

For a non-interactive SkillPress run, the pinned 0.101.0 CLI creates a bounded-lifetime publisher
key with `tessl api-key create --workspace <workspace> --name <name> --role publisher
--expiry-date <ISO-8601>`; export the value shown once as `TESSL_TOKEN` in the shell that starts
SkillPress. Do not use the newer documentation's `tessl auth token` spelling with the pinned CLI.
This is the only ambient credential variable forwarded to the provider subprocess; the interactive
login store and home directory are intentionally not forwarded. Interactive login remains useful
for direct Tessl CLI administration. Never paste the value into chat or commit it; rotate it after
release. Automatic CLI updates are disabled for captured runs with the official
`TESSL_AUTO_UPDATE_INTERVAL_MINUTES=0` setting so the executable digest stays stable.
Pass `--executable <absolute-versioned-binary>` to evidence capture and
`--tessl-executable <absolute-versioned-binary>` to publication. Point these options at the
extracted 0.101.0 executable whose digest is in the signed trust set, not at an installer or
auto-updating launcher.

SkillPress 0.1.0 pins Tessl CLI 0.101.0 and invokes these no-shell argv sequences:

```text
tessl --version
tessl skill lint <private-plugin-projection/.tessl-plugin/plugin.json>
tessl review run quality --json --force [--workspace <workspace>] --threshold 0 <canonical-skill>
tessl eval run --json --force --context <private-eval-snapshot> --skill <configured-name> [--agent <agent>] [--model <model>] --runs <count> <linked-eval-source>
tessl eval view --json <run-id>
```

Agent and model selection are optional. When omitted, Tessl selects the workspace defaults and
SkillPress binds the resolved agent/model returned by the provider plus the exact command digest
without selection flags. Every official Quality and Impact capture uses `--force` so the provider
recomputes current review and paired-eval results instead of reusing an older context. This supports
plans that do not permit explicit model selection without weakening evidence.
Keep generated or holdout scenario sources under the ignored `.skillpress/tessl-evals/<set>` path;
the complete private tree is still digested before and after capture and again at the release gate.
The source must be a Tessl plugin with a real `.tessl-plugin/plugin.json`, `evals/`, and exactly one
injectable `skills/<configured-skill-name>` tree; docs, rules, extra skills, and other plugin context
are rejected. If the linked source has `tessl.json`, it must be a vendored project with an empty
dependency map; provider dependencies cannot supply hidden context. Because Tessl injects plugin
content into the paired run, SkillPress validates the
embedded skill, requires its complete tree digest to equal the canonical skill, copies the complete
source into a content-addressed private evidence directory, rechecks the snapshot digest, and passes
that snapshot as explicit `--context` with an explicit `--skill` selector. The original linked
source remains the final positional argument so Tessl retains its registered project identity.
Capture and the release gate require the provider's start and completed-result JSON to echo that
exact context path and require final `metadata.cliInvocation` to equal the complete submitted argv.
The original and snapshot are checked again after capture and at release time.

The lint command requires Tessl plugin context, so SkillPress creates a private temporary plugin
manifest and copies the canonical skill into it, verifies that the copied skill has the same full
tree digest, runs lint, then verifies the digest again. The generated provider manifest never
enters the canonical skill or a commit.

The review bridge uses `--force`, then reads `review.reviewScore` and `validation.overallPassed`
from the official JSON result. The eval bridge binds the returned run ID, agent, model, and scenario
count to its request, then computes each baseline and with-context percentage from the returned
assessment criteria. Impact is the mean with-context percentage; its baseline, delta, and uplift
ratio remain separate.

## Trust and freshness

The executable itself is SHA-256 checked against every platform binary extracted from Tessl's
ECDSA-signed 0.101.0 release manifest. A version string alone is not trusted. To update the pin:

1. download the new release manifest and detached signature from `install.tessl.io`;
2. verify that signature using the public key shipped by the official installer;
3. verify each release archive against the signed manifest;
4. extract each supported executable and record its SHA-256 in `src/tessl/trusted-cli.ts`;
5. update parser contract tests against the new CLI's actual JSON output and command help;
6. review and commit the pin as an explicit supply-chain change.

Before and after a provider run, SkillPress binds evidence to Git HEAD, `skillpress.yaml`, the
complete canonical skill tree, and (for Impact) the complete eval-source tree, its private capture
snapshot, and their exclusive embedded canonical-skill copy. Symlinks, special files, unsafe paths,
oversized trees, relevant dirty state, or concurrent source changes fail closed or make evidence
ineligible. A later release gate must independently recompute the same bindings and reject stale
evidence.

## Storage and privacy

Every Tessl subprocess receives a fresh private temporary HOME, USERPROFILE, XDG, and AppData
boundary, plus only the explicit provider variables required for that command. The temporary home
is removed after the command, so an ambient interactive Tessl login cannot authenticate evidence
or publication. Raw version, lint, review, submission, and completed-result streams are bounded and
written under `.skillpress/tessl/<random-id>/` with directory mode `0700` and file mode `0600`.
That directory is ignored by Git and must not enter a package. The schema-validated `evidence.json`
exposes only provider facts, hashes, aggregate scores, scenario fingerprint hashes, and eligibility reasons.
It does not expose provider prose, scenario text, or credentials. Only `TESSL_TOKEN` is forwarded
to Tessl from the ambient environment.

## External boundary

Provider authentication, workspace access, service availability, and actual scores are external
facts. If they are unavailable, SkillPress reports the provider error and preserves the 90-point
release gate. Tests with a custom or digest-untrusted executable prove parsing and failure behavior
but are always marked ineligible.
