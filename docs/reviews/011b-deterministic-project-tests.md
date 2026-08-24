# Review 011b: deterministic project tests

- Slice: `feat: run bounded deterministic project tests`
- Base: `766a301adb5326dfb124e99a55f7fa334aac8896`
- Candidate: `aed556b9f4a1631a7e498232b369259d6dd4f861`
- Result: **011b delta: PASS**

## Execution boundary

`runProjectTests` loads only schema-valid configured commands and executes them sequentially with
`child_process.spawn`, `shell: false`, stdin disabled, explicit argv, and a minimal environment.
It forwards the captured executable search path and Windows process-launch variables when present,
adds only `SKILLPRESS=1`, and does not forward `HOME`, `NODE_OPTIONS`, cloud credentials, or other
ambient parent variables. macOS may independently inject `__CF_USER_TEXT_ENCODING`; it is not
forwarded by SkillPress.

Each command working directory is resolved beneath the inspected project root. Missing paths,
non-directories, symbolic links, and real paths outside the root return `invalid_cwd` without
starting a process. Reports retain only the configured relative cwd, never the absolute project
path.

Combined stdout and stderr are capped at 1 MiB. Raw output is streamed only into SHA-256 and byte
counters and is never retained in the result. Nonzero exit, asynchronous or synchronous spawn
failure, timeout, and output overflow have distinct fixed statuses. On POSIX, commands are detached
into a process group and timeout/overflow kills that group. Node's portable Windows fallback kills
the direct child; release-eligible untrusted execution remains reserved for the Phase 2 sandbox
backend, not this explicitly invoked local deterministic runner.

## Public contract and CLI

The root API exports `runProjectTests`, its frozen report types, and the output limit. The lower
level arbitrary-command runner remains package-internal. `skillpress test` supports the same
bounded `--project` and stable `--json` contract as `check`; successful reports exit 0 and failed
test reports are written to stdout with exit 3. Human output contains status, duration, and output
sizes but never raw child output or absolute paths.

The built CLI runs the generated project's real `node --test` command successfully. Its report
contains the configured name and relative cwd, exit 0, 113 stdout bytes, the stdout digest
`037e4e41a3bb7ca94393108bc92a1e2a8af95f881d841c1860b670792a70b8a9`, and the empty stderr
digest.

## Adversarial and quality evidence

The authored matrix covers:

- stdout/stderr byte counts and digests without raw retention;
- nonzero exit, nonexistent executable, synchronous NUL executable rejection, timeout, stdout
  overflow, stderr overflow, and concurrent overflow;
- shell metacharacters passed as a literal argument without creating the requested file;
- ambient environment and credential exclusion;
- missing, non-directory, symbolic-link, and valid nested working directories;
- sequential continuation after failure, report freezing, path confinement, CLI human/JSON modes,
  configuration failure, usage failure, and output callback failure.

The complete check passes formatting, lint, generated-source verification, TypeScript, build, and
57 files / 772 tests. Coverage is 5,380/5,605 statements (95.98%), 3,899/4,111 branches (94.84%),
630/631 functions (99.84%), and 4,824/4,948 lines (97.49%). `src/process/run.ts` has 100% authored
statement, branch, function, and line coverage; `src/test/project.ts` has 100% statements,
functions, and lines with 94.73% branches.

Frozen primary artifacts:

- `src/process/run.ts`: 150 lines, SHA-256
  `41de5c03d86cbff33a1e617b3c40d4326c82a43f2e4745eb4f9d2db5e650269e`;
- `src/test/project.ts`: 84 lines, SHA-256
  `1e4bb3a5462388a28bfc23e18d94ec96ceafe11d6ff78e405885a9af38191f32`;
- `src/test/types.ts`: 30 lines, SHA-256
  `c1031b41927215a29d61b62833bb305afe43f3106912bef76cb62330bd7ea6cb`;
- `test/project-test-runner.test.ts`: 227 lines, SHA-256
  `c54b799809e3556ab10bf2f5e47d7f2f20b78f673f15a8dfa86f24bcb3048e7a`.

The implementation commit was pushed to `main`, and `git ls-remote` returned the exact candidate
hash before this record.
