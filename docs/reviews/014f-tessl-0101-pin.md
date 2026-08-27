# 014f Tessl 0.101.0 trust-pin review

Date: 2026-08-27

Candidate base commit: `102993b2998352f17f4f438970261f36924e0776`

## Scope

- replace the Tessl 0.99.0 signed-release trust set with 0.101.0;
- verify the detached release-manifest signature and every platform archive used by the runtime
  trust set, including the distinct Windows Winget carriers;
- recheck the Quality, Impact, lint, registry inspection, and publication command contracts;
- update current operator documentation without rewriting historical review records.

## Supply-chain verification

The official 0.101.0 `SHA256SUMS` and `SHA256SUMS.sig` were downloaded directly from
`https://install.tessl.io/binaries/0.101.0/`. The detached signature verified with SHA-256 and the
`kms-2026-06` ECDSA public key embedded in the official Tessl installer. The signed manifest
contains ten entries, including two Winget-specific carrier archives. Its retained identities are:

- manifest SHA-256: `5dfcccb44f2025b019a5b164306284096cb887640766f53e26d8fd2c72d7ed97`;
- detached-signature SHA-256:
  `c4233fd0cc79b242cc5968f11df3d8a969a471792d213ba39b792e84b3898518`.

All ten platform archives matched their signed manifest SHA-256 before extraction. The extracted
executable SHA-256 values now trusted by SkillPress are:

| Platform | Executable SHA-256 |
| --- | --- |
| darwin-arm64 | `9494050a66ec8a6f3f82405f7d7c5afccbdc03c1a195a823e07b6bfc5dea2f6c` |
| darwin-x64 | `a8a71b43399998cbafa787503c6a51b0e212e0c2883f5bcc2cf094d141d7993a` |
| linux-arm64 | `405aac95750048ec31c4026cf38b389442a6dbe5eecce9908a399c615e2ea386` |
| linux-arm64-musl | `316819d34dbf200f07c605abdceda2ae920581c26da51a5f21b93b56e2b1a6b2` |
| linux-x64 | `67b974938e244edf0e24523be84dcb55b56ef41c4813bf86be8715d7055a4e0e` |
| linux-x64-musl | `fd2cf07b81f408c648013b76e92b5e8eea1565f54dca46adeda0ec8cc6a59098` |
| win32-arm64-winget | `283d1df9bc8c6a12a5511979d6de5b1524703e7bd8cc99c77963ff29f4cd31ce` |
| win32-arm64 | `4816ce6bea0188a3a61480e43807a0ffe588c114d224d027dcc2798d7bbd63b7` |
| win32-x64-winget | `ed1c04bd0e2242f2950e14acec99bb20d33b946af792c8133049bd72a7734601` |
| win32-x64 | `a922e16f58e223ddc5ef7d38f33138250548bc78b30668a27af9974159b12129` |

The installed darwin-arm64 executable independently reports `0.101.0` and matches the signed
darwin-arm64 digest above. The previous 0.99.0 version/digest pair is explicitly rejected by the
updated trust-set test.

## Command-contract review

The real 0.101.0 executable retained the exact command families SkillPress invokes:

- `skill lint <plugin.json>`;
- `review run quality --json --force [--workspace] --threshold 0 <skill>`;
- `eval run --json --force [--agent] [--model] --runs <count> <source>`;
- `eval view --json <run-id>`;
- `plugin publish --dry-run --skip-evals --verbose <plugin>`;
- `api --raw --header accept:application/gzip <version-archive-endpoint>`.

The real lint command accepted the existing private SkillPress plugin projection. The exact public
0.1.0 archive lookup returned Tessl's structured JSON 404, preserving the adapter's absent-version
classification. Evidence and publication subprocesses now use a fresh private HOME/XDG/AppData
boundary, current Quality capture uses the provider's `--force` option, and operator commands
require the extracted versioned binary instead of an installer launcher. Live Quality and Impact
capture remains the final parser and release-gate forward-test after the pin change is committed
and the relevant Git inputs are clean.

## Verification

- focused provider-home, Tessl evidence, release-gate, publication-adapter, docs-contract, and CLI
  suites: 196 tests passed;
- formatting, lint, and TypeScript checks passed;
- full repository gate: 91 test files and 1283 tests passed; coverage remained 95.77% statements,
  93.98% branches, 99.43% functions, and 97.23% lines;
- production dependency audit: zero vulnerabilities;
- package verification: 410 files, 378,708 packed bytes, npm SHA-1
  `171b79df8d07d732842b228eb3d0011a86f0c39d`, and clean-consumer CLI version 0.1.0.
