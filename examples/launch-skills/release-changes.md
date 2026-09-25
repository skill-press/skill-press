# Supplied change records (synthetic)

Target audience: existing CLI users. Range: base A through head E. This is an
excerpt of changes, not access to a real repository or a deployed release.

- B: Add `--output json` to the list command. Diff: the list command branches on
  that flag and serializes the same result records; default text stays unchanged.
- C: Add a test for retries on HTTP 503. Diff: only `test/retry.test.ts` changes;
  no runtime retry implementation changes in the supplied range.
- D: Remove support for configuration key `cacheDir`. Diff: the configuration
  parser rejects it as unknown. No replacement key or migration document supplied.
- E: Revert an experimental automatic-update feature added earlier in the range.
  The net diff contains no automatic-update implementation.

One commit message claims "100x faster" but no benchmark result is supplied.
Do not publish or edit files; return a draft and any release-blocking questions.
