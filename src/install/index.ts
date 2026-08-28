import { canonicalProjectRoot, prepareAtomicInstallation } from "./atomic.js";
import { createCanonicalInstallClient, type VerifiedSkillRelease } from "./client.js";
import { TrustedInstallError } from "./errors.js";
import { assertGitLocalInstallPolicy, createGitPolicyBudget } from "./git-policy.js";
import { parseExactSkillLocator } from "./locator.js";
import {
  acquireSkillMutationLock,
  readSkillLockSnapshot,
  withSkillLockEntry,
  writeSkillLock,
} from "./lock.js";
import type {
  SkillLockEntry,
  SkillPressLockfile,
  TrustedAddOptions,
  TrustedInstallOptions,
  TrustedInstallResult,
} from "./types.js";
import { parseStoredSkillArchive } from "./zip.js";

const MAX_LOCKED_ARTIFACT_BYTES = 512 * 1024 * 1024;

function entryFromRelease(release: VerifiedSkillRelease): SkillLockEntry {
  return Object.freeze({
    ...release.locator,
    artifact: Object.freeze({
      sha256: release.release.artifact.sha256,
      bytes: release.release.artifact.bytes,
    }),
    attestation: Object.freeze({
      sha256: release.release.attestation.sha256,
      keyId: release.attestation.envelope.keyId,
    }),
    trust: Object.freeze({
      sequence: release.trust.statement.sequence,
      status: "trusted" as const,
      keyId: release.trust.envelope.keyId,
      sha256: release.trust.envelopeSha256,
      updatedAt: release.trust.statement.updatedAt,
    }),
    installedPath: `.agents/skills/${release.locator.skill}`,
  });
}

function lockChanged(left: SkillPressLockfile, right: SkillPressLockfile): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

/** Resolve, verify, lock, and atomically add one exact Skill Press release. */
export async function addTrustedSkill(options: TrustedAddOptions): Promise<TrustedInstallResult> {
  const locator = parseExactSkillLocator(options.locator);
  const projectRoot = await canonicalProjectRoot(options.projectRoot);
  const gitPolicyBudget = createGitPolicyBudget();
  // Run before creating even the transient mutation lock, and again under that lock below.
  await assertGitLocalInstallPolicy(projectRoot, [locator.skill], gitPolicyBudget);
  const releaseMutationLock = await acquireSkillMutationLock(projectRoot);
  try {
    const lockSnapshot = await readSkillLockSnapshot(projectRoot);
    const originalLock = lockSnapshot.lock;
    const related = originalLock.skills.find(
      (entry) =>
        entry.installedPath === `.agents/skills/${locator.skill}` ||
        (entry.namespace === locator.namespace && entry.skill === locator.skill),
    );
    if (related !== undefined && related.locator !== locator.locator) {
      throw new TrustedInstallError(
        "install_conflict",
        `${locator.skill} is already locked to a conflicting release or namespace.`,
      );
    }
    await assertGitLocalInstallPolicy(projectRoot, [locator.skill], gitPolicyBudget);
    const client = createCanonicalInstallClient(options);
    const release = await client.resolve(options.locator, related?.trust.sequence ?? 0);
    const archive = parseStoredSkillArchive(release.artifactBytes, locator.skill);
    const entry = entryFromRelease(release);
    const nextLock = withSkillLockEntry(originalLock, entry);
    const prepared = await prepareAtomicInstallation(projectRoot, locator.skill, archive);
    let committed: Awaited<ReturnType<typeof prepared.commit>> | undefined;
    try {
      const shouldWrite = lockChanged(originalLock, nextLock);
      const lockPath = shouldWrite
        ? await writeSkillLock(projectRoot, nextLock, lockSnapshot.revision)
        : `${projectRoot}/skill-lock.json`;
      // Persist the trust floor before SKILL.md can become agent-visible. A crash may leave a
      // locked-but-absent target, which `install` can safely rehydrate; never the inverse.
      const checkpoint = await client.verifyCurrentTrust(release);
      client.assertCurrentTrustFresh(checkpoint);
      committed = await prepared.commit(
        // Git can change independently of the skpress mutation lock. Recheck it at the publication
        // gate; atomic commit then revalidates the pending tree before the final time check.
        () => assertGitLocalInstallPolicy(projectRoot, [locator.skill], gitPolicyBudget),
        () => client.assertCurrentTrustFresh(checkpoint),
      );
      return Object.freeze({
        entry,
        lockPath,
        installedPath: committed.targetPath,
        changed: committed.changed || shouldWrite,
      });
    } catch (error) {
      await prepared.abort();
      await committed?.rollback();
      throw error;
    }
  } finally {
    await releaseMutationLock();
  }
}

/** Rehydrate every exact lock entry after rechecking current signed trust and immutable bytes. */
export async function installTrustedSkills(
  options: TrustedInstallOptions = {},
): Promise<readonly TrustedInstallResult[]> {
  const projectRoot = await canonicalProjectRoot(options.projectRoot);
  const gitPolicyBudget = createGitPolicyBudget();
  // A rejected Git-local policy must not create even the transient project mutation lock.
  const preflightLock = await readSkillLockSnapshot(projectRoot);
  if (preflightLock.lock.skills.length === 0) return Object.freeze([]);
  await assertGitLocalInstallPolicy(
    projectRoot,
    preflightLock.lock.skills.map((entry) => entry.skill),
    gitPolicyBudget,
  );
  const releaseMutationLock = await acquireSkillMutationLock(projectRoot);
  try {
    const lockSnapshot = await readSkillLockSnapshot(projectRoot);
    const originalLock = lockSnapshot.lock;
    if (originalLock.skills.length === 0) return Object.freeze([]);
    await assertGitLocalInstallPolicy(
      projectRoot,
      originalLock.skills.map((entry) => entry.skill),
      gitPolicyBudget,
    );
    const aggregateBytes = originalLock.skills.reduce(
      (total, entry) => total + entry.artifact.bytes,
      0,
    );
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > MAX_LOCKED_ARTIFACT_BYTES) {
      throw new TrustedInstallError(
        "lock_invalid",
        "skill-lock.json exceeds the aggregate installation byte budget.",
      );
    }
    const client = createCanonicalInstallClient(options);
    const entries: SkillLockEntry[] = [];
    const committed = [] as Awaited<
      ReturnType<Awaited<ReturnType<typeof prepareAtomicInstallation>>["commit"]>
    >[];
    let nextLock = originalLock;
    let persistedLock = originalLock;
    let expectedRevision = lockSnapshot.revision;
    let lockWasWritten = false;
    try {
      // Resolve through commit one entry at a time so trust is fresh and only one artifact is held.
      for (const locked of originalLock.skills) {
        const release = await client.resolve(locked.locator, locked.trust.sequence);
        if (
          release.release.artifact.sha256 !== locked.artifact.sha256 ||
          release.release.artifact.bytes !== locked.artifact.bytes ||
          release.release.attestation.sha256 !== locked.attestation.sha256 ||
          release.attestation.envelope.keyId !== locked.attestation.keyId
        ) {
          throw new TrustedInstallError(
            "lock_invalid",
            `The immutable release for ${locked.locator} no longer matches skill-lock.json.`,
          );
        }
        if (
          release.trust.statement.sequence === locked.trust.sequence &&
          (release.trust.envelope.keyId !== locked.trust.keyId ||
            release.trust.envelopeSha256 !== locked.trust.sha256 ||
            release.trust.statement.updatedAt !== locked.trust.updatedAt)
        ) {
          throw new TrustedInstallError(
            "lock_rollback",
            `The signed trust envelope for ${locked.locator} changed without advancing sequence.`,
          );
        }
        const archive = parseStoredSkillArchive(release.artifactBytes, locked.skill);
        const entry = entryFromRelease(release);
        nextLock = withSkillLockEntry(nextLock, entry);
        const prepared = await prepareAtomicInstallation(projectRoot, locked.skill, archive);
        let installed: Awaited<ReturnType<typeof prepared.commit>>;
        try {
          if (lockChanged(persistedLock, nextLock)) {
            await writeSkillLock(projectRoot, nextLock, expectedRevision);
            const persisted = await readSkillLockSnapshot(projectRoot);
            if (lockChanged(persisted.lock, nextLock)) {
              throw new TrustedInstallError(
                "install_conflict",
                "skill-lock.json changed after its trust floor was persisted.",
              );
            }
            persistedLock = persisted.lock;
            expectedRevision = persisted.revision;
            lockWasWritten = true;
          }
          // Checkpoint is the last network operation, after the per-entry floor fsync and before
          // activation. A later failure never rolls the observed higher sequence backwards.
          const checkpoint = await client.verifyCurrentTrust(release);
          client.assertCurrentTrustFresh(checkpoint);
          installed = await prepared.commit(
            () => assertGitLocalInstallPolicy(projectRoot, [locked.skill], gitPolicyBudget),
            () => client.assertCurrentTrustFresh(checkpoint),
          );
        } catch (error) {
          await prepared.abort();
          throw error;
        }
        committed.push(installed);
        entries.push(entry);
      }
      const lockPath = `${projectRoot}/skill-lock.json`;
      return Object.freeze(
        entries.map((entry, index) => {
          // `entries` and `committed` are appended together in the same successful loop body.
          const installed = committed[index] as (typeof committed)[number];
          return Object.freeze({
            entry,
            lockPath,
            installedPath: installed.targetPath,
            changed: installed.changed || lockWasWritten,
          });
        }),
      );
    } catch (error) {
      for (const item of [...committed].reverse()) await item.rollback();
      throw error;
    }
  } finally {
    await releaseMutationLock();
  }
}

export type {
  CanonicalInstallClient,
  CanonicalInstallClientOptions,
  VerifiedCurrentTrustCheckpoint,
  VerifiedSkillRelease,
} from "./client.js";
export { createCanonicalInstallClient } from "./client.js";
export { TrustedInstallError } from "./errors.js";
export { parseExactSkillLocator } from "./locator.js";
export { readSkillLock } from "./lock.js";
export { SKILL_PRESS_PINNED_KEYS } from "./signatures.js";
export type {
  ExactSkillLocator,
  SkillLockEntry,
  SkillPressCurrentTrustCheckpoint,
  SkillPressLockfile,
  SkillPressP256PublicJwk,
  SkillPressPinnedKey,
  SkillPressReleaseAttestation,
  SkillPressReleaseResource,
  SkillPressSigningKeyRole,
  SkillPressSignedEnvelope,
  SkillPressTrustStatement,
  SkillPressTrustStatus,
  TrustedAddOptions,
  TrustedInstallOptions,
  TrustedInstallResult,
} from "./types.js";
export { parseStoredSkillArchive } from "./zip.js";
