import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  mode: "normal",
  count: 0,
  directoryPath: "",
  directoryCloseCount: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const error = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;
  const changed = <Value extends object>(value: Value, property: "ctimeMs" | "ino"): Value =>
    new Proxy(value, {
      get(target, key) {
        const current = Reflect.get(target, key, target) as unknown;
        if (key === property)
          return typeof current === "bigint" ? current + 1n : Number(current) + 1;
        return typeof current === "function" ? current.bind(target) : current;
      },
    });
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0]);
      if (fault.mode === "stale-lstat-fail" && path.endsWith(".skill-lock.json.lock")) {
        throw error("EACCES");
      }
      if (fault.mode === "revision-lstat-fail" && path.endsWith("skill-lock.json")) {
        throw error("EACCES");
      }
      const result = await actual.lstat(...args);
      if (
        (fault.mode === "read-changed" || fault.mode === "revision-changed") &&
        path.endsWith("skill-lock.json")
      ) {
        fault.count += 1;
        if (fault.count === 2) return changed(result, "ctimeMs");
      }
      if (fault.mode === "stale-moved-mismatch" && path.includes(".stale-")) {
        return changed(result, "ino");
      }
      if (fault.mode === "claim-mismatch" && path.endsWith(".previous")) {
        return changed(result, "ino");
      }
      return result;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fault.mode === "stale-rename-fail" && String(args[1]).includes(".stale-")) {
        throw error("EACCES");
      }
      return actual.rename(...args);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      const destination = String(args[1]);
      if (fault.mode === "claim-link-fail" && destination.endsWith(".previous")) {
        throw error("EACCES");
      }
      if (fault.mode === "publish-link-fail" && destination.endsWith("skill-lock.json")) {
        throw error("EACCES");
      }
      return actual.link(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (fault.mode === "directory-sync-fail" && String(args[0]) === fault.directoryPath) {
        return new Proxy(handle, {
          get(target, key) {
            if (key === "sync") return async () => Promise.reject(error("EINVAL"));
            if (key === "close") {
              return async () => {
                fault.directoryCloseCount += 1;
                await target.close();
              };
            }
            const current = Reflect.get(target, key, target) as unknown;
            return typeof current === "function" ? current.bind(target) : current;
          },
        });
      }
      if (
        fault.mode !== "acquire-write-fail" ||
        !String(args[0]).endsWith(".skill-lock.json.lock")
      ) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, key) {
          if (key === "writeFile") return async () => Promise.reject(error("EIO"));
          const current = Reflect.get(target, key, target) as unknown;
          return typeof current === "function" ? current.bind(target) : current;
        },
      });
    },
  };
});

const { acquireSkillMutationLock, readSkillLock, readSkillLockSnapshot, writeSkillLock } =
  await import("../src/install/lock.js");

const temporaryPaths: string[] = [];

afterEach(async () => {
  fault.mode = "normal";
  fault.count = 0;
  fault.directoryPath = "";
  fault.directoryCloseCount = 0;
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryProject(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "skillpress-lock-fault-test-"));
  temporaryPaths.push(path);
  return path;
}

describe("trusted install lock filesystem faults", () => {
  it("rejects a lock that changes during its stable read", async () => {
    const root = await temporaryProject();
    const empty = await readSkillLock(root);
    await writeSkillLock(root, empty);
    fault.mode = "read-changed";
    await expect(readSkillLock(root)).rejects.toMatchObject({ code: "lock_invalid" });
  });

  it.each(["stale-lstat-fail", "stale-rename-fail", "stale-moved-mismatch"])(
    "fails closed while reclaiming a dead lock: %s",
    async (mode) => {
      const root = await temporaryProject();
      const lockPath = join(root, ".skill-lock.json.lock");
      await writeFile(lockPath, "999999999 12345678-1234-4123-8123-123456789abc\n");
      fault.mode = mode;
      await expect(acquireSkillMutationLock(root)).rejects.toMatchObject({
        code: "install_conflict",
      });
      await expect(readFile(lockPath, "utf8")).resolves.toContain("999999999");
    },
  );

  it("removes only its own partially acquired mutation lock after a write fault", async () => {
    const root = await temporaryProject();
    fault.mode = "acquire-write-fail";
    await expect(acquireSkillMutationLock(root)).rejects.toMatchObject({ code: "install_failed" });
    await expect(readFile(join(root, ".skill-lock.json.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["revision-lstat-fail", "revision-changed"])(
    "rejects an unsafe current lock revision: %s",
    async (mode) => {
      const root = await temporaryProject();
      const empty = await readSkillLock(root);
      await writeSkillLock(root, empty);
      const snapshot = await readSkillLockSnapshot(root);
      fault.mode = mode;
      await expect(writeSkillLock(root, snapshot.lock, snapshot.revision)).rejects.toMatchObject({
        code: "install_conflict",
      });
    },
  );

  it.each(["claim-link-fail", "claim-mismatch"])(
    "preserves the canonical existing lock when its CAS claim fails: %s",
    async (mode) => {
      const root = await temporaryProject();
      const empty = await readSkillLock(root);
      await writeSkillLock(root, empty);
      const before = await readFile(join(root, "skill-lock.json"));
      const snapshot = await readSkillLockSnapshot(root);
      fault.mode = mode;
      await expect(writeSkillLock(root, snapshot.lock, snapshot.revision)).rejects.toMatchObject({
        code: "install_conflict",
      });
      await expect(readFile(join(root, "skill-lock.json"))).resolves.toEqual(before);
    },
  );

  it("classifies a non-EEXIST no-clobber publication failure without creating a lock", async () => {
    const root = await temporaryProject();
    const snapshot = await readSkillLockSnapshot(root);
    fault.mode = "publish-link-fail";
    await expect(writeSkillLock(root, snapshot.lock, snapshot.revision)).rejects.toMatchObject({
      code: "install_failed",
    });
    await expect(readFile(join(root, "skill-lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes the directory descriptor when directory fsync is unsupported", async () => {
    const root = await temporaryProject();
    const empty = await readSkillLock(root);
    fault.mode = "directory-sync-fail";
    fault.directoryPath = root;
    await expect(writeSkillLock(root, empty)).resolves.toBe(join(root, "skill-lock.json"));
    expect(fault.directoryCloseCount).toBe(1);
    await expect(readFile(join(root, "skill-lock.json"))).resolves.toBeInstanceOf(Buffer);
  });
});
