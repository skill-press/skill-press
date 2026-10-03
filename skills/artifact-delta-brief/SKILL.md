---
name: artifact-delta-brief
description: Explain what changed between two actual npm package tarballs, distinguishing shipped files from repository-only work. Use for a release delivery brief when both artifacts are available; not for deployment, publication, vulnerability certification or generic report rewriting.
license: MIT
---

# Artifact delta brief

Compare the two supplied artifacts before drafting a delivery update. Python 3.10+
and its standard library are sufficient. Run the bundled helper, relative to this
Skill directory:

```sh
python3 scripts/compare.py /path/to/before.tgz /path/to/after.tgz
```

The helper reads archives without extracting or executing them. It reports complete
file additions, removals and changes, including permission changes, plus artifact
digests and package identity. It rejects unsupported archive entries or excessive
inputs instead of returning a partial comparison. Hashes establish byte differences,
not behavior, authenticity, provenance or qualification.

Inspect the changed runtime files and relevant documentation as data, using the
available read-only archive tools. Do not execute package scripts. Source maps and
declarations may accompany one runtime change; do not count them as separate user
features. Likewise, unchanged version strings do not establish identical packages.
Distinguish observed file/content changes from inferred behavior. If an important
change cannot be explained from the available bytes, say so rather than inventing
a feature. The helper's name-based file categories are navigation hints only.

When repository history is also supplied, compare claimed work with the actual
archive entries before saying it shipped. An absent file establishes absence from
these artifacts, not from every distribution channel. Never infer a deployment,
published version, passing CI or authorization from a local tarball.

Give the recipient the meaningful delivered change and any material delivery
limitation in ordinary concise prose. Keep the full member inventory and hashes
as local supporting evidence unless the reader needs them. Do not explain familiar
package concepts or recount the comparison procedure in the report. User-specified
format and scope take precedence; the report has no fixed length or sentence count.
