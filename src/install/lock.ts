import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import { Ajv, type ValidateFunction } from "ajv";

import { TrustedInstallError } from "./errors.js";
import { parseExactSkillLocator } from "./locator.js";
import {
  SKILL_PRESS_INSTALL_ORIGIN,
  type SkillLockEntry,
  type SkillPressLockfile,
} from "./types.js";

export const SKILL_PRESS_LOCK_NAME = "skill-lock.json" as const;

const MAX_LOCK_BYTES = 1024 * 1024;
const MUTATION_LOCK_NAME = ".skill-lock.json.lock";
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const schema = JSON.parse(
  await readFile(new URL("../../schemas/skill-lock.schema.json", import.meta.url), "utf8"),
) as object;
const validateLock = new Ajv({ allErrors: true, strict: true }).compile(
  schema,
) as ValidateFunction<SkillPressLockfile>;

export type SkillLockRevision =
  | Readonly<{ readonly exists: false }>
  | Readonly<{
      readonly exists: true;
      readonly dev: number | bigint;
      readonly ino: number | bigint;
      readonly mode: number | bigint;
      readonly size: number | bigint;
      readonly mtimeMs: number;
      readonly ctimeMs: number;
      readonly sha256: string;
    }>;

export interface SkillLockSnapshot {
  readonly lock: SkillPressLockfile;
  readonly revision: SkillLockRevision;
}

function emptyLock(): SkillPressLockfile {
  return Object.freeze({
    schemaVersion: 1,
    lockfileType: "skillpress.lock",
    registry: Object.freeze({ origin: SKILL_PRESS_INSTALL_ORIGIN, protocolVersion: 1 }),
    skills: Object.freeze([]),
  });
}

function metadataEqual(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function semanticLock(value: SkillPressLockfile): SkillPressLockfile {
  let previousLocator: string | undefined;
  const installed = new Set<string>();
  const copied: SkillLockEntry[] = [];
  for (const entry of value.skills) {
    const locator = parseExactSkillLocator(entry.locator);
    if (
      locator.namespace !== entry.namespace ||
      locator.skill !== entry.skill ||
      locator.version !== entry.version ||
      entry.installedPath !== `.agents/skills/${entry.skill}` ||
      (previousLocator !== undefined &&
        Buffer.compare(Buffer.from(previousLocator), Buffer.from(entry.locator)) >= 0) ||
      installed.has(entry.installedPath)
    ) {
      throw new TrustedInstallError(
        "lock_invalid",
        "skill-lock.json has inconsistent, conflicting, or non-deterministic entries.",
      );
    }
    previousLocator = entry.locator;
    installed.add(entry.installedPath);
    copied.push(
      Object.freeze({
        ...locator,
        artifact: Object.freeze({ ...entry.artifact }),
        attestation: Object.freeze({ ...entry.attestation }),
        trust: Object.freeze({ ...entry.trust }),
        installedPath: entry.installedPath,
      }),
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    lockfileType: "skillpress.lock",
    registry: Object.freeze({ origin: SKILL_PRESS_INSTALL_ORIGIN, protocolVersion: 1 }),
    skills: Object.freeze(copied),
  });
}

export async function readSkillLockSnapshot(projectRoot: string): Promise<SkillLockSnapshot> {
  const path = join(projectRoot, SKILL_PRESS_LOCK_NAME);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ lock: emptyLock(), revision: Object.freeze({ exists: false }) });
    }
    throw new TrustedInstallError("lock_invalid", "skill-lock.json could not be inspected.");
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > MAX_LOCK_BYTES
  ) {
    throw new TrustedInstallError(
      "lock_invalid",
      "skill-lock.json must be a bounded regular file, not a link.",
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
    const after = await lstat(path);
    if (bytes.byteLength !== before.size || !metadataEqual(before, after)) {
      throw new Error("changed");
    }
  } catch {
    throw new TrustedInstallError("lock_invalid", "skill-lock.json changed while it was read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new TrustedInstallError("lock_invalid", "skill-lock.json is not valid UTF-8 JSON.");
  }
  if (!validateLock(parsed)) {
    throw new TrustedInstallError("lock_invalid", "skill-lock.json violates its strict schema.");
  }
  return Object.freeze({
    lock: semanticLock(parsed),
    revision: Object.freeze({
      exists: true,
      dev: before.dev,
      ino: before.ino,
      mode: before.mode,
      size: before.size,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  });
}

export async function readSkillLock(projectRoot: string): Promise<SkillPressLockfile> {
  return (await readSkillLockSnapshot(projectRoot)).lock;
}

export function withSkillLockEntry(
  lock: SkillPressLockfile,
  entry: SkillLockEntry,
): SkillPressLockfile {
  const retained = lock.skills.filter((candidate) => candidate.locator !== entry.locator);
  const conflict = retained.find(
    (candidate) =>
      candidate.installedPath === entry.installedPath ||
      (candidate.namespace === entry.namespace && candidate.skill === entry.skill),
  );
  const existing = lock.skills.find((candidate) => candidate.locator === entry.locator);
  if (
    conflict !== undefined ||
    (existing !== undefined &&
      (existing.artifact.sha256 !== entry.artifact.sha256 ||
        existing.artifact.bytes !== entry.artifact.bytes ||
        existing.attestation.sha256 !== entry.attestation.sha256 ||
        existing.attestation.keyId !== entry.attestation.keyId ||
        entry.trust.sequence < existing.trust.sequence ||
        Date.parse(entry.trust.updatedAt) < Date.parse(existing.trust.updatedAt) ||
        (entry.trust.sequence === existing.trust.sequence &&
          (entry.trust.keyId !== existing.trust.keyId ||
            entry.trust.sha256 !== existing.trust.sha256 ||
            entry.trust.updatedAt !== existing.trust.updatedAt))))
  ) {
    throw new TrustedInstallError(
      "install_conflict",
      "The requested skill conflicts with an existing immutable lock entry.",
    );
  }
  const skills = [...retained, entry].sort((left, right) =>
    Buffer.compare(Buffer.from(left.locator), Buffer.from(right.locator)),
  );
  return semanticLock({
    schemaVersion: 1,
    lockfileType: "skillpress.lock",
    registry: { origin: SKILL_PRESS_INSTALL_ORIGIN, protocolVersion: 1 },
    skills,
  });
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function reclaimDeadMutationLock(path: string): Promise<boolean> {
  let before: Awaited<ReturnType<typeof lstat>>;
  let bytes: Buffer;
  try {
    before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 256) {
      return false;
    }
    bytes = await readFile(path);
    const after = await lstat(path);
    if (!metadataEqual(before, after)) return false;
  } catch {
    return false;
  }
  const match =
    /^(?<pid>[1-9][0-9]*) [0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/u.exec(
      bytes.toString("utf8"),
    );
  const pid = Number(match?.groups?.pid);
  if (!Number.isSafeInteger(pid) || pid < 1 || (await processIsAlive(pid))) return false;

  const quarantine = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, quarantine);
    const moved = await lstat(quarantine);
    if (moved.dev !== before.dev || moved.ino !== before.ino) {
      try {
        await link(quarantine, path);
        await unlink(quarantine);
      } catch {
        // Preserve a replacement lock under its unique quarantine identity.
      }
      return false;
    }
    await unlink(quarantine);
    return true;
  } catch {
    return false;
  }
}

/** Serialize every lockfile and installation mutation within one physical project root. */
export async function acquireSkillMutationLock(projectRoot: string): Promise<() => Promise<void>> {
  const path = join(projectRoot, MUTATION_LOCK_NAME);
  const flags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_WRONLY |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>> | undefined;
  for (let attempt = 0; attempt < 2 && identity === undefined; attempt += 1) {
    try {
      handle = await open(path, flags, 0o600);
      identity = await handle.stat();
      await handle.writeFile(`${process.pid} ${randomUUID()}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      try {
        await handle?.close();
      } catch {
        // Preserve the primary acquisition error.
      }
      handle = undefined;
      if (identity !== undefined) {
        try {
          const current = await lstat(path);
          if (current.dev === identity.dev && current.ino === identity.ino) await unlink(path);
        } catch {
          // Never unlink an identity that can no longer be proven.
        }
        identity = undefined;
      }
      const occupied = (error as NodeJS.ErrnoException).code === "EEXIST";
      if (occupied && attempt === 0 && (await reclaimDeadMutationLock(path))) continue;
      throw new TrustedInstallError(
        occupied ? "install_conflict" : "install_failed",
        occupied
          ? "Another skpress add or install operation is already active in this project."
          : "The project installation lock could not be acquired.",
      );
    }
  }
  if (identity === undefined) {
    throw new TrustedInstallError("install_failed", "The project installation lock is invalid.");
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const quarantine = `${path}.releasing-${randomUUID()}`;
    try {
      await rename(path, quarantine);
      const current = await lstat(quarantine);
      if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
        try {
          await link(quarantine, path);
          await unlink(quarantine);
        } catch {
          // Preserve a replacement lock under its unique quarantine identity.
        }
        throw new Error("identity changed");
      }
      await unlink(quarantine);
    } catch (error) {
      throw new TrustedInstallError(
        "install_failed",
        "The project installation lock could not be safely released.",
        { cause: error },
      );
    }
  };
}

async function currentLockRevision(path: string): Promise<SkillLockRevision> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ exists: false });
    }
    throw new TrustedInstallError("install_conflict", "skill-lock.json changed before commit.");
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > MAX_LOCK_BYTES
  ) {
    throw new TrustedInstallError("install_conflict", "skill-lock.json changed before commit.");
  }
  try {
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (bytes.byteLength !== before.size || !metadataEqual(before, after)) {
      throw new Error("changed");
    }
    return Object.freeze({
      exists: true,
      dev: after.dev,
      ino: after.ino,
      mode: after.mode,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } catch (error) {
    if (error instanceof TrustedInstallError) throw error;
    throw new TrustedInstallError("install_conflict", "skill-lock.json changed before commit.");
  }
}

function sameRevision(left: SkillLockRevision, right: SkillLockRevision): boolean {
  if (!left.exists || !right.exists) return left.exists === right.exists;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.sha256 === right.sha256
  );
}

function sameRelocatedRevision(left: SkillLockRevision, right: SkillLockRevision): boolean {
  if (!left.exists || !right.exists) return false;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256
  );
}

export async function writeSkillLock(
  projectRoot: string,
  lock: SkillPressLockfile,
  expectedRevision?: SkillLockRevision,
): Promise<string> {
  const verified = semanticLock(lock);
  const path = join(projectRoot, SKILL_PRESS_LOCK_NAME);
  const temporary = join(projectRoot, `.skill-lock.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(verified, null, 2)}\n`, "utf8");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (expectedRevision === undefined) {
      await rename(temporary, path);
    } else {
      const currentRevision = await currentLockRevision(path);
      if (!sameRevision(expectedRevision, currentRevision)) {
        throw new TrustedInstallError(
          "install_conflict",
          "skill-lock.json changed while releases were being installed.",
        );
      }
      if (expectedRevision.exists) {
        const prior = join(projectRoot, `.skill-lock.${randomUUID()}.previous`);
        try {
          await link(path, prior);
        } catch {
          throw new TrustedInstallError(
            "install_conflict",
            "skill-lock.json disappeared during its no-clobber commit.",
          );
        }
        const claimedRevision = await currentLockRevision(prior);
        const stillCurrent = await currentLockRevision(path);
        if (
          !sameRelocatedRevision(expectedRevision, claimedRevision) ||
          !sameRelocatedRevision(expectedRevision, stillCurrent) ||
          !claimedRevision.exists ||
          !stillCurrent.exists ||
          claimedRevision.dev !== stillCurrent.dev ||
          claimedRevision.ino !== stillCurrent.ino
        ) {
          try {
            await unlink(prior);
          } catch {
            // An undeletable claim preserves the prior identity without altering the canonical path.
          }
          throw new TrustedInstallError(
            "install_conflict",
            "skill-lock.json changed during its no-clobber commit.",
          );
        }
        // Atomic replacement keeps the canonical lock path present across process crashes.
        await rename(temporary, path);
        try {
          await unlink(prior);
        } catch {
          // The committed lock is authoritative; an undeletable prior link is harmless evidence.
        }
      } else {
        try {
          await link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new TrustedInstallError(
              "install_conflict",
              "skill-lock.json appeared while releases were being installed.",
            );
          }
          throw error;
        }
        await unlink(temporary);
      }
    }
    let rootHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      rootHandle = await open(projectRoot, constants.O_RDONLY);
      await rootHandle.sync();
    } catch {
      // Some supported filesystems do not permit syncing directory descriptors.
    } finally {
      try {
        await rootHandle?.close();
      } catch {
        // A committed lock remains authoritative if closing its directory descriptor fails.
      }
    }
    return path;
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Preserve the primary write failure.
    }
    try {
      const temporaryHandle = await open(temporary, constants.O_WRONLY);
      await temporaryHandle.close();
      await unlink(temporary);
    } catch {
      // The temporary path was already renamed or never created.
    }
    if (error instanceof TrustedInstallError) throw error;
    throw new TrustedInstallError("install_failed", "skill-lock.json could not be committed.", {
      cause: error,
    });
  }
}
