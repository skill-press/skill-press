# 014a SkillPress Agent Skill review

Date: 2026-08-24

Implementation commit: `543137f`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- automatic discovery boundary and canonical Agent Skills frontmatter;
- authoring, deterministic checks, trusted project tests, and paired sandbox evaluation guidance;
- external evidence classes and Tessl release-gate truthfulness;
- deterministic package, provider capability, dry-run, execution, and receipt-recovery guidance;
- authority separation, credential isolation, and immutable/public rollback boundaries.

The `skill-creator` guidance was applied to keep the entrypoint short and discriminating, route
conditional detail through focused references, avoid unnecessary scripts and UI metadata, and test
observable validation rather than heading text.

## Findings and fixes

Five material gaps in the earlier Phase 1 sample were resolved.

1. The sample presented a single fixed workflow after the product had grown multiple operating
   modes. The entrypoint now routes authoring/evaluation, evidence/release gates, and publication/
   recovery to separate references and tells agents to load only what the request needs.
2. The old workflow could be read as continuous authority from creation through publication. The
   skill now states that checks, tests, packaging, and external mutation are separate authorities
   and lists concrete pre-mutation stop conditions.
3. The product intentionally has no package or publish CLI command yet. The skill documents the
   real TypeScript staging, packaging, saga, and resume APIs and explicitly forbids inventing the
   placeholder CLI commands still named in top-level help.
4. Provider status was underspecified. A current capability table now distinguishes publish,
   submit, and derived targets and gives each target's truthful success boundary.
5. Local readiness, paired evaluation, Tessl scores, provenance, and publication receipts are now
   defined as separate evidence classes. Missing or stale external evidence cannot be relabeled or
   replaced by a local value.

No release-blocking skill-content finding remained after these fixes.

## Verification

- Built self-host `skillpress check --project . --json`: pass, eligible, 100/100, zero diagnostics.
- `npm run check`: pass; 80 test files and 1148 tests.
- Coverage: 95.97% statements, 94.27% branches, 99.72% functions, and 97.50% lines.
- The complete skill resource graph resolves all three references without placeholder, portability,
  secret, path, or unsupported-file findings.

## Validator boundary

The `skill-creator` bundled quick validator targets Codex's narrower local-skill frontmatter and
rejects the existing Agent Skills `compatibility` field. Removing that standards-compliant field
would make this canonical skill less accurate. The review therefore retained it and used
SkillPress's hardened Agent Skills validator and self-host check as the authoritative validation.
