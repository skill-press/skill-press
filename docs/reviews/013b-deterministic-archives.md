# 013b deterministic archives review

Date: 2026-08-24

Implementation commit: `ea147596487ecec417dd6898e0061ec01f7b5448`

Reviewer: primary-agent adversarial review; active policy prohibited a new review subagent.

Review confirmed that archive input is exclusively the tracked staging snapshot. Every staged file
is rechecked against its recorded size, SHA-256, and executable bit, and the full staged tree digest
must still match before any artifact is emitted.

The ZIP writer fixes UTF-8 flags, STORE compression, 1980-01-01 timestamps, bytewise path order,
CRC-32, Unix regular/executable modes, central-directory offsets, and top-level skill name. `.skill`
and `.zip` are deliberately the same canonical ZIP bytes. Provenance has no wall-clock field and is
schema-validated; its own hash was added to `SHA256SUMS` during review so provenance cannot change
without invalidating the distributed checksum file.

Focused tests generated independent random staging roots and proved byte-identical artifacts,
validated the archive with the system unzip reader, and rejected config, tree, file metadata, and
identity drift. The accumulated gate passed 70 files and 997 tests at 96.09% statements and 94.67%
branches; archive code reached 99.13% statements and 93.75% branches.

A clean self-host run packaged `skills/skillpress` at implementation commit
`ea147596487ecec417dd6898e0061ec01f7b5448`; its canonical archive was 3,691 bytes with SHA-256
`32c005c6194345b66128567cac2bb31bad9b46cfa78cff942fc370fc1b9e2e57`.
