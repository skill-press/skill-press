# Security model

SkillPress processes skill instructions, repository files, model output, fixtures, subprocess
output, archives, and registry responses as untrusted data. Its deterministic checks reduce
accidental and adversarial release risk; they do not turn a host directory or third-party service
into a security boundary.

## Trust boundaries

| Boundary | Trusted for | Not trusted for |
| --- | --- | --- |
| Repository owner and current Git checkout | choosing release inputs and policy | proving an owner did not deliberately rewrite all local evidence |
| Canonical skill tree | data to validate and package | instructions to execute on the host |
| Docker/Podman sandbox | enforcing the configured eval resource policy | protecting against a compromised container runtime or kernel |
| Private `.skillpress/` storage | retaining raw evidence and journals for the same OS account | hostile processes running as that account |
| Provider CLI/API | authenticated remote facts after exact parsing and verification | arbitrary prose, stable schemas, absence after ambiguous errors, or rollback guarantees |
| GitHub-hosted release runner | bound OIDC publication identity | bypassing repository/environment/tag protection chosen by the owner |

## Main threats and controls

| Threat | Control | Residual boundary |
| --- | --- | --- |
| Prompt injection or malicious skill instructions | validation reads bounded files and never executes the skill; eval runs in an explicit sandbox | a user can still authorize unsafe external tools or host execution outside SkillPress |
| Path traversal, links, device files, races, and Unicode aliases | safe relative paths, no symlinks/special files, bounded tree snapshots, Unicode collision checks, before/after digests | a same-account hostile process can race portable filesystem calls; isolate mutually untrusted work by OS/container boundary |
| Secret files or credential-like resources entering a skill | basename rules, semantic secret scans, tracked-only staging, package allowlists | novel encodings and credentials deliberately embedded in otherwise ordinary prose require human review |
| Shell injection or unbounded subprocesses | argv execution without a shell, explicit cwd, time/output limits, process-group termination | provider binaries and the container runtime remain privileged dependencies |
| Holdout leakage or hostile improvement roles | separate author/reviewer/evaluator processes; author payload contains training only; schema-bound private request/response files; canonical validation and regression gates before atomic acceptance | role executables are user-authorized host programs and retain that authority; run untrusted roles inside an external OS/container boundary |
| Fabricated readiness or external scores | separate evidence types; official Tessl CLI pin; raw output hashes; current Git/tree/time binding; gate reparsing | current Tessl CLI output has no detached provider signature, so a hostile filesystem owner is outside the proof model |
| Duplicate or partial publication | all-target preflight, deterministic idempotency key, per-step private receipt, exact remote verification, resume binding | some providers expose irreversible public history or require manual rollback/review |
| Dependency/action substitution | exact npm lockfile, generated-source checks, full-SHA official GitHub actions, no release cache, production audit | registry or action-owner compromise still requires pin/lock review and incident response |
| Long-lived npm credential theft | GitHub OIDC trusted publishing, no npm write-token secret, protected environment, exact tag/repository/source checks | repository/environment administrators can authorize a release by design |

## Execution and sandbox policy

`skillpress test` runs project-configured commands on the host and is only for trusted project
tests. Configuration supplies argv, not a shell string; cwd stays inside the project and output and
wall time are bounded. Do not run an untrusted repository's test configuration on the host.

`skillpress eval` is the untrusted behavior path. It uses a digest-pinned Docker or Podman image,
separate baseline and with-skill containers, a read-only staged skill, the minimum fixture input,
a new writable output mount, an empty/allowlisted environment, and disabled networking by default.
It enforces CPU, memory, PID, filesystem, file-count, output, and time limits. The repository root,
home directory, SSH agent, cloud configuration, and keychain sockets are not mounted.

An isolated directory alone is not a sandbox. Unsafe host execution cannot create release-eligible
evidence. A live network profile must be explicit and should use the narrowest enforceable egress;
unrestricted networking is not release evidence.

`skillpress improve` runs explicitly supplied role executables on the host without a shell. Each
call uses a fresh private temporary directory, bounded output and time, and an explicit environment
allowlist. This isolates role requests from one another but is not an operating-system sandbox.
The author payload excludes holdout suites; the evaluator alone receives them. Candidate paths,
file counts, sizes, encodings, Agent Skill structure, measured training progress, holdout
non-regression, and live project identity are rechecked before the canonical tree is replaced.

## Credential handling

Credential values must never enter `skillpress.yaml`, a canonical skill, an eval fixture, a
receipt, provenance, or Git. Adapter `auth` arrays are names/descriptors written to plans and
receipts, not credential values.

| Target | Credential boundary |
| --- | --- |
| GitHub and catalog | authenticated `gh`; `GH_TOKEN`/`GITHUB_TOKEN` only in the provider subprocess environment |
| npm | GitHub's short-lived `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`; `NODE_AUTH_TOKEN` and `NPM_TOKEN` are forbidden in the release workflow |
| Tessl | `TESSL_TOKEN` only for authenticated identity, dry-run, and publish calls; public verification and binary/version checks do not receive it |
| askill.sh | official CLI login state; the receipt records `ASKILL_LOGIN`, never the local token |
| agentskillhub.dev | no credential; its unauthenticated import endpoint is still a remote mutation requiring explicit execution |
| Agent Skills Hub catalog | authenticated `gh` identity and reviewable fork/branch/PR |
| ClawHub | official CLI login/config plus explicit in-memory `MIT-0` consent; receipt descriptors are `CLAWHUB_LOGIN` and `CLAWHUB_MIT0_CONSENT`, never values; no license is silently rewritten in canonical source |
| skills.sh | no write credential; optional GitHub/Vercel tokens improve read-only verification only |

Register all provider secrets with the surrounding log redactor before invoking SkillPress. Use
short-lived and least-privilege credentials. If a value appears in output, stop, rotate it, preserve
a redacted incident record, and inspect private raw storage before sharing anything.

## Evidence and storage

Raw eval, Tessl, improvement, staging, and publication state lives under ignored `.skillpress/` directories.
POSIX directories use mode `0700` and evidence/receipt/artifact files use `0600`. Loaders reject
unsafe path shapes, symlinks, non-regular files, oversized data, permissive receipt/evidence files,
schema drift, digest mismatch, and concurrent source change.

Redaction is defense in depth, not permission to publish raw transcripts. Persisted public evidence
should contain only the documented hashes, byte counts, aggregates, identifiers, bounded excerpts,
and eligibility reasons. Keep holdout prompts outside author-adapter input.

## Release and rollback security

All publication defaults to dry run. Explicit `execute: true` authorizes only the configured
adapter steps; it does not authorize bypassing evidence gates, changing a license, deleting remote
state, or treating a submitted/pending/derived target as published.

Git, npm, Tessl, askill, Agent Skill Hub snapshots, catalog PRs, and ClawHub each have different
rollback limits. Public history, immutable versions, license grants, moderation records, and human
review cannot be assumed reversible. Use the exact target contract in
[the registry guide](REGISTRIES.md) and preserve the receipt when coordinating manual recovery.

The npm release workflow responds only to a formal non-prerelease release in the canonical public
repository, checks the exact `v<version>` tag commit, reruns tests/audit/package smoke, disables
package-manager caching, does not persist checkout credentials, and grants OIDC only to the publish
job. Protect the `npm` environment and release tags in GitHub settings.

## Vulnerability response

Do not place live credentials, private transcripts, holdout cases, or exploit data containing
third-party secrets in a public issue. Revoke exposed credentials first, preserve redacted hashes
and exact versions, and contact the repository owner privately through the maintainer identity in
`package.json`. Once disclosure is safe, record affected versions, entry point, impact, minimal
reproduction, and whether remote state or release artifacts require revocation/deprecation.
