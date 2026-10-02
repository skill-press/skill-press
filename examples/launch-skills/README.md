# Launch skill candidates

These source candidates are not published releases. They need isolated
behavioral and review verification; local structural validation is not a quality
score or admission decision. Their source folders are under `skills/`, independent
of the repository's existing self-hosted `skill-press` project configuration.

Use [the author preparation guide](AUTHORING.md) to turn one candidate into its
own project; do not accidentally package the CLI repository's self-hosted skill.

| Skill | Try it with | Expected useful outcome | Runtime |
| --- | --- | --- | --- |
| `release-notes` | Ask for user-facing release notes using `release-changes.md` | Separate actual change from test-only and reverted changes; identify migration uncertainty | Agent text reasoning; Git only for local revision ranges |
| `incident-handoff` | Ask for a shift handoff at 10:15 UTC from `incident-records.md` | Preserve conflicting health observations, unconfirmed cause and unassigned work | Agent text reasoning only |
| `csv-quality-check` | Ask whether `import.csv` is ready for a spreadsheet import | Detect malformed width, blanks, exact duplicate and formula-like content without rewriting | Python 3.10+ standard library and an agent |
| `ci-revision-triage` | Diagnose the source-derived case in `ci-revision-triage.json` | Locate stale revision/configuration copies and propose the minimal repair without weakening CI | Agent text reasoning; optional read-only Git/CI access |

The first three examples are synthetic. The CI case reconstructs an actual
repository incident with normalized source facts; it is not an external-user
interview or unseen holdout. The first three candidates failed incremental-gain
qualification and remain preserved. CI triage is the first replacement candidate,
not yet evaluated or qualified; the quality thresholds are unchanged. Its input
and expected outcome are explicit so usefulness can be checked before investing
in complete paired suites. Do not feed the expected outcome to either actor.

No external account, network or production resources
are needed. They are portable skill folders for an agent supporting `SKILL.md`;
specific agent loading/reload behavior is not asserted here. Do not invent live
`skpress add` locators for these drafts or bypass canonical installation checks.

The CSV example has five logical data records, three columns, a width mismatch at
record 5, a blank second field at record 3, one duplicate record and one potential
formula cell. The quoted multiline field remains one record. These are fixture
expectations, not a recorded successful behavioral run.

See [local walkthrough outputs](walkthrough.md) for the root's application of each
skill to these inputs and the limits of that evidence. The three actual skill
trees also passed an isolated platform admission/review/publication/install and
discovery test at CLI commit `092d0d5`; external provider evidence and keys were
synthetic, so that run does not grant production admission or external scores.
