# 014b self-hosting and recovery end-to-end review

Date: 2026-08-24

Implementation commit: `2e28774`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- staging and deterministic packaging of this repository's tracked canonical SkillPress skill;
- binding package provenance to the real Git source commit and complete canonical resource graph;
- all eight configured publication targets and their publish, submit, or derived capability;
- dry-run non-mutation, partial publication failure, private receipt journaling, exact resume, and
  completed-receipt replay;
- fixture-secret non-disclosure and narrowly scoped cleanup of generated private run directories.

## Findings and fixes

The first focused run exposed an assertion that compared a four-entry expected prefix with the
complete eight-target receipt. The assertion was corrected to require all later targets to remain
`planned` after the injected Tessl failure, strengthening rather than weakening the test.

The final review also confirmed these release-significant properties:

1. The package case calls `stageCanonicalSkill` on the actual repository twice. It checks the real
   Git `HEAD`, all five canonical files, byte-identical archives and provenance, archive paths, and
   artifact digests; it does not substitute a generated fixture for the self-host claim.
2. The saga case first performs a dry run and proves that no adapter execution or verification took
   place. Execution then fails on Tessl's second step only after GitHub and npm are verified.
3. Resume skips both verified targets and Tessl's already journaled first step, retries only the
   failed step, processes every later target, and records skills.sh as derived. Replaying the
   completed receipt performs no new preflight, mutation, or verification call.
4. Receipt contents omit the injected credential-like error detail and use mode `0600` where POSIX
   permissions apply. Cleanup accepts only random 64-hex staging/publication child paths and never
   removes the shared `.skillpress` root or another run.

No release-blocking test or implementation finding remained after the focused and accumulated
suites passed.

## Verification

- Focused self-host/recovery suite: pass; 2 tests.
- `npm run check`: pass; 81 test files and 1150 tests.
- Coverage: 95.97% statements, 94.27% branches, 99.72% functions, and 97.50% lines.
