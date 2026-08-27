import { realpathSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SkillPressSubmissionReceipt } from "../src/submission/generated-receipt.js";
import {
  createSubmissionStorage,
  persistSubmissionReceipt,
  readSubmissionReceipt,
  submissionReceiptExists,
  SubmissionJournalError,
  submissionReceiptPath,
} from "../src/submission/journal.js";

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(temporaryRoot, "skill-press-submission-journal-"));
  temporaryDirectories.push(root);
  return root;
}

function receipt(
  idempotencyKey: string,
  overrides: Partial<SkillPressSubmissionReceipt> = {},
): SkillPressSubmissionReceipt {
  const timestamp = "2026-08-27T12:00:00.000Z";
  return {
    schemaVersion: 1,
    receiptType: "skillpress.submission",
    runId: "1".repeat(64),
    idempotencyKey,
    registry: { origin: "https://skill-press.com", protocolVersion: 1, namespace: "example" },
    bindings: {
      sourceCommit: "2".repeat(40),
      projectVersion: "1.2.3",
      skillName: "example-skill",
      projectConfigSha256: "3".repeat(64),
      skillSha256: "4".repeat(64),
      artifactSha256: "5".repeat(64),
      provenanceSha256: "6".repeat(64),
      checksumsSha256: "7".repeat(64),
      manifestSha256: "8".repeat(64),
      reviewEvidenceSha256: "9".repeat(64),
      evalEvidenceSha256: "a".repeat(64),
      evalSourceSha256: "b".repeat(64),
    },
    dryRun: false,
    operationStatus: "submitting",
    request: { status: "pending", attempts: 0 },
    remote: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    storagePath: submissionReceiptPath(idempotencyKey),
    ...overrides,
  };
}

type ReceiptRelease = NonNullable<NonNullable<SkillPressSubmissionReceipt["remote"]>["release"]>;

function publishedReceipt(
  idempotencyKey: string,
  releaseOverrides: Partial<ReceiptRelease> = {},
): SkillPressSubmissionReceipt {
  const timestamp = "2026-08-27T12:00:00.000Z";
  return receipt(idempotencyKey, {
    operationStatus: "submitted",
    request: { status: "completed", attempts: 1 },
    remote: {
      id: "submission_12345678",
      namespace: "example",
      url: "https://skill-press.com/submissions/submission_12345678",
      status: "published",
      statusVersion: 7,
      observedAt: timestamp,
      release: {
        locator: "example/example-skill@1.2.3",
        version: "1.2.3",
        artifactSha256: "5".repeat(64),
        canonicalUrl: "https://skill-press.com/skills/example/example-skill/1.2.3",
        attestationUrl: "https://skill-press.com/attestations/example/example-skill/1.2.3",
        trust: { status: "trusted", sequence: 1, updatedAt: timestamp },
        ...releaseOverrides,
      },
    },
  });
}

describe("private submission journal", () => {
  it("atomically replaces one private receipt and leaves no temporary inventory", async () => {
    const root = await project();
    const key = "c".repeat(64);
    const path = await createSubmissionStorage(root, key);
    const initial = receipt(key);
    await persistSubmissionReceipt(root, initial);
    const failed = receipt(key, {
      operationStatus: "failed",
      request: { status: "pending", attempts: 1 },
      errorCode: "registry_unavailable",
      updatedAt: "2026-08-27T12:01:00.000Z",
    });
    await persistSubmissionReceipt(root, failed);

    const stored = await readSubmissionReceipt(root, path);
    expect(stored).toEqual(failed);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.bindings)).toBe(true);
    expect(await readdir(join(root, path, ".."))).toEqual(["receipt.json"]);
    if (process.platform !== "win32") {
      expect((await lstat(join(root, ".skill-press"))).mode & 0o777).toBe(0o700);
      expect((await lstat(join(root, path))).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects dry-run persistence and incoherent submitted receipts", async () => {
    const root = await project();
    const key = "d".repeat(64);
    await createSubmissionStorage(root, key);
    const dryRun = receipt(key, {
      dryRun: true,
      operationStatus: "prepared",
      storagePath: null,
    });
    await expect(persistSubmissionReceipt(root, dryRun)).rejects.toBeInstanceOf(
      SubmissionJournalError,
    );
    await expect(
      persistSubmissionReceipt(root, receipt(key, { operationStatus: "submitted" })),
    ).rejects.toBeInstanceOf(SubmissionJournalError);
    await expect(
      persistSubmissionReceipt(
        root,
        receipt(key, {
          operationStatus: "submitting",
          request: { status: "completed", attempts: 1 },
        }),
      ),
    ).rejects.toBeInstanceOf(SubmissionJournalError);
  });

  it("binds cached releases to the exact skill, version, artifact, and canonical URLs", async () => {
    const root = await project();
    const key = "7".repeat(64);
    await createSubmissionStorage(root, key);
    const valid = publishedReceipt(key);
    await persistSubmissionReceipt(root, valid);
    await expect(readSubmissionReceipt(root, valid.storagePath as string)).resolves.toEqual(valid);

    const invalidReleases = [
      {
        locator: "example/other-skill@1.2.3",
        canonicalUrl: "https://skill-press.com/skills/example/other-skill/1.2.3",
        attestationUrl: "https://skill-press.com/attestations/example/other-skill/1.2.3",
      },
      {
        locator: "example/example-skill@1.2.4",
        version: "1.2.4",
        canonicalUrl: "https://skill-press.com/skills/example/example-skill/1.2.4",
        attestationUrl: "https://skill-press.com/attestations/example/example-skill/1.2.4",
      },
      { artifactSha256: "f".repeat(64) },
      { canonicalUrl: "https://skill-press.com/skills/example/other-skill/1.2.3" },
      { attestationUrl: "https://skill-press.com/attestations/example/other-skill/1.2.3" },
    ] satisfies readonly Partial<ReceiptRelease>[];

    for (const release of invalidReleases) {
      await expect(
        persistSubmissionReceipt(root, publishedReceipt(key, release)),
      ).rejects.toBeInstanceOf(SubmissionJournalError);
    }
  });

  it("validates journal keys, existence, paths, and private parent storage", async () => {
    expect(() => submissionReceiptPath("not-a-digest")).toThrowError(SubmissionJournalError);

    const root = await project();
    const key = "a".repeat(64);
    await expect(submissionReceiptExists(root, key)).resolves.toBe(false);
    const relative = await createSubmissionStorage(root, key);
    await expect(submissionReceiptExists(root, key)).resolves.toBe(false);
    await persistSubmissionReceipt(root, receipt(key));
    await expect(submissionReceiptExists(root, key)).resolves.toBe(true);
    await expect(readSubmissionReceipt(root, "receipt.json")).rejects.toBeInstanceOf(
      SubmissionJournalError,
    );

    if (process.platform !== "win32") {
      const submissions = join(root, ".skill-press", "submissions");
      await chmod(submissions, 0o755);
      await expect(readSubmissionReceipt(root, relative)).rejects.toBeInstanceOf(
        SubmissionJournalError,
      );
      await chmod(submissions, 0o700);
    }

    const unsafeRoot = await project();
    await writeFile(join(unsafeRoot, ".skill-press"), "not a directory\n", { mode: 0o600 });
    await expect(createSubmissionStorage(unsafeRoot, key)).rejects.toBeInstanceOf(
      SubmissionJournalError,
    );
    await expect(
      createSubmissionStorage(join(root, "missing", "project"), key),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects corrupted path bindings, malformed JSON, and permissive receipt files", async () => {
    const root = await project();
    const key = "e".repeat(64);
    const relative = await createSubmissionStorage(root, key);
    await persistSubmissionReceipt(root, receipt(key));
    const absolute = join(root, relative);
    const original = await readFile(absolute, "utf8");
    const forged = JSON.parse(original) as SkillPressSubmissionReceipt;
    forged.idempotencyKey = "f".repeat(64);
    forged.storagePath = submissionReceiptPath(forged.idempotencyKey);
    await writeFile(absolute, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
    await expect(readSubmissionReceipt(root, relative)).rejects.toBeInstanceOf(
      SubmissionJournalError,
    );

    await writeFile(absolute, "not-json\n", { mode: 0o600 });
    await expect(readSubmissionReceipt(root, relative)).rejects.toBeInstanceOf(
      SubmissionJournalError,
    );

    if (process.platform !== "win32") {
      await writeFile(absolute, original, { mode: 0o600 });
      await chmod(absolute, 0o644);
      await expect(readSubmissionReceipt(root, relative)).rejects.toBeInstanceOf(
        SubmissionJournalError,
      );
    }
  });
});
