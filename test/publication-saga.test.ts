import { realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import type { SkillPressProject } from "../src/config/generated.js";
import type { SkillPackageArtifacts } from "../src/package/archive.js";
import {
  type PublicationAdapter,
  PublicationSagaError,
  readPublicationReceipt,
  runPublicationSaga,
} from "../src/publish/saga.js";

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function project(targets = ["github"]): Promise<string> {
  const root = await mkdtemp(join(temporaryRoot, "skillpress-saga-"));
  temporaryDirectories.push(root);
  const source = await readFile(new URL("fixtures/config/valid.yaml", import.meta.url), "utf8");
  const config = parse(source) as SkillPressProject;
  config.publish.targets = targets as SkillPressProject["publish"]["targets"];
  await writeFile(join(root, "skillpress.yaml"), stringify(config));
  return root;
}

const artifacts: SkillPackageArtifacts & { sourceCommit: string } = {
  schemaVersion: 1,
  artifactsPath: ".skillpress/staging/x/artifacts",
  skillArchive: "example.skill",
  zipArchive: "example.zip",
  checksums: "SHA256SUMS",
  provenance: "provenance.json",
  provenanceSha256: "b".repeat(64),
  provenanceBytes: 20,
  checksumsSha256: "e".repeat(64),
  checksumsBytes: 30,
  artifactSha256: "a".repeat(64),
  artifactBytes: 10,
  sourceCommit: "c".repeat(40),
};

function adapter(
  state: { calls: string[]; fail?: string; preflight?: boolean },
  id = "github",
): PublicationAdapter {
  return {
    id,
    capability: "publish",
    auth: ["FAKE_TOKEN"],
    rollback: "remote deletion is manual",
    steps: ["create", "upload"],
    preflight: async () => ({
      ok: state.preflight !== false,
      code: state.preflight === false ? "auth_missing" : "ready",
      message: state.preflight === false ? "token missing" : "ready",
    }),
    execute: async (_context, step) => {
      state.calls.push(step);
      if (state.fail === step) throw new Error("provider secret detail");
      return { remoteId: `remote-${step}`, url: `https://example.invalid/${step}` };
    },
    verify: async () => ({ ok: true, remoteId: "remote", url: "https://example.invalid/item" }),
  };
}

describe("publication saga", () => {
  it("defaults to a non-mutating dry run with explicit capability and rollback", async () => {
    const root = await project();
    const state = { calls: [] as string[] };
    const receipt = await runPublicationSaga(root, artifacts, [adapter(state)]);
    expect(receipt).toMatchObject({
      execute: false,
      status: "dry_run",
      storagePath: null,
      targets: [
        { capability: "publish", status: "planned", rollback: "remote deletion is manual" },
      ],
    });
    expect(state.calls).toEqual([]);
  });

  it("journals every completed step and resumes without duplicate publication", async () => {
    const root = await project();
    const state = { calls: [] as string[], fail: "upload" };
    const failed = await runPublicationSaga(root, artifacts, [adapter(state)], { execute: true });
    expect(failed.status).toBe("failed");
    expect(state.calls).toEqual(["create", "upload"]);
    expect(failed.storagePath).toMatch(RECEIPT_PATH_FOR_TEST);
    expect((await stat(join(root, failed.storagePath as string))).mode & 0o777).toBe(0o600);
    state.fail = undefined;
    const resumed = await runPublicationSaga(root, artifacts, [adapter(state)], {
      execute: true,
      resumeReceiptPath: failed.storagePath as string,
    });
    expect(resumed.status).toBe("completed");
    expect(state.calls).toEqual(["create", "upload", "upload"]);
    expect(resumed.targets[0]?.status).toBe("verified");
    expect(JSON.stringify(resumed)).not.toContain("provider secret detail");
    const inspected = await readPublicationReceipt(root, resumed.storagePath as string);
    expect(inspected).toEqual(resumed);
    expect(Object.isFrozen(inspected.targets[0])).toBe(true);
    const receiptFile = join(root, resumed.storagePath as string);
    const mismatchedRun = JSON.parse(await readFile(receiptFile, "utf8"));
    mismatchedRun.runId = "d".repeat(64);
    await writeFile(receiptFile, `${JSON.stringify(mismatchedRun)}\n`, { mode: 0o600 });
    await expect(
      readPublicationReceipt(root, resumed.storagePath as string),
    ).rejects.toBeInstanceOf(PublicationSagaError);
  });

  it("blocks execution on preflight and records derived targets without claiming publish", async () => {
    const blockedRoot = await project();
    const blocked = await runPublicationSaga(
      blockedRoot,
      artifacts,
      [adapter({ calls: [], preflight: false })],
      { execute: true },
    );
    expect(blocked).toMatchObject({ status: "blocked", storagePath: null });

    const derivedRoot = await project(["skills-sh"]);
    const derived: PublicationAdapter = {
      id: "skills-sh",
      capability: "derived",
      auth: [],
      rollback: "no mutation",
      steps: [],
      preflight: async () => ({ ok: true, code: "ready", message: "ready" }),
      verify: async () => ({ ok: false, url: "https://example.invalid/organic" }),
    };
    const receipt = await runPublicationSaga(derivedRoot, artifacts, [derived], { execute: true });
    expect(receipt.status).toBe("completed");
    expect(receipt.targets[0]).toMatchObject({ status: "derived" });
    expect(JSON.stringify(receipt)).not.toContain("published");
  });

  it("rejects adapter, target, and resume contract mismatches", async () => {
    const root = await project();
    await expect(runPublicationSaga(root, artifacts, [])).rejects.toBeInstanceOf(
      PublicationSagaError,
    );
    const invalid = { ...adapter({ calls: [] }), id: "BAD" };
    await expect(runPublicationSaga(root, artifacts, [invalid])).rejects.toBeInstanceOf(
      PublicationSagaError,
    );
    await expect(
      runPublicationSaga(root, artifacts, [adapter({ calls: [] })], {
        resumeReceiptPath: "bad.json",
      }),
    ).rejects.toBeInstanceOf(PublicationSagaError);
    await expect(
      runPublicationSaga(root, artifacts, [adapter({ calls: [] })], {
        execute: true,
        resumeReceiptPath: "bad.json",
      }),
    ).rejects.toBeInstanceOf(PublicationSagaError);

    const derivedMutation = {
      ...adapter({ calls: [] }, "github"),
      capability: "derived" as const,
      steps: [],
    };
    await expect(runPublicationSaga(root, artifacts, [derivedMutation])).rejects.toBeInstanceOf(
      PublicationSagaError,
    );
    const noExecute = { ...adapter({ calls: [] }), execute: undefined };
    await expect(runPublicationSaga(root, artifacts, [noExecute])).rejects.toBeInstanceOf(
      PublicationSagaError,
    );
    const noSteps = { ...adapter({ calls: [] }), steps: [] };
    await expect(runPublicationSaga(root, artifacts, [noSteps])).rejects.toBeInstanceOf(
      PublicationSagaError,
    );
    const manySteps = {
      ...adapter({ calls: [] }),
      steps: Array.from({ length: 33 }, (_, i) => `s${i}`),
    };
    await expect(runPublicationSaga(root, artifacts, [manySteps])).rejects.toBeInstanceOf(
      PublicationSagaError,
    );
  });

  it("rejects unsafe or mismatched resume receipts and skips already verified targets", async () => {
    const root = await project();
    const failed = await runPublicationSaga(
      root,
      artifacts,
      [adapter({ calls: [], fail: "upload" })],
      {
        execute: true,
      },
    );
    const reblocked = await runPublicationSaga(
      root,
      artifacts,
      [adapter({ calls: [], preflight: false })],
      { execute: true, resumeReceiptPath: failed.storagePath as string },
    );
    expect(reblocked.status).toBe("blocked");
    const receiptPath = join(root, failed.storagePath as string);
    await chmod(receiptPath, 0o644);
    await expect(
      runPublicationSaga(root, artifacts, [adapter({ calls: [] })], {
        execute: true,
        resumeReceiptPath: failed.storagePath as string,
      }),
    ).rejects.toBeInstanceOf(PublicationSagaError);
    await chmod(receiptPath, 0o600);
    const saved = await readFile(receiptPath, "utf8");
    await writeFile(receiptPath, "{}\n", { mode: 0o600 });
    await expect(
      runPublicationSaga(root, artifacts, [adapter({ calls: [] })], {
        execute: true,
        resumeReceiptPath: failed.storagePath as string,
      }),
    ).rejects.toBeInstanceOf(PublicationSagaError);
    const malformed = JSON.parse(saved) as {
      targets: Array<{ capability: string; steps: Array<{ status: string }> }>;
    };
    (malformed.targets[0] as { steps: Array<{ status: string }> }).steps[0] = {
      status: "forged",
    };
    await writeFile(receiptPath, `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
    await expect(
      runPublicationSaga(root, artifacts, [adapter({ calls: [] })], {
        execute: true,
        resumeReceiptPath: failed.storagePath as string,
      }),
    ).rejects.toBeInstanceOf(PublicationSagaError);
    const mismatched = JSON.parse(saved) as {
      targets: Array<{ capability: string }>;
    };
    (mismatched.targets[0] as { capability: string }).capability = "submit";
    await writeFile(receiptPath, `${JSON.stringify(mismatched)}\n`, { mode: 0o600 });
    await expect(
      runPublicationSaga(root, artifacts, [adapter({ calls: [] })], {
        execute: true,
        resumeReceiptPath: failed.storagePath as string,
      }),
    ).rejects.toBeInstanceOf(PublicationSagaError);
    await writeFile(receiptPath, saved, { mode: 0o600 });
    await expect(
      runPublicationSaga(
        root,
        { ...artifacts, artifactSha256: "d".repeat(64) },
        [adapter({ calls: [] })],
        {
          execute: true,
          resumeReceiptPath: failed.storagePath as string,
        },
      ),
    ).rejects.toBeInstanceOf(PublicationSagaError);

    const calls: string[] = [];
    const completed = await runPublicationSaga(root, artifacts, [adapter({ calls })], {
      execute: true,
      resumeReceiptPath: failed.storagePath as string,
      now: () => new Date("2026-08-24T00:00:00.000Z"),
    });
    expect(completed.status).toBe("completed");
    calls.splice(0);
    const replay = await runPublicationSaga(root, artifacts, [adapter({ calls })], {
      execute: true,
      resumeReceiptPath: completed.storagePath as string,
    });
    expect(replay.status).toBe("completed");
    expect(calls).toEqual([]);
  });

  it("journals verification failures and derived remote identifiers", async () => {
    const root = await project();
    const failing = { ...adapter({ calls: [] }), verify: async () => ({ ok: false }) };
    const receipt = await runPublicationSaga(root, artifacts, [failing], { execute: true });
    expect(receipt).toMatchObject({ status: "failed", targets: [{ errorCode: "adapter_failed" }] });

    const derivedRoot = await project(["skills-sh"]);
    const derived: PublicationAdapter = {
      id: "skills-sh",
      capability: "derived",
      auth: [],
      rollback: "none",
      steps: [],
      preflight: async () => ({ ok: true, code: "ready", message: "ready" }),
      verify: async () => ({ ok: true, remoteId: "organic", url: "https://skills.sh/item" }),
    };
    const derivedReceipt = await runPublicationSaga(derivedRoot, artifacts, [derived], {
      execute: true,
    });
    expect(derivedReceipt.targets[0]).toMatchObject({ remoteId: "organic", status: "derived" });
  });

  it("rejects schema-valid receipts with incoherent execution and target semantics", async () => {
    const root = await project();
    const completed = await runPublicationSaga(root, artifacts, [adapter({ calls: [] })], {
      execute: true,
    });
    const path = join(root, completed.storagePath as string);
    const original = await readFile(path, "utf8");
    type MutableReceipt = {
      execute: boolean;
      status: string;
      storagePath: string | null;
      targets: Array<{
        capability: string;
        status: string;
        preflight: { ok: boolean };
        steps: Array<{ id: string; status: string }>;
      }>;
    };
    const mutations: Array<(receipt: MutableReceipt) => void> = [
      (receipt) => {
        receipt.execute = false;
      },
      (receipt) => {
        receipt.status = "dry_run";
      },
      (receipt) => {
        const target = receipt.targets[0] as MutableReceipt["targets"][number];
        target.capability = "derived";
        target.status = "running";
        target.steps = [];
        receipt.status = "running";
      },
      (receipt) => {
        const target = receipt.targets[0] as MutableReceipt["targets"][number];
        target.capability = "derived";
        target.status = "derived";
      },
      (receipt) => {
        (receipt.targets[0]?.steps[0] as { status: string }).status = "pending";
      },
      (receipt) => {
        const target = receipt.targets[0] as MutableReceipt["targets"][number];
        target.status = "preflight_failed";
      },
      (receipt) => {
        const target = receipt.targets[0] as MutableReceipt["targets"][number];
        target.status = "planned";
        target.preflight.ok = false;
        receipt.status = "running";
      },
      (receipt) => {
        (receipt.targets[0] as MutableReceipt["targets"][number]).status = "planned";
      },
      (receipt) => {
        receipt.status = "failed";
      },
      (receipt) => {
        receipt.status = "blocked";
      },
    ];
    for (const mutate of mutations) {
      const receipt = JSON.parse(original) as MutableReceipt;
      mutate(receipt);
      await writeFile(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
      await expect(
        readPublicationReceipt(root, completed.storagePath as string),
      ).rejects.toBeInstanceOf(PublicationSagaError);
    }
    await writeFile(path, "not-json\n", { mode: 0o600 });
    await expect(
      readPublicationReceipt(root, completed.storagePath as string),
    ).rejects.toBeInstanceOf(PublicationSagaError);
  });

  it.runIf(process.platform !== "win32")(
    "handles existing private storage and rejects unsafe creation",
    async () => {
      const existing = await project();
      await mkdir(join(existing, ".skillpress"), { mode: 0o700 });
      await expect(
        runPublicationSaga(existing, artifacts, [adapter({ calls: [] })], { execute: true }),
      ).resolves.toMatchObject({ status: "completed" });

      const unsafe = await project();
      await writeFile(join(unsafe, ".skillpress"), "not a directory\n");
      await expect(
        runPublicationSaga(unsafe, artifacts, [adapter({ calls: [] })], { execute: true }),
      ).rejects.toBeInstanceOf(PublicationSagaError);

      const denied = await project();
      await chmod(denied, 0o500);
      try {
        await expect(
          runPublicationSaga(denied, artifacts, [adapter({ calls: [] })], { execute: true }),
        ).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await chmod(denied, 0o700);
      }
    },
  );
});

const RECEIPT_PATH_FOR_TEST = /^\.skillpress\/publications\/[a-f0-9]{64}\/receipt\.json$/u;
