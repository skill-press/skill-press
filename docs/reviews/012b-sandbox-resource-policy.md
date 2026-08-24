# 012b sandbox resource policy review

Date: 2026-08-24

Implementation commit: `9c0d375bb617702f3335e4fa68454cf6eef1989a`

Reviewer: primary-agent adversarial review. The active collaboration policy prohibited creating a
new review subagent for this slice, so this is not represented as an independent review.

## Scope

- audited Docker and Podman `run` argv construction;
- immutable image and container-name validation;
- exact mount topology and shell-free command validation;
- network, privilege, filesystem, identity, resource, logging, and timeout policy;
- release eligibility for pinned versus explicitly allowed local images.

The contract was checked against the current official
[Docker run](https://docs.docker.com/reference/cli/docker/container/run),
[Docker resource constraint](https://docs.docker.com/engine/containers/resource_constraints/),
and [Podman run](https://docs.podman.io/en/latest/markdown/podman-run.1.html) documentation.

## Findings and fixes

One compatibility finding was fixed before commit. The initial writable bind-mount rendering used
a bare `rw` field. A real Docker 29.4.0 run rejected that field because long `--mount` syntax treats
write access as the default. The final builder omits `readonly` for `/output` and retains it for
`/skill` and `/input`.

No release-blocking finding remained after that fix.

- Release-eligible images require an immutable `sha256` digest. An explicit unpinned-image override
  remains ineligible in the returned contract.
- The only accepted topology is read-only `/skill`, read-only `/input`, and writable `/output`.
  Duplicate, nested, relative, ambiguous, comma-containing, or extra targets fail closed.
- The container has no network, a read-only root, no Linux capabilities, no-new-privileges, a
  numeric non-root identity, an empty host-environment projection, and no engine transcript log.
- CPU, memory and swap, PID, shared-memory, temporary-filesystem, open-file, output, artifact,
  artifact-count, and wall-time limits are explicit and bounded.
- `restricted` networking fails as unsupported rather than silently becoming unrestricted.
- Docker/Podman and the container command are separate argv values; no shell interprets user text.

## Verification

- `npm run check`: pass; 60 test files and 821 tests.
- Coverage: 96.10% statements, 94.95% branches, 99.84% functions, 97.58% lines; every measured
  deterministic source file satisfied the per-file 90% gates.
- Real Docker smoke: `python@sha256:05b2…dcdc` ran with the exact hardened flags, could read the
  input mount, could not write the skill mount, and wrote only the output proof. Evidence remains
  under `/private/tmp/skillpress-sandbox-smoke.tqs6ur`.
- Remote `main` resolved to the exact implementation commit after push.

## Residual boundaries

- This slice constructs and validates the backend invocation. The paired runner must create and
  inspect the three private staging trees, enforce output/artifact counts after execution, kill and
  remove a named container on timeout, and bind that result to the staged skill digest.
- Podman syntax is contract-tested against current official documentation, but Podman was not
  installed for a live local smoke. A later doctor/preflight must report backend-specific cgroup or
  remote-client limitations rather than weakening the resource policy.
