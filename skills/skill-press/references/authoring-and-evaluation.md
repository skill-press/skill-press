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

First identify existing evidence. Do not rerun complete measurements merely to change
protocol flags; use the matching checker in the evidence reference. Evidence belongs
to the exact author-project source, not the CLI revision used to read it.

For new reviewed first-party text-only measurements (SKILL.md and optional LICENSE),
preview each suite using `skpress eval-text --project . --suite training --dry-run --json`
and then `--suite holdout`. For reviewed scripts/resources, use `eval-tool` instead.
Both previews prepare local artifacts but invoke no models or containers. Review all
inputs before replacing `--dry-run` with `--reviewed-inputs --max-model-calls <preview-count>`.
Use the count for that suite, not a copied constant. Retain each returned `evidencePath`.

These public evaluators use the reviewed ChatGPT-entitled Codex backend, fixed
`gpt-6.1-sol`/medium, with serial calls and no paid API/Tessl fallback. The host model
is networked; tool Python runs in the fixed reviewed Docker image without network.
Do not feed unreviewed third-party inputs. Failed runs retain private checkpoints;
there is no automatic retry or resume. Preserve unchanged quality failures instead
of repeatedly running them to obtain a pass. After substantive source changes,
commit and collect new evidence; never attach old receipts to the new source.

For the separate container-native profile, use a digest-pinned Docker or Podman
image and a compatible authorized adapter:

```sh
skpress eval --project . --suite training --image <image@sha256:digest> --model <model> -- <adapter-argv...>
skpress eval --project . --suite holdout --image <same-image> --model <same-model> -- <same-adapter-argv...>
```

Run baseline and with-skill attempts against the same scenario and preserve their bindings. A
mutable local image requires the explicit unsafe override and creates ineligible evidence.
Use only an explicitly authorized backend; these commands neither provide a model/adapter nor
authorize billing. Do not substitute paid Tessl or synthetic fixture outputs for real measurements.
After the isolated holdout run, check both evidence files with `skpress eval-check`; read the
evidence-and-release-gates reference linked from SKILL.md for native policy and claim limits.

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
