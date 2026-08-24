# Operating SkillPress

This runbook covers local development, evidence capture, deterministic packaging, publication
planning and recovery, and the npm release workflow for SkillPress 0.1.0.

## Current interface boundary

The installed CLI currently implements `create`, `check`, `test`, `eval`, and `tessl`. Staging,
packaging, release-gate evaluation, adapter construction, publication, and receipt resume are
public TypeScript APIs. `package`, `publish`, `status`, and `doctor` are not CLI commands in 0.1.0;
do not turn their help placeholders into operating instructions.

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

## Capture and verify Tessl evidence

Install the pinned official Tessl CLI 0.99.0, authenticate, and confirm the intended workspace.
Use `TESSL_TOKEN` for non-interactive calls; do not place it in `skillpress.yaml` or the skill.

```bash
tessl auth login
tessl auth whoami --json
node dist/bin.js tessl review --project . --workspace <workspace> --json
node dist/bin.js tessl eval --project . --source <tessl-eval-source> \
  --agent <agent> --model <model> --json
```

Retain the two returned private evidence paths. Immediately before staging a release, re-open and
revalidate them against current Git inputs:

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

The caller must require `gate.passed` before any remote mutation. The staging/package APIs do not
accept manual score arguments and do not silently run an external provider gate. They require
clean tracked canonical inputs, then emit private `.skillpress/staging/` artifacts, checksums, and
source-bound provenance. Preserve that staging run until every target is verified.

## Plan publication

Construct exactly one adapter for each entry in `publish.targets`, in the same order. Adapter
options bind provider identities; credentials stay in the provider's login store or named
environment variable.

```js
import {
  createAgentSkillHubPublicationAdapter,
  createAgentSkillsHubCatalogAdapter,
  createAskillPublicationAdapter,
  createClawHubPublicationAdapter,
  createGitHubPublicationAdapter,
  createNpmPublicationAdapter,
  createSkillsShDerivedAdapter,
  createTesslPublicationAdapter,
  runPublicationSaga,
} from "@mushanyoung/skillpress";

const adapters = [
  createGitHubPublicationAdapter(),
  createNpmPublicationAdapter(),
  createTesslPublicationAdapter({ workspace: "<tessl-workspace>" }),
  createSkillsShDerivedAdapter({ source: "<github-owner>/<repository>" }),
  createAskillPublicationAdapter({ author: "<github-login>" }),
  createAgentSkillHubPublicationAdapter(),
  createAgentSkillsHubCatalogAdapter({ contributor: "<github-login>" }),
  createClawHubPublicationAdapter({ owner: "<clawhub-owner>", licenseConsent: "MIT-0" }),
];

const plan = await runPublicationSaga(projectRoot, artifacts, adapters);
```

Dry run is the default. Inspect every target's `preflight`, `capability`, `auth`, steps, and
rollback statement. A failed preflight blocks the complete mutation run; resolve it without
editing the receipt or weakening the gate. `skills-sh` is intentionally `derived` and has no
mutation step. The catalog target is `submit`; an open pull request is not a merged listing.

## Execute and recover

Only after reviewing a fresh dry run and obtaining publication authority, start execution:

```js
const receipt = await runPublicationSaga(projectRoot, artifacts, adapters, { execute: true });
```

The saga writes a schema-validated receipt after every completed step under
`.skillpress/publications/<run-id>/receipt.json`. Directories are private and receipt files use
mode `0600` on POSIX systems. The receipt contains credential names, never values or provider error
details.

If `receipt.status === "failed"`, keep the artifacts and resume the exact receipt:

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
whose tag is exactly `v<package-version>`. It reruns all gates, production dependency audit, and
package smoke on Node.js 26, then uses npm trusted publishing. Before first use:

1. Create a protected GitHub environment named `npm` and require the desired reviewers.
2. On npm, configure the trusted publisher for owner `mushanyoung`, repository `skillpress`,
   workflow `release.yml`, environment `npm`, and allowed action `npm publish`.
3. Confirm the repository is public and `package.json.repository.url` is unchanged.
4. Protect release tags. Do not add `NODE_AUTH_TOKEN`, `NPM_TOKEN`, or a write token fallback.
5. Run the full Tessl gate locally, publish/verify the requested skill targets, then create the
   immutable tag and formal GitHub Release only when the release policy is satisfied.

The workflow requires npm 11.5.1 or newer and Node.js 22.14.0 or newer, grants `id-token: write`
only to the publish job, and relies on npm's automatic provenance for a public package from a
public GitHub repository.

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

Private evidence and receipts are ignored working state, not disposable cache. Back them up with
the same confidentiality as build logs and delete only an explicitly identified run after its
retention requirement has expired.
