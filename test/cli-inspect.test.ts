import { describe, expect, it, vi } from "vitest";

import { runDoctorCommand, runStatusCommand } from "../src/cli/inspect.js";
import { ProjectConfigError } from "../src/config/errors.js";
import type { DoctorReport } from "../src/doctor/project.js";
import type { ProjectStatusReport } from "../src/status/project.js";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

function status(ready: boolean): ProjectStatusReport {
  return {
    schemaVersion: 1,
    statusType: "skillpress.status",
    evaluatedAt: "2026-08-24T12:00:00.000Z",
    ready,
    local: { eligible: ready, score: ready ? 100 : 40, minimum: 90 },
    gate: null,
    package: null,
    publication: null,
    issues: ready
      ? []
      : [{ code: "status.evidence.missing", path: "/gate", message: "evidence is missing" }],
  };
}

function doctor(ready: boolean): DoctorReport {
  return {
    schemaVersion: 1,
    reportType: "skillpress.doctor",
    ready,
    gate: null,
    checks: [
      {
        id: "evidence.tessl",
        status: ready ? "pass" : "error",
        message: ready ? "evidence passes" : "evidence is missing",
      },
    ],
  };
}

function operations() {
  return {
    status: vi.fn(async () => status(true)),
    doctor: vi.fn(async () => doctor(true)),
  } satisfies NonNullable<Parameters<typeof runStatusCommand>[2]>;
}

describe("inspection CLI orchestration", () => {
  it("requires Tessl evidence arguments as an all-or-none set", async () => {
    const output = capture();
    await expect(
      runStatusCommand(["--review-evidence", "review.json", "--json"], output.io),
    ).resolves.toBe(2);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "usage",
      issues: [{ code: "cli.usage" }],
    });
  });

  it("requires artifacts when a receipt binding is requested", async () => {
    const output = capture();
    await expect(
      runStatusCommand(
        ["--receipt", `.skillpress/publications/${"1".repeat(64)}/receipt.json`],
        output.io,
      ),
    ).resolves.toBe(2);
    expect(output.stderr.join("")).toContain("--receipt requires --artifacts");
  });

  it("passes exact optional package and receipt paths to read-only status", async () => {
    const ops = operations();
    const output = capture();
    const artifacts = `.skillpress/staging/${"1".repeat(64)}/artifacts`;
    const receipt = `.skillpress/publications/${"2".repeat(64)}/receipt.json`;
    const review = `.skillpress/tessl/${"3".repeat(64)}/evidence.json`;
    const evaluation = `.skillpress/tessl/${"4".repeat(64)}/evidence.json`;

    await expect(
      runStatusCommand(
        [
          "--project",
          ".",
          "--review-evidence",
          review,
          "--eval-evidence",
          evaluation,
          "--eval-source",
          "tessl-evals",
          "--artifacts",
          artifacts,
          "--receipt",
          receipt,
          "--json",
        ],
        output.io,
        ops,
      ),
    ).resolves.toBe(0);
    expect(ops.status).toHaveBeenCalledWith(".", {
      evidence: {
        reviewEvidencePath: review,
        evalEvidencePath: evaluation,
        evalSource: "tessl-evals",
      },
      artifactsPath: artifacts,
      receiptPath: receipt,
    });
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      command: "status",
      ok: true,
      statusType: "skillpress.status",
    });
  });

  it("uses exit 3 for a complete blocked status or doctor report", async () => {
    const ops = operations();
    ops.status.mockResolvedValue(status(false));
    ops.doctor.mockResolvedValue(doctor(false));
    const statusOutput = capture();
    const doctorOutput = capture();

    await expect(runStatusCommand(["--json"], statusOutput.io, ops)).resolves.toBe(3);
    await expect(runDoctorCommand(["--json"], doctorOutput.io, ops)).resolves.toBe(3);
    expect(JSON.parse(statusOutput.stdout[0] as string)).toMatchObject({
      command: "status",
      ok: false,
    });
    expect(JSON.parse(doctorOutput.stdout[0] as string)).toMatchObject({
      command: "doctor",
      ok: false,
    });
  });

  it("does not reflect hostile unknown options and treats output failure as internal", async () => {
    const hostile = capture();
    await expect(runDoctorCommand(["FORGED\u001b[31m"], hostile.io)).resolves.toBe(2);
    expect(hostile.stderr.join("")).not.toContain("FORGED");

    const ops = operations();
    await expect(
      runStatusCommand(
        [],
        { stdout: () => Promise.reject(new Error("sink")), stderr: () => {} },
        ops,
      ),
    ).resolves.toBe(1);
  });

  it.each([
    ["duplicate json", ["--json", "--json"]],
    ["duplicate value", ["--project", ".", "--project", "."]],
    ["missing value", ["--project"]],
    ["option-like value", ["--project", "--json"]],
    ["unsafe path", ["--project", "bad\0path"]],
  ])("rejects %s for status", async (_name, args) => {
    const output = capture();
    await expect(runStatusCommand(args, output.io)).resolves.toBe(2);
    expect(output.stderr.join("")).toContain("cli.usage");
  });

  it("passes every optional doctor input and renders a ready human report", async () => {
    const ops = operations();
    const output = capture();
    const review = `.skillpress/tessl/${"3".repeat(64)}/evidence.json`;
    const evaluation = `.skillpress/tessl/${"4".repeat(64)}/evidence.json`;
    await expect(
      runDoctorCommand(
        [
          "--project",
          ".",
          "--review-evidence",
          review,
          "--eval-evidence",
          evaluation,
          "--eval-source",
          "tessl-evals",
          "--tessl-executable",
          "/opt/tessl",
          "--askill-executable",
          "/opt/askill",
          "--clawhub-executable",
          "/opt/clawhub",
        ],
        output.io,
        ops,
      ),
    ).resolves.toBe(0);
    expect(ops.doctor).toHaveBeenCalledWith(".", {
      evidence: {
        reviewEvidencePath: review,
        evalEvidencePath: evaluation,
        evalSource: "tessl-evals",
      },
      tesslExecutable: "/opt/tessl",
      askillExecutable: "/opt/askill",
      clawHubExecutable: "/opt/clawhub",
    });
    expect(output.stdout.join("")).toContain("Doctor: ready");
  });

  it("renders package, publication, gate, URL, and issue details in human status", async () => {
    const ops = operations();
    ops.status.mockResolvedValue({
      ...status(false),
      gate: {
        schemaVersion: 1,
        gateType: "skillpress.tessl-release",
        evaluatedAt: "2026-08-24T12:00:00.000Z",
        sourceCommit: "1".repeat(40),
        passed: false,
        thresholds: { quality: 90, impact: 90, maxAgeHours: 168 },
        scores: { quality: null, impact: null },
        evidence: { reviewPath: "review", evalPath: "eval" },
        issues: [],
      },
      package: {
        artifactsPath: "artifacts",
        sourceCommit: "1".repeat(40),
        artifactSha256: "2".repeat(64),
      },
      publication: {
        receiptPath: "receipt",
        status: "blocked",
        sourceCommit: "1".repeat(40),
        artifactSha256: "2".repeat(64),
        targets: [
          {
            id: "github",
            status: "preflight_failed",
            preflightOk: false,
            url: "https://example.invalid",
          },
        ],
      },
    });
    const output = capture();
    await expect(runStatusCommand([], output.io, ops)).resolves.toBe(3);
    expect(output.stdout.join("")).toContain("Tessl gate: blocked");
    expect(output.stdout.join("")).toContain("Publication: blocked");
    expect(output.stdout.join("")).toContain("evidence is missing");
  });

  it.each(["status", "doctor"])("maps known, storage, and unknown %s failures", async (command) => {
    const run = command === "status" ? runStatusCommand : runDoctorCommand;
    for (const error of [
      new ProjectConfigError("invalid", [{ code: "config", path: "/", message: "bad" }]),
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    ]) {
      const ops = operations();
      (command === "status" ? ops.status : ops.doctor).mockRejectedValue(error);
      const output = capture();
      await expect(run(["--json"], output.io, ops)).resolves.toBe(3);
      expect(JSON.parse(output.stderr[0] as string).ok).toBe(false);
    }
    const ops = operations();
    (command === "status" ? ops.status : ops.doctor).mockRejectedValue(new Error("secret"));
    const output = capture();
    await expect(run([], output.io, ops)).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("failed unexpectedly");
    expect(output.stderr.join("")).not.toContain("secret");
  });

  it("returns internal failure when doctor stdout or usage stderr is closed", async () => {
    const ops = operations();
    await expect(
      runDoctorCommand(
        [],
        { stdout: () => Promise.reject(new Error("closed")), stderr: () => {} },
        ops,
      ),
    ).resolves.toBe(1);
    await expect(
      runDoctorCommand(
        ["--unknown"],
        { stdout: () => {}, stderr: () => Promise.reject(new Error("closed")) },
        ops,
      ),
    ).resolves.toBe(1);
  });
});
