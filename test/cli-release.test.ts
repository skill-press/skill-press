import { describe, expect, it, vi } from "vitest";

import {
  createConfiguredPublicationAdapters,
  runPackageCommand,
  runPublishCommand,
} from "../src/cli/release.js";
import type { LoadedSkillPackageArtifacts } from "../src/package/archive.js";
import type { StagedCanonicalSkill } from "../src/package/stage.js";
import type { PublicationAdapter, PublicationReceipt } from "../src/publish/saga.js";
import type { TesslReleaseGateReport } from "../src/release/tessl-gate.js";

const commit = "1".repeat(40);
const digest = "2".repeat(64);
const reviewPath = `.skillpress/tessl/${"3".repeat(64)}/evidence.json`;
const evalPath = `.skillpress/tessl/${"4".repeat(64)}/evidence.json`;
const artifactsPath = `.skillpress/staging/${"5".repeat(64)}/artifacts`;

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

function gate(passed = true): TesslReleaseGateReport {
  return {
    schemaVersion: 1,
    gateType: "skillpress.tessl-release",
    evaluatedAt: "2026-08-24T12:00:00.000Z",
    sourceCommit: commit,
    passed,
    thresholds: { quality: 90, impact: 90, maxAgeHours: 168 },
    scores: { quality: passed ? 94 : 89, impact: 95 },
    evidence: { reviewPath, evalPath },
    issues: passed
      ? []
      : [
          {
            code: "release.quality.minimum",
            path: "/review/qualityScore",
            message: "official Tessl Quality must meet the configured minimum",
          },
        ],
  };
}

const staged: StagedCanonicalSkill = {
  schemaVersion: 1,
  sourceCommit: commit,
  projectConfigSha256: digest,
  skillSha256: digest,
  stagingPath: artifactsPath.slice(0, -"/artifacts".length),
  skillPath: "canonical/example",
  files: [],
};

const artifacts: LoadedSkillPackageArtifacts = {
  schemaVersion: 1,
  sourceCommit: commit,
  artifactsPath,
  skillArchive: "example-1.0.0.skill",
  zipArchive: "example-1.0.0.zip",
  checksums: "SHA256SUMS",
  provenance: "provenance.json",
  provenanceSha256: digest,
  provenanceBytes: 10,
  checksumsSha256: digest,
  checksumsBytes: 10,
  artifactSha256: digest,
  artifactBytes: 10,
};

const adapter: PublicationAdapter = {
  id: "github",
  capability: "publish",
  auth: ["GH_TOKEN"],
  rollback: "manual",
  steps: ["publish"],
  preflight: async () => ({ ok: true, code: "ready", message: "ready" }),
  execute: async () => ({}),
  verify: async () => ({ ok: true }),
};

function receipt(status: PublicationReceipt["status"], execute: boolean): PublicationReceipt {
  return {
    schemaVersion: 1,
    receiptType: "skillpress.publication",
    runId: digest,
    idempotencyKey: digest,
    sourceCommit: commit,
    artifactSha256: digest,
    projectVersion: "1.0.0",
    execute,
    status,
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
    targets: [
      {
        id: "github",
        capability: "publish",
        auth: ["GH_TOKEN"],
        rollback: "manual",
        preflight: { ok: true, code: "ready", message: "ready" },
        status: status === "completed" ? "verified" : "planned",
        steps: [{ id: "publish", status: status === "completed" ? "completed" : "pending" }],
      },
    ],
    storagePath: execute ? `.skillpress/publications/${digest}/receipt.json` : null,
  };
}

function operations() {
  return {
    checkGate: vi.fn(async () => gate()),
    stage: vi.fn(async () => staged),
    package: vi.fn(async () => artifacts),
    load: vi.fn(async () => artifacts),
    adapters: vi.fn(async () => [adapter]),
    publish: vi.fn(async () => receipt("dry_run", false)),
  } satisfies NonNullable<Parameters<typeof runPackageCommand>[2]>;
}

const common = [
  "--project",
  ".",
  "--review-evidence",
  reviewPath,
  "--eval-evidence",
  evalPath,
  "--eval-source",
  "tessl-evals",
  "--json",
] as const;

describe("release CLI orchestration", () => {
  it("checks the gate before staging and emits the reusable artifact identity", async () => {
    const calls: string[] = [];
    const ops = operations();
    ops.checkGate.mockImplementation(async () => {
      calls.push("gate");
      return gate();
    });
    ops.stage.mockImplementation(async () => {
      calls.push("stage");
      return staged;
    });
    ops.package.mockImplementation(async () => {
      calls.push("package");
      return artifacts;
    });
    const output = capture();

    await expect(runPackageCommand(common, output.io, ops)).resolves.toBe(0);
    expect(calls).toEqual(["gate", "stage", "package", "gate"]);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      command: "package",
      ok: true,
      status: "packaged",
      artifacts: { artifactsPath, artifactSha256: digest },
    });
  });

  it("never stages or packages when the release gate is blocked", async () => {
    const ops = operations();
    ops.checkGate.mockResolvedValue(gate(false));
    const output = capture();

    await expect(runPackageCommand(common, output.io, ops)).resolves.toBe(3);
    expect(ops.stage).not.toHaveBeenCalled();
    expect(ops.package).not.toHaveBeenCalled();
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      command: "package",
      ok: false,
      status: "blocked",
    });
  });

  it("reports a final gate race as blocked after creating only private artifacts", async () => {
    const ops = operations();
    ops.checkGate.mockResolvedValueOnce(gate()).mockResolvedValueOnce(gate(false));
    const output = capture();

    await expect(runPackageCommand(common, output.io, ops)).resolves.toBe(3);
    expect(ops.stage).toHaveBeenCalledTimes(1);
    expect(ops.package).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      command: "package",
      ok: false,
      status: "blocked",
      artifacts: { artifactsPath },
      gate: { passed: false },
    });
  });

  it("rechecks the gate and passes exact resume bindings to the publication saga", async () => {
    const ops = operations();
    const completed = receipt("completed", true);
    ops.publish.mockResolvedValue(completed);
    const output = capture();
    const resume = `.skillpress/publications/${digest}/receipt.json`;

    await expect(
      runPublishCommand(
        [...common, "--artifacts", artifactsPath, "--execute", "--resume", resume],
        output.io,
        ops,
      ),
    ).resolves.toBe(0);
    expect(ops.checkGate).toHaveBeenCalledTimes(1);
    expect(ops.load).toHaveBeenCalledWith(".", artifactsPath);
    expect(ops.publish).toHaveBeenCalledWith(".", artifacts, [adapter], {
      execute: true,
      resumeReceiptPath: resume,
    });
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      command: "publish",
      ok: true,
      status: "completed",
      receipt: { storagePath: resume },
    });
  });

  it("returns blocked when a dry-run target fails preflight", async () => {
    const ops = operations();
    const blocked = receipt("dry_run", false);
    blocked.targets[0].preflight = {
      ok: false,
      code: "auth_missing",
      message: "authentication is unavailable",
    };
    blocked.targets[0].status = "preflight_failed";
    ops.publish.mockResolvedValue(blocked);
    const output = capture();

    await expect(
      runPublishCommand([...common, "--artifacts", artifactsPath], output.io, ops),
    ).resolves.toBe(3);
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      command: "publish",
      ok: false,
      status: "dry_run",
      receipt: {
        targets: [{ preflight: { ok: false, code: "auth_missing" } }],
      },
    });
  });

  it("blocks a package from a different source commit before provider preflight", async () => {
    const ops = operations();
    ops.load.mockResolvedValue({ ...artifacts, sourceCommit: "9".repeat(40) });
    const output = capture();

    await expect(
      runPublishCommand([...common, "--artifacts", artifactsPath], output.io, ops),
    ).resolves.toBe(3);
    expect(ops.adapters).not.toHaveBeenCalled();
    expect(ops.publish).not.toHaveBeenCalled();
    expect(JSON.parse(output.stderr[0] as string)).toMatchObject({
      ok: false,
      code: "release_blocked",
      issues: [{ code: "release.configuration", path: "/artifacts" }],
    });
  });

  it("blocks publish before loading artifacts when the gate is blocked", async () => {
    const ops = operations();
    ops.checkGate.mockResolvedValue(gate(false));
    const output = capture();
    await expect(
      runPublishCommand([...common, "--artifacts", artifactsPath], output.io, ops),
    ).resolves.toBe(3);
    expect(ops.load).not.toHaveBeenCalled();
    expect(JSON.parse(output.stdout[0] as string)).toMatchObject({
      command: "publish",
      ok: false,
      status: "blocked",
    });
  });

  it.each([
    ["duplicate boolean", [...common, "--json"]],
    ["duplicate value", [...common, "--project", "."]],
    ["missing value", ["--review-evidence"]],
    ["option-like value", ["--review-evidence", "--json"]],
    ["unsafe path", ["--review-evidence", "bad\0path"]],
    ["unknown option", ["--unknown"]],
  ])("rejects package usage with %s", async (_name, args) => {
    const output = capture();
    await expect(runPackageCommand(args, output.io)).resolves.toBe(2);
    expect(output.stderr.join("")).toContain("cli.usage");
  });

  it("requires execute for resume and parses every provider override", async () => {
    const invalid = capture();
    await expect(
      runPublishCommand(
        [...common, "--artifacts", artifactsPath, "--resume", "receipt"],
        invalid.io,
      ),
    ).resolves.toBe(2);

    const ops = operations();
    ops.publish.mockResolvedValue(receipt("completed", true));
    const output = capture();
    await expect(
      runPublishCommand(
        [
          ...common,
          "--artifacts",
          artifactsPath,
          "--execute",
          "--tessl-workspace",
          "workspace",
          "--tessl-executable",
          "/opt/tessl",
          "--askill-author",
          "askill-author",
          "--askill-executable",
          "/opt/askill",
          "--catalog-contributor",
          "catalog-owner",
          "--clawhub-owner",
          "claw-owner",
          "--clawhub-executable",
          "/opt/clawhub",
          "--accept-clawhub-mit0",
        ],
        output.io,
        ops,
      ),
    ).resolves.toBe(0);
    expect(ops.adapters.mock.calls[0]?.[0]).toMatchObject({
      execute: true,
      tesslWorkspace: "workspace",
      tesslExecutable: "/opt/tessl",
      askillAuthor: "askill-author",
      askillExecutable: "/opt/askill",
      catalogContributor: "catalog-owner",
      clawHubOwner: "claw-owner",
      clawHubExecutable: "/opt/clawhub",
      acceptClawHubMit0: true,
    });
  });

  it("constructs every configured adapter without contacting a provider", async () => {
    const configured = await createConfiguredPublicationAdapters({
      project: ".",
      reviewEvidencePath: reviewPath,
      evalEvidencePath: evalPath,
      evalSource: "tessl-evals",
      artifactsPath,
      execute: false,
      tesslWorkspace: "workspace",
      tesslExecutable: "/opt/tessl",
      askillAuthor: "askill-author",
      askillExecutable: "/opt/askill",
      catalogContributor: "catalog-owner",
      clawHubOwner: "claw-owner",
      clawHubExecutable: "/opt/clawhub",
      acceptClawHubMit0: true,
      json: false,
    });
    expect(configured.map((entry) => entry.id)).toEqual([
      "tessl",
      "skills-sh",
      "askill-sh",
      "agentskillhub-dev",
      "agent-skills-hub-catalog",
      "clawhub",
      "github",
    ]);
    await expect(
      createConfiguredPublicationAdapters({
        project: ".",
        reviewEvidencePath: reviewPath,
        evalEvidencePath: evalPath,
        evalSource: "tessl-evals",
        artifactsPath,
        execute: false,
        acceptClawHubMit0: true,
        json: false,
      }),
    ).rejects.toThrow("--tessl-workspace");
    await expect(
      createConfiguredPublicationAdapters({
        project: ".",
        reviewEvidencePath: reviewPath,
        evalEvidencePath: evalPath,
        evalSource: "tessl-evals",
        artifactsPath,
        execute: false,
        tesslWorkspace: "workspace",
        acceptClawHubMit0: false,
        json: false,
      }),
    ).rejects.toThrow("--accept-clawhub-mit0");
  });

  it("blocks source changes between gate and staging", async () => {
    const ops = operations();
    ops.stage.mockResolvedValue({ ...staged, sourceCommit: "9".repeat(40) });
    const output = capture();
    await expect(runPackageCommand(common, output.io, ops)).resolves.toBe(3);
    expect(ops.package).not.toHaveBeenCalled();
    expect(JSON.parse(output.stderr[0] as string)).toMatchObject({ code: "release_blocked" });
  });

  it("renders human gate and receipt states including unavailable scores", async () => {
    const ops = operations();
    const blocked = { ...gate(false), scores: { quality: null, impact: null } };
    ops.checkGate.mockResolvedValue(blocked);
    const packageOutput = capture();
    await expect(
      runPackageCommand(
        common.filter((entry) => entry !== "--json"),
        packageOutput.io,
        ops,
      ),
    ).resolves.toBe(3);
    expect(packageOutput.stdout.join("")).toContain("unavailable");

    const publishOps = operations();
    publishOps.publish.mockResolvedValue(receipt("failed", true));
    const publishOutput = capture();
    await expect(
      runPublishCommand(
        [
          ...common.filter((entry) => entry !== "--json"),
          "--artifacts",
          artifactsPath,
          "--execute",
        ],
        publishOutput.io,
        publishOps,
      ),
    ).resolves.toBe(3);
    expect(publishOutput.stdout.join("")).toContain("Publication: failed");
  });

  it("maps expected storage and type errors while redacting unknown failures", async () => {
    for (const error of [
      Object.assign(new Error("missing"), { code: "ENOENT" }),
      new TypeError("bad identity"),
    ]) {
      const ops = operations();
      ops.load.mockRejectedValue(error);
      const output = capture();
      await expect(
        runPublishCommand([...common, "--artifacts", artifactsPath], output.io, ops),
      ).resolves.toBe(3);
      expect(JSON.parse(output.stderr[0] as string)).toMatchObject({ code: "release_blocked" });
    }
    const ops = operations();
    ops.package.mockRejectedValue(new Error("secret"));
    const output = capture();
    await expect(runPackageCommand(common, output.io, ops)).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("failed unexpectedly");
    expect(output.stderr.join("")).not.toContain("secret");
  });

  it("returns internal failure for closed success and error sinks", async () => {
    const ops = operations();
    await expect(
      runPackageCommand(
        common,
        { stdout: () => Promise.reject(new Error("closed")), stderr: () => {} },
        ops,
      ),
    ).resolves.toBe(1);
    await expect(
      runPublishCommand(
        [],
        { stdout: () => {}, stderr: () => Promise.reject(new Error("closed")) },
        ops,
      ),
    ).resolves.toBe(1);
  });
});
