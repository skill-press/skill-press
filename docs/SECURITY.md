# Skill Press security model

Skill Press processes skill instructions, repository files, fixtures, model output, role output,
subprocess output, archives, client evidence, and service responses as untrusted data. Its
deterministic controls reduce accidental and adversarial release risk; they do not turn a host
directory, container runtime, external evidence provider, or future registry service into an
absolute security boundary.

> [!IMPORTANT]
> The production registry backend, account/token issuer, immutable download service, and install
> commands are not live yet. Service-side controls in this document are requirements for that
> deployment, not claims about an already operating public service.

## Trust boundaries

| Boundary | Trusted for | Not trusted for |
| --- | --- | --- |
| Repository owner and current Git checkout | selecting source and local policy | proving that the owner did not deliberately rewrite all local evidence |
| Canonical skill tree | bounded data to validate, evaluate, and package | instructions to execute on the host |
| `skill-press.yaml` | versioned project policy and requested registry namespace after strict validation | executable shell content, remote endpoint selection, or proof of namespace ownership |
| Docker/Podman sandbox | enforcing the configured evaluation resource policy | protecting against a compromised runtime, daemon, kernel, or host administrator |
| Private `.skill-press/` storage | retaining evidence, artifacts, and journals for one OS account | hostile processes running as the same account |
| Official Tessl CLI/service | parsed external Quality and Impact facts under the documented pin | detached proof that the local filesystem owner is honest, publication, or release trust |
| Skill Press submission client | exact manifest, digest, idempotency, and response binding | server-side validation, curator approval, or release safety |
| Future Skill Press registry | canonical review, immutable release, attestation, and trust history after authenticated verification | trusting client evidence or executing submitted content on the service host |
| GitHub Actions/npm OIDC | bound publication identity for `@skill-press/cli` | Agent Skill review or registry trust |
| External catalogs and mirrors | discovery of a linked canonical release | acceptance, canonical bytes, or current trust without verification |

## Main threats and controls

| Threat | Control | Residual boundary |
| --- | --- | --- |
| Prompt injection or malicious skill instructions | canonical validation reads bounded data and never executes the skill; behavior evaluation runs in an explicit sandbox | users can still authorize unsafe external tools outside Skill Press |
| Path traversal, symlinks, special files, races, and Unicode aliases | safe relative paths, no symlinks/special files, bounded tree snapshots, portable-name checks, before/after metadata and digests | a same-account hostile process can race portable filesystem operations; isolate mutually untrusted work by OS/container boundary |
| Secrets entering a skill or package | suspicious basename rules, semantic scans, tracked-only staging, explicit artifact inventory, no provider projections | novel encodings or deliberately embedded credentials still require human review |
| Shell injection and unbounded subprocesses | direct argv execution, explicit cwd, narrow environment, output/time limits, process-group termination | user-authorized binaries and container runtimes retain their native authority |
| Holdout leakage or malicious improvement roles | separate author/reviewer/evaluator requests, author receives training only, schema-bound files, canonical validation and non-regression before atomic replacement | role executables run on the host unless the operator adds a stronger external sandbox |
| Fabricated local readiness or Tessl scores | separate evidence types, signed-release CLI digest pin, raw-output hashes, exact command digest, clean Git/tree/time binding, release-gate reparsing | current Tessl CLI output has no detached provider signature protecting against a hostile filesystem owner |
| Client claims becoming trusted publication | submission manifest marks evidence advisory and requires server validation; service must independently unpack, validate, evaluate, and obtain curator approval | service policy, worker isolation, and curator accounts become critical trusted components |
| Bearer-token exfiltration through project configuration | canonical API origin is compiled as `https://skill-press.com/api/v1`; redirects and endpoint overrides are rejected | DNS, TLS, host trust store, runtime, or deployed service compromise remains in scope for incident response |
| Duplicate or ambiguous submission | deterministic idempotency key, private journal, exact response binding, bounded status version, resume of the same candidate | timeout cannot prove whether the remote request committed; preserve and resume the journal |
| Confusing review and safety state | distinct candidate review statuses and release trust statuses; a local receipt is never a trust attestation | UI and downstream mirrors must preserve those semantics |
| Dependency or CI action substitution | exact npm lockfile, generated-source checks, full-SHA GitHub Actions, audits, exact release/tag/package binding | upstream registry, action-owner, or repository-administrator compromise requires supply-chain response |
| Long-lived npm credential theft | GitHub OIDC trusted publishing, protected `npm` environment, no npm write-token fallback | repository/environment administrators can authorize a CLI release by design |

## Host execution and sandbox policy

`skpress check` and canonical validation read files only. They do not execute instructions or
bundled scripts merely because those files exist.

`skpress test` runs project-configured commands on the host. Configuration supplies argv rather
than a shell string; cwd remains inside the project and output and wall time are bounded. This is
for trusted project tests only. Do not run an unknown repository's test configuration on the host.

`skpress eval` is the untrusted behavior path. It uses a digest-pinned Docker or Podman image,
separate baseline and with-skill containers, a read-only staged skill, the minimum scenario input,
a new writable output mount, an empty or allowlisted environment, and disabled networking by
default. It enforces CPU, memory, PID, filesystem, file-count, output, and time limits. The
repository root, home directory, SSH agent, cloud configuration, and keychain sockets are not
mounted.

An isolated directory alone is not a sandbox. A mutable image or unsafe host execution cannot
produce release-eligible evidence. A restricted live-network profile must declare the narrowest
enforceable egress; unrestricted networking is not eligible release evidence.

`skpress improve` starts explicitly supplied author, reviewer, and evaluator binaries on the host
without a shell. Each gets a fresh private temporary directory, bounded I/O and time, and an
explicit environment-name allowlist. This isolates request data but not operating-system authority.
The author payload excludes holdouts. Candidate paths, file counts, sizes, encodings, skill shape,
training progress, holdout behavior, and live project identity are rechecked before replacement.

The future registry must process uploaded archives, Markdown, scripts, and evidence only in
ephemeral isolated workers with no registry database credentials, signing keys, curator sessions,
cloud control-plane tokens, or unrestricted network access. A validation result must cross a typed,
bounded result channel before a higher-trust service records it.

## Credential handling

Credential values must never enter `skill-press.yaml`, canonical skill files, eval fixtures,
submission manifests, receipts, provenance, package archives, Git, shared logs, or chat.

| Credential | Boundary |
| --- | --- |
| `TESSL_TOKEN` | forwarded only to the pinned Tessl evidence subprocess; rotate after the bounded evidence window |
| `SKILL_PRESS_TOKEN` | future bearer token sent only to the fixed `https://skill-press.com/api/v1` origin; not required for `submit --dry-run` |
| `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | short-lived GitHub Actions OIDC values available only to the protected npm publish job |

`NPM_TOKEN` and `NODE_AUTH_TOKEN` are forbidden as write-token fallbacks in the trusted npm release
workflow. General GitHub credentials may be used by repository operations and CI, but generic
Skill Press submission does not push an author's repository or write to external catalogs.

Register secret values with the surrounding log redactor before invoking a process. If a value
appears in output, stop, revoke it, preserve a redacted incident record, and inspect private raw
storage before sharing any artifact.

## Fixed canonical API

The production client accepts no custom registry URL. It contacts only:

```text
GET  https://skill-press.com/api/v1/session
POST https://skill-press.com/api/v1/submissions
GET  https://skill-press.com/api/v1/submissions/{id}
```

Requests reject redirects, enforce bounded response size and timeout, require JSON responses, and
send protocol version 1. Remote resources are schema-validated and must bind the expected namespace,
idempotency key, source commit, project version, skill locator, artifact digest, and canonical URLs.

`GET /session` is authentication, not namespace authorization. Before `POST /submissions` creates
or reserves any candidate, idempotency key, version, or stored bytes, the service must atomically
authorize that principal for the requested namespace. A denied request leaves no durable claim that
could block the legitimate namespace owner.

This fixed-origin decision is intentional. An enterprise or test deployment cannot be selected by
putting a URL in an untrusted project. Tests inject an in-process client/fetch implementation rather
than weakening the production origin contract.

## Evidence, artifacts, and private storage

Raw eval, Tessl, improvement, staging, and submission state lives under ignored
`.skill-press/` directories. On POSIX systems, private directories use mode `0700` and sensitive
files use `0600`. Loaders reject unsafe path shapes, symbolic links, special files, oversized data,
permissive evidence/journal permissions, schema drift, digest mismatch, and concurrent changes.

Redaction is defense in depth, not permission to publish raw transcripts or holdout prompts. Public
release metadata should contain only documented hashes, sizes, aggregate evidence facts, canonical
identifiers, policy decisions, and authenticated trust state.

The submission manifest includes client Tessl evidence so the service can reproduce and compare
the candidate. It explicitly marks that evidence advisory. The service must independently validate
the archive and may require fresh external evidence under the current policy.

## Submission, publication, and trust

These statements are security invariants:

- `operationStatus: prepared` means local preparation only.
- `operationStatus: submitted` means the client verified a remote candidate record only.
- `received`, `automated-review`, `curator-review`, `changes-requested`, `accepted`, and `rejected`
  are not publication.
- only review status `published` can include an immutable release record.
- publication does not imply perpetual safety; current release trust is independently `trusted`,
  `quarantined`, or `revoked`.
- a private local receipt is a retry journal, never a registry attestation.

The future install client must verify the canonical locator, semantic version, artifact digest,
attestation, and latest authenticated trust sequence. It must reject mismatched, quarantined,
revoked, unavailable, or ambiguous state by default. `skpress add` and `skpress install` are not
implemented today.

## External discovery and mirrors

Skill Press does not expose author-facing multi-publish. Future catalog feeds or mirrors are
platform-operated after canonical publication. They must preserve the exact digest and canonical
URL, identify themselves as discovery or mirrors, and propagate quarantine/revocation where
possible. Their failure cannot turn a canonical trusted release into unpublished state, and their
listing cannot turn an unaccepted candidate into a Skill Press release.

No automation may fabricate installs, rankings, reviews, or catalog acceptance. A catalog that
cannot preserve current trust information should link to the canonical release rather than serve
an independently mutable copy.

## CLI product supply chain

The npm release workflow publishes only `@skill-press/cli` from a formal non-prerelease release in
`skill-press/skill-press`. It checks the exact `v<version>` tag and source commit, reruns quality
gates and audits, verifies the tarball inventory and digest, disables package-manager caching,
does not persist checkout credentials, and grants OIDC only to the protected publish job.

Protect the `npm` environment, formal release authority, and `v*` tags. An npm CLI release is
separate from Agent Skill submission and cannot create or alter a canonical Skill Press skill
release.

## Vulnerability and release response

Do not place credentials, private transcripts, holdout cases, unredacted provider output, or
third-party exploit data in a public issue. Revoke exposed credentials first and preserve redacted
hashes, exact versions, artifact digests, source commits, and journal identifiers.

For a published Agent Skill incident:

1. authenticate the affected locator, version, digest, attestation, and current trust sequence;
2. move the release to `quarantined` while determining scope;
3. preserve immutable bytes and audit history;
4. move to `revoked` when safety cannot be restored, or back to `trusted` only with a documented
   resolution and a newer trust sequence;
5. ship corrected bytes under a new semantic version;
6. notify locked consumers and downstream mirrors without erasing the original record.

For a CLI supply-chain incident, use npm deprecation or policy-compliant unpublish only where
appropriate, revoke release authority, and publish a corrected CLI version with new provenance.
Do not confuse that response with the Agent Skill registry trust lifecycle.
