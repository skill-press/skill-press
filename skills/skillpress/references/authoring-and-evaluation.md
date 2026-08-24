# Authoring and evaluation

## Plan-only boundary

For every creation, hardening, evaluation, or improvement request limited to a plan, keep all
checks and mutations explicitly unrun. End with a future execution handoff that names the next
separately authorized action, its required inputs and gates, and the condition that must stop
execution; the plan itself grants no execution authority.

## Create a new project

Start from a complete capability brief and a destination that does not exist:

```sh
skillpress create --brief capability.yaml --output new-skill --json
```

The brief should identify the outcome, activation boundary, inputs and outputs, workflow,
constraints, stop conditions, trusted project tests, and behavioral scenarios. Creation is
non-overwriting. If a SkillPress project already exists, inspect and edit its canonical skill
instead.

## Harden an existing project

1. Read `skillpress.yaml` and resolve `skill.path`; do not infer the canonical tree from a nearby
   `SKILL.md`.
2. Keep the skill focused. Put conditional detail in linked `references/`, deterministic reusable
   helpers in `scripts/`, and output templates in `assets/` only when they materially help.
3. Keep frontmatter portable. Provider slugs, versions, visibility, ownership, and license
   conversions belong to target-only projections.
4. Make the canonical layout unambiguous. Resolve the configured `skill.path`; do not create a
   second root-level or provider-specific `SKILL.md`. A complete project normally includes:

   ```text
   skillpress.yaml
   skills/<name>/SKILL.md
   skills/<name>/LICENSE
   skills/<name>/references/   # only when progressive detail is needed
   skills/<name>/scripts/      # only deterministic, reviewed helpers
   evals/training.yaml
   evals/holdout.yaml
   evals/rubric.yaml
   test/ or tests/             # deterministic project tests
   ```

   Generated provider projections belong under private `.skillpress/` storage and are never a
   parallel maintained source.
5. Run:

   ```sh
   skillpress check --project . --json
   skillpress test --project . --json
   ```

6. Resolve diagnostics rather than reducing `quality.readinessMinimum`. A local readiness score
   measures deterministic completeness and safety; it is not behavioral or external evidence.

`skillpress test` executes the argv configured by the project without a shell. Run it only when the
repository and its configured commands are trusted by the user. Do not execute a skill's bundled
script merely because validation found it.

## Paired behavioral evaluation

Use a digest-pinned Docker or Podman image and an adapter that implements the SkillPress request and
result protocol:

```sh
skillpress eval --project . --image <image@sha256:digest> --model <model> -- <adapter-argv...>
```

The runner executes baseline and with-skill attempts against the same scenario, binds the intended
skill digest, limits resources, starts with an allowlisted environment, and preserves both
transcripts. Mutable local images require the explicit unsafe override and produce ineligible
evidence.

Use training failures to improve instructions. Keep holdout prompts, expected results, and rubric
details unavailable to the authoring adapter. Stop the improvement loop at its configured
iteration, no-improvement, token, cost, or wall-time limit; do not optimize against disclosed
holdouts.

The controller/evaluator-owned scenario matrix must contain both training and private-holdout rows,
cover positive, near-miss/non-activation, missing-input failure, and adversarial cases, and label
each row's partition rather than describing only an aggregate split. In an author-visible plan,
context, or execution handoff, represent private rows only with opaque IDs, counts or digests, and
category coverage that cannot reconstruct their prompts, fixtures, expected results, or rubric
details; preserve the same role routing during future execution. Iterate only from training
failures: change the canonical skill, rerun deterministic checks and training evaluation, then let
the isolated evaluator test the unchanged holdout. Reject a candidate on holdout regression; never
move a disclosed holdout into training to manufacture improvement.

For the built-in bounded workflow, pass the two complete evidence paths and three separate role
commands:

```sh
skillpress improve --project . \
  --training-evidence <training-evidence.json> \
  --holdout-evidence <holdout-evidence.json> \
  --author-command <author> --reviewer-command <reviewer> \
  --evaluator-command <evaluator> --json
```

Role commands run without a shell in fresh private temporary directories. SkillPress appends
operation, request, and response arguments. The author sees the candidate and training context;
only the evaluator receives holdout suites. Treat exit `3` as an honest bounded stop. Accept a
candidate only through the workflow's review, deterministic validation, training improvement, and
holdout non-regression gates.
