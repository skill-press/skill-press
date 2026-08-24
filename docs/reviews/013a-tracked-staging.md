# 013a tracked canonical staging review

Date: 2026-08-24

Implementation commit: `46a27739db9ad132de394746ef2492cbcfe8f5e6`

Reviewer: primary-agent adversarial review; active policy prohibited a new review subagent.

The review fixed one provenance gap before commit: the initial status check covered only the skill
tree. A dirty or concurrently changing `skillpress.yaml` could therefore produce a staging report
bound to bytes that were not in `sourceCommit`. Staging now includes the configuration in both Git
status samples and compares its exact bytes before returning.

The final implementation:

- requires a valid canonical skill and Git HEAD;
- rejects tracked, untracked, and ignored skill inputs plus dirty configuration;
- obtains the sorted release file set from `git ls-files -z` without a shell;
- creates only private, non-symlink staging path components;
- preserves tracked executable intent while writing private files;
- requires source-before, source-after, and staged full-tree digests to match;
- repeats relevant Git/file-set checks after copying and returns only hashes and paths.

Verification passed 69 test files and 993 tests. Global coverage was 96.04% statements and 94.67%
branches; `stage.ts` reached 94.87% statements and 90.9% branches. Built self-host readiness remained
eligible at 100/100. The remote main ref was verified at the exact implementation SHA.

Residual same-account path races are bounded by pre/post snapshots but cannot be eliminated with
portable path-based Node.js APIs. Release CI should use a dedicated account, and the archive builder
must consume only the returned staging snapshot rather than rereading canonical source.
