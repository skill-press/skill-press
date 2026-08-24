# Release gates

SkillPress keeps local readiness, local paired behavior, and official Tessl evidence separate. A
release profile does not convert one evidence type into another.

The `checkTesslReleaseGate` library API accepts only explicit evidence files under the private
`.skillpress/tessl/<run-id>/evidence.json` capture layout and an eval-source directory inside the
project. It then independently checks:

- both evidence documents against their strict generated schemas;
- private regular-file and directory permissions, with no symbolic-link path components;
- current Git HEAD and clean release-relevant inputs;
- exact `skillpress.yaml`, complete canonical-skill tree, and complete eval-source tree digests;
- evidence timestamps against `quality.evidenceMaxAgeHours`, including future-date rejection;
- the signed-release Tessl version/executable digest pair;
- normalized official command digests, exit status, raw byte counts, and raw stream hashes;
- Quality and Impact derivation by reparsing raw provider JSON;
- provider validation, configured Quality and Impact minimums, and per-scenario non-regression.

The default configuration requires Tessl Quality and Impact of at least 90. Missing, stale,
ineligible, malformed, locally scored, or hand-placed evidence outside capture storage fails closed.
The gate never accepts a numeric score option.

Private evidence is part of the local trusted computing base: a user who can arbitrarily rewrite
the repository, SkillPress implementation, and every private raw/evidence file can also falsify
local state. Tessl does not currently provide a detached provider signature in these CLI outputs,
so stronger hostile-owner attestation requires online provider verification or a future signed
receipt. SkillPress prevents accidental/manual score substitution and detects inconsistent
tampering; it does not claim cryptographic proof that the filesystem owner is honest.
