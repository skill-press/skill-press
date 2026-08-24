# Publication and recovery

## Deterministic package boundary

Prefer the CLI because it checks current official Tessl evidence both before and after packaging:

```sh
skillpress package --project . --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> --eval-source <eval-source> --json
```

The low-level TypeScript API is available when a typed caller enforces the release gate itself:

```ts
import { packageStagedSkill, stageCanonicalSkill } from "@mushanyoung/skillpress";

const staged = await stageCanonicalSkill(projectRoot);
const packaged = await packageStagedSkill(projectRoot, staged);
const artifacts = { ...packaged, sourceCommit: staged.sourceCommit };
```

Staging accepts only clean, tracked canonical files and rejects links, special files, ignored or
untracked release inputs, and source changes during capture. Packaging emits byte-identical `.skill`
and `.zip` archives, checksums, and provenance with fixed ordering, modes, and timestamps. Keep the
private staging directory intact until publication and verification finish.

## Provider capability map

| Target | Capability | Success boundary |
| --- | --- | --- |
| GitHub | publish | exact commit/tag/release assets verified |
| npm | publish | exact scoped version, integrity, provenance, and public metadata verified |
| Tessl | publish | exact public plugin archive verified; public approval and external gate required |
| askill.sh | publish | exact immutable version and raw projected `SKILL.md` verified |
| agentskillhub.dev | publish | documented import accepted, then exact public record verified |
| Agent Skills Hub catalog | submit | pull request merged; an open PR remains review-required |
| ClawHub | publish | exact MIT-0 projection and clean security review verified |
| skills.sh | derived | public GitHub source ready; organic listing is never manufactured |

Construct exactly one adapter for every configured `publish.targets` entry. Provider credentials,
workspace/owner identity, explicit MIT-0 consent, and current API tokens belong in adapter options
or their named environment variable; never put them in the canonical skill.

## Dry run, execute, and resume

Use `skillpress publish` with the exact private artifacts path and the same current evidence.
Dry-run is the default; `--execute` is explicit and `--resume <receipt>` additionally requires it.
Supply only the identity/executable options required by configured targets, including
`--tessl-workspace` and explicit `--accept-clawhub-mit0` when those targets are present.

Some target sets require a public source/CI checkpoint before the all-target dry run. When one does,
obtain explicit source-push authority and satisfy that target's exact branch and CI contract. The
current self-host target set requires the packaged source commit on public `main`, requires `main`
to be the repository's default branch, and requires all CI checks to pass. Do not create a version
tag or formal Release at this checkpoint. If its source-push authority is absent, or its branch
contract fails, stop and report the blocker. If no configured target requires this checkpoint,
record it as not applicable and do not introduce an unrelated external mutation.

The complete dry run must then validate every configured target, including provider-specific
dry-run commands. An initial dry run may discover missing identity, credentials, first-public
provider approval, license consent, collision, or capability prerequisites. A read-only dry run
does not authorize remediation: obtain separate explicit authority before changing provider or
account state. Resolve the prerequisites and rerun a fresh complete all-target dry run; request
separate execution authority only after that fresh plan is fully preflighted.

The low-level API is:

```ts
import { runPublicationSaga } from "@mushanyoung/skillpress";

const plan = await runPublicationSaga(projectRoot, artifacts, adapters, { execute: false });
// Inspect plan.targets; authorize any mutating remediation at its own boundary, rerun a fresh
// dry run, then authorize saga execution separately.
const receipt = await runPublicationSaga(projectRoot, artifacts, adapters, { execute: true });
```

Execution is authorized only by the user's separate explicit publication request after the dry-run
state is known. In the current self-host plan, preserve configured target order and keep GitHub last:
its `publish-release` step is the only point that creates the version tag and formal Release, after
earlier targets succeed. The saga persists a private receipt after each step. If a run fails, resume
with its exact `storagePath`:

```ts
await runPublicationSaga(projectRoot, artifacts, adapters, {
  execute: true,
  resumeReceiptPath: receipt.storagePath,
});
```

Do not start a fresh run to hide a partial failure. Adapters recheck identity and remote state
immediately before mutation, skip only verified or derived targets, reuse only exact existing
versions, and fail on ambiguous provider errors. Classify read-only remote probes as absent,
exact-existing, conflicting, unavailable, or still ambiguous when probing the requested immutable
identity or version. A conflict means that requested identity or version exists with a different
owner, source, or content digest; only exact-existing is reusable, while conflicting, unavailable,
and ambiguous states fail closed. Provider lifecycle states such as older, outdated, or pending
follow only the adapter's explicit update or polling rules and are not exact-existing reuse;
rejected remains fail closed. Resume only while the source commit, artifact digest, project version,
adapter order, capability, auth-descriptor names, step plan, rollback contract, receipt path and
schema, and private storage permissions remain bound and unchanged. A completed receipt still needs
each target's remote verification; `submitted`, `derived`, pending moderation, or human review is
not equivalent to published.
