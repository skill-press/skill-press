# SkillPress implementation plan

Status: accepted after independent review; all implementation phases complete locally, external
identity setup, official evidence, registry approvals, and public release remain fail-closed

Date: 2026-08-19

Repository: `https://github.com/mushanyoung/skillpress`

## Outcome

SkillPress will be both an Agent Skill and a real CLI. It will guide an agent through designing a
focused skill, turn the result into a portable and tested repository, measure behavior against a
no-skill baseline, produce reproducible release artifacts, and publish through the supported path
for each target registry.

The product must not claim that a skill has a Tessl Quality or Impact score of 90 or greater until
that result is backed by evidence from Tessl. Local checks produce a clearly named **readiness
score**, not a substitute Tessl score. A release profile will require current Tessl Quality and
Impact evidence at or above the configured thresholds (90 by default).

## Product principles

1. **Behavior over prose.** A good-looking `SKILL.md` is not proof that an agent performs better.
   Every publishable skill needs positive, near-miss, holdout, failure, and adversarial scenarios.
2. **Paired, sandboxed evaluation.** Behavioral evaluation runs the same task without and with the
   exact skill under test in ephemeral sandboxes. It records setup, redacted transcripts, model,
   repetitions, rubric results, and behavioral delta.
3. **Deterministic gates first.** Structure, references, placeholders, scripts, fixtures,
   packaging, secrets, manifests, versions, and receipts are checked by code. An LLM judge is used
   only for semantic criteria that cannot be checked deterministically.
4. **One canonical skill.** Runtime and registry distributions are generated into staging from one
   source; generated mirrors are not maintained by hand.
5. **Evidence, not badges.** Local readiness, live eval results, Tessl review/eval results, test
   coverage, artifact hashes, commit IDs, and publication receipts remain distinct evidence types.
6. **Fail closed for releases.** TODOs, example placeholders, missing licenses, unrun live evals,
   stale score evidence, dirty tracked inputs, secret-like files, symlinks, or a failed target
   preflight block release packaging and execution.
7. **Safe publication.** Publication defaults to a dry run. `--execute` is explicit, every target
   performs an auth/capability preflight, and completed steps are journaled for idempotent resume.
8. **No invented automation.** If a registry has no supported publishing interface, SkillPress
   reports the real derived or manual step instead of browser-scraping or declaring success.

## What the references contribute

`property-tax-appeal-skll` contributes its strongest production patterns: canonical source plus
generated distributions, fail-closed fixtures, deterministic builders, adversarial and golden
tests, tracked-only reproducible archives, checksums, release provenance, and pinned CI actions.
SkillPress will avoid its large commits, monolithic validator, duplicated schemas, and manual-only
registry records.

[SkillForge](https://github.com/tripleyak/SkillForge/tree/4fc8bb486aa8edca12facbf02b53aa1ada76a4a9)
contributes RED/GREEN skill development, positive/near-miss/holdout trigger sets, fresh-context
generation, doctor/collision concepts, and target adapters. SkillPress will not reproduce its
known false-positive paths: untouched TODO scaffolds passing validation, live tests that do not
explicitly install the target skill, parsed-but-unused baseline/setup data, mocked-only live tests,
or packaging that bypasses the full gate.

## User workflow

```text
skillpress create       brief -> plan, canonical skill, eval fixtures, repository contracts
skillpress improve      bounded author/review/eval loop driven by measured failures
skillpress check        spec lint + references + safety + readiness report
skillpress test         deterministic project and bundled-script tests
skillpress eval         sandboxed baseline/with-skill behavioral runs
skillpress tessl        official lint/review/eval bridge and score evidence capture
skillpress package      reproducible .skill/.zip + checksums + provenance
skillpress publish      target plan, preflight, execute, resume, and receipts
skillpress status       gate/evidence/publication summary
skillpress doctor       environment, collisions, credentials, and stale evidence
```

Commands will support human-readable and stable JSON output. Non-interactive operations will have
documented exit codes. External commands are executed without a shell, with explicit arguments,
bounded output, and timeouts. A command from an untrusted skill is not executed on the host merely
because it appears in configuration or Markdown.

## Repository architecture

```text
src/
  cli/                   argument parsing, output, exit codes
  config/                versioned project schema and migrations
  create/                brief validation and canonical scaffold generation
  improve/               bounded feedback-to-patch iteration and regression control
  check/                 Agent Skills spec, references, safety, readiness rubric
  test/                  deterministic command and fixture runner
  eval/                  scenario schema, isolated paired runner, evidence model
  package/               tracked-only staging, deterministic archives, provenance
  publish/
    adapters/            github, tessl, askill, agent-skill-hub, clawhub, skills-sh
  process/               safe subprocess and capability probing
skills/skillpress/       the installable meta-skill
templates/               generated repository/skill assets
schemas/                 source JSON Schemas for config, eval, evidence, receipts
test/                    unit, integration, end-to-end, adversarial, golden tests
fixtures/                intentionally passing and failing repositories
docs/                    product contracts and registry runbooks
```

The npm package will be `@mushanyoung/skillpress` because the unscoped `skillpress` package is
already owned by another project. The installed binary remains `skillpress`. The initial runtime
target is maintained Node.js 22 and newer; CI covers Node.js 22, 24, and 26. The implementation
uses TypeScript and minimizes runtime dependencies.

## Core data and evidence

`skillpress.yaml` is the single project definition. It records the canonical skill path, version,
repository, test commands, quality thresholds, eval policy, risk profile, and requested publish
targets. JSON Schemas are authoritative; TypeScript types and starter documents are generated or
validated against them rather than maintained as competing definitions.

Evidence is append-only and bound to a content digest and git commit:

- deterministic test report and coverage;
- readiness diagnostics and score (local, never called Tessl Quality);
- paired agent eval runs, including baseline, with-skill, repetitions, and delta;
- Tessl lint/review/eval receipts and actual Quality/Impact scores;
- package manifest, SHA-256 hashes, source commit, tool/runtime versions;
- target publication receipt, remote identifier/version/URL, and verification state.

Stale evidence cannot satisfy a release gate after relevant inputs change.

## Registry capability contract

Each adapter declares one of `publish`, `submit`, or `derived`, plus auth requirements, mutation
steps, verification method, idempotency key, and rollback limitations. Provider IDs are exact and
never inferred from a display name: `github`, `tessl`, `skills-sh`, `askill-sh`,
`agentskillhub-dev`, `agent-skills-hub-catalog`, and `clawhub`. npm is released by a separate
protected GitHub Actions trusted-publishing workflow after the ordered local saga reaches its final
GitHub target.

| Target | Planned supported path | Important boundary |
| --- | --- | --- |
| GitHub | Create/configure repository, push commits/tags, create release and upload attestations | Requires authenticated GitHub API for repository creation; SSH alone can push only after creation |
| Tessl | Official CLI lint, review, eval, publish, and evidence capture | First public approval is a Tessl web workflow; release gate needs real Quality and Impact >= 90 |
| skills.sh | Publish-ready public GitHub source and listing verification | No official write API; indexing/ranking is derived from real installation activity |
| askill.sh (`askill-sh`) | Official askill CLI local-token or GitHub-source publish | Provider identity and resulting listing are recorded in the receipt |
| agentskillhub.dev (`agentskillhub-dev`) | Documented repository analyze/import API, then poll/verify | Treat unauthenticated remote mutation as explicit `--execute`, never as dry run |
| Agent Skills Hub catalog (`agent-skills-hub-catalog`) | Create a contribution branch/PR | Human merge is `pr_review_required`, never reported as published |
| ClawHub | Official CLI/workflow publish, poll asynchronous security review | Requires token; license compatibility is checked and never rewritten silently |

Adapter behavior and command syntax will be pinned by contract tests using fake executables and
HTTP servers. Optional live smoke tests require explicit credentials and never run on forks.

The canonical `SKILL.md` follows the Agent Skills specification. Target-only fields are projected
into ephemeral staging: askill's top-level `slug`/`version`, Tessl's `tile.json`, and ClawHub
metadata never pollute the canonical frontmatter. One project version maps to provider-specific
versions, and every mapping is recorded in the publication receipt.

## Evaluation threat model

An isolated directory is not a security boundary. SkillPress treats skill instructions, bundled
scripts, fixtures, tool output, model output, and downloaded registry content as untrusted.

- Host execution is denied by default. Deterministic scripts and agent tasks run through an
  explicit sandbox backend (initially Docker/Podman); `--allow-unsafe-host-execution` is a noisy,
  per-run override and its evidence is ineligible for a release gate.
- The sandbox receives a read-only skill snapshot and the minimum scenario fixture. Output uses a
  new writable mount; no repository root, SSH agent, cloud config, keychain socket, or user home is
  mounted.
- The environment starts empty and uses an allowlist. Provider credentials are short-lived and
  injected only into the runner that needs them; their names and values are registered with the
  redactor before process output is read.
- Network is disabled by default. A live provider profile must declare required egress;
  unrestricted networking is marked unsafe and cannot produce release-eligible evidence. Provider
  support is deferred if an enforceable egress policy is unavailable on that platform.
- Wall time, CPU, memory, process count, file count, output bytes, and artifact size are bounded.
  Child processes are terminated as a group on timeout or cancellation.
- Raw transcripts and model artifacts live under ignored, private-permission run storage, never in
  a release archive. Persisted evidence contains redacted excerpts/digests; explicit export runs a
  second secret/PII scan.
- Setup actions are a typed, declarative fixture contract. Arbitrary setup shell is not accepted by
  the release-eligible runner.

## Improvement loop

SkillPress does more than reject a weak scaffold. `create` begins with a concrete capability brief
and RED baseline cases; `improve` then runs a bounded state machine:

1. collect deterministic diagnostics, paired baseline/with-skill failures, and official Tessl
   review/eval feedback;
2. send only training scenarios and necessary artifacts to a configured authoring agent adapter;
3. produce a patch proposal, validate its scope, and require review before acceptance;
4. rerun deterministic checks and training scenarios;
5. evaluate untouched holdouts only after a candidate passes training gates;
6. accept only improvements that do not regress safety, activation precision, or holdout behavior;
7. stop on success, no measurable improvement, repeated failure, or configured iteration, token,
   cost, and wall-time budgets.

Holdout tasks and expected results are never disclosed to the authoring adapter. Tessl feedback is
treated as evidence for the next proposal, not instructions to obey. Each iteration retains the
candidate digest and before/after metrics so a score cannot be optimized by silently deleting hard
scenarios. Final Quality and Impact still come from Tessl; SkillPress iterates until both are at
least 90 or reports a truthful blocked result.

Activation precision is recomputed as `true positives / (true positives + false positives)`. If a
candidate predicts no activations, precision is `0` when positive runs exist and `1` only for an
all-negative suite; this prevents silence from looking precise on a mixed suite.

## Quality model

The default local readiness rubric is diagnostic and intentionally conservative:

- Agent Skills specification and activation precision;
- narrow outcome, inputs, outputs, boundaries, and stop conditions;
- actionable workflow and progressive disclosure;
- deterministic helpers and error behavior;
- positive, negative, near-miss, holdout, edge, and prompt-injection coverage;
- executable project tests and minimum branch/statement coverage;
- privacy, permissions, current-data, and untrusted-input treatment appropriate to risk;
- clean, licensed, reproducible, registry-compatible distribution.

Fatal findings make the score ineligible regardless of numeric total. Readiness of 90 is necessary
but not sufficient for a release. The default release profile additionally requires:

- all deterministic tests pass;
- paired live eval evidence is current and meets configured success/delta bounds;
- Tessl Quality >= 90 and Tessl Impact >= 90 from current official evidence;
- security and package checks pass;
- every requested target preflight passes or is explicitly classified as derived/manual;
- git inputs are clean, committed, and version/tag contracts agree.

## Testing strategy for SkillPress itself

- unit tests for schemas, diagnostics, scoring, path handling, secret rules, command construction,
  receipt transitions, and archive primitives;
- property/fuzz tests for malformed frontmatter, hostile paths, duplicate YAML keys, oversized
  files, Unicode, archive traversal, and output parsing;
- integration tests with temporary git repositories, isolated homes, fake agent/registry CLIs,
  and local HTTP servers;
- golden tests for generated repositories, reports, manifests, and deterministic archives;
- end-to-end tests covering create -> fail gate -> complete fixtures -> eval -> package -> publish
  dry run -> resumable fake publication;
- fault injection for timeouts, partial publication, invalid JSON, interrupted writes, stale
  evidence, dirty worktrees, symlinks, and credential leakage;
- coverage gates of at least 90% statements and 90% branches for deterministic TypeScript code;
- Node.js 22, 24, and 26 CI, with release/security checks on the newest supported runner.

Real provider smoke tests are separate from hermetic CI. They are never replaced by mocks in the
release evidence; mocks prove adapter behavior, while provider receipts prove provider behavior.

## Commit and review plan

Every slice follows this sequence:

1. implement only the named slice;
2. run its focused tests and the accumulated suite;
3. ask a subagent that did not author the slice to review the actual diff and tests;
4. fix findings and rerun verification;
5. make one focused commit and push it;
6. record the review and verification summary for release provenance.

Planned commits (each includes focused tests; split again if a diff becomes hard to review):

1. `docs: establish SkillPress product and delivery plan`
2. `chore: scaffold the typed CLI package`
3. `chore: enforce formatting, typecheck, tests, and coverage`
4. `feat: validate the versioned project schema`
5. `feat: generate a canonical skill from a capability brief`
6. `feat: validate Agent Skills frontmatter and references`
7. `feat: detect placeholders, secrets, and unsafe bundled files`
8. `feat: report local readiness without external-score claims`
9. `feat: validate behavioral scenario and rubric schemas`
10. `feat: add the sandbox backend and resource policy`
11. `feat: run paired baseline and with-skill evaluations`
12. `feat: add bounded improve and holdout regression control`
13. `feat: capture Tessl review and eval evidence`
14. `feat: enforce Tessl Quality and Impact release gates`
15. `feat: stage tracked-only canonical skill inputs`
16. `feat: produce deterministic archives and provenance`
17. `feat: add publication saga and receipt recovery`
18. `feat: publish GitHub source and immutable releases`
19. `feat: publish the scoped npm CLI with provenance`
20. `feat: publish through askill-sh`
21. `feat: import through agentskillhub-dev`
22. `feat: prepare Agent Skills Hub catalog pull requests`
23. `feat: publish through ClawHub with MIT-0 consent`
24. `feat: track skills-sh source and organic listing status`
25. `feat: add the SkillPress agent skill`
26. `test: add self-hosting and failure-recovery end-to-end cases`
27. `ci: enforce supported runtimes and release provenance`
28. `docs: publish operating, security, and registry guides`

If a slice grows beyond a reviewable diff, it will be split before review. Commits will not mix
format-only churn with behavior changes.

## Delivery phases

Current delivery note (2026-08-24): the complete ten-command CLI, typed APIs, hermetic tests,
self-host checks, deterministic artifacts, provider adapters, CI, and trusted-release workflow are
implemented locally. Public release remains fail-closed because current official Tessl 90/90
evidence, provider identities/approvals, npm trusted-publisher configuration, and GitHub release
protections are external prerequisites. Three independent reviewers audited exact clean commit
`7d77b4a8a5a74d6766040da06db712ebcb77aba1` across implementation/security,
release/supply-chain, and macOS/Linux test portability; all returned PASS with no release-blocking
code finding.

### Phase 0: remote and reviewed plan

Reauthenticate GitHub, create `mushanyoung/skillpress`, add the SSH remote, commit this reviewed
plan, and push it. No implementation slice starts until the first commit is visible remotely.

### Phase 1: trustworthy local loop

Deliver `create`, `check`, `test`, JSON diagnostics, versioned schemas, and a self-hosted sample.
Exit criterion: a generated placeholder cannot pass release checks, while a completed fixture can
pass all local deterministic checks.

### Phase 2: behavioral proof

Deliver sandboxed baseline/with-skill evaluation, bounded improvement, and the Tessl bridge. Exit
criterion: the runner
proves it loaded the intended skill digest, consumes setup data, preserves both transcripts, and
cannot satisfy the external 90-point gates with local or hand-entered scores.

### Phase 3: secure artifacts and publication

Deliver reproducible packages, provenance, adapters, dry-run plans, resumable execution, and remote
verification. Exit criterion: hermetic adapters survive partial failures without duplicate
publishing and every reported success has a verifiable receipt.

### Phase 4: self-host and release

Use the SkillPress skill to inspect and improve SkillPress itself, run independent adversarial
review, obtain available external scores, and publish only to targets whose credentials and
approval states are available.

The CLI itself is released as `@mushanyoung/skillpress`: CI verifies `npm pack --dry-run`, installs
the produced tarball in a clean temporary project, runs CLI smoke tests, and checks package contents
before npm trusted publishing/provenance. npm publication is a separate explicit target and receipt;
it never falls back to the occupied unscoped package name.

## Known external prerequisites

- The public repository exists and GitHub CLI authorization includes workflow-file access. The
  exact reviewed source still must be present on public `main` and pass CI before any release saga.
- Tessl scoring/publication needs a short-lived publisher API key inherited by the SkillPress
  process, a publisher workspace, current official evidence, and public approval.
- npm trusted publishing requires owner-side GitHub environment and npm publisher configuration.
- askill, Agent Skill Hub, and catalog execution require provider-specific authority, identity,
  token, or pull-request confirmation discovered during preflight.
- A 90+ target is an acceptance gate and iteration objective, not a score that can be guaranteed in
  advance or fabricated when a provider is unavailable.

Provider-specific implementation can proceed without Tessl/registry credentials after Phase 0;
live provider acceptance remains blocked until the corresponding preflight succeeds. External
operations stop with exact remediation instructions instead of weakening a gate.
