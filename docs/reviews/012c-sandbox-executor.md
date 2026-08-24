# 012c sandbox executor review

Date: 2026-08-24

Implementation commit: `dee96d6fbcc2d48a28fdbe5af2241af8b895f3aa`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- execution of branded sandbox invocations without a shell;
- minimal engine-client environment;
- bounded stdout/stderr capture and digests;
- wall-time and combined-output termination;
- process-group kill and named-container forced cleanup;
- startup, nonzero exit, overflow, and timeout classification.

## Findings

No release-blocking finding remained after review.

- The executor rejects copied or caller-fabricated invocation objects. Only a policy-validated
  invocation produced in the same module can reach `spawn`.
- The Docker/Podman client receives only its discovery/context variables; arbitrary host variables,
  `NODE_OPTIONS`, and application credentials are not inherited. Those client variables are not
  forwarded into the container.
- A forced run first terminates the local engine client as a process group, then issues an exact
  `rm --force <unique-name>` after the client closes. No shell or user-controlled container name is
  involved.
- Captured output is bounded by the invocation policy and receives byte counts and SHA-256 digests.
  Raw engine output is retained in memory only for the caller to redact or persist privately; it is
  not a release receipt.
- Cleanup failure remains explicit and cannot be interpreted as a successful evaluation.

## Verification

- `npm run check`: pass; 61 test files and 828 tests.
- Coverage: 96.05% statements, 94.93% branches, 99.70% functions, 97.54% lines; the new executor
  satisfied 91.42% statements and 90.00% branches.
- Fault injection used a fake Docker executable for success, nonzero exit, host-environment
  isolation, overflow, timeout, counterfeit invocation, engine disappearance, and cleanup.
- Real Docker 29.4.0 executor smoke passed with the pinned Python image and wrote the expected proof
  under `/private/tmp/skillpress-sandbox-executor.*`.
- Remote `main` resolved to the exact implementation commit after push.

## Residual boundaries

- The paired runner must convert engine output and result files into redacted evidence, verify the
  adapter protocol, and mark any cleanup failure ineligible.
- Cancellation signals and platform-specific engine preflight reporting remain doctor/status work;
  the wall-time and output failure paths themselves are already fail-closed.
