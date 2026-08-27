# Skill Press

Skill Press is a developer platform for building, verifying, curating, and distributing trusted
Agent Skills. The CLI turns one canonical skill into a reproducible candidate, measures behavior,
captures external evidence, and submits that exact candidate to the Skill Press review pipeline.

The product boundary is deliberate: authors submit once to Skill Press. Skill Press performs
automated validation and curator review, then publishes immutable releases through its canonical
registry. It does not ask authors to publish separate copies to multiple Agent Skill platforms.

> [!IMPORTANT]
> The CLI and submission protocol are under active development. The registry backend, account and
> token issuance, and `skpress add` / `skpress install` are not live yet. `skpress submit --dry-run`
> can prepare and verify a candidate locally; a non-dry-run submission cannot succeed until the
> canonical service is deployed.

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
owner; the future service must verify that the authenticated submitter controls it.

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
                                      +-> rejected
```

A published release separately has a mutable safety disposition:

- `trusted`: approved for normal installation;
- `quarantined`: temporarily withheld while an issue is investigated;
- `revoked`: no longer trusted for installation.

Review status answers what happened to a candidate. Trust status answers whether an immutable
release remains safe to install now. A local receipt is a retry journal, not a trust attestation.

The future `skpress add` and `skpress install` commands will resolve only canonical Skill Press
release records by default and verify version, digest, attestation, and current trust state. They
are not implemented or live today.

## Distribution model

- GitHub is the canonical open-source and source-transparency surface. It is not the Agent Skill
  registry.
- npm distributes the `@skill-press/cli` developer tool. Agent Skills are not npm packages.
- Skill Press owns admission, curator decisions, immutable skill versions, attestations, and
  trust-state changes.
- External catalogs may later index or mirror an already published release for discovery. Any
  mirror must preserve the exact digest and canonical URL, and its failure must not change the
  Skill Press release state.

Skill Press does not provide author-facing multi-publish. Future syndication, if added, will be a
platform-operated downstream process after canonical publication rather than a set of provider
credentials and target adapters in each author's project.

## Library API

The package exports the strict canonical-skill validator and the typed local workflow APIs:

```js
import { validateAgentSkill } from "@skill-press/cli";

const report = await validateAgentSkill("./skills/my-skill", {
  expectedName: "my-skill",
});
```

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
