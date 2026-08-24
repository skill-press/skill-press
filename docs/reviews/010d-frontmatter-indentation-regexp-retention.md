# Review 010d: frontmatter indentation RegExp retention

- Slice: `fix: remove frontmatter indentation regexp retention`
- Base: `b30bc1709d562b0451495da5303f5bbc08317434`
- Candidate: `1a89872962dfe73c5554dd7844ebbba18cfc33ae`
- Result: **010d delta: PASS**

## P0 finding and scope

The base indentation budget executed both `yaml.split(/\r\n|\n|\r/u)` and
`line.search(/[^ ]/u)` over untrusted frontmatter before rejecting an over-indented line. A fixed,
raw-free complexity diagnostic did not remove the process-global copy left in V8's 19 legacy
RegExp aliases. With a nonempty benign left and right context, the private reproduction changes all
19 aliases and leaves the 65-space secret line in `RegExp.input`.

The candidate replaces only that indentation gate with a monotonic UTF-16 code-unit scan using
module-initialized snapshots of `Reflect.apply` and `String.prototype.charCodeAt`. The over-indented
route preserves all 19 seeded aliases and returns the same parsed result and fixed diagnostic,
without the secret in the report. This P0 slice changes no public export, input or report shape,
diagnostic text, limit, field admission, YAML configuration, filesystem behavior, graph/session
behavior, schema, configuration, or package boundary.

## Exact language, priority, and trust boundary

The scanner starts each logical line with an indentation count of zero. Lone CR and lone LF each
end a line; CRLF is consumed as one separator. Mixed adjacent separators therefore have the same
line boundaries as the former alternation. While at line start, only U+0020 increments the count.
The 65th leading space rejects immediately; zero through 64 pass this gate. An all-space line uses
the same boundary. The first non-U+0020 code unit ends indentation scanning for that line, so tabs,
NBSP, U+2028, astral text, lone surrogates, and any later run of spaces cannot add indentation.
Empty YAML and empty logical lines remain below budget.

The pre-existing envelope scan retains priority over this gate: a source-leading BOM, forbidden
source controls, missing or unclosed exact delimiters, and frontmatter greater than 65,536 UTF-8
bytes return first.
At exactly 65,536 bytes an over-indented line gets `skill.frontmatter.complexity`; one byte over
gets `skill.frontmatter.too_large`. An indentation rejection reports line 2, column 1 and returns
before `yaml`'s `Lexer`. Inputs within this indentation budget continue to the unchanged token and
flow-depth Lexer budgets, strict YAML parse, node budget, AST restrictions, and field projection.

Module initialization is the scanner's trust boundary: replacing live intrinsics after import does
not affect it. This is deliberately a module-local and early-route claim, not a claim that the full
parser is RegExp-free. With the pinned `yaml` 2.9.0, an ordinary accepted literal block scalar still
changes 19/19 aliases in both base and candidate through transitive parser behavior. The production
module itself contains no RegExp execution entry point, and an over-indented input reaches neither
that parser nor its Lexer.

## Authored evidence and frozen artifacts

The 15-test frontmatter file covers the existing strict parser plus the complete 0/65 indentation
boundary across CR, LF, CRLF, mixed separators, empty and all-space lines, ASCII/non-ASCII tails,
astral text, and a lone surrogate. It locks envelope byte priority, the fixed raw-free diagnostic,
all 19 aliases, captured intrinsics, zero Lexer calls on early rejection, and a production-source
gate. Targeted format, lint, TypeScript, focused tests, and `git diff --check` pass.

Frozen artifacts:

- `src/validate/frontmatter.ts`: 326 lines; SHA-256
  `ce9041d13c567f6f48880b8177778592aaacb2fd25b61a42b5cd647a66acc50e`;
- `test/frontmatter.test.ts`: 350 lines; SHA-256
  `9db7cc5adf1c7cbb1b74bdb8dd8ebf742c8d9de49f6cf3b4c39ed26a6bc8b69e`.

Production changes by +24/-3 and the test by +135/-0: +159/-3, net +156 lines. The focused lane
passes 1 file / 15 tests. The shared root complete check passes 52 files / 709 tests. Global
coverage is 95.88% statements, 94.85% branches, 99.82% functions, and 97.44% lines.
`frontmatter.ts` covers 121/127 statements, 100/106 branches, 14/14 functions, and 106/112 lines.

## Canonical private release and package

Canonical evidence is retained at `/private/tmp/skillpress-010d-release.aE15Lv`. Base and candidate
are fresh `--no-local`, detached, self-contained clones with no alternates; the candidate cold
install adds 122 packages to its private dependency tree and uses only the private release cache.
Node 22.23.2, 24.19.0, and 26.7.0 each pass the focused 1-file/15-test selection and full
52-file/709-test suite. Homebrew Node 26.7.0, npm 11.19.0, and zlib 1.2.12 pass the complete check.
Full and omit-development audits report zero vulnerabilities.

Canonical dry and actual pack JSON agree in every top-level field and all 195 file rows:

- 195 entries; 172,022 packed bytes; 918,958 unpacked bytes;
- npm SHA-1 `e6cf23daafe894e9486cab53d73d01f5319054d4`;
- archive SHA-256 `2342d9084f3b92aebb3c972c3912719bd5fbc1655f46fb68d22dc3c4325aeed0`;
- integrity
  `sha512-K/6wW0CZbUxAsUCYaCVqs/sbHBMM9fr2HE5tDlMFpp5MkYsV8TFvB8Vp85oOw06mesfKnr0dgXviuPQdZ6ORlg==`;
- decompressed-tar SHA-256
  `69c4b3539c2c76e5bdcbdb734e38df5c37f7c0e14c9fbec67274032ba4a9898f`;
- sorted relative `path\0mode-octal\0file-SHA-256\n` rows produce payload-manifest SHA-256
  `c697925cd0804e6a44bab0be75a4a6fbbf897cb18406b988d825dd2a160e654a`.

The extracted payload has 195 regular 0644 files, six directories, zero special files, no source,
tests, docs, or scripts, and only `.` in its export map. The isolated consumer cold-adds 41 packages
and audits clean. Node 18.20.8, 22.23.2, 24.19.0, and 26.7.0 expose exactly 18 root runtime names;
six internal imports return `ERR_PACKAGE_PATH_NOT_EXPORTED`; CLI version is `0.1.0`, and its help is
17 lines with SHA-256 `9f7ed8f6bcb5174a067f9f94794347a3116a93c75d66d8117b6ec78c3fa1e016`.
Strict TypeScript 7.0.2 NodeNext accepts the root and rejects the frontmatter internal subpath with
only `TS2307`; the no-save compiler install leaves both consumer manifests unchanged.

The read-only property repository remains clean at
`90965164c80fdc9e6209deccba85e2b64a1e0a60`. On Node 22, 24, and 26 its public report retains
SHA-256 `b78fa593ecf98ccc2b51aec95f683cc6cd112a4ce1f20608a3d161660a7c76a1` and only the existing
license warning. Its compact graph summary remains
`4a2438e2fc699e12dff38c6b3f8758dc596a20d86a1b2f05b5ba059d679f84c8`: four files, 59,712
bytes, 1,872 nodes, three line-12 edges, three targets, 20 work units, six components, no aliases,
and empty graph, resource, and placeholder findings.

## Independent distribution boundary

Independent canonical evidence is retained at `/private/tmp/skillpress-010d-dist.dfvE7Q`. Its
fresh detached base and candidate builds each contain 188 regular files and three descendant
directories, with identical path sets and directory sets. Of the files, 185 are byte-identical;
only `frontmatter.d.ts.map`, `.js`, and `.js.map` change. Root `dist/index.js` remains
`6cd258eebb405a6c42aff6c204febf3f5dccc75cd5ef926946d0686ea10f6b63`, and root
`dist/index.d.ts` remains `204bf9749b3534803239bc2a9d542451c7b5cb8dad5755be263ba0846710a56e`.

Base and candidate packages retain the same 195-path/six-directory surface. Their runtime API is
identical: 18 root names, version `0.1.0`, six blocked internal/package paths, and unchanged 17-line
CLI help. A separate pinned `yaml` 2.9.0 normal literal-block-scalar probe records zero parse errors
or warnings and the explicit module-local boundary above: transitive parsing changes all 19 legacy
aliases. The earlier literal `/tmp/skillpress-010d-dist.xcjGg8` tree, which Darwin resolves beneath
`/private/tmp`, used an archive-derived root and did not establish the required fresh `--no-local`
roots; its entire evidence set is explicitly discarded.

## Differential, adversarial, and property holdouts

The private oracle at `/private/tmp/skillpress-010d-adversarial.1TazkV/oracle.mjs` is 718 lines with
SHA-256 `351e84227718dbe703a3855a6ee00d0e4f5fb035a2a6c74732bcc4c141826e42`.
On each of Node 22.23.2, 24.19.0, and 26.7.0, the exact former split/search result and the
independent manual scan agree for all 386,584 inputs, and every input produces exact base/candidate
built-parser outcomes. Including four alias/boundary calls and one post-import-poisoning parser
call, the oracle makes 773,173 direct built frontmatter-parser calls per Node:
`2 × 386,584 + 5`. Across the three Nodes, that is 1,159,752 differential inputs and 2,319,519
direct parser calls, with corpus SHA-256
`9abd4fcb6dde64b7098e687b47ec0e7e6514392735a180ab0de2b10ccc250590` and zero mismatch.
The corpus includes 262,144 BMP/context cases, 24,434 separator cases, 100,000 deterministic fuzz
cases, and six exact byte-boundary cases per Node; it locks both envelope priority and Lexer reach.

The over-indented base changes 19/19 aliases and retains the raw line; the candidate changes 0/19
while returning an exact object-graph match with no raw report text. An accepted literal block
scalar changes 19/19 on both endpoints, preserving the stated parser boundary. On the candidate
early route, poisoning 15 live Reflect/String/RegExp entries after import records zero poison calls
and zero Lexer calls on rejection. Base and candidate property results are exact frozen object-graph
matches: public report SHA-256 is
`b78fa593ecf98ccc2b51aec95f683cc6cd112a4ce1f20608a3d161660a7c76a1`, and the oracle's full
graph-summary serialization is
`bce99696fd3e829549e1fb156ff7761463b14c36b373e932fffdda7f90a8b742`.
Adversarial discovery/calibration inputs were excluded from the frozen measured corpus; this was
planned evidence selection, not a harness failure.

## Harness record and shared-checkout accounting

The author's first signed candidate commit attempt failed because the private signing key was not
available; retrying with signing disabled created the exact candidate. The canonical release then
had three harness-only incidents: a read of nonexistent `coverage-final.json` returned `ENOENT`
before audits, after which the existing `coverage-summary.json` supplied the exact counts; a strict
Homebrew `PATH` made the first bare `mise` consumer invocation return `command not found` before any
consumer test started, after which the absolute executable passed all four Nodes; and using zsh's
special `path` variable hid `wc` and `tr` during the final two line-count reads, which were rerun
with a neutral variable and absolute commands.

The independent lane discarded the noncanonical tree above. In its replacement lane, unsupported
`sed -z` produced zero manifest rows before a portable implementation replaced it; a consumer run
with the wrong private workdir was discarded; a shell `$'` quoting mistake stopped the first YAML
probe before Node; and an empty-left-context seed changed 17/19 aliases before the final nonempty-
context seed demonstrated 19/19. It also ran one read-only `npm --version` while its cwd was the
shared checkout. These incidents changed no candidate, package, or accepted evidence.

During review authoring, a direct Biome format check reported that this documentation path was
ignored and processed zero files; it wrote nothing. The subsequent no-index whitespace diff check
performed the intended validation and passed.

Shared attribution is exact: the root lane ran the full shared `npm run check`; the independent lane
made that one read-only version query in the shared cwd; every stateful release npm operation and
cache lived in private paths. This review document is the sole post-candidate tracked content
change. No release lane wrote or ran stateful npm in the shared checkout. After this review's
commit, the shared checkout and the candidate, base, property, independent, and adversarial Git
trees finish clean. This record is authored after the verified candidate, is absent from the
package, and changes none of the frozen implementation, test, API, or distribution content.
