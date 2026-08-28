# Canonical registry and distribution contract

Skill Press has one publication authority: the registry at `https://skill-press.com`. The CLI
submits an exact candidate only to the fixed API at `https://skill-press.com/api/v1`; it does not
publish author-maintained copies across multiple Agent Skill platforms.

> [!IMPORTANT]
> This document defines the client protocol and intended service contract. The registry and
> account/token issuance are not deployed yet. The submission, discovery, and trusted-install
> clients are implemented and locally tested; today, `skpress submit --dry-run` is the only
> end-user workflow that does not depend on the unavailable production service.

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
PUT  https://skill-press.com/api/v1/submissions/{id}/objects/{role}
POST https://skill-press.com/api/v1/submissions/{id}/finalize
GET  https://skill-press.com/api/v1/discovery?limit={n}[&cursor={opaque-token}]
GET  https://skill-press.com/api/v1/releases/{namespace}/{skill}/{version}
GET  https://skill-press.com/artifacts/{namespace}/{skill}/{version}
GET  https://skill-press.com/attestations/{namespace}/{skill}/{version}
GET  https://skill-press.com/trust/{namespace}/{skill}/{version}
GET  https://skill-press.com/checkpoints/{namespace}/{skill}/{version}
```

Project files cannot override the scheme, origin, base path, or redirects. This is a credential
boundary: `SKILL_PRESS_TOKEN` must never be sent to an origin selected by untrusted project input.

Authenticated submission requests use:

- `Authorization: Bearer <SKILL_PRESS_TOKEN>`;
- `Skill-Press-Protocol-Version: 1`;
- JSON responses with a bounded body;
- redirect rejection;
- a bounded timeout.

Discovery is public and read-only. It sends no bearer token, author credential, or provider
credential, but retains the fixed-origin, redirect, protocol, schema, response-size, and timeout
checks.

Submission is a bounded, resumable three-stage protocol:

1. `POST /submissions` sends only the deterministic canonical manifest. The service authenticates
   the principal, authorizes the namespace, checks the idempotency binding, and atomically reserves
   the exact namespace, skill, and version before retaining candidate bytes.
2. The client uploads each declared object to its fixed `objects/{role}` endpoint. Each request
   carries the exact declared media type and byte length; the service streams it to private
   candidate storage and accepts it only when its digest and size match the reserved manifest.
3. `POST /finalize` verifies that all six roles are committed, then atomically advances the
   candidate and its durable validation outbox record. Queue delivery may be retried, but it cannot
   create a second logical validation job.

The six roles are exactly:

- `manifest`: deterministic `skillpress.submission-manifest` JSON;
- `artifact`: the canonical deterministic skill archive;
- `provenance`: source, tree, runtime, and package bindings;
- `checksums`: exact release payload digests;
- `review-evidence`: current Tessl Quality evidence;
- `eval-evidence`: current Tessl Impact evidence.

The manifest is the object committed during reservation; the other five roles are uploaded
separately. It binds the explicitly requested lowercase registry namespace, project version, Git
source commit, project-config digest, complete skill-tree digest, artifact digest, evidence digests,
and eval-source digest. The namespace is neither `author.github` nor a value silently inferred from
the repository owner; the service must authorize the authenticated submitter for it. The manifest
says `serverValidationRequired: true` and marks client evidence advisory. The service must not
convert a client upload directly into a trusted release.

`GET /session` confirms authentication only. The initial `POST /submissions` transaction must
verify that the authenticated principal controls the manifest namespace before creating a
candidate, reserving the idempotency key or version, or retaining the upload. Authorization
failure must leave no namespace, candidate, idempotency, version, or artifact record behind.

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
| `publication-blocked` | The accepted candidate is held by a platform capacity gate; an audited curator retry is required after capacity expands |
| `published` | An immutable release record exists and matches the submitted artifact |
| `rejected` | The candidate will not be published |
| `withdrawn` | The author stopped a pre-acceptance candidate; its version and audit records remain reserved |

`received`, `automated-review`, `curator-review`, `changes-requested`, `accepted`,
`publication-blocked`, and `withdrawn` must never be displayed as “published.” A local
`operationStatus: submitted` means only that the client verified the remote candidate record.

An authenticated owner may call `POST /api/v1/submissions/{id}/withdraw` while a candidate is
`received`, `automated-review`, or `curator-review`. The append-only transition releases pending
quota without deleting candidate bytes, review history, or the permanent version reservation.

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
| `revoked` | Refuse new installation; require operator remediation for an existing local copy |

The bytes, version, locator, and original attestation of a published release are immutable. Trust
changes append a newer authenticated state with a monotonically increasing sequence; quarantine or
revocation never rewrites history to pretend the version did not exist.

The three ES256 signing roles are disjoint: `release-attestation`, `trust-event`, and
`current-trust`. After verifying the immutable artifact and attestation plus the latest signed
trust event, the installer obtains a separately signed current-trust checkpoint. That checkpoint
binds the exact locator, artifact and attestation digests, trust-envelope digest, status, sequence,
and update time, and is issued for ten minutes. Clients accept a checkpoint lifetime of at most 15
minutes, require at least 30 seconds to remain at activation, and reject cached dynamic responses.

A cached artifact or historically valid `trusted` event is therefore not enough to install. The
installer persists the highest observed trust sequence in `skill-lock.json` before exposing
`SKILL.md`, and fails closed if live trust is unavailable, quarantined, revoked, mismatched, stale,
or below that floor. Offline installation and force bypasses are intentionally unsupported.

Installed bytes under `.agents/skills/` are derived local state, not distributable source. They
must remain ignored by Git; only `skill-lock.json` is committed. A Git checkout containing a
tracked or unignored install target cannot use trusted installation, because cloning such bytes
would bypass the current-trust check.

Trust refresh is deliberately non-destructive. An error cannot safely prove that a pre-existing
directory is installer-owned, and an unavailable or ambiguous response is not a signed revocation,
so `skpress install` never silently removes an already visible local copy. After a **confirmed**
quarantine or revocation, stop agents that may already have loaded the skill, preserve the directory
if incident analysis needs it, then move `.agents/skills/<skill>/` completely outside every agent
discovery root. Keep `skill-lock.json` and its highest trust sequence; do not lower or delete that
floor to reinstall the old release. Restore only after the same release becomes trusted at a higher
signed sequence or a reviewed replacement version is added.

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
Skill Press does not publish the canonical skill to Tessl, and a Tessl result does not itself create a Skill Press submission,
curator approval, release, or trust record. The server applies a pinned self-consistency policy to
the advisory document, while a curator independently corroborates it and records an immutable
workpaper digest. This is human review authority, not a provider-signed execution receipt.

## Controlled discovery, mirrors, and feeds

External discovery is a platform feature, not an author command. `GET /api/v1/discovery` returns
pages with `snapshot`, `generatedAt`, `totalEntries`, normalized published releases, and an opaque
`nextCursor`. A full client collection always starts at the origin. The server cursor is an
authenticated token bound to the same snapshot, the last emitted position, and an expiry; clients
never decode it or use a caller cursor to claim a complete snapshot.

The canonical snapshot is:

```text
SHA-256("skillpress.discovery-snapshot.v1\n" || UTF8(JSON.stringify(normalized releases)))
```

Release records are sorted by locator, object fields have fixed canonical order, and each release's
mirror array is sorted by globally unique mirror ID. The client collects exactly `totalEntries`,
recomputes the digest, and rejects changed snapshots, early termination, excess records, cursor
cycles, no-progress pages, or conflicting release and mirror provenance.

Canonical field order is part of snapshot version 1:

```text
release: releaseState, locator, namespace, skill, version, artifactSha256, canonicalUrl,
         attestationUrl, publishedAt, trust, mirrors
trust:   status, sequence, updatedAt, [reasonCode]
mirror:  projectionType, id, operator, provider, mirrorKind, url, verifiedAt,
         [artifactSha256], source
source:  locator, artifactSha256, canonicalUrl, attestationUrl
```

The initial mirror policy accepts only `provider: github` URLs at the exact `github.com` origin and
under `/skill-press/`, with a launch maximum of 384 characters. Userinfo, ports, queries,
fragments, IP addresses, encoded/ambiguous paths, and other owners or subdomains are rejected.
The 384-character bound keeps the proven 256-release × 8-mirror worst case inside the 4 MiB
canonical snapshot budget. Every projection includes its canonical source
locator, artifact digest, release URL, and attestation URL:

- `mirrorKind: listing` is a read-only catalog projection;
- `mirrorKind: artifact` must additionally carry `artifactSha256` equal to the immutable release.

Mirror IDs are globally unique. Reusing a mirror URL is allowed only for identical canonical source
provenance. Mirrors propagate current `trusted`, `quarantined`, or `revoked` state but do not create
or alter it. Their failure is independent of canonical publication, and they never fabricate
installation activity, rankings, acceptance, or verification.

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
