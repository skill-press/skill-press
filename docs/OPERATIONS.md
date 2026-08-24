# Operating SkillPress

This runbook covers local development, evidence capture, deterministic packaging, publication
planning and recovery, and the npm release workflow for SkillPress 0.1.0.

## Current interface boundary

The installed CLI implements `create`, `improve`, `check`, `test`, `eval`, `tessl`, `package`,
`publish`, `status`, and `doctor`. The corresponding staging, packaging, release-gate, status,
diagnostic, adapter-construction, publication, and receipt APIs are also exported for typed
integrations. CLI `package` and `publish` always recheck official Tessl evidence; there is no
manual-score path. Publication is a dry run unless `--execute` is explicit.

Use Node.js 22 or newer. The repository quality matrix covers Node.js 22, 24, and 26.

```bash
npm ci --ignore-scripts
npm run check
npm run security:audit
npm run package:verify
```

`npm run check` formats-checks, lints, verifies generated sources, type-checks, builds, runs every
test, and enforces coverage. `package:verify` runs `npm pack --dry-run`, creates the actual tarball,
checks its allowlisted contents and integrity, installs it with lifecycle scripts disabled in a
clean temporary project, and probes both the CLI and library exports.

## Exit codes

Every command uses the same bounded exit-code set:

| Code | Meaning | Commands |
| --- | --- | --- |
| `0` | Successful command, satisfied report/gate, or help/version output | all |
| `1` | Unexpected internal, subprocess-I/O, or output-sink failure | all |
| `2` | Invalid CLI usage or arguments | all |
| `3` | Invalid input/project/evidence, failed deterministic or provider gate, bounded improvement stop, or blocked publication/readiness state | all operational commands |
| `4` | Unsafe, concurrently changed, or already-existing create destination | `create` only |

`publish` therefore exits `0` only when every dry-run preflight is ready or every executed target
is verified. `--resume` requires `--execute`; it never implies mutation silently.

## Authoring and local proof

Create a project only from a complete capability brief:

```bash
node dist/bin.js create --brief capability-brief.yaml --output ./my-skill
node dist/bin.js check --project ./my-skill --json
node dist/bin.js test --project ./my-skill --json
```

For behavior evidence, provide a digest-pinned agent adapter image and explicit adapter argv:

```bash
node dist/bin.js eval --project ./my-skill \
  --image <adapter-image@sha256:digest> \
  --model <model> -- <adapter-command> <adapter-args...>
```

The paired runner uses separate baseline and with-skill sandboxes. It disables networking by
default and writes raw results to private ignored `.skillpress/runs/` storage. Local readiness and
paired behavior are necessary evidence classes, but neither is a Tessl score.

Use the returned complete training and holdout evidence with three explicit role executables:

```bash
node dist/bin.js improve --project ./my-skill \
  --training-evidence <training-evidence.json> \
  --holdout-evidence <holdout-evidence.json> \
  --author-command <author> --reviewer-command <reviewer> \
  --evaluator-command <evaluator> --json
```

Repeat `--author-arg`, `--reviewer-arg`, or `--evaluator-arg` for argv. Environment forwarding is
an explicit name allowlist through the corresponding `--*-env <NAME>` option. SkillPress appends
`--skillpress-operation`, `--request`, and `--response`; adapters must write the versioned response
schema. Each call gets a fresh private temporary directory. The author request contains training
context only, while holdout scenarios go only to the evaluator. A report with exit code `3` is a
bounded stop, not an internal failure or permission to bypass a gate.

## Capture and verify Tessl evidence

Install the pinned official Tessl CLI 0.99.0, authenticate, and confirm the intended workspace.
SkillPress intentionally does not expose the interactive login store to evidence or publication
subprocesses. Generate a short-lived Tessl API key locally and export it only in the shell that
launches SkillPress (or Codex); never paste it into chat, `skillpress.yaml`, or the skill.

```bash
tessl login
tessl auth whoami --json
tessl api-key create --workspace <workspace> --name skillpress-release-<YYYYMMDD> \
  --role publisher --expiry-date <YYYY-MM-DDT00:00:00Z>
export TESSL_TOKEN='<value-shown-once>'
node dist/bin.js tessl review --project . --workspace <workspace> --json
node dist/bin.js tessl eval --project . --source <tessl-eval-source> \
  --agent <agent> --model <model> --json
```

Retain the two returned private evidence paths. Immediately before staging a release, re-open and
revalidate them against current Git inputs:

```bash
node dist/bin.js package --project . \
  --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> --eval-source <tessl-eval-source> --json
```

The command checks the gate before staging and again after private artifacts are written. A source
change or final-gate failure blocks the result. The returned exact
`.skillpress/staging/<run-id>/artifacts` path is the only accepted CLI publication input.

The equivalent low-level API is:

```js
import {
  checkTesslReleaseGate,
  packageStagedSkill,
  stageCanonicalSkill,
} from "@mushanyoung/skillpress";

const gate = await checkTesslReleaseGate(projectRoot, {
  reviewEvidencePath,
  evalEvidencePath,
  evalSource,
});
if (!gate.passed) throw new Error(JSON.stringify(gate.issues));

const staged = await stageCanonicalSkill(projectRoot);
const packaged = await packageStagedSkill(projectRoot, staged);
const artifacts = { ...packaged, sourceCommit: staged.sourceCommit };
```

An API caller must require `gate.passed` before any remote mutation. The low-level staging/package
APIs do not accept manual score arguments and do not silently run an external provider gate. They
require clean tracked canonical inputs, then emit private `.skillpress/staging/` artifacts,
checksums, and source-bound provenance. Preserve that staging run until every target is verified.

Read current local and release state without provider mutation:

```bash
node dist/bin.js status --project . \
  --review-evidence <review-evidence.json> --eval-evidence <eval-evidence.json> \
  --eval-source <tessl-eval-source> --artifacts <artifacts-directory> \
  --receipt <receipt.json> --json
node dist/bin.js doctor --project . \
  --review-evidence <review-evidence.json> --eval-evidence <eval-evidence.json> \
  --eval-source <tessl-eval-source> --json
```

`status` verifies local readiness and supplied evidence/package/receipt bindings. `doctor` probes
only configured local executables, local install-name collisions, runtime support, credential
context by variable name, and optional Tessl freshness. It never prints credential values or
contacts registries; the publication dry run remains authoritative for provider identity,
capability, authentication, and remote collisions.

## Plan publication

The CLI constructs exactly one adapter for each entry in `publish.targets`, in the same order.
Adapter options bind provider identities; credentials stay in the provider's login store or named
environment variable.

Freeze the clean release candidate, capture current Tessl evidence, package that exact commit,
then push the candidate commit to the public GitHub `main` branch and wait for every required CI
check to pass before starting the publication dry run. This first source-publication phase is not
a tag or formal Release. It is intentional: `skills-sh` and the import targets must be able to
prove that public `main` already equals `sourceCommit` during the all-target preflight.

Start with a dry run only after that public-source/CI checkpoint:

```bash
node dist/bin.js publish --project . --artifacts <artifacts-directory> \
  --review-evidence <review-evidence.json> --eval-evidence <eval-evidence.json> \
  --eval-source <tessl-eval-source> --tessl-workspace <workspace> \
  --accept-clawhub-mit0 --json
```

Omit provider flags for targets that are not configured. The equivalent low-level API is:

```js
import {
  createAgentSkillHubPublicationAdapter,
  createAgentSkillsHubCatalogAdapter,
  createAskillPublicationAdapter,
  createClawHubPublicationAdapter,
  createGitHubPublicationAdapter,
  createSkillsShDerivedAdapter,
  createTesslPublicationAdapter,
  runPublicationSaga,
} from "@mushanyoung/skillpress";

const adapters = [
  createTesslPublicationAdapter({ workspace: "<tessl-workspace>" }),
  createSkillsShDerivedAdapter({ source: "<github-owner>/<repository>" }),
  createAskillPublicationAdapter({ author: "<github-login>" }),
  createAgentSkillHubPublicationAdapter(),
  createAgentSkillsHubCatalogAdapter({ contributor: "<github-login>" }),
  createClawHubPublicationAdapter({ owner: "<clawhub-owner>", licenseConsent: "MIT-0" }),
  createGitHubPublicationAdapter(),
];

const plan = await runPublicationSaga(projectRoot, artifacts, adapters);
```

This order matches the self-host configuration: GitHub is last, and its `publish-source` step is
expected to be a verified no-op after the public-source checkpoint. Its final step creates the tag
and formal Release only after the other six targets and the derived skills.sh state have been
verified, so npm cannot start early. npm remains an exported adapter for integrations, but it is
not a member of this production saga because trusted publishing requires the protected GitHub
workflow context.

Dry run is the default. Inspect every target's `preflight`, `capability`, `auth`, steps, and
rollback statement. A failed preflight blocks the complete mutation run; resolve it without
editing the receipt or weakening the gate. `skills-sh` is intentionally `derived` and has no
mutation step. The catalog target is `submit`; an open pull request is not a merged listing.

## Execute and recover

Only after reviewing a fresh dry run and obtaining publication authority, start execution:

```bash
node dist/bin.js publish --project . --artifacts <artifacts-directory> \
  --review-evidence <review-evidence.json> --eval-evidence <eval-evidence.json> \
  --eval-source <tessl-eval-source> --tessl-workspace <workspace> \
  --accept-clawhub-mit0 --execute --json
```

The equivalent API call is:

```js
const receipt = await runPublicationSaga(projectRoot, artifacts, adapters, { execute: true });
```

The saga writes a schema-validated receipt after every completed step under
`.skillpress/publications/<run-id>/receipt.json`. Directories are private and receipt files use
mode `0600` on POSIX systems. The receipt contains credential names, never values or provider error
details.

If `receipt.status === "failed"`, keep the artifacts and resume the exact receipt:

```bash
node dist/bin.js publish --project . --artifacts <artifacts-directory> \
  --review-evidence <review-evidence.json> --eval-evidence <eval-evidence.json> \
  --eval-source <tessl-eval-source> --tessl-workspace <workspace> \
  --accept-clawhub-mit0 --execute --resume <receipt.json> --json
```

The equivalent API call is:

```js
const resumed = await runPublicationSaga(projectRoot, artifacts, adapters, {
  execute: true,
  resumeReceiptPath: receipt.storagePath,
});
```

Do not create a fresh run to conceal a partial result. Resume rechecks unfinished targets, skips
verified targets and completed steps, and fails if the source commit, artifact digest, version,
adapter order, capability, auth descriptors, steps, rollback contract, path, schema, or private
permissions changed. Provider versions are treated as immutable; ambiguous remote state fails
closed instead of retrying blindly.

## npm trusted release

The repository's `release.yml` workflow publishes only a formal, non-prerelease GitHub Release
whose tag is exactly `v<package-version>`. The unprivileged `verify` job checks out that tag,
reopens the exact four GitHub Release assets, reruns all gates and the production audit, produces
one npm tarball, verifies it, and uploads that exact tarball plus its digest manifest and
digest-bound registry verifier. Only the protected `publish` job can request OIDC; after approval
it rehashes those three files, establishes whether the immutable version is explicitly absent or
already an exact match, publishes only when absent, verifies the registry DSSE/SLSA subject,
repository, commit, builder, and integrity, then uses `npm audit signatures` to cryptographically
verify registry signatures and provenance attestations before preserving a receipt. This
exact-existing branch makes a rerun safe after npm accepted the package but a later workflow step
failed.

Trusted publishing can be attached only after the package exists. Bootstrap the package name once
under the npm account that owns the `@mushanyoung` scope:

1. Enable account-level 2FA and run `npm whoami`; it must show the intended owner. Do this in a
   disposable private directory, not by changing this checkout.
2. Create a minimal `@mushanyoung/skillpress@0.0.0` package containing only a bootstrap README,
   the MIT license declaration, and the exact GitHub repository URL. Publish it interactively with
   `npm publish --access public --tag bootstrap --provenance=false`; complete the 2FA prompt. This
   claims the name without assigning the `latest` tag or consuming version `0.1.0`.
3. Confirm `npm view @mushanyoung/skillpress@0.0.0 name version dist-tags --json`, then remove the
   disposable directory. The bootstrap version is public and immutable.

Configure the release identity and approval boundary next:

1. In GitHub repository settings, create an environment named exactly `npm`. Add a required
   reviewer, prevent self-review when another maintainer is available, add no npm secret, and
   restrict deployment tags to `v*`.
2. Add an active tag ruleset targeting `v*`; restrict tag creation, updates, and deletion to the
   narrowest practical bypass list.
3. In npm package **Settings → Trusted publishing**, choose GitHub Actions and enter organization
   or user `mushanyoung`, repository `skillpress`, workflow filename `release.yml` (filename only),
   environment `npm`, and allowed action `npm publish`. With npm 11.15.0 or newer, the CLI
   equivalent is:

   ```bash
   npm trust github @mushanyoung/skillpress --repo mushanyoung/skillpress \
     --file release.yml --env npm --allow-publish
   ```

4. Confirm the repository is public and `package.json.repository.url` remains the exact GitHub
   repository. Do not add `NODE_AUTH_TOKEN`, `NPM_TOKEN`, or a write-token fallback.
5. After the first OIDC release succeeds, set npm **Publishing access** to **Require two-factor
   authentication and disallow tokens**, then revoke any obsolete write tokens.

The environment reviewer must wait for the unprivileged `verify` job and the local seven-target
publication receipt to finish, then compare the release tag/source commit, Tessl 90/90 evidence,
four GitHub Release assets, and npm tarball manifest before approving `publish`. The workflow uses
Node.js 26 (above npm's Node 22.14/npm 11.5.1 minimum), grants `id-token: write` only to the approved
job, and relies on npm's automatic provenance for a public package from a public repository.

## Incident checklist

When a run stops:

1. Preserve the exact staging directory, receipt, Git commit, and console-visible error code.
2. Determine whether the failure was preflight, a journaled mutation step, or verification.
3. Query provider state read-only. Never infer absence from a timeout or malformed response.
4. Rotate a credential if exposure is suspected; receipt files should never contain its value.
5. Fix external identity, access, approval, or service state without editing release inputs.
6. Resume the original receipt. If source or artifacts must change, bump/rebuild deliberately and
   treat it as a new release.
7. Use the provider-specific rollback statement in [the registry guide](REGISTRIES.md); never
   claim deletion or reversal that the provider does not guarantee.

For an npm workflow failure after the GitHub Release was published, fix only the external approval
or service condition and rerun the original GitHub Actions workflow run. Do not recreate, edit, or
republish the Release to manufacture another `release.published` event. The workflow re-verifies
the immutable release bundle; if npm already contains the exact version with exact provenance, it
skips `npm publish` and recovers the receipt. A conflict or unavailable registry state still fails
closed.

Private evidence and receipts are ignored working state, not disposable cache. Back them up with
the same confidentiality as build logs and delete only an explicitly identified run after its
retention requirement has expired.
