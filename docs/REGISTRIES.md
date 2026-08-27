# Canonical registry and distribution contract

Skill Press has one publication authority: the registry at `https://skill-press.com`. The CLI
submits an exact candidate only to the fixed API at `https://skill-press.com/api/v1`; it does not
publish author-maintained copies across multiple Agent Skill platforms.

> [!IMPORTANT]
> This document defines the client protocol and intended service contract. The production registry
> backend, account/token issuance, immutable download service, and install commands are not live
> yet. Today, `skpress submit --dry-run` can prepare and validate the exact candidate locally.

## Authority matrix

| Surface | Role | Authoritative for | Explicitly not authoritative for |
| --- | --- | --- | --- |
| Skill Press registry | Canonical skill registry | namespace, review result, immutable release, artifact digest, attestation, trust history | an author's source-control history |
| GitHub | Source and transparency | repository and exact source commit | Skill Press acceptance, release trust, or installation safety |
| npm | Developer-tool distribution | `@skill-press/cli` package versions and provenance | Agent Skill versions |
| Tessl | External evidence provider | official Quality and Impact results returned by its pinned CLI | canonical publication or trust state |
| External catalogs and mirrors | Future discovery | their own listing availability | acceptance, canonical bytes, or current trust unless verified from Skill Press |

The Skill Press meta-skill follows the same rule: its canonical source belongs in
`skill-press/skill-press`, and its first authoritative Agent Skill release belongs in the Skill
Press registry. It is not independently published to third-party skill registries at launch.

## No author-facing multi-publish

Skill Press does not provide author-facing multi-publish.

`skill-press.yaml` contains no provider target list. `skpress submit` has no `--target`, custom
registry URL, or third-party credential option. This avoids several failure classes:

- the same version resolving to different bytes on different platforms;
- provider-only metadata drifting away from the canonical `SKILL.md`;
- authors granting broad credentials to every local project;
- a weak downstream review being mistaken for Skill Press approval;
- one unavailable catalog blocking publication everywhere;
- security quarantine or revocation failing to reach users of an untracked copy.

Portability is still a product goal. An immutable Skill Press bundle can be exported, cached, or
mirrored as the exact same bytes. Portability does not require multiple independent publication
authorities.

## Fixed API boundary

The production client compiles in these endpoints:

```text
GET  https://skill-press.com/api/v1/session
POST https://skill-press.com/api/v1/submissions
GET  https://skill-press.com/api/v1/submissions/{id}
```

Project files cannot override the scheme, origin, base path, or redirects. This is a credential
boundary: `SKILL_PRESS_TOKEN` must never be sent to an origin selected by untrusted project input.

Every request uses:

- `Authorization: Bearer <SKILL_PRESS_TOKEN>`;
- `Skill-Press-Protocol-Version: 1`;
- JSON responses with a bounded body;
- redirect rejection;
- a bounded timeout.

The submission request is multipart and includes exactly:

- `manifest`: deterministic `skillpress.submission-manifest` JSON;
- `artifact`: the canonical deterministic skill archive;
- `provenance`: source, tree, runtime, and package bindings;
- `checksums`: exact release payload digests;
- `reviewEvidence`: current Tessl Quality evidence;
- `evalEvidence`: current Tessl Impact evidence.

The manifest binds the explicitly requested lowercase registry namespace, project version, Git
source commit, project-config digest, complete skill-tree digest, artifact digest, evidence digests,
and eval-source digest. The namespace is neither `author.github` nor a value silently inferred from
the repository owner; the service must authorize the authenticated submitter for it. The manifest
says `serverValidationRequired: true` and marks client evidence advisory. The service must not
convert a client upload directly into a trusted release.

`GET /session` confirms authentication only. The `POST /submissions` transaction must verify that
the authenticated principal controls the manifest namespace before creating a candidate, reserving
the idempotency key or version, or retaining the upload. Authorization failure must leave no
namespace, candidate, idempotency, version, or artifact record behind.

## Idempotency and recovery

The client derives an idempotency key from the exact deterministic submission manifest and sends
it as `Idempotency-Key`. The same manifest must resolve to the same submission resource. A version
or key conflict with different bytes fails closed.

Before and after the request, the client rechecks:

- the current Tessl release gate;
- the clean source commit;
- the packaged artifact inventory and digests;
- the generated manifest and idempotency key;
- the remote namespace, source commit, version, artifact digest, and status version.

A mutating attempt writes a private journal to:

```text
.skill-press/submissions/<idempotency-key>/receipt.json
```

The journal is written after state transitions and can be resumed only with the exact artifact and
evidence bindings. A timeout or malformed response is ambiguous; it is not proof that the server
did nothing. If a validated remote ID was saved, resume refreshes that exact resource without a
second POST. If no remote ID was received, resume repeats the POST with the identical manifest and
idempotency key so the service resolves it to the same candidate rather than creating another one.

The receipt records client operation states `submitting`, `failed`, and `submitted`. A dry run
returns an unpersisted `prepared` receipt. These are local transport/recovery states, not service
review or release trust.

## Submission review lifecycle

The canonical service resource exposes one candidate review status:

| Status | Contract |
| --- | --- |
| `received` | The service accepted and durably identified the exact candidate |
| `automated-review` | Isolated server-side validation and evaluation are running |
| `curator-review` | Automated policy permits human review to proceed |
| `changes-requested` | The candidate cannot advance without an updated, newly identified submission |
| `accepted` | Automated and curator review approved the candidate; release creation is pending |
| `published` | An immutable release record exists and matches the submitted artifact |
| `rejected` | The candidate will not be published |

`received`, `automated-review`, `curator-review`, `changes-requested`, and `accepted` must never be
displayed as “published.” A local `operationStatus: submitted` means only that the client verified
the remote candidate record.

Published resources additionally expose a release record with:

- canonical locator;
- semantic version;
- immutable artifact SHA-256;
- canonical release URL;
- attestation URL;
- current release trust state and sequence.

## Release trust lifecycle

Trust is separate from candidate review:

| Trust | Required consumer behavior |
| --- | --- |
| `trusted` | Normal installation may proceed after digest and attestation verification |
| `quarantined` | Block new installation by default while an incident is investigated |
| `revoked` | Refuse new installation and surface remediation for existing locks |

The bytes, version, locator, and original attestation of a published release are immutable. Trust
changes append a newer authenticated state with a monotonically increasing sequence; quarantine or
revocation never rewrites history to pretend the version did not exist.

A cached artifact is not enough to install safely when current trust cannot be established. The
future installation design must document its offline policy and fail closed for a release whose
trust state is unavailable, quarantined, revoked, mismatched, or older than the lock's observed
sequence.

## GitHub role

GitHub hosts source, reviewable history, CI, issues, and the Skill Press CLI product release. A
Skill Press candidate binds a canonical GitHub repository and exact commit, but generic submission
does not push branches, tags, topics, or releases to an author's repository.

The repository `skill-press/skill-press` may create GitHub Releases for the CLI product and its
audited build artifacts. That is product release infrastructure, not the Agent Skill registry.

## npm role

npm contains one package: `@skill-press/cli`, with executable `skpress`. The package uses
GitHub Actions OIDC trusted publishing and npm provenance. npm does not contain canonical Agent
Skill release records, curator decisions, or trust history.

The absence, deprecation, or compromise of an npm CLI version is handled through the CLI product
supply chain. It does not mutate the immutable Agent Skill artifacts already held by the Skill
Press registry.

## Tessl role

Tessl provides external evidence used by the client release gate.
Skill Press does not publish the canonical skill to Tessl, and a Tessl result does not itself
create a Skill Press submission, curator approval, release, or trust record. The server may
independently re-run or corroborate external evidence under its current policy.

## Future catalogs, mirrors, and feeds

External discovery is a later platform feature, not an author command. A future Skill Press feed
or syndication worker may expose a release to a catalog only after canonical publication. It must:

1. use the exact canonical artifact digest and version;
2. link to the canonical Skill Press release and attestation;
3. distinguish a mirror from the publication authority;
4. propagate current `trusted`, `quarantined`, or `revoked` state where the target supports it;
5. avoid provider-specific source mutations or silent license changes;
6. record failure independently without blocking or rolling back canonical publication;
7. never fabricate installation activity, rankings, acceptance, or verification.

If a catalog cannot preserve those boundaries, Skill Press may provide a discovery link rather
than a mirrored package. Organic indexing of public GitHub source is an external fact and is not a
Skill Press publication receipt.

## Rollback and incident boundary

Candidate review can be stopped by `changes-requested` or `rejected`. Published versions are
immutable and are not overwritten or reused. If a released skill becomes unsafe:

1. move the release to `quarantined` while assessing scope;
2. preserve the exact artifact, attestation, review record, and audit history;
3. move to `trusted` only after a documented resolution, or to `revoked` when trust cannot be
   restored;
4. publish a fixed new semantic version rather than modifying the old bytes;
5. notify locked consumers and downstream mirrors through authenticated trust-state updates.

Deletion is not the primary safety control because it destroys the evidence consumers need to
understand an incident. Trust history and replacement guidance are the durable rollback mechanism.
