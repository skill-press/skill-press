# npm v0.1.0 provenance propagation incident

- Status: Resolved in the registry; deployment receipt not issued
- Local date: 2026-08-31
- UTC date: 2026-09-01
- Package: `@skill-press/cli@0.1.0`
- Source commit: `c2718e8d2b204cc4b9f8b1222f9f9762e18ce80f`
- Release workflow: <https://github.com/skill-press/skill-press/actions/runs/33470764933>
- Publish job: `99740320571`

## Summary

The first Trusted Publisher workflow successfully published `@skill-press/cli@0.1.0`, but its
post-publication verifier queried npm's attestation endpoint before provenance had propagated. The
package metadata was already present and exactly matched the sealed tarball. The attestation
request returned HTTP 404 at approximately 2026-09-01 05:08:56 UTC, about one second after npm
accepted publication, and the workflow failed before writing its publication receipt.

The immutable version was not republished and the failed workflow was not rerun. Later read-only
verification using the exact verifier preserved by the original workflow returned `match`. A
fresh, isolated install followed by `npm audit signatures --include-attestations` returned
`audit-match`. These checks establish that the registry bytes, npm signatures, and SLSA provenance
are valid; they do not retroactively create the missing first-deploy receipt.

## Bound identity

- Registry integrity:
  `sha512-oCMDUGlhVreIXLEojUN01HwXZOSnX7UHcU5lJ333Mm75pM99/wu/zY7jchmNLTpaMrD8ISr9/qDWWG4dVJftgw==`
- Registry shasum: `0392668931774cee56283c1127a72447b5d12b7f`
- Registry tarball:
  `https://registry.npmjs.org/@skill-press/cli/-/cli-0.1.0.tgz`
- Final dist-tags: `bootstrap: 0.0.0`, `latest: 0.1.0`

## Impact and disposition

The npm package is usable and its provenance is now valid. Production first deployment remains
blocked because run attempt 1 did not produce the sealed `skillpress.npm-trusted-release` receipt.
The workflow contract intentionally rejects reruns, and npm versions are immutable.

Recovery therefore uses a new CLI patch version, `0.1.1`. The verifier will represent an exact
metadata match followed by attestation HTTP 404 as a bounded post-publication `pending` state. It
will continue to fail closed for conflicting metadata and every other attestation response. A new
protected tag and GitHub Release will publish `0.1.1` and must complete its original workflow
attempt, cryptographic audit, and receipt upload before production deployment resumes.

No Tessl evaluation is repeated for this recovery: the canonical Skill bytes and Skill version are
unchanged.
