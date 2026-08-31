# Submission and recovery

## Deterministic package boundary

Create an advanced reusable package explicitly when needed:

```sh
skpress package --project . --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> --eval-source <eval-source> --json
```

Or let `submit` package after the same gate. Staging accepts only clean tracked canonical files and
rejects links, special files, ignored or untracked release inputs, and changes during capture.
Packaging emits byte-identical `.skill` and `.zip` archives, checksums, and provenance with fixed
ordering, modes, compression, and timestamps.

The low-level API remains available to typed callers:

```ts
import { packageStagedSkill, stageCanonicalSkill } from "@skill-press/cli";

const staged = await stageCanonicalSkill(projectRoot);
const packaged = await packageStagedSkill(projectRoot, staged);
```

## Prepare and submit

Prepare locally without network mutation:

```sh
skpress submit --project . --dry-run \
  --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> --eval-source <eval-source> --json
```

After reviewing the exact plan, a plain invocation submits only to Skill Press:

```sh
SKILL_PRESS_TOKEN=<token> skpress submit --project . \
  --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> --eval-source <eval-source> --json
```

The production origin is fixed at `https://skill-press.com`; neither repository configuration nor
CLI flags can redirect the bearer token. The request uses one deterministic manifest and one
idempotency key. It includes the exact canonical archive, provenance, checksums, and advisory
evidence bindings. It also binds the explicit lowercase `registry.namespace` from
`skill-press.yaml`; do not infer that namespace from `author.github` or the repository owner. The
server must authorize the authenticated submitter for the requested namespace and treats all client
evidence as untrusted input.

Session validation proves authentication only. The server must atomically authorize the requested
namespace during `POST /submissions`, before it creates a candidate, reserves an idempotency key or
version, or retains any uploaded bytes. A rejected caller must not be able to occupy an identity on
behalf of its owner.

## Journal and recovery

Before its mutating request, submit persists a mode-0600 journal under:

```text
.skill-press/submissions/<idempotency-key>/receipt.json
```

On an interrupted or failed run, reuse the exact artifacts and receipt:

```sh
skpress submit --project . --artifacts <artifacts-directory> \
  --resume .skill-press/submissions/<idempotency-key>/receipt.json \
  --review-evidence <review-evidence.json> \
  --eval-evidence <eval-evidence.json> --eval-source <eval-source> --json
```

Resume rechecks the release gate, package inventory, manifest digest, source commit, config and skill
digests, evidence digests, registry protocol, and receipt path. If the journal contains a validated
remote ID, resume refreshes it without a second POST. Otherwise retry sends the identical manifest
under the same idempotency key so a crash after server acceptance cannot create a second candidate.
Do not start a fresh run to hide partial state.

The local journal is not an attestation. Report remote review states exactly: `received`,
`automated-review`, `curator-review`, `changes-requested`, `accepted`, `publication-blocked`,
`published`, `rejected`, or `withdrawn`. Only `published` includes an immutable release binding.
Its append-only trust status is `trusted`, `quarantined`, or `revoked`; quarantine and revocation
never rewrite the artifact bytes or version.
Offline `skpress status` reports only local release-input readiness and cached, last-observed trust;
its JSON field `currentTrustVerified` is always `false` and cannot authorize installation.

GitHub Releases and npm trusted publishing ship the Skill Press product itself through repository
CI. They are not author-facing skill publication targets. Do not publish unreviewed candidates to
askill, ClawHub, AgentSkillHub, or community catalogs on the user's behalf.
