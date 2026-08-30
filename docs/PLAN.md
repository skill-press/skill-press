# Skill Press product and implementation plan

Status: active implementation baseline

Date: 2026-08-27

Repository: `https://github.com/skill-press/skill-press`

## Outcome

Skill Press is the trusted quality, curation, and immutable distribution layer for Agent Skills.
It helps an author create and improve one canonical skill, prove that it behaves better than a
no-skill baseline, package exact source-bound artifacts, and submit one candidate for automated and
human review.

The canonical registry at `skill-press.com` is the only publication authority in the product
model. Authors do not select downstream registries or supply credentials for other Agent Skill
platforms. External catalogs may discover or mirror a canonical release only through the
platform-controlled downstream feed; they do not decide whether it is accepted, published,
trusted, quarantined, or revoked.

The product promise is therefore narrower and stronger than “publish everywhere”:

> Build once, prove quality, submit once, and install an immutable release whose current trust
> state can be verified.

## Product identity

| Surface | Canonical identity |
| --- | --- |
| Brand | Skill Press |
| Website and registry origin | `https://skill-press.com` |
| Registry API | `https://skill-press.com/api/v1` |
| GitHub organization | `skill-press` |
| Main repository | `skill-press/skill-press` |
| npm package | `@skill-press/cli` |
| CLI executable | `skpress` |
| Project definition | `skill-press.yaml` |
| Private local state | `.skill-press/` |

`SkillPress*` remains the stable prefix for exported TypeScript types and serialized protocol
identifiers. It is not the product spelling used in prose.

## Current implementation boundary

The repository currently implements the local CLI, strict schemas, deterministic validation,
sandboxed paired evaluation, bounded improvement, Tessl evidence capture, release gates,
reproducible packaging, and a canonical submission client/journal contract.

| Capability | Current state |
| --- | --- |
| `skpress init`, `check`, `test`, `eval`, `improve` | Implemented locally |
| `skpress tessl`, `package`, `status`, `doctor` | Implemented locally |
| `skpress submit --dry-run` | Implemented locally |
| Canonical submission client for `https://skill-press.com/api/v1` | Implemented and hermetically testable |
| Cloudflare registry backend and account/token issuance | Implemented in the private control-plane repository; not deployed |
| Curator API and isolated server-side validation | Implemented and locally integration-tested; not live |
| Immutable registry downloads, attestations, and current-trust checkpoints | Implemented and locally integration-tested; not live |
| `skpress add` and `skpress install` | Implemented and hermetically testable; live origin unavailable |
| Canonical discovery client, schema, and snapshot verification | Implemented and hermetically testable |
| Discovery snapshot, cursor, and mirror service | Implemented in the control plane; not live |

This distinction is part of the contract. A compiled client or a schema does not prove that a
remote service exists, and a locally prepared submission does not prove publication or trust.

## Product principles

1. **Behavior over prose.** A polished `SKILL.md` is not evidence that an agent performs better.
   Publishable candidates need positive, near-miss, failure, adversarial, and untouched holdout
   scenarios.
2. **One canonical source.** A project maintains one Agent Skill tree. Package and submission
   metadata are generated from it; provider-specific mirrors are not maintained by authors.
3. **Deterministic gates first.** Structure, references, placeholders, scripts, fixtures,
   versions, source state, artifacts, and receipts are checked by code. Semantic judging is used
   only where deterministic checks cannot establish the result.
4. **Paired, sandboxed evaluation.** Behavioral evidence runs the same scenario without and with
   the exact staged skill in separate bounded sandboxes.
5. **Evidence types remain distinct.** Local readiness, local paired behavior, Tessl Quality and
   Impact, curator decisions, artifact attestations, and release trust are never collapsed into a
   single invented score.
6. **Server validation is authoritative.** Client evidence is useful for fast feedback and
   reproducible submission, but it is advisory to the service. The registry derives artifact/tree
   facts itself, applies its versioned safety and evidence policy, and requires an authenticated
   curator's independent corroboration before publication.
7. **Submission is not publication.** Upload success means only that an exact candidate entered
   review. Human acceptance and immutable publication are later service-side events.
8. **Trust can change; bytes cannot.** Published artifact bytes and versions are immutable. Their
   safety disposition may move from `trusted` to `quarantined` or `revoked` without rewriting
   history.
9. **No author-facing multi-publish.** Skill Press accepts one canonical submission. Later
   discovery and mirroring are platform operations downstream of publication.
10. **Truth before growth.** Missing infrastructure, unavailable evidence, ambiguous remote
    state, or a blocked review is reported as such rather than represented as success.

## User workflow

```text
skpress init       strict brief -> canonical skill, tests, eval inputs, project contract
skpress improve    bounded author/reviewer/evaluator loop with holdout isolation
skpress check      spec, references, safety, identity, and local readiness
skpress test       trusted deterministic project commands without a shell
skpress eval       isolated baseline/with-skill behavioral measurement
skpress tessl      official external Quality and Impact evidence capture
skpress package    reproducible candidate archive, checksums, and provenance
skpress submit     one canonical Skill Press submission or local dry run
skpress status     local gate, package, and submission-journal summary
skpress doctor     runtime, sandbox, Tessl, credential-name, and collision diagnostics
```

After the registry is deployed, the implemented installation workflow is:

```text
skpress add <namespace>/<skill>@<version>  resolve and record a canonical trusted release
skpress install                       restore exact locked releases and verify trust
```

These commands have one compiled registry origin and are intentionally unusable offline. They do
not resolve an arbitrary GitHub branch or third-party catalog entry. Code availability does not
mean that the production origin is already serving releases.

Commands support human-readable output and stable JSON. External processes are invoked without a
shell, with explicit argv, bounded output, timeouts, and narrow environment forwarding.

## Repository architecture

```text
src/
  cli/                   commands, argument parsing, output, and exit codes
  config/                schema-v2 skill-press.yaml loading and generated types
  create/                strict brief loading and transactional project generation
  check/                 deterministic Agent Skill validation and readiness
  test/                  trusted project test runner
  eval/                  scenario contracts and isolated paired evaluation
  improve/               bounded author/review/evaluation state machine
  tessl/                 pinned external evidence capture
  release/               current source-bound evidence gate
  package/               tracked-only staging, deterministic archives, provenance
  submission/            fixed-origin manifest, client, journal, and recovery
  discovery/             fixed-origin, full-snapshot discovery verification
  install/               signatures, trust freshness, lockfiles, ZIP parsing, atomic activation
  status/                read-only local lifecycle summary
  doctor/                local prerequisites and credential-name diagnostics
skills/skill-press/       the self-hosted Skill Press meta-skill
schemas/                 authoritative JSON Schemas
test/                    hermetic, integration, adversarial, and golden tests
docs/                    current operating and trust contracts
docs/reviews/            historical slice reviews; not the current product contract
```

The production service is a separate authority boundary. Its private Cloudflare control plane uses
D1 for the authoritative state machine, separate candidate and immutable-release R2 buckets,
Queues for bounded review work, and isolated API, validator, review, signer, and current-trust
checkpoint Workers. None of those deployed-service claims apply until the production resources are
provisioned and verified.

## Project, evidence, and artifact model

`skill-press.yaml` schema version 2 records the project and canonical skill identity, requested
`registry.namespace`, risk class, test commands, local readiness threshold, external Quality and
Impact thresholds, evidence age, evaluation policy, and improvement budgets. The namespace is a
request that the service must authorize; it is not inferred from the author or repository owner.
The configuration deliberately has no `publish.targets`, endpoint override, or provider credential
configuration.

Private working state is rooted at `.skill-press/`:

```text
.skill-press/
  runs/           raw paired evaluation state
  improvements/   bounded-loop reports, candidates, and rollback data
  tessl/          raw external output and schema-validated evidence
  tessl-evals/    private linked scenario sources
  staging/        canonical snapshots and deterministic artifacts
  submissions/    exact retry journals keyed by idempotency digest
  tmp/            bounded temporary work
```

Evidence and artifacts are bound to the current clean Git commit and content digests:

- local readiness diagnostics and score;
- deterministic test reports;
- paired baseline and with-skill scenario evidence;
- current official Tessl Quality and Impact evidence;
- complete canonical-skill and eval-source tree digests;
- deterministic skill archive, checksums, and provenance;
- a deterministic submission manifest and idempotency key;
- a private submission retry journal.

Stale evidence cannot satisfy a release gate after relevant input changes. A local journal records
what the client attempted and last observed; it is not a server attestation.

## Canonical submission protocol

The production client has one compiled origin: `https://skill-press.com/api/v1`. Project content
cannot override it. The staged protocol defines:

- `GET /session` to establish the bearer-token identity;
- `POST /submissions` to reserve an exact manifest and version with an idempotency key;
- `PUT /submissions/{id}/objects/{role}` to upload each declared digest-bound object;
- `POST /submissions/{id}/finalize` to commit the complete object set and validation outbox event;
- `GET /submissions/{id}` to verify or refresh the exact remote resource.

Reservation retains only the bounded canonical manifest after authentication and namespace
authorization. The five remaining objects are the canonical archive, provenance, checksums, Tessl
review evidence, and Tessl evaluation evidence. Every upload must match its reserved media type,
byte length, and SHA-256 before finalization. The manifest marks all client evidence advisory and
explicitly requires server validation.

`SKILL_PRESS_TOKEN` is the only canonical submission credential name. It must never enter
`skill-press.yaml`, canonical skill files, evidence, provenance, journals, or logs.

The client binds every remote response to the expected idempotency key, source commit, version,
skill locator, artifact digest, and canonical URLs. `GET /session` proves authentication only; the
submission transaction must authorize the principal for the requested namespace before creating a
candidate, reserving an idempotency key or version, or retaining bytes. Ambiguous failure is
journaled and must be recovered by resuming the exact receipt rather than creating a different
candidate with the same version.

The production backend and token issuer are not live yet. Until deployment, only the local
`--dry-run` submission path and hermetic install/discovery tests are operational workflows.

## Review lifecycle and release trust

Submission review status is candidate-scoped:

| Status | Meaning |
| --- | --- |
| `received` | Exact candidate accepted into the service queue |
| `automated-review` | Service-side validation and evaluation are running |
| `curator-review` | Automated gates passed far enough for human review |
| `changes-requested` | Author must prepare a new candidate addressing explicit findings |
| `accepted` | Review approved, but immutable release publication is not yet complete |
| `publication-blocked` | Review remains accepted, but a platform capacity gate requires an audited retry after expansion |
| `published` | Immutable release record and artifact are available |
| `rejected` | Candidate will not be published |
| `withdrawn` | Author stopped a pre-acceptance candidate while preserving its version reservation and audit trail |

Release trust is a separate, release-scoped state:

| Trust | Meaning |
| --- | --- |
| `trusted` | Current policy permits normal installation |
| `quarantined` | New installation should stop while an incident is investigated |
| `revoked` | Release is no longer trusted and must not be newly installed |

Only a `published` submission can carry a release record. Publication does not imply that a
release remains trusted forever. Quarantine and revocation append state transitions while keeping
the original locator, version, digest, and attestation immutable.

Three independently pinned P-256 roles prevent one protocol purpose from silently substituting for
another: `release-attestation`, `trust-event`, and `current-trust`. The current-trust Worker issues
a 10-minute signed checkpoint that binds the exact current trust-envelope digest and sequence.
Installers accept at most a 15-minute checkpoint lifetime, reject cached dynamic responses, persist
the highest observed trust sequence before activation, and make `SKILL.md` visible last. This is a
small freshness layer inspired by update-system timestamp metadata, not a claim to implement the
complete TUF specification.

## Authority and distribution roles

### Skill Press registry

The registry is authoritative for namespaces, curator decisions, immutable versions, artifact
digests, attestations, and trust history. The registry must fail closed on version conflicts and
must never accept client claims as a substitute for server-side checks.

### GitHub

GitHub is the canonical open-source repository, CI, issue, and source-transparency surface. An
author's repository and commit are evidence inputs. GitHub is not the Skill Press registry, and the
generic CLI does not push author branches, tags, or releases as part of submission.

### npm

npm distributes only `@skill-press/cli`. The CLI release uses a protected GitHub Actions
environment, OIDC trusted publishing, exact tag and source binding, package integrity checks, and
provenance. Agent Skill releases are not npm packages.

### Tessl

Tessl supplies external Quality and Impact evidence through a pinned CLI. Skill Press does not
publish skills to Tessl as part of its canonical workflow.

### External catalogs and mirrors

The platform-operated discovery contract may expose an already published Skill Press release
elsewhere only if it preserves the exact immutable digest, version, canonical URL, attestation,
and current trust signal. Full collections verify a domain-separated digest over all normalized
records. The initial mirror allowlist is limited to verified `github.com/skill-press/` listing and
artifact projections. A listing's bounded HTML must contain the canonical release URL and exact
artifact digest; an artifact projection must be byte-identical. A mirror or listing is never
acceptance evidence, and its availability must not block canonical publication.

## Quality model

The local readiness rubric is diagnostic and conservative. Fatal findings make it ineligible
regardless of its numeric total. The default client release gate additionally requires:

- current clean source and matching project/skill identity;
- passing deterministic tests and complete scenario/rubric inputs;
- eligible paired baseline/with-skill evidence with no required regression;
- current official Tessl Quality and Impact at or above the configured minimums, both 90 by
  default;
- reproducible tracked-only packaging, checksums, and provenance;
- exact submission-manifest and artifact bindings.

These client gates are necessary to submit, not sufficient to publish. The service must independently
validate the exact artifact and canonical tree, check advisory evidence against its current policy,
and then obtain a curator decision backed by an independent corroboration workpaper. Until an
evidence provider supplies a detached verifiable receipt, the service does not claim cryptographic
proof that a submitting client actually executed the reported provider run.

## Evaluation and improvement threat model

Skill instructions, resources, fixtures, model output, role output, archives, and service responses
are untrusted.

- Canonical validation reads bounded files and never executes skill instructions.
- Paired evaluation uses separate ephemeral sandboxes, read-only skill input, a new writable
  output mount, disabled networking by default, and explicit CPU, memory, PID, filesystem, output,
  and time limits.
- Project test and improvement role commands are user-authorized host programs. No-shell argv and
  bounded I/O reduce injection and denial-of-service risk but do not sandbox a malicious binary.
- The author role never receives holdout prompts; the evaluator alone receives them.
- Raw transcripts, private scenarios, provider prose, and candidate rollback data remain under
  `.skill-press/` and do not enter a release artifact.
- The service must treat submitted archives and client evidence as hostile input and process them
  only in isolated workers.

## Testing strategy

- schema and generated-type checks for configuration, evaluation, evidence, packaging, submission,
  and server resource contracts;
- unit and property tests for malformed YAML/frontmatter, hostile paths, Unicode aliases,
  oversized files, archive traversal, receipt transitions, and output parsing;
- integration tests with temporary Git repositories, isolated homes, fake role executables,
  digest-pinned sandbox fixtures, and local HTTP servers;
- golden tests for generated projects, reports, manifests, archives, and checksums;
- fault injection for timeouts, partial writes, concurrent input changes, stale evidence,
  ambiguous submission state, and credential leakage;
- end-to-end local coverage from `init` through `submit --dry-run`;
- live service tests only after an explicit staging backend and test identity exist.

The repository quality gate targets at least 90% statements and 90% branches for deterministic
TypeScript code and covers maintained Node.js 22, 24, and 26 runtimes.

## Delivery phases

### Phase 1: identity and local contract

Complete the Skill Press branding, `skpress` binary, `@skill-press/cli` package identity,
`skill-press.yaml` schema v2, `.skill-press/` storage migration, and removal of author-facing
multi-publish code and documentation.

Exit criterion: all generated projects and local commands use only the canonical identity and no
project config contains a provider target list.

### Phase 2: canonical submission client

Complete the deterministic submission manifest, fixed-origin API client, private retry journal,
dry run, exact resume, remote-response binding, status inspection, and adversarial tests.

Exit criterion: local tests prove that project input cannot redirect the bearer token and that a
retry cannot change source, evidence, version, or artifact identity.

### Phase 3: registry backend and curator workflow

Implement authenticated accounts/tokens, isolated upload processing, independent automated
validation, curator review, immutable storage, signed attestations, namespace/version collision
handling, and complete review status history.

Exit criterion: a real service candidate can move from `received` to `published` only after server
gates and curator approval, with exact artifact retrieval and audit history.

### Phase 4: trusted installation

Implement canonical release resolution, lockfiles, digest and attestation verification, current
trust-state checks, atomic installation, quarantine warnings, revocation refusal, and offline
limitations for `skpress add` and `skpress install`.

Exit criterion: an install reproduces the exact trusted artifact and fails closed on a mismatched,
quarantined, revoked, unavailable, or ambiguously identified release.

### Phase 5: controlled discovery and mirroring

Expose a platform-operated, read-only feed at
`https://skill-press.com/api/v1/discovery`. A full collection begins at the origin, locks one
snapshot across all pages, and recomputes the domain-separated digest of every normalized release.
Opaque server cursors bind the snapshot, last position, and expiry. Initial mirrors are verified
GitHub projections under `github.com/skill-press/`; listing pages expose the canonical release URL
and exact artifact digest, while artifact projections are byte-identical. Do not add author provider
credentials or restore a `publish.targets` model.

Exit criterion: every external record links back to the canonical release, preserves its exact
digest, passes full-snapshot verification, and cannot alter Skill Press review or trust state.

## Definition of the initial platform release

The initial platform is not complete until all of the following are true:

- the CLI is formally released as `@skill-press/cli` with `skpress` and npm provenance;
- `https://skill-press.com/api/v1` is deployed behind authenticated, rate-limited endpoints;
- service-side validation does not trust client evidence or execute submitted code on the host;
- curator decisions and review transitions are auditable;
- immutable releases expose a canonical locator, version, digest, artifact, and attestation;
- trust transitions are monotonic, signed or otherwise authenticated, and queryable;
- `skpress add` and `skpress install` verify the canonical record and current trust state;
- documentation and UI never equate submitted, accepted, published, and trusted.

Until those conditions are met, Skill Press must describe itself as an actively developed local
toolchain and protocol, not as a live public registry.
