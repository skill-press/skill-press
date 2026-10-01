# Native evaluation (implementation in progress)

Skill Press is replacing mandatory Tessl evaluation with its own paired evaluation
and review path. Do not run paid Tessl evaluation for launch preparation.

The first implemented slice is local measurement and consistency checking:

```sh
skpress eval --suite training --image <digest-pinned-image> --model <model> -- <adapter-argv...>
skpress eval --suite holdout --image <same-image> --model <same-model> -- <same-adapter-argv...>
skpress eval-check \
  --training-evidence .skill-press/runs/<training-run>/evidence.json \
  --holdout-evidence .skill-press/runs/<holdout-run>/evidence.json --json
```

Use an existing explicitly authorized execution backend. These commands do not
install a model, provide an adapter, authorize provider billing or call Tessl.
`eval-check` itself only reads local files. Adapter fixtures used in automated
tests are synthetic protocol tests, not real model-quality evidence.

New runs retain an `evaluationInputsSha256` digest over UTF-8
`JSON.stringify({ suite, rubric }) + "\n"`, using the complete parsed suite and
rubric as loaded by the CLI. This includes expected/forbidden behavior, categories
and rubric descriptions and weights, not just the prompts. Each passed leg retains
judge criterion IDs and scores, without rationale text that may contain secrets.
Historical schema-v1 evidence remains readable, but native checking rejects it
when these new measurement fields are absent. Do not retrofit old runs.

The checker recomputes weighted scores, success flags and aggregate results;
requires complete training and holdout suites, current source/config bindings,
matching model/adapter, digest-pinned images, supported network isolation, fresh
evidence and no custom executor. The native policy uses success fractions: at
least 0.9 success, at least 0.1 absolute improvement over baseline, at least three
repetitions and at most 168 hours age. Stricter project settings still apply.
Per-run readiness is at least 90/100. Judge criteria must carry at least 65/100
weight; activation-only scoring cannot stand in for task quality. Safety scenarios
must pass and no individual scenario may regress against baseline.

These are advisory consistency checks. Authors control uploaded data, including
judge scores; hashes do not prove honest execution or judging. In this protocol,
deterministic rubric criteria measure activation, not transcript quality.
Independent curator execution and review remain necessary.

`releaseAuthorized` is always `false` in this local report. Package/submission and
server admission have **not yet migrated** and still use the historical Tessl
contract. A successful `eval-check` must not bypass those gates. The next slice
must connect versioned native evidence through those boundaries before the project
can claim Tessl-independent publication support.
