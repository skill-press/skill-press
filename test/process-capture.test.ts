import { describe, expect, it } from "vitest";

import { runCapturedCommand } from "../src/process/capture.js";

describe("bounded captured command runner", () => {
  it("captures bounded output and an explicit minimal environment without a shell", async () => {
    const result = await runCapturedCommand({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(process.argv[1]);process.stderr.write(process.env.TESSL_TOKEN ?? 'missing')",
        "; touch SHOULD-NOT-EXIST",
      ],
      cwd: process.cwd(),
      timeoutSeconds: 2,
      env: { TESSL_TOKEN: "provider-token" },
    });

    expect(result).toMatchObject({ status: "passed", exitCode: 0, signal: null });
    expect(result.stdout.toString()).toBe("; touch SHOULD-NOT-EXIST");
    expect(result.stderr.toString()).toBe("provider-token");
    expect(result.stdoutBytes).toBe(result.stdout.byteLength);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("classifies nonzero exit, spawn failure, timeout, and combined output overflow", async () => {
    await expect(
      runCapturedCommand({
        argv: [process.execPath, "-e", "process.exit(7)"],
        cwd: process.cwd(),
        timeoutSeconds: 2,
      }),
    ).resolves.toMatchObject({ status: "failed", exitCode: 7 });
    await expect(
      runCapturedCommand({
        argv: ["missing-skillpress-capture-command"],
        cwd: process.cwd(),
        timeoutSeconds: 2,
      }),
    ).resolves.toMatchObject({ status: "spawn_error" });
    await expect(
      runCapturedCommand({
        argv: ["bad\u0000command"],
        cwd: process.cwd(),
        timeoutSeconds: 2,
      }),
    ).resolves.toMatchObject({ status: "spawn_error" });
    await expect(
      runCapturedCommand({
        argv: [process.execPath, "-e", "setInterval(() => undefined, 1000)"],
        cwd: process.cwd(),
        timeoutSeconds: 1,
      }),
    ).resolves.toMatchObject({ status: "timed_out" });
    const overflow = await runCapturedCommand({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.alloc(800,97));process.stderr.write(Buffer.alloc(800,98))",
      ],
      cwd: process.cwd(),
      timeoutSeconds: 2,
      maxOutputBytes: 1024,
    });
    expect(overflow.status).toBe("output_limit");
    expect(overflow.stdout.byteLength + overflow.stderr.byteLength).toBeLessThanOrEqual(1024);

    const stderrOverflow = await runCapturedCommand({
      argv: [process.execPath, "-e", "process.stderr.write(Buffer.alloc(2048,98))"],
      cwd: process.cwd(),
      timeoutSeconds: 2,
      maxOutputBytes: 1024,
    });
    expect(stderrOverflow.status).toBe("output_limit");
  });

  it("rejects unsafe resource limits", async () => {
    await expect(
      runCapturedCommand({
        argv: [process.execPath],
        cwd: process.cwd(),
        timeoutSeconds: 0,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      runCapturedCommand({
        argv: [process.execPath],
        cwd: process.cwd(),
        timeoutSeconds: 7201,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      runCapturedCommand({
        argv: [process.execPath],
        cwd: process.cwd(),
        timeoutSeconds: 1,
        maxOutputBytes: Number.NaN,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      runCapturedCommand({
        argv: [process.execPath],
        cwd: process.cwd(),
        timeoutSeconds: 1,
        maxOutputBytes: 1000,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      runCapturedCommand({
        argv: [process.execPath],
        cwd: process.cwd(),
        timeoutSeconds: 1,
        maxOutputBytes: 17 * 1024 * 1024,
      }),
    ).rejects.toThrow(TypeError);
  });
});
