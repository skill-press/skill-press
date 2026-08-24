# Unicode 17.0.0 comparable-text category data

This directory contains a byte-for-byte copy of the Unicode Character Database
17.0.0 extracted general-category file used as a development input for
SkillPress's deterministic comparable-text punctuation and symbol table.

- Source retrieval date: 2026-08-24
- SPDX license identifier: `Unicode-3.0`

| File | Upstream | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `DerivedGeneralCategory.txt` | <https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedGeneralCategory.txt> | 277,514 | `d62e5bab70ca74f099343f71224fa051cb1fdd61a1ab45c0488c44cfc0b6102e` |

The data is licensed under Unicode License V3; see
[`LICENSES/Unicode-3.0.txt`](../../../LICENSES/Unicode-3.0.txt) and the repository's
[`THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md).

This file is a repository-only generation input. The npm package allowlist deliberately
excludes `vendor/`; generated runtime artifacts must be committed separately.
