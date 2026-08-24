# Registry publication guide

SkillPress generates every target distribution from one canonical Agent Skill. Provider-only
frontmatter and manifests live in private staging; they never become a second hand-maintained
source. Publication uses the TypeScript adapter APIs in 0.1.0 and always starts with a dry run.

## Capability matrix

| Provider ID | Capability | Required identity or credential | Verified success | Rollback boundary |
| --- | --- | --- | --- | --- |
| `github` | publish | authenticated `gh` / `GH_TOKEN` | public `main` and `v<version>` resolve to the source commit, release assets/digests match, `agent-skills` topic exists | release/tag deletion is manual; pushed history remains |
| `npm` | publish | GitHub Actions OIDC | exact public `@mushanyoung/skillpress@<version>` metadata, repository, integrity, and provenance | versions are immutable; deprecation/unpublish is policy-bound and manual |
| `tessl` | publish | pinned Tessl CLI, `TESSL_TOKEN`, workspace approval | exact public plugin version archive matches every projected byte, path, count, and executable mode | public cannot become private; unpublish is limited to two days, then archive manually |
| `skills-sh` | derived | exact public GitHub source; optional read tokens | source is exact; listing metadata is recorded only when independently visible | no mutation; ranking/indexing is organic |
| `askill-sh` | publish | official askill CLI login as configured author | exact immutable version and raw projected `SKILL.md` match | removal or a later version is manual |
| `agentskillhub-dev` | publish | none; public GitHub source | import completes and exact path, commit, source, and content record become visible | public import is a provider snapshot; request removal manually |
| `agent-skills-hub-catalog` | submit | authenticated `gh` as contributor | exact open PR or exact merged upstream tree is verified; capability remains submit while review is open | close PR/delete branch manually; merged history follows upstream policy |
| `clawhub` | publish | official CLI login and explicit `MIT-0` consent | exact projected version passes asynchronous security review | withdraw manually; MIT-0 grant and version history are irreversible |

Provider IDs are exact configuration values. `publish`, `submit`, and `derived` are receipt
capabilities, not synonyms. A derived target cannot execute steps; a submit target is not published
until its external acceptance condition is met.

## GitHub (`github`)

The adapter requires the configured repository to exist and be public, authenticates the GitHub
CLI, and runs official skill validation. Its journaled steps push the exact source commit to
`main`, add the `agent-skills` topic, then create `v<version>` with the `.skill`, `.zip`, checksums,
and provenance artifacts. Verification binds branch, tag, release metadata, every asset digest,
and topic.

Repository creation is deliberately outside the adapter: create it with explicit owner authority
before dry run. Existing tags/releases are reused only if every immutable fact matches. See the
[GitHub CLI manual](https://cli.github.com/manual/) and
[GitHub release documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

## npm (`npm`)

Only the scoped package `@mushanyoung/skillpress` is valid. The adapter requires matching package
version/repository, public access, provenance enabled, npm 11.5.1 or newer, the canonical GitHub
Actions repository/SHA, and OIDC request variables. It will not accept a long-lived token fallback.
Preflight pings npm and performs `npm pack --dry-run`; verification reads the exact registry
version and distribution integrity.

Configure npm's trusted publisher with workflow filename `release.yml` and GitHub environment
`npm`. Trusted publication of a public package from a public repository automatically generates
provenance. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/).

## Tessl (`tessl`)

SkillPress pins official Tessl CLI 0.99.0 by executable digest. The adapter projects
`.tessl-plugin/plugin.json` and the complete canonical tree, requires a public workspace identity,
and runs `tessl plugin publish --dry-run --skip-evals --verbose` before mutation. First-public
workspace approval is an external web workflow. Verification downloads the exact immutable public
version through the CLI API and compares the complete archive.

Tessl publication does not replace the separate pre-release Quality and Impact gate; both official
scores must be current and at least the configured thresholds. See the
[Tessl CLI reference](https://docs.tessl.io/reference/cli-commands),
[plugin configuration](https://docs.tessl.io/reference/configuration), and
[public sharing lifecycle](https://docs.tessl.io/distribute/sharing-plugins-publicly).

## skills.sh (`skills-sh`)

skills.sh has no supported write API for SkillPress. The derived adapter first proves that the
public GitHub default branch and canonical skill files exactly match the packaged source. It then
queries listing status when the optional Vercel OIDC context is available. Missing listing data
does not become a fabricated publication result: the receipt remains `derived`, with the public
source/listing URL when available.

Installation activity controls organic indexing and ranking. Publish the exact public GitHub
source and let users install it naturally; do not automate installs or scrape browser flows. See
[skills.sh](https://skills.sh/) for the public index.

## askill.sh (`askill-sh`)

The adapter requires official askill CLI 0.1.15 or newer and a login whose GitHub author matches the
configured adapter option. It creates a private `SKILL.md` projection with target `slug` and
`version`, runs official validation, publishes that projection, then verifies the immutable
provider ID, author, slug, version, and raw source-bound projected content.

Run `askill login` interactively before local publication. An absent, malformed, unavailable, or
conflicting listing is not safe to overwrite. See [askill.sh](https://askill.sh/) for the provider
and official CLI entrypoint.

## Agent Skill Hub (`agentskillhub-dev`)

Agent Skill Hub documents public repository analysis/import endpoints that do not require a
credential. Lack of authentication does not make the POST harmless: SkillPress classifies import
as a mutation and calls it only under explicit execution. Preflight analyzes the exact public
GitHub repository/path; execution imports it; verification polls the public record and binds the
repository, canonical path, source commit, and skill contents.

Timeouts and provider errors remain ambiguous and fail closed. Do not post again until a read-only
detail query establishes state. See [agentskillhub.dev](https://agentskillhub.dev/) for current
provider behavior.

## Agent Skills Hub catalog (`agent-skills-hub-catalog`)

This adapter contributes to
[`agent-skills-hub/agent-skills-hub`](https://github.com/agent-skills-hub/agent-skills-hub). It
binds the canonical tracked files to the packaged commit, verifies contributor identity, checks
upstream and fork state, creates/reuses a fork, writes a deterministic contribution branch, and
opens/reuses a pull request. A conflicting upstream path, branch, fork, or PR fails closed.

An open PR is `pr_review_required`, not publication. Adapter verification can prove either an exact
open submission or the exact files merged to upstream `main`; the receipt's `submit` capability and
PR URL preserve that distinction even when saga status is `verified`. Pull-request text must
disclose material AI assistance when required by the target repository's current contribution
policy.

## ClawHub (`clawhub`)

ClawHub publication requires official CLI 0.23.3 or newer, the configured owner identity, an exact
dry-run fingerprint/file count, and an explicit constructor option `licenseConsent: "MIT-0"`.
SkillPress creates a private MIT-0 target projection and does not edit the canonical skill's
license. Execution rechecks CLI, identity, remote state, projection, and fingerprint immediately
before publishing, then polls the asynchronous security result.

Pending moderation is journaled but does not become verified until the exact version is accepted;
a rejection or conflicting version blocks the target. The MIT-0 grant is deliberate and
irreversible even if a listing is later withdrawn. See the
[ClawHub publishing guide](https://clawhub.ai/clawhub-master/skills/skill-publish-guide).

## Ordering, recovery, and receipts

The saga preflights every configured target before the first mutation and processes adapters in
configuration order. It stops on the first execution or verification failure. Every completed step
is persisted before advancing, so resume can skip exact verified work and retry only unfinished
steps.

Never reorder adapters, edit a receipt, rebuild the artifact, or change the source commit during
resume. Preserve the original private storage and use `resumeReceiptPath`. See
[the operations runbook](OPERATIONS.md) for the API sequence and
[the security model](SECURITY.md) for credential, storage, and rollback requirements.
