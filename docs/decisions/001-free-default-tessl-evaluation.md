# ADR 001: Use provider-default Tessl evaluation on the free plan

- Status: Accepted
- Date: 2026-08-31
- Scope: Skill Press v0.1 self-release

## Context

The v0.1 release gate requires fresh, eligible official Tessl Quality and Impact evidence at or
above 90. Tessl Free permits fresh Impact evaluation but rejects explicit `--agent` or `--model`
selection. The provider currently resolves an omitted selection to `claude / deepseek-v4-flash`.

The first official seven-scenario, three-run default-model evaluation completed, but manual raw
arithmetic was approximately 48 Impact and four contextual critical criteria were not full-score.
The evidence bridge rejected the then-unverified raw `usage-spec` variant before creating eligible
evidence. That protocol mismatch was fixed and independently reviewed; the poor behavioral result
remains valid product feedback.

## Decision

Skill Press will remain on Tessl Free for the v0.1 release and omit `--agent` and `--model` from
official Impact commands. The captured provider-resolved agent/model and the exact selection-free
command remain evidence-bound.

The team will improve the canonical skill for the default evaluator while preserving the existing
quality bar:

- Quality and Impact minima remain 90;
- each official Impact evaluation remains three runs per scenario;
- failed scenarios, weights, and conjunctive `critical_*` invariants are not removed or weakened;
- improvements must be general instructions or activation-boundary fixes, not task-answer leakage;
- a new official run requires a material, reviewed source change rather than repeated sampling of
  unchanged bytes.

Paid model selection may be reconsidered only through a later decision that evaluates cost,
reproducibility, and provider capability. It will not be purchased merely to rescue failing v0.1
evidence.

## Consequences

The v0.1 release remains blocked until the provider-default evaluation satisfies every critical
criterion, reaches Impact 90, and passes scenario non-regression. This is intentionally a higher
compatibility bar and may require more product iteration.

Tessl may change its workspace default over time. Every evidence object therefore records the
resolved agent and model, trusted CLI digest, exact command digest, raw output hashes, source commit,
and scenario tree. Any provider-default change is reviewed as a new evidence fact rather than
silently treated as equivalent.

