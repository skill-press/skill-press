# Review 010c: metadata RegExp retention

- Slice: `fix: remove metadata regexp retention`
- Base: `222aa92dba26e6cad81d4ff31aeac56e4e81b407`
- Candidate: `b85d3117813eb34d10118c849ccdc7ef3f10bb0d`
- Result: **010c delta: PASS**

## Finding and scope

The supplemental-metadata module previously executed two expressions over caller-controlled text:
`/^\S+(?: \S+)*$/u.test(allowedTools)` and
`body.split(/\r\n|\n|\r/u)`. A successful execution updated V8's process-global legacy RegExp
statics. The first route retained the decoded `allowed-tools` value; the second retained the whole
Markdown body even though neither raw value appeared in its fixed diagnostics.

The candidate replaces both expressions with monotonic UTF-16 code-unit scanners. It captures
`Reflect.apply` and `String.prototype.charCodeAt` at module initialization and invokes only those
snapshots. This changes no public export, metadata or report shape, diagnostic text, field order,
limit, parser, graph/session behavior, filesystem behavior, schema, configuration, or package
boundary. Module initialization remains the trust boundary; pre-import intrinsic replacement is
not covered.

## Exact languages and priority

The allowed-tools scanner preserves the exact language of `^\S+(?: \S+)*$`:

- the value is nonempty and consists of one or more nonempty tokens;
- adjacent tokens have exactly one U+0020 separator, so leading, trailing, and repeated spaces are
  rejected;
- no token contains an ECMAScript whitespace code unit: U+0009–U+000D, U+0020, U+00A0, U+1680,
  U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, or U+FEFF;
- U+0085, U+180E, U+200B, astral characters, and lone surrogates remain non-whitespace and are
  accepted inside a token, exactly as before.

Existing admission priority is unchanged. A missing field is skipped; a non-string produces the
type diagnostic. A decoded string is copied to `result.allowedTools` before its format check. An
invalid string gets `skill.allowed_tools.format`; a valid string instead gets the existing
experimental warning. There is no new length gate, and optional strings still precede metadata-map
validation and body validation.

The body scanner starts at one logical line, counts each lone CR or LF once, and consumes CRLF as
one separator. It therefore preserves `body.split(/\r\n|\n|\r/u).length`, including mixed adjacent
separators; U+2028, U+2029, and every other code unit are not line separators here. Exactly 500
lines remains accepted and more than 500 produces the recommendation. The pre-existing
`body.trim() === ""` check retains priority: a blank body gets only the empty-body warning from this
branch, even if it contains more than 500 CR/LF logical lines.

These guarantees are deliberately module-local. The authored retention cases construct their
`ParsedAgentSkillFrontmatter`, result, and collector objects before seeding the benign nine-group
RegExp state. One direct route then exercises valid allowed-tools plus a blank body; the other
exercises no allowed-tools plus a multiline body. The immediate 19-alias snapshots therefore
measure only `validateSupplementalMetadata`. They do not claim that the frontmatter/YAML parser or
the whole public validation pipeline executes no RegExp or preserves legacy statics.

## Authored evidence and frozen artifacts

The nine-test file covers all 25 ECMAScript whitespace code units, accepted near misses, empty and
separator boundaries, a 512 KiB value, exact 500/501 logical-line boundaries, mixed CR/LF/CRLF,
blank priority, and both former retention routes. All 19 canonical and alias legacy slots remain
unchanged on the candidate. Post-import poisoning of live `Reflect.apply`, `charCodeAt`, String
split, and RegExp exec/test/split entries records zero calls. A source gate excludes RegExp and
String RegExp-entry paths from the production module.

Frozen artifacts:

- `src/validate/metadata-rules.ts`: 215 lines; SHA-256
  `af5272a323eaab6c7f77b18d6589373cef363a738a2b8fdb151c471b1d3dcb2d`;
- `test/metadata-rules.test.ts`: 303 lines; SHA-256
  `682b06ea7256ac7cf1ca850d5b62ff3af8363a8509557c2737a2fd4006c9e7f4`.

Production changes by +54/-2 and the test by +201/-1: two paths, +255/-3, net +252 lines.
`git diff --check` passes.

## Root gate and canonical private release

The root shared `npm run check` passes formatting and lint over 114 files, generated checks,
typecheck, and all 52 files / 704 tests. Global coverage is 95.87% statements (5,039/5,256),
94.83% branches (3,729/3,932), 99.82% functions (584/585), and 97.43% lines (4,519/4,638).
`metadata-rules.ts` is 100%: 85/85 statements, 70/70 branches, 10/10 functions, and 74/74 lines.

Canonical evidence is retained at `/private/tmp/skillpress-010c-release.DK3pxg`. The fresh
`--no-local`, detached base and candidate use no Git alternates. The candidate has its own
dependency tree and uses the private release cache; the read-only base anchor required no install.
Node.js 22.23.2, 24.19.0, and Homebrew 26.7.0 each pass the focused 1-file/9-test selection
and full 52-file/704-test suite. Homebrew Node 26.7.0, npm 11.19.0, and zlib 1.2.12 pass the
complete check. The canonical review records full and omit-development audits at zero
vulnerabilities.

Canonical dry and actual pack JSON agree in every top-level field and all 195 file metadata rows:

- 195 entries; 171,844 packed bytes; 917,611 unpacked bytes;
- npm SHA-1 `a4eafdbdffb5e68687ed72f2309c58835a8a5503`;
- archive SHA-256 `ed6c9d921ce49c3a7b30e7850df9740b626d7ea46aa5927c24656a6cba739875`;
- integrity
  `sha512-FTIIrRzv43LQLWyZ0ExndJLezMLkhLfIlEUNf7DEoZ19jwDaCo0AhwC2nuEjT9Wzl/brRB08DoJAmmzC8DBFgQ==`;
- decompressed-tar SHA-256
  `2ebcea3eb724acdf5695caedc935be7e89e6b6e16963c576152f266e1fec6c8a`;
- sorted relative `path\0mode-octal\0file-SHA-256\n` rows, with mode `644` and a final LF,
  produce payload-manifest SHA-256
  `b801556f9959100456d462a881506ce0495cdc820ae5c496e7948bf8d1821fdb`.

The payload has 195 regular 0644 files, six directories, zero special files, and no source, tests,
docs, or scripts. Its export map still contains only `.`. The isolated consumer cold-adds 41
packages and audits clean. Node 18.20.8, 22.23.2, 24.19.0, and 26.7.0 expose exactly 18 root runtime
names; six internal imports return `ERR_PACKAGE_PATH_NOT_EXPORTED`; CLI version is `0.1.0` and help
is 17 lines. Strict TypeScript 7.0.2 NodeNext accepts the root and rejects the metadata-rules
internal subpath with `TS2307`.

The read-only property repository remains clean at
`90965164c80fdc9e6209deccba85e2b64a1e0a60`. On Node 22, 24, and 26 its public report retains
SHA-256 `b78fa593ecf98ccc2b51aec95f683cc6cd112a4ce1f20608a3d161660a7c76a1` and only the existing
license warning. Its complete graph retains four documents, three line-12 edges, totals of four
files, 59,712 bytes, 1,872 nodes, three targets, 20 work units, six components, and zero aliases,
with empty graph/resource/placeholder findings.

## Independent distribution and adversarial review

The independent lane recorded its fresh base/candidate dist evidence under
`/private/tmp/skillpress-010c-release.aUxpbN`; that temporary tree was later removed. Each dist has
188 regular files and three descendant directories, with no added or removed path; 185 files are
byte-identical. Only `metadata-rules.d.ts.map`, `.js`, and `.js.map` change. Root `index.js` remains
`6cd258eebb405a6c42aff6c204febf3f5dccc75cd5ef926946d0686ea10f6b63`, and root `index.d.ts`
remains `204bf9749b3534803239bc2a9d542451c7b5cb8dad5755be263ba0846710a56e`.

The adversarial oracle at `/private/tmp/skillpress-010c-adversarial.33kGjr/oracle.mjs` is 778 lines
with SHA-256 `3c03221c7cd37163b59613de800b39fd5c4dfadbfb56b2759e2e355ab2b00708`.
Per Node it compares 512,264 allowed-tools cases and 138,807 body cases, or 651,071 differential
inputs. Across Node 22.23.2, 24.19.0, and 26.7.0 that is 1,953,213 inputs and 3,906,441 real built-
module calls, with corpus SHA-256
`755f8c4991ffa3a7d49e640435653b0796c8945a2fdcdd53f8778a877dbeaeb0` and zero mismatch.

On both direct routes the base changes 19/19 legacy aliases and retains the raw input; the candidate
changes 0/19, while exact returned metadata and diagnostics stay equal. The allowed-tools value
remains intentionally present in both returned metadata objects; body text is absent from both
outputs. Poisoning 15 post-import live RegExp/String/Reflect entries produces zero calls. Base and
candidate property public reports remain exact object-graph matches at the public digest above;
the oracle's complete graph-summary serialization is
`bce99696fd3e829549e1fb156ff7761463b14c36b373e932fffdda7f90a8b742`. The earlier canonical
`4a2438e2fc699e12dff38c6b3f8758dc596a20d86a1b2f05b5ba059d679f84c8` value is a different,
compact summary serialization, not a graph mismatch.

## Harness record and boundary

The author's first focused coverage command omitted the module `include`; all nine tests passed,
but unrelated global per-file thresholds made the command exit nonzero. Constraining coverage to
`metadata-rules.ts` produced the exact 100% result above. The canonical consumer's first root
TypeScript run omitted Node types and received `TS2591`; pinning `@types/node` 22.20.1 and adding
the Node type set made the root pass while the internal negative remained exactly `TS2307`.

An adversarial-agent spawn attempt was rejected by the thread limit before it started; it created
no process or evidence. The running adversarial lane completed normally. The independent
distribution lane had no harness incident.

A later read-only consumer fact-check invoked `node --input-type=module runtime.mjs`; Node rejected
the incompatible flag/file combination with `ERR_INPUT_TYPE_NOT_ALLOWED`. The correct commands
then passed on all four Node versions, with no write or npm operation.

The only shared-checkout npm activity attributed to this review is the root complete check. All
canonical, independent, adversarial, consumer, and property work used private paths and performed
zero npm operations or writes in the shared checkout. Candidate, base, property, and private trees
finished clean. This authorized later review record is the sole shared change; it is not present in
the verified package and changes none of the frozen implementation, test, API, or package contents.
