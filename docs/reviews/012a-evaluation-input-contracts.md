# 012a evaluation input contracts review

Date: 2026-08-24

Implementation commit: `ae8ee0ae5d24c7a96a62044519ed1fa3593388bd`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- authoritative JSON Schemas and generated TypeScript types for scenario suites and rubrics;
- strict YAML loading with stable, non-reflective diagnostics;
- category/activation, forbidden-behavior, duplicate, conflict, and rubric-weight semantics;
- training/holdout identity checks and normalized cross-suite leakage detection;
- generated-project and self-hosted rubric inputs;
- readiness integration.

## Findings

No release-blocking finding remained after review.

- Schema validation rejects unknown fields, unsafe fixture paths, oversized collections, and
  malformed identifiers before semantic evaluation.
- Training and holdout labels and canonical skill identities are checked at the project boundary.
- Exact IDs and Unicode-normalized prompts cannot occur in both training and holdout inputs. This
  deterministic gate does not claim to detect semantic paraphrases; later evaluation review must
  still inspect set design.
- Near-miss activation is false; every other category activates. Near-miss and adversarial cases
  require explicit forbidden behavior, and holdouts admit only positive and near-miss categories.
- Expected and forbidden behavior cannot conflict after normalization. Rubric criterion IDs are
  unique and weights total exactly 100.
- Strict-loader errors are remapped without prompt values. The public result does not expose local
  absolute paths.
- Readiness now validates all three inputs rather than awarding points for file existence alone,
  and symbolic links remain ineligible.

## Verification

- `npm run check`: pass; 59 test files and 795 tests.
- Coverage: 96.05% statements, 94.88% branches, 99.84% functions, 97.55% lines; every measured
  deterministic source file satisfied the per-file 90% gates.
- Built CLI self-host check: eligible, 100/100, zero diagnostics.
- Remote `main` resolved to the exact implementation commit after push.

## Residual boundaries

- The input layer validates declarative fixture data but does not execute it. Execution and
  resource-policy enforcement belong to the next sandbox slice.
- Holdout paraphrase detection and semantic rubric judgments are intentionally not fabricated by
  this deterministic loader.
