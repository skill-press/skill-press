# Skill Press release gates

Skill Press keeps local readiness, deterministic tests, paired behavior, official Tessl evidence,
client packaging, submission review, and published-release trust as distinct facts. Passing one
does not manufacture another.

## Client release gate

The `checkTesslReleaseGate` library API accepts only explicit review/eval evidence under the
private `.skill-press/tessl/<run-id>/evidence.json` capture layout and an eval-source directory
inside the project. It independently verifies:

- both evidence documents against their strict generated schemas;
- private regular-file and directory permissions with no symbolic-link path components;
- current Git HEAD and clean release-relevant inputs;
- exact `skill-press.yaml`, complete canonical-skill tree, and complete eval-source tree digests;
- exact private eval snapshot and exclusive embedded canonical-skill binding;
- evidence timestamps against `quality.evidenceMaxAgeHours`, including future-date rejection;
- the signed-release Tessl version and executable digest pair;
- normalized official command digests, exit status, raw byte counts, and raw stream hashes;
- Quality and Impact derivation by reparsing raw provider JSON;
- provider validation, configured Quality and Impact minimums, and required scenario
  non-regression;
- absence of residual temporary Git-boundary metadata.

The default project policy requires local readiness, Tessl Quality, and Tessl Impact of at least
90. Missing, stale, ineligible, malformed, locally scored, or hand-placed evidence fails closed.
The gate never accepts a numeric score option.

## What a passed gate authorizes

A passed client gate authorizes deterministic packaging of the exact bound source. It is also a
prerequisite for `skpress submit` and is rechecked before and after package/submission preparation.
The portable package profile applies to the complete archive, including Markdown that is not linked
from `SKILL.md`: at most 256 Markdown files, 512 KiB per Markdown file, and 8 MiB of Markdown in
total. These client-side bounds exactly match the isolated service validator and fail before upload.

It does not authorize or prove:

- publication to GitHub, npm, Tessl, or another Agent Skill catalog;
- successful submission to the Skill Press service;
- automated-review success;
- curator approval;
- immutable registry publication;
- current release trust;
- installation safety for a different version or digest.

The CLI has one canonical skill submission destination:
`https://skill-press.com/api/v1`. `skpress submit --dry-run` prepares and binds a local candidate
without contacting it. The production registry backend is not live yet.

## Submission gate

The deterministic submission manifest binds:

- config schema version, requested registry namespace, and project/skill identity;
- Git source commit and exact project-config digest;
- complete canonical-skill tree digest;
- immutable artifact bytes, digest, size, and media type;
- provenance and checksums;
- review/eval evidence bytes and digests;
- normalized eval-source path and complete eval-source digest;
- CLI package identity;
- `serverValidationRequired: true` and advisory client evidence.

The client derives an idempotency key from that manifest. A live submission must receive and then
re-read a schema-valid service resource whose namespace, key, commit, version, and artifact digest
match. A private receipt under `.skill-press/submissions/` is an exact retry journal only; it is not
a trust attestation.

## Service review gate

`GET /session` proves only that a bearer token identifies an active session; it does not authorize a
registry namespace. `POST /submissions` must authenticate the caller and atomically authorize the
requested namespace before it creates a candidate, reserves an idempotency key or version, retains
upload bytes, or emits `received`. An unauthorized request fails without occupying any identity.

After that admission boundary, and before the service can move a candidate to `accepted` or
`published`, it must:

1. establish immutable version absence or an exact idempotent match;
2. unpack and validate the artifact inside an isolated worker;
3. recompute the artifact digest and canonical tree digest, validate the archive and safety profile,
   and verify the exact provenance, checksums, and evidence-object bindings;
4. apply the versioned server policy to the untrusted Tessl evidence: pinned executable allowlist,
   normalized command digests, freshness, minimum scores, and scenario arithmetic/non-regression;
5. preserve the exact input digests, findings, policy version, and validity deadline;
6. obtain a curator decision that independently reviews the repository and records a digest of its
   corroboration workpaper;
7. create immutable storage and an authenticated attestation for the exact bytes.

The server can derive `skillSha256` from the uploaded ZIP. It cannot reconstruct the repository
commit, `skill-press.yaml`, or eval-source tree from this six-object protocol, so those values remain
cross-bound client claims for curator review. Likewise, Tessl currently supplies no detached provider
signature: command/output digests and score arithmetic prove evidence self-consistency, not that the
client actually executed Tessl. The automated gate therefore combines artifact-authoritative static
validation with advisory evidence policy checks; authenticated curator judgment remains an explicit
release authority.

Candidate review statuses are:

```text
received
automated-review
curator-review
changes-requested
accepted
publication-blocked
published
rejected
withdrawn
```

Only `published` means an immutable release record exists. `submitted`, `received`, `accepted`, and
`publication-blocked` are not synonyms for published. `publication-blocked` records an operational
capacity stop without misrepresenting it as a candidate-quality failure; resumption is an audited
curator action after the capacity/protocol limit is raised.
`withdrawn` is an author-requested terminal review state; it preserves the version reservation and
audit evidence while releasing pending-submission capacity.

## Release trust gate

A published release separately exposes one current trust state:

- `trusted`: normal installation is permitted after digest and attestation verification;
- `quarantined`: new installation is blocked while an issue is investigated;
- `revoked`: new installation is refused and existing consumers need remediation.

The release locator, semantic version, bytes, artifact digest, and original attestation remain
immutable. Trust changes append an authenticated, monotonically sequenced state; they do not erase
or overwrite the release.

The implemented `skpress add` and `skpress install` commands require `published` plus current
`trusted` state and verify the canonical digest, attestation, trust event, and short-lived
current-trust checkpoint. They remain unusable against production until the registry is deployed.

## Local trust limitation

Private evidence is part of the local trusted computing base. A user who can arbitrarily rewrite
the repository, Skill Press implementation, trusted executable table, and every private raw and
evidence file can falsify local state. Tessl CLI output currently has no detached provider
signature.

The client gate prevents accidental/manual score substitution and detects inconsistent tampering;
it does not claim cryptographic proof that the filesystem owner is honest. The service must treat all
client artifacts and evidence as untrusted, derive what it can from the uploaded bytes, apply its
current policy to the advisory evidence, and require its own authenticated curator and release
records. A future provider-signed receipt or isolated service-side rerun can strengthen this boundary
without changing what a current advisory document proves.

## External catalogs

External catalogs and mirrors are future discovery surfaces, not release gates. Their availability
does not block canonical Skill Press publication, and their listing does not create acceptance or
trust. A future platform-operated mirror must preserve the exact canonical version, digest,
attestation link, and current trust signal.
