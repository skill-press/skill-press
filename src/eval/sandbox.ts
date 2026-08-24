import { isAbsolute, resolve } from "node:path";

import { isUnambiguousUnicode } from "../path-safety.js";

export type SandboxBackend = "docker" | "podman";
export type SandboxNetwork = "none" | "restricted";

export interface SandboxMount {
  readonly source: string;
  readonly target: string;
  readonly mode: "read-only" | "read-write";
}

export interface SandboxResourcePolicy {
  readonly timeoutSeconds: number;
  readonly cpus: number;
  readonly memoryMib: number;
  readonly pids: number;
  readonly tmpfsMib: number;
  readonly shmMib: number;
  readonly maxOutputBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxArtifactFiles: number;
}

export interface SandboxRunRequest {
  readonly backend: SandboxBackend;
  readonly runId: string;
  readonly image: string;
  readonly command: readonly [string, ...string[]];
  readonly mounts: readonly SandboxMount[];
  readonly network: SandboxNetwork;
  readonly policy?: SandboxResourcePolicy;
  readonly allowUnpinnedImage?: boolean;
}

export interface SandboxInvocation {
  readonly executable: SandboxBackend;
  readonly argv: readonly string[];
  readonly containerName: string;
  readonly releaseEligible: boolean;
  readonly ineligibilityReasons: readonly string[];
  readonly policy: Readonly<SandboxResourcePolicy>;
}

export interface SandboxPolicyIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class SandboxPolicyError extends Error {
  readonly issues: readonly SandboxPolicyIssue[];

  constructor(issues: readonly SandboxPolicyIssue[]) {
    super("Sandbox request violates the resource or isolation policy.");
    this.name = "SandboxPolicyError";
    this.issues = Object.freeze([...issues]);
  }
}

export const DEFAULT_SANDBOX_RESOURCE_POLICY: Readonly<SandboxResourcePolicy> = Object.freeze({
  timeoutSeconds: 300,
  cpus: 1,
  memoryMib: 512,
  pids: 64,
  tmpfsMib: 64,
  shmMib: 16,
  maxOutputBytes: 1024 * 1024,
  maxArtifactBytes: 64 * 1024 * 1024,
  maxArtifactFiles: 1024,
});

const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const PINNED_IMAGE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/u;
const RUN_ID = /^[a-f0-9]{16,64}$/u;
const CONTAINER_TARGET = /^\/(?:[a-z0-9][a-z0-9._-]*)(?:\/[a-z0-9][a-z0-9._-]*)*$/u;
const genuineInvocations = new WeakSet<object>();

export function isGenuineSandboxInvocation(value: unknown): value is SandboxInvocation {
  return typeof value === "object" && value !== null && genuineInvocations.has(value);
}

function issue(code: string, path: string, message: string): SandboxPolicyIssue {
  return Object.freeze({ code, path, message });
}

function validInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function validArgument(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_ARGUMENT_BYTES &&
    isUnambiguousUnicode(value)
  );
}

function targetOverlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function validatePolicy(policy: SandboxResourcePolicy): SandboxPolicyIssue[] {
  const issues: SandboxPolicyIssue[] = [];
  const integerBounds = [
    ["timeoutSeconds", policy.timeoutSeconds, 1, 3600],
    ["memoryMib", policy.memoryMib, 64, 8192],
    ["pids", policy.pids, 8, 1024],
    ["tmpfsMib", policy.tmpfsMib, 8, 1024],
    ["shmMib", policy.shmMib, 1, 1024],
    ["maxOutputBytes", policy.maxOutputBytes, 1024, 16 * 1024 * 1024],
    ["maxArtifactBytes", policy.maxArtifactBytes, 1024, 1024 * 1024 * 1024],
    ["maxArtifactFiles", policy.maxArtifactFiles, 1, 100_000],
  ] as const;
  for (const [name, value, minimum, maximum] of integerBounds) {
    if (!validInteger(value, minimum, maximum)) {
      issues.push(
        issue(
          "sandbox.policy.bound",
          `/policy/${name}`,
          "sandbox resource limit is outside its supported integer range",
        ),
      );
    }
  }
  if (!Number.isFinite(policy.cpus) || policy.cpus < 0.1 || policy.cpus > 8) {
    issues.push(
      issue(
        "sandbox.policy.bound",
        "/policy/cpus",
        "sandbox CPU limit must be finite and between 0.1 and 8",
      ),
    );
  }
  return issues;
}

function validateMounts(mounts: readonly SandboxMount[]): SandboxPolicyIssue[] {
  const issues: SandboxPolicyIssue[] = [];
  if (mounts.length !== 3) {
    issues.push(
      issue("sandbox.mount.count", "/mounts", "sandbox requires exactly three explicit mounts"),
    );
  }
  let writableCount = 0;
  const expectedTargets = new Map([
    ["/skill", "read-only"],
    ["/input", "read-only"],
    ["/output", "read-write"],
  ] as const);
  for (let index = 0; index < mounts.length; index += 1) {
    const mount = mounts[index] as SandboxMount;
    if (
      !isAbsolute(mount.source) ||
      resolve(mount.source) !== mount.source ||
      !isUnambiguousUnicode(mount.source) ||
      mount.source.includes(",")
    ) {
      issues.push(
        issue(
          "sandbox.mount.source",
          `/mounts/${index}/source`,
          "mount source must be a normalized, absolute, unambiguous path without commas",
        ),
      );
    }
    if (!CONTAINER_TARGET.test(mount.target)) {
      issues.push(
        issue(
          "sandbox.mount.target",
          `/mounts/${index}/target`,
          "mount target must be a normalized absolute container path",
        ),
      );
    }
    const expectedMode = expectedTargets.get(mount.target as "/skill" | "/input" | "/output");
    if (expectedMode !== mount.mode) {
      issues.push(
        issue(
          "sandbox.mount.topology",
          `/mounts/${index}`,
          "mounts must be read-only /skill and /input plus writable /output",
        ),
      );
    }
    if (mount.mode === "read-write") writableCount += 1;
    for (let prior = 0; prior < index; prior += 1) {
      if (targetOverlaps(mount.target, (mounts[prior] as SandboxMount).target)) {
        issues.push(
          issue(
            "sandbox.mount.overlap",
            `/mounts/${index}/target`,
            "container mount targets must not overlap",
          ),
        );
      }
    }
  }
  if (writableCount !== 1) {
    issues.push(
      issue(
        "sandbox.mount.writable",
        "/mounts",
        "sandbox requires exactly one writable output mount",
      ),
    );
  }
  return issues;
}

function mountArgument(mount: SandboxMount): string {
  const fields = ["type=bind", `src=${mount.source}`, `dst=${mount.target}`];
  if (mount.mode === "read-only") fields.push("readonly");
  return fields.join(",");
}

/**
 * Construct an auditable Docker/Podman invocation. It does not read mounts or start a process.
 */
export function createSandboxInvocation(request: SandboxRunRequest): SandboxInvocation {
  const policy = request.policy ?? DEFAULT_SANDBOX_RESOURCE_POLICY;
  const issues = [...validatePolicy(policy), ...validateMounts(request.mounts)];
  if (request.backend !== "docker" && request.backend !== "podman") {
    issues.push(issue("sandbox.backend", "/backend", "sandbox backend must be docker or podman"));
  }
  if (!RUN_ID.test(request.runId)) {
    issues.push(issue("sandbox.run_id", "/runId", "run id must be 16 to 64 lowercase hex digits"));
  }
  const pinnedImage = PINNED_IMAGE.test(request.image);
  if (!pinnedImage && request.allowUnpinnedImage !== true) {
    issues.push(
      issue(
        "sandbox.image.unpinned",
        "/image",
        "sandbox image must use an immutable sha256 digest",
      ),
    );
  }
  if (request.network !== "none") {
    issues.push(
      issue(
        "sandbox.network.unsupported",
        "/network",
        "restricted egress is unavailable; release-eligible runs require no network",
      ),
    );
  }
  if (request.command.length === 0 || request.command.length > MAX_ARGUMENTS) {
    issues.push(
      issue(
        "sandbox.command.count",
        "/command",
        `sandbox command requires between 1 and ${MAX_ARGUMENTS} arguments`,
      ),
    );
  }
  for (let index = 0; index < request.command.length; index += 1) {
    if (!validArgument(request.command[index] as string)) {
      issues.push(
        issue(
          "sandbox.command.argument",
          `/command/${index}`,
          "sandbox command argument is empty, ambiguous, or too large",
        ),
      );
    }
  }
  if (issues.length > 0) throw new SandboxPolicyError(issues);

  const containerName = `skillpress-${request.runId}`;
  const memory = `${policy.memoryMib}m`;
  const argv = [
    "run",
    "--rm",
    "--pull=never",
    `--name=${containerName}`,
    "--hostname=skillpress",
    "--network=none",
    "--read-only",
    ...(request.backend === "podman" ? ["--read-only-tmpfs=false"] : []),
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65532:65532",
    `--cpus=${policy.cpus}`,
    `--memory=${memory}`,
    `--memory-swap=${memory}`,
    `--pids-limit=${policy.pids}`,
    `--shm-size=${policy.shmMib}m`,
    "--ulimit=nofile=256:256",
    "--stop-timeout=1",
    "--log-driver=none",
    `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=${policy.tmpfsMib}m,mode=1777`,
    "--env=HOME=/tmp",
    "--env=TMPDIR=/tmp",
    "--env=NO_COLOR=1",
    "--env=SKILLPRESS_SANDBOX=1",
    "--workdir=/output",
    ...request.mounts.flatMap((mount) => ["--mount", mountArgument(mount)]),
    request.image,
    ...request.command,
  ];
  const ineligibilityReasons = Object.freeze(pinnedImage ? [] : ["sandbox_image_unpinned"]);
  const invocation = Object.freeze({
    executable: request.backend,
    argv: Object.freeze(argv),
    containerName,
    releaseEligible: ineligibilityReasons.length === 0,
    ineligibilityReasons,
    policy: Object.freeze({ ...policy }),
  });
  genuineInvocations.add(invocation);
  return invocation;
}
