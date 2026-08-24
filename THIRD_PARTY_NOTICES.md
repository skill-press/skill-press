# Third-Party Notices

SkillPress includes the following third-party material in its source repository.

## Unicode Character Database 15.1.0

The following development-only files are unmodified data files from Unicode
Character Database 15.1.0, copyright © 2023 Unicode, Inc.

| File | Upstream | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `CaseFolding.txt` | <https://www.unicode.org/Public/15.1.0/ucd/CaseFolding.txt> | 84,870 | `4e55acfdc32825a22e87670e9056a3bf94ad7c5400065778e9e10f8314372bcf` |
| `DerivedAge.txt` | <https://www.unicode.org/Public/15.1.0/ucd/DerivedAge.txt> | 131,154 | `04e16379344bdb9973cdb6f6bf0a5dd66f7cd41b014cd9f79d848768ae757256` |
| `DerivedCoreProperties.txt` | <https://www.unicode.org/Public/15.1.0/ucd/DerivedCoreProperties.txt> | 1,072,686 | `f55d0db69123431a7317868725b1fcbf1eab6b265d756d1bd7f0f6d9f9ee108b` |

- SPDX license identifier: `Unicode-3.0`
- Source retrieval date: 2026-08-19

## Unicode Character Database 17.0.0

The following development-only file is an unmodified data file from Unicode
Character Database 17.0.0, copyright © 2025 Unicode, Inc.

| File | Upstream | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `DerivedGeneralCategory.txt` | <https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedGeneralCategory.txt> | 277,514 | `d62e5bab70ca74f099343f71224fa051cb1fdd61a1ab45c0488c44cfc0b6102e` |

- SPDX license identifier: `Unicode-3.0`
- Source retrieval date: 2026-08-24

The npm package ships `dist/validate/generated-unicode.*`. Its JavaScript and source maps contain
mechanically generated, compressed derived tables from the pinned 15.1.0 and 17.0.0 inputs. The
original Unicode data files remain development-only.

They are distributed under Unicode License V3. The complete license text is in
[`LICENSES/Unicode-3.0.txt`](LICENSES/Unicode-3.0.txt) and was retrieved from
<https://www.unicode.org/license.txt>.
