---
name: report-brief
description: Turn supplied natural-language task reports into a clear recipient-specific progress brief by extracting source-linked facts and rendering selected outcomes with their necessary conditions. Use for routine report consolidation and updates, not exhaustive evidence handoffs, raw-system investigation or sending messages.
license: MIT
---

# Report brief

The user supplies ordinary reports and, when available, the recipient's question
and prior knowledge. Do not ask the user to prepare structured data. Python 3.10+
and its standard library are needed for the bundled local renderer. No network,
credentials, external model calls or automatic delivery are used by the script.

Keep the source text unchanged. Internally prepare `brief-facts.json` containing
the complete supplied source records and extracted facts in a temporary working
directory. Do not overwrite the reports. Extract atomic meanings rather
than shortened paragraphs. Label routine scores, counts, procedures and hashes
as evidence; they do not become current outcomes merely because they are recent.
Prior reader knowledge is not new progress. A conditional action is not an
already-made decision to perform it now. Preserve important failure and limitation
facts even when they make the brief less positive.

The internal plan has this shape (illustrative placeholders, not report facts):

```json
{"version":1,"sources":{"report.txt":{"order":1,"text":"本地试用完成，线上尚未验证。"}},"facts":[{"id":"result","topic":"trial","key":"status","scope":"local","kind":"outcome","clause":"本地试用已完成","source":{"id":"report.txt","quote":"本地试用完成"},"known":false},{"id":"limit","topic":"trial","key":"live-limit","scope":"local","kind":"condition","clause":"线上尚未验证","source":{"id":"report.txt","quote":"线上尚未验证"},"qualifies":["result"]}],"include":["result"]}
```

Each fact needs `id`, `topic`, `key`, `scope`, `kind`, one-line `clause`, and a
`source` reference. Kinds are outcome, decision, action, condition and evidence.
Use exact source spans; the clause may paraphrase but must preserve
their meaning. `known: true` marks an unchanged fact explicitly already known
to this reader. A changed fact gets its own ID and `supersedes: [oldId]` only for
the same object/topic, key and scope, citing a source with a strictly later `order`.
Derive order from the supplied chronology, not the desired conclusion. A newer check
in a different environment is not a replacement for an unresolved live problem.

Attach each material condition through `qualifies: [claimId]`; it travels with
that selected claim even if the condition was already known. An action's trigger
is also a condition qualifying that action. A replacement claim must explicitly
carry its predecessor's conditions; automatic condition resolution is unsupported.
Select only the outcomes,
decisions and actual next actions needed for this reader's current question.
Do not select a future checklist item as today's next action or relabel process
evidence to get it into the output. Group related work in an atomic shared outcome
only when the cited passages support that conclusion.

Run the script relative to this skill directory:

```sh
python3 scripts/render.py /path/to/brief-facts.json
```

It validates exact quotes and declared relationships, rejects superseded
selections, omits unchanged known selections, and excludes evidence from the
selectable kinds. It groups claims and conditions by topic and puts actions last,
with a single “下一步” prefix; write action clauses without that prefix. This
renderer currently produces Chinese briefs. Input is limited to 2 MiB and 256
extracted facts. An error is not a usable brief.
Never truncate or discard source content to get past a limit.

Check extraction against the original reports before using `report`. The script
does not understand relevance, verify paraphrases, infer chronology or discover
missing conditions. Its `semanticExtractionVerified: false` is intentional.
Incorrect classifications, scope, omitted limitations or invented conclusions
remain failures even if the script succeeds. Correct an extraction only from
source evidence, then rerender. Do not hand-rewrite a failed rendered report into
an apparent tool success. Deliver the `report` text without appending procedural
commentary; keep the plan and renderer diagnostics locally for review. For no new
selected facts, confirm the supplied material genuinely supports a no-change update.
