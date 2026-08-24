# Review 010f: create semantic-stage RegExp retention

- Slice: `fix: remove create semantic regexp retention`
- Base: `0ca2257406c01e1a6af4e8d267adf05e98cfb393`
- Candidate: `3c8a66089a10781e4aac18d1f9d8a8fbeea4f462`
- Result: **010f delta: PASS**

## P0 finding and exact boundary

After YAML loading and Ajv validation, the base capability-brief loader executed eight
module-owned regular-expression routes over raw semantic text. Placeholder analysis used one
line-splitting expression and four matching expressions; lexical uniqueness used three global
replacement expressions for default-ignorable code points, punctuation/symbols, and whitespace.
Successful V8 matching or replacement can retain the complete input through all 19 legacy
`RegExp` statics even though SkillPress returns only fixed diagnostics or normalized comparison
keys.

The candidate removes all eight routes from the post-schema create semantic stage. Placeholder
analysis now calls the already reviewed, expression-free semantic-text classifier. Comparable-text
normalization now uses a monotonic UTF-16 scanner backed by generated Unicode membership tables.
The exact checkpoint is after schema validation and before the first uniqueness normalizer call;
all 21 normalization calls and all 48 placeholder-classification calls for the complete fixture
preserve the checkpoint byte-for-byte across the 19 aliases.

This is deliberately not a whole-loader or whole-`src/create` claim. Strict YAML loading and Ajv
schema validation still run before the checkpoint and may execute their own expressions over raw
input. Markdown escaping, rendered-path validation, source-error remapping, and other fixed or
nonsemantic expressions remain outside this slice. The package consumer guard proves only that the
eight former semantic sources are never executed through the public loader; it does not claim that
YAML or Ajv is RegExp-free.

## Placeholder integration and diagnostic contract

The loader inventories every schema-valid string and JSON Pointer path before it invokes the
classifier. The pre-existing non-prose exclusions remain exact:

- project name, version, repository, author GitHub name, license identifier, risk, sandbox, and
  network;
- capability input and output names;
- command arguments and command working directories;
- publish targets and scenario identifiers.

Every remaining string is classified as one complete authorized semantic-text segment. The loader
accepts only a module-local genuine classification for which the provenance predicate returns the
literal boolean `true`. It rejects foreign or cloned singletons, forgeries, active and revoked
proxies, accessors, truthy non-booleans, exceptional producers and predicates, and invalid or
oversized results without reading hostile properties. Any such failure becomes exactly:

```text
brief.placeholder_analysis
value could not be analyzed safely for placeholders
```

No producer exception, candidate value, classifier reason other than the fixed public projection,
or private sentinel is retained. Placeholder findings are staged and discarded atomically if a
later classification fails. Published diagnostic order remains invalid Unicode, placeholder
analysis, then uniqueness, matching the base even though uniqueness is computed before the first
classifier callback.

Integrating the frozen classifier intentionally refines the legacy create heuristic. Exact and
colon directives, genuine dash annotations, uppercase annotations, and reviewed editable brackets
remain findings. Near misses such as `todo-list`, `placeholder-driven design`, `replace me-not`,
`[fill rate]`, `[enter key]`, and `[your rights]` remain safe. The line-separator edges of the dash
grammar and U+0085's non-whitespace status are explicit authored cases.

## Re-entrant trust boundary and non-thenable result

Module initialization, before the capability-schema top-level await yields, captures every
dependency used by semantic-text inventory, comparable normalization, classifier validation, and
post-callback assembly: the classifier and its genuine-result predicate, the comparable
normalizer, `Reflect.apply`, proxy and descriptor inspection, `Object.defineProperty`, array/object
inventory operations, the non-prose `Set` lookup, and the relevant string methods. The
top-level-await test suspends the schema read, replaces live module exports and selected
intrinsics, keeps the replacements installed through a real `loadCapabilityBrief` call, and
observes zero poisoned calls.

Before the first classifier callback can run, the loader completes invalid-Unicode traversal,
semantic-text inventory, uniqueness normalization, the resolved version, the final result record,
and the fixed `CapabilityBriefError`. After a callback, it reads only dense own inventory slots and
uses the captured `Object.defineProperty` to append own numeric slots. Descriptor inputs have a
null prototype, so polluted inherited `get`, `set`, `value`, `writable`, `enumerable`, or
`configurable` fields cannot affect `ToPropertyDescriptor`.

The direct async success record has an own `then` data property with value `undefined`,
`enumerable: false`, `writable: false`, and `configurable: false`. It prevents native Promise
resolution from reaching a classifier-installed `Object.prototype.then` getter or callable and
keeps subsequent `await` or `Promise.resolve` operations non-thenable. The barrier is absent from
the static type and invisible to `Object.keys`, entries, spread, JSON, YAML, ordinary rendering,
and structured cloning. It is intentionally observable through `Object.hasOwn`, `in`,
`Object.getOwnPropertyNames`, and `Reflect.ownKeys`; callers also cannot assign, delete, or redefine
that reserved key. The input schema already rejects a top-level `then` property.

Authored and private tests install throwing replacements for live array, map, set, weak-set,
string, Reflect, object-descriptor, proxy, and iterator entries; inherited numeric slots;
`Error.prototype.name`; `Object.prototype.version`, `issues`, `then`, and descriptor fields; and
live `Object.defineProperty`. Safe success, placeholder error, and late classifier failure paths
all finish with their fixed public projection and zero poison calls.

## Comparable-text projection

`src/create/comparable-text.ts` preserves the former operation order without a RegExp or string
rewrite entry point:

1. host `NFKC` normalization;
2. host `toLocaleLowerCase("en-US")`;
3. Unicode 15.1 default-ignorable deletion;
4. Unicode 17 punctuation/symbol conversion to a pending ASCII separator;
5. the exact ECMAScript whitespace set converted to the same separator;
6. leading, repeated, and trailing separator removal.

Default-ignorable membership is checked before punctuation/symbol membership, preserving the base
replacement order. The scanner decodes valid surrogate pairs, preserves lone surrogates for the
existing invalid-Unicode gate, and captures normalization, lowercase, code-unit, slice, and table
capabilities at module initialization. Its source contains no `RegExp`, `exec`, `test`, `match`,
`search`, `replace`, `replaceAll`, `split`, `trim`, or `Symbol.replace` route.

The authored independent reference uses explicit character classes generated from the pinned
source ranges rather than the host's property escapes. It covers 20,000 deterministic strings,
every Unicode 17 P/S range boundary, every ECMAScript whitespace code point, astral characters,
default ignorables, compatibility forms, locale-sensitive lowercase cases, and representative
lone surrogates. A retained 30-line private smoke harness at SHA-256
`042d2be2b693ea0e05151660c1da9b6ad9aa6c8efd58a2bfc2625f09758a3c7b` warms the scanner with
10,000 copies of `a!!!`, then measures one Node 26.7.0 pass over 2,000,000 copies. The
8,000,000-code-unit input produces the expected 3,999,999-code-unit result. Single-run timing is
informational and is not a performance gate or guarantee.

## Unicode data and intentional version pin

The new development-only input is the unmodified official Unicode 17.0.0 extracted
`DerivedGeneralCategory.txt`:

- 277,514 bytes;
- SHA-256 `d62e5bab70ca74f099343f71224fa051cb1fdd61a1ab45c0488c44cfc0b6102e`;
- source
  `https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedGeneralCategory.txt`;
- Unicode-3.0 license and 2026-08-24 retrieval record in both the vendor README and
  `THIRD_PARTY_NOTICES.md`.

The parser validates all 30 category sections, 4,144 records, declared totals, strict section
ordering, and a gap-free partition of all 1,114,112 code points. Punctuation and symbol categories
contain 708 source records and 9,473 code points, merged into 355 strictly ordered ranges. Their
packed semantic bitmap SHA-256 is
`c06972e22f0b283c265dd69e0ee3a44b525f1f06a45e57f6f2ed64091b8f666a`. The existing Unicode
15.1 default-ignorable table contains 27 source records, 4,174 code points, 17 runs, and packed
bitmap SHA-256 `c8984091f29193139ea640ff7fc181d77f209fe34867cb0368af1f07f260a3bd`.

Fresh private regeneration first replaced the committed generated header with a sentinel, then
regenerated from the pinned inputs. The output is byte-identical to the candidate at SHA-256
`4d0d317f09673955f31a12f04d9feae996cb39f3816e42ba52bd0237ab31a759`, and `--check` passes on
all five reviewed Node versions. The original UCD files remain excluded by the npm allowlist;
notices, the Unicode license, and mechanically generated runtime ranges are packed.

The P/S table is intentionally pinned to Unicode 17, rather than dispatched through the host
runtime. Current Node 22.23.2, 24.19.0, and 26.7.0 all expose Unicode 17 and match the former host
property escape at every code point. At the supported patch-level floors, the candidate is
deliberately more current and deterministic:

| Runtime | Host Unicode | Pinned-only P/S | Host-only P/S | First pinned-only |
| --- | ---: | ---: | ---: | --- |
| Node 22.0.0 | 15.1 | 856 | 0 | U+1B4E |
| Node 24.0.0 | 16.0 | 104 | 0 | U+20C1 |
| Node 22.23.2 / 24.19.0 / 26.7.0 | 17.0 | 0 | 0 | none |

Each packed mismatch-record stream lists differences by ascending code point as five-byte records:
a little-endian unsigned 32-bit code point followed by a one-byte pinned-membership flag. The Node
22.0 stream SHA-256 is
`2f7d3bf4df723fa7efb745fd9b6ad1d3a55db1e86c0cd5f4b129f1323140a966`; the Node 24.0
stream is `bdce8f9f89ecf21fccd50f06a9f07a8888d55682d00e19fc29987d1f407ba33e`.
This is an intentional semantic stabilization, not a claim that early Node 22 or 24 patches retain
their old host projection. `NFKC` and en-US lowercase mapping deliberately remain host semantics.

## Authored evidence and frozen artifacts

The focused six-file selection passes 48 tests. It covers the full non-prose matrix, the complete
normalization projection, every generated-table endpoint, source integrity and licensing, all 19
legacy aliases, TLA capture, forged and exceptional classifier results, atomic late failure,
module-export replacement, live intrinsic poisoning, inherited descriptors, hidden-result shape,
grammar deltas, property-tax source sentences, and generated-source gates.

The complete candidate check passes formatting and lint over 119 files, generated-source checks,
TypeScript `--noEmit`, build, and 55 files / 737 tests. Global coverage is 5,180/5,399 statements
(95.94%), 3,794/3,997 branches (94.92%), 593/594 functions (99.83%), and 4,644/4,764 lines
(97.48%). `src/create/load.ts` is 97.04% statements, 92.07% branches, 100% functions, and 97.43%
lines. The comparable-text and generated-Unicode modules retain 100% authored coverage.

Frozen primary artifacts:

- `src/create/load.ts`: 464 lines, SHA-256
  `c16a164afa4c12bef3c2880acdf7258f3e235e5c06cfe586f19384c9ab1e7460`;
- `src/create/comparable-text.ts`: 82 lines, SHA-256
  `11c5d57938b896514120dc696fc28380268cf28023b2fc5020c7dba0010688f2`;
- `test/create-semantic-retention.test.ts`: 736 lines, SHA-256
  `7f9f2b2948187a4693441783e412b0681982d45433e15c08c9e32f24b0d94e48`;
- `test/create-comparable-text.test.ts`: 270 lines, SHA-256
  `76e48498d62c839f1ead2824a82c5c21dd23da2b7ac51ccdfc0f15ab562ae540`;
- `scripts/unicode-general-category-table.mjs`: 200 lines, SHA-256
  `7e15aa754d09979b202a8bf1affe4d4e326fe999edcd7014f20119a1f6321b68`;
- `src/validate/generated-unicode.ts`: 1,524 lines, SHA-256
  `4d0d317f09673955f31a12f04d9feae996cb39f3816e42ba52bd0237ab31a759`.

## Independent review

Three independent reviewers returned final PASS results after reconstructing the implementation,
test, Unicode, and API boundaries. Their initial reviews found material gaps rather than merely
rubber-stamping the first candidate:

- the first TLA test restored its poisons before the actual loader call and did not cover the
  comparable normalizer;
- the first post-callback design still used live traversal methods and computed uniqueness after a
  potentially re-entrant classifier;
- later review found inherited numeric setters, delayed `version`, async inherited-`then`, error
  construction, and inherited descriptor-field windows;
- the original runtime-property oracle was invalid on Node 22.0/Unicode 15.1 and Node
  24.0/Unicode 16.0.

The final candidate fixes each gap with real checkpoint placement, full inventory staging,
pre-callback normalization/result/error construction, captured own-slot definition, null-prototype
descriptors, the hidden then barrier, and a pinned-source oracle. Final implementation review found
no callback-late prototype-sensitive read, write, constructor, or async-assimilation path. Final
test review confirmed that the numeric, version, error, and then poisons stay installed across the
operations they claim to test. Final Unicode review independently reproduced all counts, hashes,
host deltas, and full-domain membership.

## Private runtime and adversarial matrix

Reproducible private artifacts are retained under
`/private/tmp/skillpress-010f-release.lH1X9M`. The base and candidate are detached worktrees at the
hashes above; the candidate receives one private `npm ci --ignore-scripts`, adding 122 packages and
finding zero vulnerabilities. The exact runtime matrix is:

| Node | Unicode | Focused | Full suite | Private combined oracle | Installed consumer |
| --- | ---: | --- | --- | --- | --- |
| 22.0.0 | 15.1 | 6 files / 48 tests | 55 / 737 | 3 / 11 | PASS |
| 22.23.2 | 17.0 | 6 / 48 | 55 / 737 | 3 / 11 | PASS |
| 24.0.0 | 16.0 | 6 / 48 | 55 / 737 | 3 / 11 | PASS |
| 24.19.0 | 17.0 | 6 / 48 | 55 / 737 | 3 / 11 | PASS |
| 26.7.0 | 17.0 | 6 / 48 | 55 / 737 | 3 / 11 | PASS |

All full suites are the valid sequential runs. One earlier attempt launched five full suites in
parallel against the same candidate directory; `test/bin.test.ts` intentionally deletes and
rebuilds the shared `dist/`, so those processes raced and produced one or two `dist`-absence/stale
file failures per runtime while the other 54 files passed. That run is discarded rather than
counted. After one rebuild, all five sequential suites pass 737/737.

The three independent untracked private oracle files pass together on every runtime:

- prototype and classifier oracle: 295 lines / 3 tests, SHA-256
  `08196c5c69ed429e758be166d6bef70086a7a3e1660adcf3766ca85496de1e65`;
- new public property holdout: 138 lines / 4 tests, SHA-256
  `e0f66e8f0814e4bd9ef51c06a1778b00b678b3dc00c5ef658ee70407bdd9c1a4`;
- Unicode oracle: 462 lines / 4 tests, SHA-256
  `c512d2f60c867a717a2dbe9d2597aff8c2e077ac9c7901b830c6b9fceb5d0d68`.

The Unicode oracle independently parses both pinned sources, checks explicit P/S and DICP classes
at all 1,114,112 code points, checks both generated predicates over the same complete domain,
checks 7,080 normalization boundary cases, and normalizes one continuous input containing every
code point. That input is 2,162,688 UTF-16 code units; its 4,325,376-byte, no-BOM UTF-16LE encoding
has SHA-256
`38606803a5c1510d128833ab8865fd9caa8172220d2063c71e356c3fcd862482`. Projection hashes are
locked separately for host Unicode 15.1, 16.0, and 17.0.

Both the full dependency audit and `npm audit --omit=dev` report zero vulnerabilities. The
installed consumer adds 41 production packages, audits 42 package nodes with zero vulnerabilities,
and passes strict TypeScript 7.0.2 NodeNext compilation through the root export.

## Distribution and public API boundary

The Node 26.7.0 / npm 11.19.0 / zlib 1.2.12 package contains:

- 199 regular files;
- 177,146 packed bytes and 954,913 unpacked bytes;
- npm SHA-1 `8e5d7bea617c6bf0d666618999124c0b752b7846`;
- tarball SHA-256 `e6f10c7193209f1dd4f37252fdfec351946d3adec20ca03bd81ea93bdbd298a2`;
- integrity
  `sha512-Cu2LyYlhHya86esqw7YQbTZlAhgthMybL+WVUdWq5Wp0QjYvq2ZB3vU/nIz7xUgTMlf8ma2x9TESgEg2eLcFcQ==`.

The base package has 195 files, 172,155 packed bytes, and 920,251 unpacked bytes. The candidate
adds only the four comparable-text JavaScript, declaration, and map artifacts to the path set.
Build comparison has 188 base and 192 candidate files: 181 common files are byte-identical, four
comparable-text files are new, and only seven common files change—`create/load` JavaScript and its
two maps, plus the generated-Unicode JavaScript, declaration, and two maps. Root `dist/index.js`,
root `dist/index.d.ts`, and public `dist/create/load.d.ts` remain byte-identical. Runtime root names
remain the same 18 exports.

The pack includes `THIRD_PARTY_NOTICES.md` and `LICENSES/Unicode-3.0.txt`, excludes `vendor/` and
the raw Unicode inputs, and exposes only `.`. Installed runtime import of the internal
`dist/create/comparable-text.js` path fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`; strict NodeNext
compilation of the same import fails with exactly `TS2307`. The root type retains no `then` key.

Across all five Nodes, the 131-line installed consumer oracle has SHA-256
`4961aa4daf9cbfe9605ef6d09d523b49125f47ce28b3b9c88404b1c4b44ebadd`. It observes 18 root
exports, zero calls to the eight forbidden former semantic expressions, all 19 RegExp aliases
unchanged around the packed comparable normalizer, the exact hidden then descriptor, and identical
seven-file rendering SHA-256
`d25d069be6d90127799a0558f59f67b9139b6dc18828bd1fe33844afe2e16ecc`. CLI version is `0.1.0`
on every runtime. The installed CLI creates the real seven-file project behind that combined
rendering digest.

## External property-tax holdout

The read-only property-tax repository remains clean at
`90965164c80fdc9e6209deccba85e2b64a1e0a60`. Its canonical case template has SHA-256
`0ce254ae528ba26b8bd84cce448b4a0d3cdaca893b6e26d23bd5756d1ea8cdd4`. Authored integration
cases copy the exact five realistic source strings containing `REPLACE`, `Replace`, `replace`, and
`Describe`; each remains safe through the public capability-brief loader.

The independent private holdout uses new, noncopied assessment prose. It accepts editing verbs in
complete instructions, rejects five genuine directives or editable fields in exact path order,
keeps directive-shaped schema-valid machine identifiers outside classification, and treats U+1B4E
as the pinned contradiction separator. All four tests pass on all five Nodes.

The installed package also validates the canonical property-tax skill successfully at that exact
commit and name. Its public report has zero errors and the single existing
`skill.license.missing` portable warning. The external repository is only a read-only release
holdout; its tree is not copied, vendored, packed, imported at runtime, or made a CI dependency.

## Harness accounting and final state

Four private setup probes were corrected and are not counted as failed product checks. A consumer
command initially named its not-yet-created directory as the process working directory and never
started; it was rerun after creating the directory. The first TypeScript consumer omitted explicit
Node types and returned the expected missing-Node-type errors; adding the candidate's pinned
`@types/node` through `typeRoots` made the root compile pass. The first property report probe checked
a nonexistent `valid` field rather than the documented `ok` field; rerunning the same validation
with `ok` confirmed the one-warning successful report. An early `npx node@22.0.0` calibration also
resolved the ambient Node 26 binary and was discarded; the matrix uses explicit private Node binary
paths and records each `process.version` and `process.versions.unicode`.

All corrected private harness work is confined to the literal `/private/tmp` release directory.
The shared main worktree remains clean at the candidate before this review record. The
implementation commit was pushed to `main`, and `git ls-remote` returned the exact candidate hash
before documentation.
