# Skill Press

Skill Press is a developer platform for building, verifying, curating, and distributing trusted
Agent Skills. The CLI turns one canonical skill into a reproducible candidate, measures behavior,
captures external evidence, and submits that exact candidate to the Skill Press review pipeline.

The product boundary is deliberate: authors submit once to Skill Press. Skill Press performs
automated validation and curator review, then publishes immutable releases through its canonical
registry. It does not ask authors to publish separate copies to multiple Agent Skill platforms.

> [!IMPORTANT]
> The CLI, registry, and trust protocol are under active development. `skpress add` and
> `skpress install` are implemented and hermetically tested, but the production registry, account
> and token issuance, immutable downloads, and discovery service are not deployed yet.
> `skpress submit --dry-run` can prepare and verify a candidate locally; network submission and
> installation cannot succeed until the canonical service is live.

## Canonical identities

| Surface | Identity |
| --- | --- |
| Brand | Skill Press |
| Website and registry authority | `https://skill-press.com` |
| Registry API | `https://skill-press.com/api/v1` |
| GitHub organization | `skill-press` |
| Main repository | `skill-press/skill-press` |
| npm package | `@skill-press/cli` |
| Executable | `skpress` |
| Project configuration | `skill-press.yaml` |
| Private project state | `.skill-press/` |

`SkillPress*` remains the prefix for programmatic types and serialized protocol identifiers. In
product prose, the brand is always written as **Skill Press**.

Each project also declares a lowercase `registry.namespace` in `skill-press.yaml`. It is the
requested canonical Skill Press identity, independent of `author.github` and the GitHub repository
owner; the production service verifies that the authenticated submitter controls it.

## Current development setup

Use Node.js 22 or newer. Until the first formal `@skill-press/cli` release, build the executable
from this repository:

```bash
npm ci --ignore-scripts
npm run build
node dist/bin.js --help
```

After the package is formally released, the intended installation is:

```bash
npm install --global @skill-press/cli
skpress --help
```

The package name is fixed, but this README does not claim that a production npm release is already
available.

## Workflow

Create a project from a complete, strictly validated capability brief:

```bash
skpress init --brief capability-brief.yaml --output ./my-skill
```

The brief must contain a registry namespace plus real outcomes, boundaries, tests, and evaluation
scenarios. `init` refuses partial TODO-style scaffolds and never overwrites an existing destination.

Run the deterministic and behavioral gates from the project root:

```bash
skpress check --project .
skpress test --project .
skpress eval --project . --image <image@sha256:digest> --model <model> -- <adapter-argv...>
```

- `check` validates the canonical skill, project identity, scenarios, rubric, references, safety,
  and local readiness. It never reports an external Quality or Impact score.
- `test` runs project-declared argv without a shell. These are trusted host tests, not a sandbox
  for an unknown repository.
- `eval` compares the same task without and with the exact skill in separate Docker or Podman
  sandboxes. Raw results remain under ignored, private `.skill-press/runs/` storage.

The bounded improvement loop accepts explicit author, reviewer, and evaluator processes while
keeping holdouts outside the author context:

```bash
skpress improve --training-evidence <training-evidence.json> \
  --holdout-evidence <holdout-evidence.json> \
  --author-command <author> --reviewer-command <reviewer> \
  --evaluator-command <evaluator>
```

Capture current official Tessl evidence with a pinned binary:

```bash
skpress tessl review --project . --workspace <workspace> \
  --executable <absolute-versioned-tessl-binary>
skpress tessl eval --project . --source .skill-press/tessl-evals/<set> \
  --executable <absolute-versioned-tessl-binary>
```

Skill Press currently trusts official Tessl CLI 0.101.0 by executable digest. Tessl is an evidence
provider, not a publication destination. See the [Tessl evidence contract](docs/TESSL.md).

Package an exact candidate only after the release gate passes:

```bash
skpress package --project . \
  --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> \
  --eval-source .skill-press/tessl-evals/<set>
```

Prepare the canonical submission locally:

```bash
skpress submit --project . --artifacts <artifacts-directory> \
  --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> \
  --eval-source .skill-press/tessl-evals/<set> \
  --dry-run
```

`submit` has exactly one production origin: `https://skill-press.com/api/v1`. Project input cannot
redirect credentials to another host. When the service is live, authenticated submission will use
`SKILL_PRESS_TOKEN`; do not put that value in configuration, fixtures, receipts, logs, or chat.

A successful HTTP submission means only that the immutable candidate entered review. It does not
mean the skill is published or trusted.

## Submission and trust are different state machines

Submission review records progress through:

```text
received -> automated-review -> curator-review -> accepted -> published
                                      |               |
                                      +-> changes-requested
                                      +-> rejected    +-> publication-blocked -> accepted (audited retry)
                                      +-> withdrawn
```

A published release separately has a mutable safety disposition:

- `trusted`: approved for normal installation;
- `quarantined`: temporarily withheld while an issue is investigated;
- `revoked`: no longer trusted for installation.

Review status answers what happened to a candidate. Trust status answers whether an immutable
release remains safe to install now. A local receipt is a retry journal, not a trust attestation.
`publication-blocked` preserves an accepted candidate when the launch discovery capacity is full;
it is neither a quality rejection nor a published release, and only an audited curator retry may
resume it after capacity is expanded.
An authenticated author may move a pre-acceptance candidate to terminal `withdrawn`; its immutable
version reservation and audit records remain, but it no longer consumes the author's pending quota.

Trusted installation uses exact locators and never falls back to a branch or third-party catalog:

```bash
skpress add <namespace>/<skill>@<exact-version>
skpress install
```

`add` records the immutable artifact and the highest observed signed trust sequence in
`skill-lock.json`, then installs under `.agents/skills/`. `install` restores every exact lock entry.
Both commands verify the canonical resolver, artifact digest and size, immutable release
attestation, signed trust event, and a short-lived signed current-trust checkpoint before making
`SKILL.md` agent-visible. Cached, expired, unavailable, quarantined, revoked, mismatched, or
rollback state fails closed. Offline installation is intentionally unsupported. The commands are
implemented in this repository but cannot perform a real install until the registry is deployed.
Commit `skill-lock.json`, but keep `.agents/skills/` ignored: installed bytes are derived locally
and every clone must rehydrate them through a fresh current-trust check.

## Distribution model

- GitHub is the canonical open-source and source-transparency surface. It is not the Agent Skill
  registry.
- npm distributes the `@skill-press/cli` developer tool. Agent Skills are not npm packages.
- Skill Press owns admission, curator decisions, immutable skill versions, attestations, and
  trust-state changes.
- The public, read-only discovery feed exposes only already published immutable releases. Its
  canonical snapshot digest covers every normalized release and mirror projection.
- Initial mirrors are Skill Press-operated GitHub projections under `github.com/skill-press/`.
  A listing must contain an actual anchor whose `href` is the exact canonical release URL and an
  actual `code` element whose text is the exact artifact digest; an artifact must be byte-identical.
  Mirror failure cannot change canonical release state.

Skill Press does not provide author-facing multi-publish. Discovery and mirroring are
platform-operated downstream processes after canonical publication, without author provider
credentials or target adapters in project configuration.

## Library API

The package exports the strict canonical-skill validator and the typed local workflow APIs:

```js
import { validateAgentSkill } from "@skill-press/cli";

const report = await validateAgentSkill("./skills/my-skill", {
  expectedName: "my-skill",
});
```

The public discovery client is fixed to the canonical origin and verifies the complete snapshot
before returning a collection:

```js
import { createCanonicalDiscoveryClient } from "@skill-press/cli";

const discovery = await createCanonicalDiscoveryClient().collect();
```

`collect()` always starts at the feed origin; caller-supplied cursors are not accepted for a full
snapshot. Low-level `listPage()` treats cursors as opaque pagination tokens and does not establish
that a partial page is a complete snapshot.

Validation reads a bounded resource tree without executing the skill. It checks strict
frontmatter, local Markdown references, placeholders, portability, path aliases, suspicious
resource names, and concurrent changes. An `ok: true` validation result is not by itself a
readiness score, behavioral evaluation, curator decision, published release, or trust attestation.

This repository self-hosts the same contract through `skill-press.yaml`,
`skills/skill-press/`, `evals/training.yaml`, `evals/holdout.yaml`, and `evals/rubric.yaml`.

## Documentation

- [Product and implementation plan](docs/PLAN.md)
- [Operating and recovery runbook](docs/OPERATIONS.md)
- [Security and trust-boundary model](docs/SECURITY.md)
- [Canonical registry and distribution contract](docs/REGISTRIES.md)
- [Tessl evidence contract](docs/TESSL.md)
- [Release-gate contract](docs/RELEASE_GATES.md)

Historical implementation reviews remain under `docs/reviews/`; they describe the code at the
time of each review and are not the current product contract.

## License

MIT
