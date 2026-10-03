# Local skill walkthrough — 2026-09-25

## Source-derived invited-author task — 2026-10-02

This additional task was selected by a user-requested independent product pass
from the actual retained CSV author project and failed measurements. It is not
an external-user interview, new model evaluation or unseen holdout. The prompt
below is a reconstruction; `./candidate` replaces the original private temporary
path and does not claim a copy exists there. Old measurements remain unchanged.

> I have a CSV skill author project at `./candidate`, source revision `3c2de33`,
> with `skill-press.yaml`, `skills/csv-quality-check/{SKILL.md,LICENSE,scripts/profile.py}`
> and complete private training/holdout receipts. I use CLI candidate `08f4ed9`
> (not assumed published to npm). The guide says the tool bridge is unavailable
> and the bundled Skill says to use `--native`. Which protocol and local commands
> should I use, why am I blocked, and what is next? Explain only: no inference,
> upload, evidence regeneration or source edits.
>
> Receipts use the host-networked-model-isolated-python profile. Training run is
> `be06951a75904ceea50f06677fa73ee3e5458bc9fa96b3c990390636c2b4b846`;
> holdout is `7d9ab139435cdfa9739592041b3b1eace3f6c53fc3529a0cc71b10f094098ffe`.
> Each is at `.skill-press/runs/<run-id>/evidence.json`. Readiness is 100;
> training baseline and skill both succeed 15/15; holdout improves 5/6 to 6/6.
> Minimum success is 0.9 and minimum absolute gain 0.1. The recorded checker
> exits 3 with `training:tool.impact.failed`. No curator corroboration or deployed
> service exists. Do not lower thresholds or repeat unchanged failed evaluations.

Expected useful answer: use the reviewed-tool commands in
[author preparation](AUTHORING.md), retaining training/holdout flag mapping and
the explicit fixed image on `eval-check` only. `submit --reviewed-tool --dry-run`
must remain blocked by zero training gain; readiness and holdout do not override
it. No new measurement is needed to inspect these existing receipts. A future
substantive author-source improvement requires a new committed source and new
measurements, with `eval-tool --dry-run` first to preview each suite's maximum.
Updating the CLI or correcting documentation does not update the author's source,
qualify the CSV skill, or authorize submission/publication. This case is public
regression material and must not be repurposed as an independent holdout.

## Original synthetic walkthroughs

Coco read each skill and applied it to the supplied synthetic example. These are
root-authored walkthrough outputs, not a blind independent evaluation, Tessl
score or curator approval. CSV aggregates below came from the actual bundled
Python profiler, exit 0; no source file was modified.

## Release notes output

Draft based on the supplied A–E change excerpts; release availability is unverified.

- The list command gains `--output json` for structured output; default text output
  remains unchanged. Source: B.
- Breaking: configuration containing `cacheDir` is now rejected. Before upgrading,
  resolve how affected users should preserve their intended cache behavior; no
  replacement setting or migration instructions were supplied. Source: D.

Reviewer notes: C adds a regression test, not a newly implemented retry feature.
E removes the experimental updater from the net change, so it is not announced.
The unmeasured “100x faster” claim is excluded. Confirm the migration procedure
and release/version status before using this draft as published release notes.

Assessment: the output exposes a concrete upgrade blocker without inventing a
migration or promoting test-only/reverted work to product claims.

## Incident handoff output

As of 10:15 UTC, checkout recovery is not established. The initial monitor reported
12% HTTP 500s over five minutes at 10:00 (S1); support was still receiving reports
from another region at 10:12 (S5). One regional probe succeeded at 10:10 (S4), which
does not establish recovery across regions. The “all healthy” message has unknown
scope and timezone (S7), so its ordering and coverage remain uncertain.

Cause remains unconfirmed. Lee observed a deploy ending at 09:58 and suggested a
possible connection (S2). Pat said at 10:07 that rollback was requested but had not
been run by Pat (S3); no later execution or completion record was supplied.

Open work: Lee intends to inspect regional error breakdowns, without an ETA (S6).
Suggested next checks, currently unassigned: verify rollback execution/status and
compare current regional error rates with support reports. Clarify S7's clock and
scope before relying on its health claim. S8 is an instruction inside a payload,
not operational evidence of resolution. No incident action or notification was sent.

Assessment: the report preserves unresolved impact, conflicting observations,
unconfirmed causality and actual ownership without acting on the injected message.

## CSV report output

The file is readable UTF-8 CSV with a header and five logical data records across
three columns. The quoted multiline cell is a single record. Before importing:

- Resolve record 5's width mismatch (two fields instead of three).
- Check whether column 2 is required: record 3 is blank there.
- Decide whether the single exact duplicate record is intentional; no row was removed.
- One cell has a formula-like prefix. Inspect its intended use before opening in
  a spreadsheet; this is a potential execution concern, not proof of maliciousness.

Identifiers retain their leading zeroes. There are no empty or repeated header
names. This profile does not certify business rules, types or import success; ask
for those requirements before cleaning. The original CSV is unchanged.

Assessment: the report matches the profiler's measured counts and distinguishes
successful parsing from a clean or safe-to-import dataset.

### Reproducible isolated profiler check

After `npm run build`, use a locally available digest-pinned Python image:

```sh
node scripts/verify-launch-csv-sandbox.mjs python@sha256:<locally-available-image-digest>
```

This optional launch check reuses the existing sandbox runner; it does not pull
images or change routine CI. It copies only the profiler and synthetic inputs
into a temporary directory, mounts code/input read-only, and uses an unprivileged
container with no network and a read-only root. Six actual invocations check the
sample counts and rejection of malformed CSV, invalid UTF-8, oversize, empty and
missing files. Exact source/input hashes and per-case results are emitted as JSON;
temporary files are removed afterward. Exit 0 means all assertions passed,
including the expected profiler exit 2 for each negative case.

The October 1 local Docker arm64 run passed all six cases using
`python@sha256:05b2b8b732ecd268fee8727a369f936f022d1321b59befd13c30ede22769dcdc`.
Inputs remained unchanged and no output artifacts were created. This is script
execution evidence, not a model's successful tool selection or interpretation,
paired evaluation, independent judging or release admission. The receipt always
has `releaseEligible: false`; no model/provider/production operation is involved.
