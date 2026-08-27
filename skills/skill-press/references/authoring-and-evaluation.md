# Authoring and evaluation

## Plan-only boundary

When the user asks only for a plan, do not run checks, execute project commands, write files, or
contact external services. End with the next separately authorized action and its stopping condition.

## Initialize a project

Start from a complete capability brief and a destination that does not exist:

```sh
skpress init --brief capability.yaml --output new-skill --json
```

The brief must define outcome, activation boundary, inputs, outputs, workflow, constraints, stop
conditions, trusted project tests, and labeled training/holdout scenarios. Initialization is
non-overwriting. For an existing project, inspect and edit its configured canonical tree instead.

## Harden an existing project

1. Read `skill-press.yaml` and resolve `skill.path`; do not infer a different root from a nearby
   `SKILL.md`. Treat `registry.namespace` as an explicit canonical identity request, not as an alias
   for `project.author.github` or the GitHub repository owner.
2. Keep instructions focused. Put conditional detail in linked `references/`, deterministic helpers
   in `scripts/`, and reusable output material in `assets/` only when useful.
3. Keep frontmatter portable. Skill Press submission identity and downstream runtime layout are
   metadata/projection concerns, not canonical skill instructions.
4. Preserve this normal project shape:

   ```text
   skill-press.yaml
   skills/<name>/SKILL.md
   skills/<name>/LICENSE
   skills/<name>/references/   # optional progressive detail
   skills/<name>/scripts/      # optional reviewed helpers
   evals/training.yaml
   evals/holdout.yaml
   evals/rubric.yaml
   test/ or tests/
   ```

5. Run deterministic checks:

   ```sh
   skpress check --project . --json
   skpress test --project . --json
   ```

`skpress test` executes configured argv without a shell. Run it only when the repository and its
commands are trusted; validation finding a bundled script is not authorization to execute it.

## Paired behavioral evaluation

Use a digest-pinned Docker or Podman image and a compatible adapter:

```sh
skpress eval --project . --image <image@sha256:digest> --model <model> -- <adapter-argv...>
```

Run baseline and with-skill attempts against the same scenario and preserve their bindings. A
mutable local image requires the explicit unsafe override and creates ineligible evidence.

The controller-owned matrix must include positive, near-miss/non-activation, missing-input failure,
and adversarial cases across training and private holdout. Show authors only opaque holdout IDs,
counts, digests, and category coverage. Iterate from training failures, rerun deterministic and
training checks, then let the isolated evaluator test the unchanged holdout. Reject regression.

The bounded improvement workflow takes separate author, reviewer, and evaluator commands:

```sh
skpress improve --project . \
  --training-evidence <training-evidence.json> \
  --holdout-evidence <holdout-evidence.json> \
  --author-command <author> --reviewer-command <reviewer> \
  --evaluator-command <evaluator> --json
```

Each role runs without a shell in a fresh private directory. Only the evaluator receives holdout
inputs. Treat exit `3` as an honest bounded stop and accept a candidate only after review,
deterministic validation, measured training improvement, and holdout non-regression.
