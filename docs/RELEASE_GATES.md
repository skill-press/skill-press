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
- complete eval-source digest;
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

After that admission boundary, and before the future service can move a candidate to `accepted` or
`published`, it must independently:

1. establish immutable version absence or an exact idempotent match;
2. unpack and validate the artifact inside an isolated worker;
3. recompute source, config, skill, artifact, provenance, checksums, and evidence bindings;
4. run the current automated quality and safety policy without trusting client pass/fail fields;
5. preserve review findings and policy versions;
6. obtain the required curator decision;
7. create immutable storage and an authenticated attestation for the exact bytes.

Candidate review statuses are:

```text
received
automated-review
curator-review
changes-requested
accepted
published
rejected
```

Only `published` means an immutable release record exists. `submitted`, `received`, and `accepted`
are not synonyms for published.

## Release trust gate

A published release separately exposes one current trust state:

- `trusted`: normal installation is permitted after digest and attestation verification;
- `quarantined`: new installation is blocked while an issue is investigated;
- `revoked`: new installation is refused and existing consumers need remediation.

The release locator, semantic version, bytes, artifact digest, and original attestation remain
immutable. Trust changes append an authenticated, monotonically sequenced state; they do not erase
or overwrite the release.

The future `skpress add` and `skpress install` commands must require `published` plus current
`trusted` state and verify the canonical digest and attestation. Those commands and the registry
download backend are not implemented today.

## Local trust limitation

Private evidence is part of the local trusted computing base. A user who can arbitrarily rewrite
the repository, Skill Press implementation, trusted executable table, and every private raw and
evidence file can falsify local state. Tessl CLI output currently has no detached provider
signature.

The client gate prevents accidental/manual score substitution and detects inconsistent tampering;
it does not claim cryptographic proof that the filesystem owner is honest. The future service must
treat all client artifacts and evidence as untrusted, rerun its current policy, and use its own
authenticated review and release records.

## External catalogs

External catalogs and mirrors are future discovery surfaces, not release gates. Their availability
does not block canonical Skill Press publication, and their listing does not create acceptance or
trust. A future platform-operated mirror must preserve the exact canonical version, digest,
attestation link, and current trust signal.
