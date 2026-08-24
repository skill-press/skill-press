# Review 011a: local readiness check

- Slice: `feat: report local readiness without external scores`
- Base: `9c2360dabcd93762ab6c5dbdee9de3dae6f3ce22`
- Candidate: `3bae195d40d0c7f927b9d06cd5fb1b6c507dda51`
- Result: **011a delta: PASS**

## Boundary and score contract

`checkProject` loads the strict versioned project configuration, validates the configured
canonical Agent Skill, confirms project/skill identity, and requires regular project and skill
license files plus training and holdout inputs. It does not execute configured commands, fetch
URLs, inspect provider credentials, consume holdout answers, or claim a Tessl Quality or Impact
score.

The local readiness score is exactly 100 points:

| Criterion | Weight |
| --- | ---: |
| Canonical Agent Skill validation | 60 |
| Project and skill identity | 10 |
| Project and canonical skill licenses | 10 |
| Training and holdout scenario inputs | 10 |
| Deterministic project test plan | 10 |

Any error makes the report ineligible even if the numeric score reaches the configured minimum.
Warnings remain visible without being mislabeled as fatal. A complete generated project reports
100/100 with the existing portable frontmatter-license warning; removing either required license,
removing a scenario input, changing project identity, or adding a visible placeholder fails
closed.

Scenario files are presence-checked only in this slice; their semantic schema is a Phase 2 input.
Likewise, the test criterion proves a schema-valid command plan exists but does not execute it;
execution lands in the next Phase 1 slice.

## API and CLI

The root package exports `checkProject` and its frozen report types. `skillpress check` accepts an
optional `--project` directory and stable `--json` output. A completed report is written to stdout
and exits 0 on pass or 3 on deterministic gate failure. Usage errors exit 2, configuration errors
remain fixed `project.invalid` errors, and unexpected failures do not expose raw exceptions.

Human diagnostics do not regain hostile resource names: the validator's authenticated resource
graph projects an unsafe filename to a fixed safe path and message before the CLI renders it. The
terminal-injection fixture confirms that embedded LF content is never reflected.

## Verification

The focused check/CLI/public-export selection passes 70 tests. The complete check passes formatting,
lint, generated-source verification, TypeScript, build, and 56 files / 755 tests. Coverage is
5,275/5,499 statements (95.92%), 3,846/4,055 branches (94.84%), 610/611 functions (99.83%), and
4,728/4,851 lines (97.46%). `src/check/project.ts` retains 92% branch coverage and `src/cli.ts`
91.85%, both above the per-file 90% gate.

Frozen primary artifacts:

- `src/check/project.ts`: 197 lines, SHA-256
  `a6f371a98c4da04a7f4c07215a3878480de24f9f06fd0c69c723328025d7325f`;
- `src/check/types.ts`: 34 lines, SHA-256
  `e66a078192fcc201b69fce3cbadac9eca03da125e93efe9c4148b8257cf130e7`;
- `test/check-project.test.ts`: 154 lines, SHA-256
  `cd6c0d03b7845769c662fb0a407e78ca44943d6ea825e6dda3af27295722927a`.

A private built-CLI round trip under `/private/tmp/skillpress-011a.NKQmSK` creates the seven-file
project and returns the exact 100/100 JSON check report. `npm pack --dry-run --json` runs the real
prepack build and reports 207 entries, 181,375 packed bytes, 975,274 unpacked bytes, SHA-1
`90f716eeedd6160d37cd23fe2398b4757df944f5`, and integrity
`sha512-L2ZF2ntUuftCSJegsCpM/qNhAOSVAH00YVqYTF0wqAaOjgZ1AtSBIhIc5dwtOPi4pagrak4O5+c3mifvrSq22A==`.

The implementation commit was pushed to `main`, and `git ls-remote` returned the exact candidate
hash before this record.
