# Review 010e: config indentation RegExp retention

- Slice: `fix: remove config indentation regexp retention`
- Base: `427b6452f624350ea7eb9a3392138c3302f8496a`
- Candidate: `f298ca8e59587ad145e1e1555e7b03a5a8b1220b`
- Result: **010e delta: PASS**

## P0 finding and scope

The base configuration complexity gate executed both `text.split(/\r?\n/u)` and
`line.search(/[^ ]/u)` over untrusted decoded configuration text before rejecting an
over-indented line. Its fixed, raw-free `ProjectConfigError` did not remove the process-global
copy left in V8's 19 legacy RegExp aliases. With nonempty benign left and right seed context, the
private reproduction changes all 19 aliases and leaves raw configuration content in the legacy
state.

The candidate replaces only that indentation gate with a monotonic UTF-16 code-unit scan. It uses
module-initialized snapshots of `Reflect.apply` and `String.prototype.charCodeAt`, captured before
the schema read's top-level await. Both the root-exported `loadProjectConfig` path and the
package-internal `loadStrictYamlDocument` path preserve all 19 seeded aliases on early rejection,
return the same fixed error shape, and omit the secret from serialized error data.

This P0 slice changes no public export, input or error shape, diagnostic text, limit, path policy,
file inspection or identity rule, YAML configuration, Ajv schema, project creation behavior,
validator behavior, property graph/session behavior, or package boundary. Its production scope is
`src/config/load.ts`; the paired regression scope is `test/config.test.ts`.

## Exact language, priority, and trust boundary

The former separator `/\r?\n/u` defines an LF-only line language: every U+000A ends a line and an
immediately preceding U+000D is consumed with it, while a bare U+000D is not a line boundary. The
manual scan therefore resets indentation only at U+000A. At line start, only U+0020 increments the
count. The 65th leading space rejects immediately; zero through 64 pass. An all-space final line
uses the same boundary. The first non-U+0020 code unit, including bare CR, tab, NBSP, U+2028,
astral text, or any other non-U+0020 code unit, ends indentation scanning until the next LF. Spaces
after that code unit do not count. CRLF, repeated CR before LF, LF followed by CR, and empty
LF-delimited lines retain the former result exactly.

Filesystem handling retains priority over parsing: path inspection, symbolic-link and file-type
checks, initial and opened-file identity and size checks, bounded reading, fatal UTF-8 decoding,
and handle closure complete before indentation inspection begins. At exactly 65,536 bytes, a
validly decoded over-indented file gets `config.complexity`; one byte over gets
`config.too_large`; malformed UTF-8 at the exact limit gets `config.encoding`. An indentation
rejection returns before `yaml`'s `Lexer`. Inputs within this budget continue to the unchanged
token-count and flow-depth Lexer gates, strict single-document YAML parsing, alias rejection, and,
for `loadProjectConfig`, Ajv schema validation.

Module initialization is the scanner's trust boundary. `Reflect.apply` and
`String.prototype.charCodeAt` are captured before `await readFile(schemaUrl, "utf8")`; replacing
the live intrinsics while that top-level schema read is suspended does not affect later scans. The
legitimate path-component operation `.split(sep)` remains a string-separator split and is outside
the removed RegExp route. This is deliberately an early scanner and module-local claim, not a
claim that YAML or Ajv is RegExp-free. Ordinary accepted configuration and ordinary schema-invalid
configuration still change 19/19 aliases in both base and candidate through unchanged transitive
parsing and validation.

## Authored evidence and frozen artifacts

The 25-test configuration file retains the existing strict loader and adds the complete 0/64/65
boundary across LF, CRLF, bare and repeated CR, empty and all-space lines, ASCII/non-ASCII tails,
astral text, and the U+FFFD replacement character. It locks the 65,536-byte priority, invalid UTF-8
priority, exact fixed error shape, both loader routes, all 19 aliases, post-import intrinsic
poisoning, zero Lexer calls on early rejection, the pre-top-level-await snapshot, and a
production-source entry-point gate that permits only the existing `.split(sep)`. Targeted
formatting, lint, TypeScript, focused tests, and `git diff --check` pass.

Frozen artifacts:

- `src/config/load.ts`: 315 lines; SHA-256
  `d328ee3a5ba98bdfc5c9b4b8c7bb79d9e1d529a49b17356b786d49881fee5848`;
- `test/config.test.ts`: 588 lines; SHA-256
  `7d04e5fe7f9799ef244954f80e611910ebf86d6b2a99ca15668bf33f680be2c1`.

Production changes by +29/-6 and the test by +350/-1: +379/-7, net +372 lines. The focused lane
passes 1 file / 25 tests. The complete check passes 52 files / 715 tests. Global coverage is
5,069/5,286 statements (95.89%), 3,745/3,948 branches (94.85%), 587/588 functions (99.82%), and
4,543/4,662 lines (97.44%). `config/load.ts` covers 115/121 statements, 57/62 branches, 16/16
functions, and 111/117 lines.

## Canonical private release and package

Canonical evidence is retained at `/private/tmp/skillpress-010e-release.9aX3iD`. Base and candidate
are fresh `--no-local`, detached, self-contained clones with zero remotes, no alternates, and clean
strict/full fsck results; only the candidate receives the private cold install, adding 122 packages.
Node 22.23.2, 24.19.0, and 26.7.0 each pass the focused
1-file/25-test selection and full 52-file/715-test suite. Homebrew Node 26.7.0, npm 11.19.0, and
zlib 1.2.12 also pass the complete check. Full and omit-development audits report zero
vulnerabilities. The candidate cold install emits npm 12's `allowScripts` notice for optional
`fsevents`; it is informational and changes no gate result or package input.

The canonical package is produced with Node 22.23.2, npm 12.0.2, and linked zlib
1.3.1-e00f703. Dry and actual pack JSON agree in all 11 top-level fields and 195 file rows:

- 195 entries; 172,628 packed bytes; 920,251 unpacked bytes;
- npm SHA-1 `8193ea527a2dcb8804039d45b7c7e827a8f6ca57`;
- archive SHA-256 `91263a0c16c28e1eec18ef03bba6c17837f17b1d3f645c4aa59a7548ba1f21d7`;
- integrity
  `sha512-oD3cnxU67V8/zSd1llM2fGjKeV3QJHt3fN+6u3MmtwE6uwSaSGj+cX5W0hYM+11i+Yaas+j147utchnQOzozHw==`;
- decompressed-tar SHA-256
  `e2680898ec656c7898e17b5cc19fe0b24e2ff5c2daf72ed6a9fc3674405424b5`;
- sorted relative `path\0mode-octal\0file-SHA-256\n` rows produce payload-manifest SHA-256
  `c3c8eb6ed47138f7baf273cda599c31429d6b4bbb5ae89adc0cd718fb55bd47b`.

The extracted payload has 195 regular 0644 files, six 0755 directories, zero special files, no
source, tests, docs, or scripts, and only `.` in its export map. The isolated consumer cold-adds 41
packages and audits clean. Its 64-line runtime harness has SHA-256
`a1e973165ed0afa5110f7033b3c9722caa57e586e5a506245d6693fe659772cd`. Node 18.20.8,
22.23.2, 24.19.0, and 26.7.0 expose exactly 18 root runtime names; six internal imports, including
`dist/config/load.js`, return `ERR_PACKAGE_PATH_NOT_EXPORTED`; CLI version is `0.1.0`, and its help
is 17 lines with SHA-256
`9f7ed8f6bcb5174a067f9f94794347a3116a93c75d66d8117b6ec78c3fa1e016`.
Strict TypeScript 7.0.2 NodeNext accepts the root and rejects the config-loader internal subpath
with one `TS2307` and exit code 1; the no-save compiler install leaves both consumer manifests
unchanged.

The 160-line read-only property holdout harness has SHA-256
`488dfb10f4dd390288b8d4fabf82df3721ed45a9620345f1fad3287ccbcc5383`. The repository remains
clean at `90965164c80fdc9e6209deccba85e2b64a1e0a60`. On Node 22, 24, and 26 its public report
retains SHA-256 `b78fa593ecf98ccc2b51aec95f683cc6cd112a4ce1f20608a3d161660a7c76a1`
and only the existing license warning. Its compact graph summary remains
`4a2438e2fc699e12dff38c6b3f8758dc596a20d86a1b2f05b5ba059d679f84c8`: four files, 59,712
bytes, 1,872 nodes, three edges, three targets, 20 work units, six components, no aliases,
and empty graph, resource, and placeholder findings.

## Independent distribution boundary

Independent evidence is retained at `/private/tmp/skillpress-010e-dist.rGPQjY`. Fresh `--no-local`
detached base and candidate clones are non-shallow, self-contained, free of alternates, fsck-clean,
and status-clean. Each private cold install adds 122 packages; full and omit-development audits
report zero vulnerabilities. Their builds each contain 188 regular files and three descendant
directories, with identical path and directory sets. Of the files, 185 are byte-identical. Only
`dist/config/load.d.ts.map`, `.js`, and `.js.map` change; every emitted declaration is unchanged.

The changed rows are exact:

- `load.d.ts.map`, 1,172 bytes at both endpoints:
  `2453abfbb5ec422bb19e8d58aff910f14f3186f158a0a0547f790878bfb9ee32` to
  `70a743787f8ec2b0f35b5f1eb8179b0c986a80c98a6b89172c89eb7541ad8592`;
- `load.js`, 8,757 to 9,483 bytes:
  `0c8d96f4f202fc8282fb8e351d7c81a7665b0b8147f716b67729c4275d091afc` to
  `381078155d84d56df29c1793a0e9433658090eaf3076be59a28c2dc24c3df8c5`;
- `load.js.map`, 8,124 to 8,691 bytes:
  `78f70d9bde91ae8f158d140251d51061e9172bbe96ae16f48725f6a32e48bb70` to
  `fc59ecbdf445fb83d3eebd4b9c71654ddf22179c85b943da32f671d3cc499501`.

C-sorted `path<TAB>mode<TAB>SHA-256` build manifests are
`7645d4f9cf5bfd2b7612670e26d8fa12e8d618e02663412b61d314114b6d5af8` for base and
`1bbdc83278b3aba5b25ae4012dc354069c55a2a7b6ca7bc6c460d592e112e7d3` for candidate. Root
`dist/index.js` remains
`6cd258eebb405a6c42aff6c204febf3f5dccc75cd5ef926946d0686ea10f6b63`, and root
`dist/index.d.ts` remains
`204bf9749b3534803239bc2a9d542451c7b5cb8dad5755be263ba0846710a56e`.

Base and candidate packages retain the same 195-path/six-directory surface, whose path-set SHA-256
is `a62b482d09fbb952a065a13df3b28dab46486ca26a70b87dc0d7173096ea100c`; 192 files are
byte-identical and only the same three config-loader rows change. All regular files are 0644, all
directories 0755, there are no symbolic links or special files, and only `.` is exported. No
source, tests, docs, or scripts are packed.

For each endpoint, dry and actual pack JSON agree exactly across 11 top-level fields and 195 file
rows. The independent npm 11 base package has 172,022 packed and 918,958 unpacked bytes, npm SHA-1
`e6cf23daafe894e9486cab53d73d01f5319054d4`, integrity
`sha512-K/6wW0CZbUxAsUCYaCVqs/sbHBMM9fr2HE5tDlMFpp5MkYsV8TFvB8Vp85oOw06mesfKnr0dgXviuPQdZ6ORlg==`,
archive SHA-256 `2342d9084f3b92aebb3c972c3912719bd5fbc1655f46fb68d22dc3c4325aeed0`,
decompressed-tar SHA-256
`69c4b3539c2c76e5bdcbdb734e38df5c37f7c0e14c9fbec67274032ba4a9898f`, and payload SHA-256
`c697925cd0804e6a44bab0be75a4a6fbbf897cb18406b988d825dd2a160e654a`.

The independent candidate package produced by Homebrew Node 26.7.0, npm 11.19.0, and zlib 1.2.12
has 172,155 packed and 920,251 unpacked bytes, npm SHA-1
`ec4c991ab699ed5c0a8b49f9323ebaea8fe6d54b`, integrity
`sha512-LaIHyTIsweexN67op6/7E3QOY7O6bf+hEiVg2+uosg1Jc6+e8C6XfAxKC/n8Az7bWC9GGeGUmDygovxNGH6fBg==`,
and archive SHA-256
`af4eb89a47efae30f3cfd888088a51d3bb5b5af84197c231c61e8be07dedde21`.
An independent repack with the canonical Node 22.23.2, npm 12.0.2, and zlib 1.3.1-e00f703
reproduces the canonical 172,628 packed bytes, SHA-1, integrity, and archive SHA exactly. Both
toolchains produce the same 920,251 unpacked bytes, 195 rows, decompressed-tar SHA
`e2680898ec656c7898e17b5cc19fe0b24e2ff5c2daf72ed6a9fc3674405424b5`, and payload SHA
`c3c8eb6ed47138f7baf273cda599c31429d6b4bbb5ae89adc0cd718fb55bd47b`. The archive-byte
variance is therefore confined to the gzip/compression toolchain; npm and Node-linked zlib both
differ, so it is not attributed to npm alone.

C-sorted package `path<TAB>mode<TAB>size<TAB>SHA-256` manifests are
`a5d9b1628816ceccfab49ba71a03e046e41c1fe4b983759b52883fe602d447d1` for base and
`f0d19bdf46b1940ca05123ef31b97c8eba8fb6164dfbcd534ebbd34359bfb219` for candidate.

Isolated base and candidate consumers each cold-add 41 packages. On Node 18.20.8, 22.23.2,
24.19.0, and 26.7.0 both expose 18 root names and version `0.1.0`; their 17-line CLI help retains
the canonical SHA. Seven paths, including package metadata, root build output, config loading, and
four validator internals, return `ERR_PACKAGE_PATH_NOT_EXPORTED` at both endpoints on all four
Nodes. The independent candidate type consumer uses strict TypeScript 7.0.2 NodeNext: the root
passes, while the config-loader internal import returns only `internal.ts(1,40) TS2307`. Every
emitted declaration is byte-identical to base, so the base declaration boundary is equivalent.
The no-save compiler installation leaves its manifest unchanged and creates no lockfile.

The valid config fixture has SHA-256
`6b277e869d4e04635f25e52298a366ae1156ad1823855c227a925a347e7a5a72`. Across both endpoints
and all four Nodes it produces object SHA-256
`faf10a948354a96c74aebfb5f7819ec4dc3cc11c27d31c48cb6280ae87c31c2b`. A separate, valid
one-field YAML document containing only `schemaVersion: 2` produces the same eight-issue error
SHA-256
`774bec41dfe3f6eef44c0eeee5d31e70f074c049e48cb0ed0979cec727611b4f`. Both ordinary paths
change 19/19 legacy aliases at both endpoints, preserving the explicit early-scanner boundary.
This lane did not run the property repository; the property claims above belong to the canonical
holdout, not to this lane.

## Differential, adversarial, and compatibility oracle

The compatibility oracle is retained at
`/private/tmp/skillpress-010e-adversarial.U0BoEg/oracle.mjs`: 713 lines, 23,706 bytes, SHA-256
`a33198f222058c2cc18a344aa296ab76870f033769e7abdf1b2db035bba08fee`. Its frozen support
artifacts are:

- `import-hook.mjs`: 17 lines, 427 bytes, SHA-256
  `470bd7ad429f292e1b2ccf615d3d36d983a0c6199a15bc1944b28466cd309164`;
- `fs-promises-shim.mjs`: 17 lines, 538 bytes, SHA-256
  `f1a304ac2d26455b27337a24ac91705c8daa15c9f01619cd7a33350ef6673996`;
- calibration-only `normal-boundary-probe.mjs`: 61 lines, 1,904 bytes, SHA-256
  `3a7ef5903a3801199ef73d8ac03685faf373ff566bd83f7d2068987254a3a3c0`;
- `property-holdout.mjs`: 210 lines, 8,101 bytes, SHA-256
  `fefbc34863f929e01aeccc4b0632f5438e0e5887bc14aaed732600029080f7d4`.

Node 22.23.2, 24.19.0, and 26.7.0 each exit zero and produce normalized result SHA-256
`b34e0183339358812dd9e942ed12bcdb84fc473694653b0ab026dda8267572db`. Per Node, the exact
former split/search predicate and independent manual predicate agree on all 241,817 inputs: 4,536
boundary combinations, 12 explicit LF/CR corners, 137,257 exhaustive strings through length six,
100,000 deterministic random strings, and 12 large or exact-limit strings. The largest is
1,048,577 UTF-16 code units. The frozen pure corpus SHA-256 is
`f1e3099fa22e75219a30d2870b914a0679130c4e128546c88bc1172e94117d9f`, with zero
mismatch.

A 1,722-input file-compatible subset per Node exercises both built revisions. All 3,444 calls per
Node match the reference predicate, with zero mismatch and built-corpus SHA-256
`3e7472f9534433caa51eaf603f6f57211cb3c9b68ee712b3377e37001e6a134e`. Across the three
Nodes, the pure lane performs 725,451 input evaluations and 1,450,902 predicate evaluations; the
built differential performs 5,166 input evaluations and 10,332 loader calls.

Each Node adds exactly 22 focused loader calls: one top-level-await capture, 12 byte-priority calls,
four alias calls, two post-import replacement calls, and three normal-pipeline calls. Thus the
oracle makes 3,466 config-loader calls per Node and 10,398 across all three Nodes. The alias probe
shows the base changing 19/19 aliases and exposing the secret through both loader routes; the
candidate changes 0/19 and exposes no secret while returning the exact fixed complexity issue.

The source capture offsets are 722 for `apply`, 759 for `charCodeAt`, and 926 for the first await;
the built offsets are 601, 638, and 804. A dynamic import hook marks the schema read as started,
then replaces both live intrinsics before releasing it. The candidate records zero poisoned target
calls and still returns the exact complexity error. A separate post-import probe replaces seven
live Reflect, String, and RegExp entry points and guards `String.prototype.split`; across both
candidate loader routes it records zero poison calls, zero RegExp-split calls, zero Lexer calls,
and exactly two permitted plain `.split(sep)` calls.

The 12 priority calls cover three byte cases across both revisions and both loader routes: 65,536
valid UTF-8 bytes return `config.complexity`, 65,536 bytes with malformed UTF-8 return
`config.encoding`, and 65,537 bytes return `config.too_large`. All error graphs match exactly. The
three candidate normal-pipeline calls accept a literal block scalar, accept the valid project, and
reject `schemaVersion: 2` with `config.schema.const`; they make six Lexer calls and change 19/19
aliases each. This preserves the stated dependency-path boundary.

On all three Nodes the oracle's read-only property holdout obtains exact base/candidate object
graphs at property HEAD `90965164c80fdc9e6209deccba85e2b64a1e0a60`. The public report SHA-256 is
`b78fa593ecf98ccc2b51aec95f683cc6cd112a4ce1f20608a3d161660a7c76a1`, the full graph
serialization is `bce99696fd3e829549e1fb156ff7761463b14c36b373e932fffdda7f90a8b742`, and the
compact graph serialization retains
`4a2438e2fc699e12dff38c6b3f8758dc596a20d86a1b2f05b5ba059d679f84c8`. The exact graph has
four files, 59,712 bytes, 1,872 nodes, three edges and targets, 20 work units, six components, no
aliases, and zero graph/resource/placeholder findings. All four source hashes and node counts also
match. Both oracle roots cold-add 122 packages, audit clean, build successfully, and remain clean.

## Harness record and shared-checkout accounting

The canonical lane records eight harness-only incidents. An initial zsh harness used the readonly
special parameter `status`; it stopped and was rerun with a neutral name. The first npm 12 pack
reader expected npm 11's array JSON, so packaging completed but parsing failed; a package-keyed
object reader then passed. One consumer launch named a not-yet-created private workdir and was
rerun after creation. The TypeScript harness initially expected exit code 2, while the intended
single `TS2307` exits 1; the assertion was corrected without changing the compilation input.

The first consumer boundary probe reused 010d's frontmatter target and was discarded in favor of
the config-loader boundary probe. One read-only declaration check looked for
`dist/config/load.d.ts` beneath the consumer root rather than the installed package, then corrected
to the installed-package path. `/usr/bin/realpath` was absent on this host, so the
path canonicalization was rerun with `pwd -P`. A read-only npm 12 version probe under Node 18
emitted its expected unsupported-engine warning and created no npm state. These incidents, and the
informational `fsevents` notice above, changed no candidate, accepted package, or consumer result.

The independent lane records eight more private harness incidents. Its first outer JavaScript pack
orchestrator had a syntax error and launched no npm process. The first manifest counted the package
root as a seventh directory and used locale-aware sorting plus a prefixed path; relative paths and
C sorting then reproduced the frozen 010d base hashes. The first TypeScript config omitted Node
types and produced two `TS2591` errors; the corrected config passed. One zsh `rg` alias pattern had
an unmatched quote and ran no probe.

A TypeScript rerun combined an incorrect expected manifest hash with `|| true`; final direct JSON
equality plus pre/post manifest equality replaced that evidence. An initial source comparison read
the worktree instead of the explicit commit range and was rerun against base and candidate. The
first npm 12 reconciliation reader again assumed npm 11's array shape; the pack succeeded, the
reader failed, and a dual-shape rerun reproduced the canonical archive. One over-broad read-only
`rg` included npm-cache noise and truncated its output; targeted log reads established the exact
toolchains. All discarded work remained private and changed no accepted artifact.

The oracle lane has two harness-only incidents. Its first Node 26 calibration assumed that a simple
`root: value` document must change the legacy aliases; that assertion failed. A separate 12-case
probe showed the simple scalar changing 0/19 and a literal block scalar changing 19/19, so the
latter became the frozen dependency-boundary input. The failed calibration is excluded from all
reported counts and hashes. One broad read-only `find /private/tmp` used while locating an existing
property artifact encountered unrelated `tmp-mount-*` permission errors; no matched path was used,
and the lane continued with explicit known paths. Neither incident changed the candidate.
After two detailed agent completion messages were filtered by the orchestrator, the root reviewer
independently re-read the JSON and recomputed the normalized and artifact hashes. This was a
coordination incident, not an evidence or harness failure.

Shared attribution is exact for the completed lanes: the author lane ran the shared complete check;
all stateful canonical and independent npm operations and caches lived in private paths. The
oracle lane likewise runs all installs and builds in private roots and makes only read-only Git
queries in the shared checkout. The independent lane finishes with zero shared status lines.
Review authoring remained under `/private/tmp` until this file was copied into the repository; this
review is the sole post-candidate tracked content change. After its commit, the shared checkout and
canonical, independent, adversarial, base, candidate, and property Git trees finish clean.
