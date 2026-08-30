# Operating Skill Press

This runbook covers local development, project authoring, behavioral and Tessl evidence, gated
packaging, canonical submission preparation, recovery journals, and the separate npm release of
the Skill Press CLI.

## Current interface boundary

The CLI implements `init`, `check`, `test`, `eval`, `tessl`, `improve`, `package`, `submit`, `add`,
`install`, `status`, and `doctor`.

`submit` has one production destination, `https://skill-press.com/api/v1`. The production registry
backend and account/token issuance are not live yet, so `submit --dry-run` is the only current
end-user submission path. A successful local dry run proves that the candidate can be prepared; it
does not create a remote review, published release, or trusted release.

`add` and `install` are implemented, but they also require the undeployed canonical registry. Their
network origin and signing roots cannot be selected by project configuration or CLI flags. The
implementation is currently usable through hermetic tests, not as a claim that a public release can
already be installed.

The CLI requires Node.js 22 or newer. The maintained CI matrix covers Node.js 22, 24, and 26.

## Repository gates

From a clean checkout:

```bash
npm ci --ignore-scripts
npm run check
npm run security:audit
npm run package:verify
```

`npm run check` checks formatting, lints, verifies generated sources, type-checks, builds, runs the
test suite, and enforces coverage. `npm run package:verify` inspects `npm pack --dry-run`, creates
the real tarball, checks its allowlisted inventory and integrity, installs it with lifecycle
scripts disabled in a clean temporary project, and probes the CLI and public library exports.

Build an executable for the commands below:

```bash
npm run build
node dist/bin.js --help
```

Examples use `skpress`; while developing from source, substitute `node dist/bin.js`.

## Exit codes

| Code | Meaning | Scope |
| --- | --- | --- |
| `0` | Command completed and its requested gate/report passed | all commands |
| `1` | Unexpected internal, subprocess-I/O, or output-sink failure | all commands |
| `2` | Invalid CLI usage or arguments | all commands |
| `3` | Project, evidence, evaluation, release gate, package, submission, installation, status, or bounded-improvement result is blocked | operational commands |
| `4` | `init` destination was unsafe, concurrently changed, or could not be rolled back without deleting unknown data | `init` only |

Exit `3` is an expected fail-closed result, not permission to bypass the gate. JSON mode retains
the same exit semantics.

## Initialize and check a project

Create a project from a complete capability brief:

```bash
skpress init --brief capability-brief.yaml --output ./my-skill
skpress check --project ./my-skill --json
skpress test --project ./my-skill --json
```

`init` requires an explicit lowercase registry namespace plus real capability, boundary, test, and
scenario content. The namespace is a requested Skill Press identity, not proof of ownership and not
an endpoint selector. The output directory must not exist. The writer claims it transactionally and
preserves a `.skill-press-incomplete` marker if unknown concurrent data makes safe rollback
impossible.

`check` reads `skill-press.yaml`, validates the canonical Agent Skill and its complete reachable
resource graph, checks scenario/rubric identity and quality, and reports local readiness. It never
reports Tessl Quality or Impact.

`test` runs the configured argv on the host without a shell, bounds cwd to the project, and limits
time and output. Run it only for a repository whose test commands you trust.

## Paired behavioral evaluation

Provide a digest-pinned agent adapter image and explicit adapter argv:

```bash
skpress eval --project ./my-skill \
  --image <adapter-image@sha256:digest> \
  --model <model> -- <adapter-command> <adapter-args...>
```

The runner starts separate baseline and with-skill containers, disables networking by default,
mounts the skill read-only only for the with-skill variant, and enforces CPU, memory, PID,
filesystem, output, and wall-time limits. The adapter must echo the request digest and loaded skill
digest. Raw results remain in private ignored `.skill-press/runs/` storage; the returned evidence
contains digests, aggregate results, and redacted excerpts.

An unpinned image can be permitted only with the explicit unsafe option, and its evidence is
release-ineligible. A custom executor used by tests is also ineligible.

## Bounded improvement

Use complete training and holdout evidence with explicit role executables:

```bash
skpress improve --project ./my-skill \
  --training-evidence <training-evidence.json> \
  --holdout-evidence <holdout-evidence.json> \
  --author-command <author> \
  --reviewer-command <reviewer> \
  --evaluator-command <evaluator> \
  --json
```

Repeat the corresponding `--author-arg`, `--reviewer-arg`, or `--evaluator-arg` option to add argv.
Environment forwarding is an explicit variable-name allowlist through `--author-env`,
`--reviewer-env`, and `--evaluator-env`.

Skill Press appends operation, request, and response paths. Each call uses a fresh private
temporary directory and a schema-versioned response. The author receives training findings only;
holdout prompts are delivered only to the evaluator. An accepted candidate must pass canonical
validation, reviewer approval, measured training improvement, and holdout non-regression before it
replaces the canonical tree. Token, cost, iteration, no-improvement, and wall-time budgets are
hard stops.

These role commands are user-authorized host programs, not sandboxed plugins. Run untrusted role
binaries inside an external OS or container boundary.

## Capture official Tessl evidence

Skill Press currently trusts official Tessl CLI 0.101.0 by executable digest. Authenticate and
confirm the intended workspace, then create a bounded-lifetime key locally:

```bash
tessl login
tessl auth whoami --json
tessl api-key create --workspace <workspace> --name skill-press-evidence-<YYYYMMDD> \
  --role publisher --expiry-date <YYYY-MM-DDT00:00:00Z>
```

Export the value shown once only in the shell that launches Skill Press:

```bash
export TESSL_TOKEN='<value-shown-once>'
export TESSL_BIN='<absolute-path-to-extracted-tessl-0.101.0-binary>'
export TESSL_AUTO_UPDATE_INTERVAL_MINUTES=0

skpress tessl review --project . --workspace <workspace> \
  --executable "$TESSL_BIN" --json

skpress tessl eval --project . \
  --source .skill-press/tessl-evals/<set> \
  --executable "$TESSL_BIN" --json
```

Never paste `TESSL_TOKEN` into chat or store it in `skill-press.yaml`, the skill, fixtures, or Git.
Rotate it when the evidence window or release work is complete.

Quality and Impact capture force fresh provider results. If the workspace plan permits selection,
add `--agent <agent>` and/or `--model <model>` to eval; otherwise omit them and let Tessl choose
workspace defaults. The returned provider identities and exact invocation remain evidence-bound.

The eval source must be a private Tessl plugin under `.skill-press/tessl-evals/<set>` with exactly
one injectable `skills/<configured-name>` tree identical to the canonical skill. Its manifest must
declare only that skill; non-empty provider dependencies, additional skills, hidden context,
symlinks, unsafe paths, and digest mismatches fail closed. Capture copies the complete source into
a content-addressed private snapshot and verifies original, snapshot, and canonical tree before
and after the provider call.

See [the Tessl evidence contract](TESSL.md) for the exact argv, signed-binary pin update process,
storage, and parser boundaries.

## Inspect the release gate

Packaging and submission call `checkTesslReleaseGate` internally. Typed callers can invoke it
directly:

```js
import { checkTesslReleaseGate } from "@skill-press/cli";

const gate = await checkTesslReleaseGate(projectRoot, {
  reviewEvidencePath: ".skill-press/tessl/<quality-run>/evidence.json",
  evalEvidencePath: ".skill-press/tessl/<impact-run>/evidence.json",
  evalSource: ".skill-press/tessl-evals/<set>",
});
```

The gate reopens raw bounded provider output, reparses scores, verifies the trusted executable and
command digests, checks clean current Git inputs, recomputes complete tree hashes, enforces
freshness, and applies configured minimums. There is no manual-score option.

## Package an exact candidate

```bash
skpress package --project . \
  --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> \
  --eval-source <tessl-eval-source> \
  --json
```

The command checks the gate, stages tracked canonical inputs, produces deterministic archives,
checksums, and provenance, then rechecks the gate. Artifacts are private under:

```text
.skill-press/staging/<run-id>/artifacts
```

Do not edit, move through a symlink, or selectively replace files in that directory. A loader
rechecks the exact inventory, permissions, bytes, source commit, config digest, and skill digest.

## Prepare a submission locally

The safe operational path while the backend is unavailable is:

```bash
skpress submit --project . \
  --artifacts .skill-press/staging/<run-id>/artifacts \
  --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> \
  --eval-source <tessl-eval-source> \
  --dry-run --json
```

Omit `--artifacts` to let `submit` stage and package the current gated source. A dry run returns an
unpersisted receipt with `operationStatus: prepared`, the fixed registry origin, manifest and
artifact bindings, and zero remote attempts. It does not require `SKILL_PRESS_TOKEN` and never
contacts the service.

The deterministic submission contains one canonical archive, provenance, checksums, Tessl Quality
evidence, Tessl Impact evidence, and a manifest that marks client evidence advisory and requires
server validation.

## Live submission boundary

When the production backend and token issuer are deployed, the intended command is:

```bash
export SKILL_PRESS_TOKEN='<short-lived-access-token>'

skpress submit --project . \
  --artifacts .skill-press/staging/<run-id>/artifacts \
  --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> \
  --eval-source <tessl-eval-source> \
  --json
```

Do not attempt this today expecting a live public service. The client is fixed to
`https://skill-press.com/api/v1`; there is intentionally no endpoint flag or project-level registry
setting.

Before upload, the client verifies `GET /session`; this proves authentication only, not namespace
authority. `POST /submissions` must atomically authorize the token for the manifest namespace before
the service creates a candidate, reserves a key or version, or stores upload bytes. The client sends
a deterministic idempotency key, then verifies the exact resource with `GET /submissions/{id}`.
Remote output must bind the same namespace, key, source commit, project version, skill locator,
artifact digest, and canonical URLs.

Successful transport produces local `operationStatus: submitted` and a remote review status such
as `received`. It does not imply `published`, and a published release separately needs trust
`trusted` before normal installation.

## Resume and refresh an exact submission

A live mutating attempt journals state at:

```text
.skill-press/submissions/<idempotency-key>/receipt.json
```

If it fails or must refresh remote state, preserve the exact package and evidence and resume it:

```bash
skpress submit --project . \
  --artifacts .skill-press/staging/<run-id>/artifacts \
  --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> \
  --eval-source <tessl-eval-source> \
  --resume .skill-press/submissions/<idempotency-key>/receipt.json \
  --json
```

`--resume` requires `--artifacts` and cannot be combined with `--dry-run`. The equivalent typed
option is `resumeReceiptPath`. Resume fails if the receipt path, registry origin, protocol,
manifest, source, version, artifact, evidence, or permissions changed.

Never create a second candidate merely because a timeout made remote state ambiguous. Preserve the
journal. When it contains a validated remote ID, resume refreshes that resource without POSTing
again; otherwise it retries the identical manifest under the same idempotency key.

## Add and restore trusted releases

Once the canonical registry is live, add one exact release from a project root:

```bash
skpress add <namespace>/<skill>@<exact-semver> --project . --json
```

The command accepts no range, tag, branch, arbitrary URL, alternate registry, or offline cache. It
resolves the fixed canonical release, downloads the exact bounded stored ZIP, verifies its digest
and size, verifies the immutable ES256 release attestation, then obtains the latest signed trust
event and a short-lived signed current-trust checkpoint. The checkpoint must bind the exact trust
envelope, remain fresh at activation, and arrive through a non-cached dynamic response.

Before `SKILL.md` becomes visible under `.agents/skills/<skill>/`, `add` validates the complete
staged Agent Skill and persists the highest observed trust sequence in `skill-lock.json`. A process
crash can therefore leave a locked-but-absent or installer-marked pending tree, never an active
untracked release. A later trusted install can resume only a marker bound to the same archive;
arbitrary partial directories fail closed.

Restore every exact entry after a fresh online trust check:

```bash
skpress install --project . --json
```

Each entry is processed within bounded per-artifact and aggregate budgets. A higher trust sequence
is persisted before that entry is activated. The client rejects signature-role confusion, key
epochs outside their validity window, a sequence below the lock's floor, a same-sequence envelope
change, stale or future-dated metadata, cached dynamic responses, checkpoint expiry, and any
quarantined or revoked state. There is deliberately no `--offline` or `--force` bypass.

`skill-lock.json` is project state and should be committed. `.agents/skills/` is derived local
state and must remain ignored; do not commit installed bytes. In a Git worktree, installation fails
closed if the target is tracked or is not covered by Git ignore rules. The CLI does not silently
rewrite a user-owned `.gitignore`; add `/.agents/skills/` explicitly when adopting Skill Press in an
existing project. A clean clone must restore the lock online so quarantine and revocation are
checked again.

`install` does not auto-delete a previously active directory when trust refresh fails. Remote
unavailability is not proof of revocation, and a running agent cannot be remotely made to forget a
skill it already loaded. For a registry-confirmed `quarantined` or `revoked` result, stop affected
agents and move the complete `.agents/skills/<skill>/` directory outside all agent discovery roots.
Preserve it separately if incident response needs the bytes. Keep the lock entry and its trust
floor; never delete or edit the sequence to force the old release back into service. An ambiguous,
unsigned, or unavailable response should block refresh and prompt investigation, not destructive
cleanup.

Temporary mutation locks, staging directories, and installation markers are recovery state; do
not delete them while another `skpress add` or `skpress install` process is active. A stale mutation
lock whose recorded process is definitively absent is reclaimed by identity; an unknown or
replaced lock is preserved and reported as a conflict.

The atomicity contract covers concurrent mutation and process termination. It does not claim that
every filesystem/storage stack preserves all target directory entries across sudden power loss.
After an unclean shutdown, run `skpress install` successfully before starting an agent; the command
rechecks exact bytes and current trust, repairs a recognized archive-bound pending state, and
rejects ambiguous or corrupted local state.

## Status and diagnostics

Inspect local gate, package, and optional submission bindings without mutation:

```bash
skpress status --project . \
  --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> \
  --eval-source <tessl-eval-source> \
  --artifacts .skill-press/staging/<run-id>/artifacts \
  --submission .skill-press/submissions/<idempotency-key>/receipt.json \
  --json
```

The three evidence arguments are all-or-none. `--submission` requires `--artifacts` so the receipt
can be rebound to the exact package, manifest, and evidence. Human output deliberately calls this
“Local release-input readiness” and labels any release state as “Last observed release trust.” JSON
always includes `currentTrustVerified: false`. `status` is therefore not a substitute for a fresh
authenticated server query and cannot authorize installation.

Probe local prerequisites and credential presence by variable name:

```bash
skpress doctor --project . \
  --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> \
  --eval-source <tessl-eval-source> \
  --tessl-executable "$TESSL_BIN" \
  --json
```

`doctor` checks Node.js, Git, the configured Docker/Podman runtime, Tessl, local installed-skill
collisions, `TESSL_TOKEN`, `SKILL_PRESS_TOKEN`, and optional evidence freshness. It never prints
credential values or contacts the canonical registry. The live `/session` endpoint remains
authoritative for Skill Press authentication once the service exists.

## npm trusted release for the CLI

The npm package is `@skill-press/cli`; its only executable is `skpress`. npm distributes the
developer tool, not Agent Skill releases.

The repository's `.github/workflows/release.yml` responds only to a formal non-prerelease GitHub
Release whose tag is `v<package-version>`. Its unprivileged verification job checks the exact tag,
repository identity, release assets, tests, production audit, package inventory, tarball digest,
and source binding. The protected `publish` job alone receives `id-token: write` and uses npm OIDC
trusted publishing; no npm write token is stored in GitHub.

The registry requires a package to exist before its Trusted Publisher can be configured. Reserve
the name once with the tracked, inert `npm/bootstrap-reservation/` package. It is version `0.0.0`,
has no executable, code, lifecycle script, dependency, or API, and is configured for only the
`bootstrap` dist-tag. It must never be reused as a product release, promoted to `latest`, or
published through the formal release workflow.

Complete this one-time ceremony before the first production release:

1. Confirm that the npm organization `skill-press` is controlled by the intended maintainers and
   that the interactive publishing account has account-level two-factor authentication. Do not use
   a CI token, granular automation token, `NPM_TOKEN`, or `NODE_AUTH_TOKEN` for this exception.
2. From a clean canonical checkout, install locked dependencies and verify the exact reservation.
   The verifier runs `npm pack --dry-run` with lifecycle scripts disabled and accepts only
   `package.json`, `README.md`, and the byte-identical repository `LICENSE`:

   ```bash
   npm ci --ignore-scripts
   npm run npm:bootstrap:verify
   BOOTSTRAP_OUTPUT_DIR="$(mktemp -d)"
   chmod 700 "$BOOTSTRAP_OUTPUT_DIR"
   npm run --silent npm:bootstrap:prepare -- "$BOOTSTRAP_OUTPUT_DIR"
   BOOTSTRAP_TARBALL="$BOOTSTRAP_OUTPUT_DIR/skill-press-cli-0.0.0.tgz"
   ```

3. Inspect the emitted JSON identity, SHA-1 `shasum`, SHA-256, SHA-512 `integrity`, and three-file
   inventory. Run the exact query below; an explicit canonical-registry `E404` is the expected
   precondition, while any returned version or any other error means stop without publishing:

   ```bash
   npm view '@skill-press/cli@*' versions dist-tags --json \
     --registry=https://registry.npmjs.org/
   ```

   Only after observing that exact `E404`, run the following fail-fast block. It removes token
   fallbacks, authenticates interactively with 2FA, makes the output directory and tarball
   read-only, and reverifies that exact tarball immediately before publishing it to the canonical
   registry and `bootstrap` tag. Any failed login, identity check, permission change, verification,
   publish, or post-publish comparison terminates the block:

   ```bash
   (
   set -euo pipefail
   unset NPM_TOKEN NODE_AUTH_TOKEN
   npm login --registry=https://registry.npmjs.org/ --auth-type=web
   npm whoami --registry=https://registry.npmjs.org/
   chmod 400 "$BOOTSTRAP_TARBALL"
   chmod 500 "$BOOTSTRAP_OUTPUT_DIR"
   BOOTSTRAP_METADATA="$(npm run --silent npm:bootstrap:verify-tarball -- "$BOOTSTRAP_TARBALL")"
   printf '%s\n' "$BOOTSTRAP_METADATA"
   npm publish "$BOOTSTRAP_TARBALL" \
     --registry=https://registry.npmjs.org/ --access public --tag bootstrap --ignore-scripts
   NPM_METADATA="$(npm view @skill-press/cli@0.0.0 \
     name version bin scripts dependencies dist-tags dist.integrity dist.shasum --json \
     --registry=https://registry.npmjs.org/)"
   printf '%s\n' "$NPM_METADATA"
   BOOTSTRAP_METADATA="$BOOTSTRAP_METADATA" NPM_METADATA="$NPM_METADATA" node <<'NODE'
   const local = JSON.parse(process.env.BOOTSTRAP_METADATA);
   const remote = JSON.parse(process.env.NPM_METADATA);
   const forbidden = ["bin", "scripts", "dependencies"];
   const tags = remote["dist-tags"];
   if (
     remote.name !== "@skill-press/cli" ||
     remote.version !== "0.0.0" ||
     forbidden.some((field) => Object.hasOwn(remote, field)) ||
     tags === null ||
     typeof tags !== "object" ||
     Array.isArray(tags) ||
     Object.keys(tags).length !== 1 ||
     tags.bootstrap !== "0.0.0" ||
     remote["dist.integrity"] !== local.integrity ||
     remote["dist.shasum"] !== local.shasum
   ) {
     throw new Error("published bootstrap reservation differs from the verified tarball");
   }
   NODE
   npm dist-tag ls @skill-press/cli --registry=https://registry.npmjs.org/
   )
   ```

   This manual exception has no provenance by design. Stop on any ambiguous response and query the
   exact version instead of retrying blindly. The immutable registry SHA-1 and SHA-512 must equal
   the immediately pre-publish verifier output, no runtime field may appear, and the dist-tag
   listing must show `bootstrap: 0.0.0` and no `latest`. A mismatch is a release incident, not a
   reason to retry publishing.

4. Create a GitHub environment named `npm` with a required reviewer and a selected Tag `v*`
   deployment rule. Protect `v*` tags from unauthorized creation, mutation, and deletion.

5. Configure npm trusted publishing for GitHub organization `skill-press`, repository
   `skill-press`, workflow filename `release.yml`, environment `npm`, and publish permission:

   ```bash
   npm trust github @skill-press/cli --repo skill-press/skill-press \
     --file release.yml --env npm --allow-publish --yes \
     --registry=https://registry.npmjs.org/
   npm trust list @skill-press/cli --json --registry=https://registry.npmjs.org/
   ```

6. Compare the returned binding byte-for-byte with the repository, workflow filename, environment,
   and allowed publish action above. In npm package settings, require 2FA and disallow traditional
   publish tokens; revoke any temporary credential used during the manual exception.

7. Publish the usable `0.1.0` package only by creating the protected `v0.1.0` GitHub Release. The
   OIDC workflow must create its provenance and move `latest` to `0.1.0`; never publish `0.1.0`
   manually. Keep `0.0.0` isolated under `bootstrap`.

Before approval, compare the tag, source commit, current gate evidence, release assets, and npm
tarball manifest. Environment approval resumes the original attempt and is safe; do not rerun a
failed workflow for the initial deployment receipt. The sealed first-deploy verifier accepts only
`runAttempt: "1"` because GitHub's run-level artifact API cannot prove which rerun produced a
same-named artifact. Preserve a failed attempt as a release incident, verify exact npm state, and
stop first deployment. Resolve the incident and deliberately prepare a new package version and
matching sealed deployment manifest instead of editing a GitHub Release, rerunning blindly, or
republishing an existing npm version.

## Incident checklist

When a local or future remote operation stops:

1. Preserve the exact Git commit, `.skill-press/staging/` artifacts, evidence, submission journal,
   and console-visible error code.
2. Determine whether the failure occurred before upload, during an ambiguous request, during
   remote verification, or during later review.
3. Do not infer remote absence from timeout, connection failure, invalid JSON, or an unexpected
   status version.
4. Rotate `TESSL_TOKEN` or `SKILL_PRESS_TOKEN` immediately if exposure is suspected.
5. Resume only the exact journal and package. If source or evidence must change, prepare a new
   semantic version or candidate deliberately.
6. Treat `changes-requested`, `rejected`, `published`, `trusted`, `quarantined`, and `revoked` as
   distinct server facts.
7. For a published safety incident, quarantine first, preserve evidence, and release fixed bytes
   under a new version rather than replacing the immutable artifact.

Private evidence and journals are ignored working state, not disposable cache. Back them up with
the same confidentiality as build logs and remove only an explicitly identified run after its
retention requirement expires.
