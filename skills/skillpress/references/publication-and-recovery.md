# Publication and recovery

## Deterministic package boundary

Packaging currently uses the TypeScript API:

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

```ts
import { runPublicationSaga } from "@mushanyoung/skillpress";

const plan = await runPublicationSaga(projectRoot, artifacts, adapters, { execute: false });
// Inspect plan.targets and resolve every failed preflight before obtaining mutation authority.
const receipt = await runPublicationSaga(projectRoot, artifacts, adapters, { execute: true });
```

Execution is authorized only by the user's explicit publication request after the dry-run state is
known. The saga persists a private receipt after each step. If a run fails, resume with its exact
`storagePath`:

```ts
await runPublicationSaga(projectRoot, artifacts, adapters, {
  execute: true,
  resumeReceiptPath: receipt.storagePath,
});
```

Do not start a fresh run to hide a partial failure. Adapters recheck identity and remote state
immediately before mutation, reuse only exact existing versions, and fail on ambiguous provider
errors. A completed receipt still needs each target's remote verification; `submitted`, `derived`,
pending moderation, or human review is not equivalent to published.
