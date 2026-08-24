# 012e bounded improvement review

Date: 2026-08-24

Implementation commit: `702944162f51054b6f7576282b2097bebea8409d`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- bounded author/review/check/training/holdout/accept state transitions;
- training-only author context and frozen scenario-set digest bindings;
- canonical-skill snapshot scope, path, size, executable, and repeat-candidate validation;
- non-regression, measurable-improvement, and target rules;
- iteration, repeated-failure, token, cost, and aborting wall-time budgets;
- schema-generated reports without candidate contents or holdout prompts.

## Findings and fixes

Two findings were fixed before commit.

1. An invalid file proposal could initially avoid accounting for otherwise valid author-reported
   token and cost usage. Usage is now accumulated before file-scope validation, while malformed
   numeric usage still makes the proposal invalid. A later iteration cannot reset or hide consumed
   budget.
2. Wall time was initially checked only between callbacks. A callback that never settled could
   therefore hang the loop. Every callback now receives an `AbortSignal` and races against the
   remaining global deadline; timeouts fail closed as `wall_time_budget`, including review,
   deterministic check, both evaluator stages, and acceptance.

No release-blocking finding remained after those fixes.

- The author context has training scenarios, measured training failure IDs, feedback, current
  candidate/training digests, and remaining budgets. It has no holdout case collection or holdout
  metrics.
- A proposal is a complete bounded snapshot, not an arbitrary host patch. Only `SKILL.md`,
  `LICENSE`, and files below `assets/`, `references/`, or `scripts/` are allowed. Portable paths,
  case/NFC uniqueness, file/count/byte limits, and script-only executable bits are enforced before
  review.
- Holdout evaluation is not invoked until review, deterministic checks, scenario-set binding,
  training non-regression, and measurable training improvement all pass.
- A holdout regression is never accepted. A scenario-set digest change or malformed metrics is a
  terminal integrity failure rather than a retryable score result.
- Reports retain only digests, cumulative budget use, decisions, and before-acceptance metrics.
  Candidate file contents, rationales, prompts, and expected holdout behavior are absent.

## Verification

- `npm run check`: pass; 64 test files and 917 tests.
- Coverage: 96.01% statements, 94.69% branches, 99.73% functions, 97.39% lines. The improvement
  state machine reached 95.68% statements and 92.65% branches; every measured deterministic source
  file passed the per-file 90% gates.
- The 51 focused cases cover success, already-satisfied targets, callback order, author-context
  freezing, review/check/evaluator failures, training and holdout regression, scenario drift,
  malformed runtime values, invalid snapshot scope, repeated candidates, every stop budget,
  aborting deadlines at every callback boundary, iteration limits, and report redaction.
- Built self-host `check`: eligible and 100/100 with zero diagnostics.

## Residual boundaries

- Callbacks are trusted in-process integrations. The state machine signals and stops waiting at
  the deadline; a callback implementation must honor its `AbortSignal` and must not mutate state
  after cancellation. Subprocess-backed adapters must independently terminate their process group.
- Token and cost use are author-adapter attestations. Provider adapters should bind these values to
  their own usage receipts; the state machine prevents reset or omission from accepted reports but
  cannot independently measure a provider bill.
- Tessl feedback can be supplied as training feedback, but Tessl scores remain a separate official
  evidence type and cannot be produced by this local loop.
