import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { digestBoundedTree } from "../src/evidence/tree-digest.js";
import type { CapturedCommand, CapturedCommandResult } from "../src/process/capture.js";
import { createClawHubPublicationAdapter } from "../src/publish/adapters/clawhub.js";
import { projectClawHubSkill } from "../src/publish/projection.js";
import type { PublicationContext } from "../src/publish/saga.js";

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const canonicalLicense = `MIT License

Copyright (c) 2026 Example

Permission is hereby granted, free of charge, to any person obtaining a copy.
`;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandResult(stdout: string, ok = true, stderr = ""): CapturedCommandResult {
  const stdoutBytes = Buffer.from(stdout);
  const stderrBytes = Buffer.from(stderr);
  return {
    status: ok ? "passed" : "failed",
    exitCode: ok ? 0 : 1,
    signal: null,
    durationMs: 1,
    stdout: stdoutBytes,
    stderr: stderrBytes,
    stdoutBytes: stdoutBytes.byteLength,
    stderrBytes: stderrBytes.byteLength,
    stdoutSha256: sha256(stdoutBytes),
    stderrSha256: sha256(stderrBytes),
  };
}

async function fixture(license = "MIT"): Promise<PublicationContext> {
  const root = await mkdirFixture();
  const stage = join(root, ".skillpress/staging/x");
  const canonical = join(stage, "canonical/skillpress");
  const artifacts = join(stage, "artifacts");
  await mkdir(join(canonical, "references"), { recursive: true });
  await mkdir(join(canonical, "scripts"), { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const skill = `---
name: skillpress
description: Reliable skill delivery.
license: ${license}
---
# SkillPress
`;
  await writeFile(join(canonical, "SKILL.md"), skill);
  await writeFile(join(canonical, "LICENSE"), canonicalLicense);
  await writeFile(join(canonical, "references/guide.md"), "# Guide\n");
  await writeFile(join(canonical, "scripts/run.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(canonical, "scripts/run.sh"), 0o700);
  const provenance = Buffer.from(
    `${JSON.stringify({
      provenanceType: "skillpress.package",
      sourceCommit: "d".repeat(40),
      skillSha256: await digestBoundedTree(canonical),
      project: { skillName: "skillpress" },
    })}\n`,
  );
  await writeFile(join(artifacts, "provenance.json"), provenance);
  return Object.freeze({
    root,
    project: Object.freeze({
      name: "skillpress",
      version: "0.1.0",
      repository: "https://github.com/mushanyoung/skillpress",
    }),
    skill: Object.freeze({ name: "skillpress", path: "skills/skillpress" }),
    sourceCommit: "d".repeat(40),
    artifactSha256: "e".repeat(64),
    artifactsPath: ".skillpress/staging/x/artifacts",
    artifacts: Object.freeze({
      skillArchive: Object.freeze({ name: "x.skill", sha256: "e".repeat(64), bytes: 1 }),
      zipArchive: Object.freeze({ name: "x.zip", sha256: "e".repeat(64), bytes: 1 }),
      checksums: Object.freeze({ name: "SHA256SUMS", sha256: "f".repeat(64), bytes: 2 }),
      provenance: Object.freeze({
        name: "provenance.json",
        sha256: sha256(provenance),
        bytes: provenance.byteLength,
      }),
    }),
    idempotencyKey: "1".repeat(64),
  });
}

async function mkdirFixture(): Promise<string> {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(temporaryRoot, "skillpress-clawhub-")),
  );
  temporaryDirectories.push(root);
  return root;
}

interface FileManifest {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

async function fileManifest(root: string, relative = ""): Promise<FileManifest[]> {
  const files: FileManifest[] = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await fileManifest(root, path)));
    } else if (entry.isFile() && !path.split("/").some((part) => part.startsWith("."))) {
      const bytes = await readFile(join(root, ...path.split("/")));
      files.push({ path, size: bytes.byteLength, sha256: sha256(bytes) });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function fingerprint(files: readonly FileManifest[]): string {
  return sha256(files.map((file) => `${file.path}:${file.sha256}`).join("\n"));
}

type RemoteState = "absent" | "clean" | "pending" | "rejected" | "unavailable";

function fakeClawHub(options?: {
  readonly initialRemote?: RemoteState;
  readonly identity?: string;
  readonly cliVersion?: string;
  readonly dryRunStatus?: string;
  readonly publishStatus?: string;
  readonly mutateInspection?: (value: Record<string, unknown>) => void;
}) {
  let remote: RemoteState = options?.initialRemote ?? "absent";
  let pendingReads = 0;
  let plan: { root: string; files: FileManifest[]; fingerprint: string } | null = null;
  const calls: CapturedCommand[] = [];
  const executor = async (command: CapturedCommand): Promise<CapturedCommandResult> => {
    calls.push(command);
    if (command.argv[2] === "--cli-version") {
      return commandResult(`${options?.cliVersion ?? "0.23.3"}\n`);
    }
    if (command.argv[2] === "whoami") {
      return commandResult(`${options?.identity ?? "mushanyoung"}\n`);
    }
    if (command.argv[2] === "skill" && command.argv[3] === "publish") {
      const root = command.argv[4] as string;
      const files = await fileManifest(root);
      plan = { root, files, fingerprint: fingerprint(files) };
      const dryRun = command.argv.includes("--dry-run");
      if (!dryRun) remote = "pending";
      return commandResult(
        JSON.stringify({
          ok: true,
          status: dryRun
            ? (options?.dryRunStatus ?? "would-publish")
            : (options?.publishStatus ?? "pending-publication"),
          slug: "skillpress",
          displayName: "skillpress",
          folder: root,
          version: "0.1.0",
          latestVersion: null,
          fileCount: files.length,
          fingerprint: plan.fingerprint,
          ...(dryRun ? {} : { versionId: "versions:1", publicationStatus: "pending" }),
        }),
      );
    }
    if (command.argv[2] === "inspect") {
      if (remote === "absent") return commandResult("", false, "HTTP 404: Version not found");
      if (remote === "unavailable") return commandResult("", false, "network failed");
      if (plan === null) throw new Error("dry run must precede inspect");
      const status = remote === "rejected" ? "malicious" : remote;
      const value: Record<string, unknown> = {
        skill: { slug: "skillpress", displayName: "skillpress" },
        latestVersion: {
          version: "0.1.0",
          createdAt: 1,
          changelog: "SkillPress 0.1.0",
          license: "MIT-0",
        },
        owner: { handle: "mushanyoung", displayName: "Mushan" },
        moderation: {
          isSuspicious: remote === "rejected",
          isMalwareBlocked: remote === "rejected",
          verdict: remote === "rejected" ? "malicious" : remote === "clean" ? "clean" : undefined,
        },
        version: {
          version: "0.1.0",
          license: "MIT-0",
          files: plan.files,
          security: {
            status,
            passed: remote === "clean",
            hasWarnings: remote !== "clean",
          },
        },
      };
      options?.mutateInspection?.(value);
      if (remote === "pending") {
        pendingReads += 1;
        if (pendingReads >= 2) remote = "clean";
      }
      return commandResult(JSON.stringify(value));
    }
    return commandResult("", false, "unexpected command");
  };
  return {
    executor,
    calls,
    get plan() {
      return plan;
    },
  };
}

function adapter(executor: (command: CapturedCommand) => Promise<CapturedCommandResult>) {
  return createClawHubPublicationAdapter({
    owner: "mushanyoung",
    licenseConsent: "MIT-0",
    verificationAttempts: 3,
    verificationIntervalMs: 0,
    executor,
  });
}

describe("ClawHub publication adapter", () => {
  it("projects the complete skill under MIT-0, publishes, and polls security review", async () => {
    const context = await fixture();
    const provider = fakeClawHub();
    const publication = adapter(provider.executor);

    await expect(publication.preflight(context)).resolves.toEqual({
      ok: true,
      code: "ready",
      message: "ClawHub publication is ready with explicit MIT-0 consent",
    });
    await expect(publication.execute?.(context, "publish-skill")).resolves.toEqual({
      remoteId: "@mushanyoung/skillpress@0.1.0",
      url: "https://clawhub.ai/mushanyoung/skills/skillpress",
    });
    await expect(publication.verify(context)).resolves.toEqual({
      ok: true,
      remoteId: "@mushanyoung/skillpress@0.1.0",
      url: "https://clawhub.ai/mushanyoung/skills/skillpress",
    });

    const projected = await projectClawHubSkill(context);
    expect(projected.skillMarkdown).toContain("license: MIT-0");
    expect(projected.skillMarkdown).toContain("version: 0.1.0");
    expect(await readFile(join(projected.root, "LICENSE"), "utf8")).toMatch(/^MIT No Attribution/u);
    expect(await readFile(join(projected.root, "references/guide.md"), "utf8")).toBe("# Guide\n");
    expect((await stat(join(projected.root, "scripts/run.sh"))).mode & 0o111).not.toBe(0);
    expect(
      await readFile(
        join(context.root, ".skillpress/staging/x/canonical/skillpress/SKILL.md"),
        "utf8",
      ),
    ).toContain("license: MIT\n");
    expect(
      provider.calls.filter(
        (call) => call.argv[3] === "publish" && !call.argv.includes("--dry-run"),
      ),
    ).toHaveLength(1);
    expect(provider.calls.every((call) => call.env?.NPM_TOKEN === undefined)).toBe(true);
  });

  it.each(["clean", "pending"] as const)(
    "reuses an exact %s version without publishing",
    async (state) => {
      const context = await fixture();
      const provider = fakeClawHub({ initialRemote: state });
      const publication = adapter(provider.executor);
      await expect(publication.preflight(context)).resolves.toMatchObject({
        ok: true,
        code: "ready",
      });
      await expect(publication.execute?.(context, "publish-skill")).resolves.toMatchObject({
        remoteId: "@mushanyoung/skillpress@0.1.0",
      });
      expect(
        provider.calls.some(
          (call) => call.argv[3] === "publish" && !call.argv.includes("--dry-run"),
        ),
      ).toBe(false);
    },
  );

  it("ignores only ClawHub's generated skill card when binding the source manifest", async () => {
    const context = await fixture();
    const provider = fakeClawHub({
      initialRemote: "clean",
      mutateInspection: (value) => {
        const files = (value.version as Record<string, unknown>).files as Array<
          Record<string, unknown>
        >;
        files.push({ path: "skill-card.md", size: 12, sha256: "a".repeat(64) });
      },
    });
    await expect(adapter(provider.executor).verify(context)).resolves.toMatchObject({ ok: true });
  });

  it.each([
    [
      "owner",
      (value: Record<string, unknown>) =>
        ((value.owner as Record<string, unknown>).handle = "attacker"),
    ],
    [
      "license",
      (value: Record<string, unknown>) =>
        ((value.version as Record<string, unknown>).license = "MIT"),
    ],
    [
      "content",
      (value: Record<string, unknown>) => {
        const first = (
          (value.version as Record<string, unknown>).files as Array<Record<string, unknown>>
        )[0];
        if (first === undefined) throw new Error("fixture manifest is empty");
        first.sha256 = "f".repeat(64);
      },
    ],
  ])("blocks an existing version with conflicting %s", async (_name, mutateInspection) => {
    const context = await fixture();
    const provider = fakeClawHub({ initialRemote: "clean", mutateInspection });
    await expect(adapter(provider.executor).preflight(context)).resolves.toMatchObject({
      ok: false,
      code: "version_conflict",
    });
  });

  it("blocks rejected scans and provider failures without treating them as absence", async () => {
    for (const state of ["rejected", "unavailable"] as const) {
      const context = await fixture();
      const provider = fakeClawHub({ initialRemote: state });
      await expect(adapter(provider.executor).preflight(context)).resolves.toMatchObject({
        ok: false,
        code: state === "rejected" ? "security_rejected" : "provider_unavailable",
      });
    }
  });

  it("requires a supported official CLI, exact dry run, and exact publisher identity", async () => {
    const unsupported = fakeClawHub({ cliVersion: "0.23.2" });
    await expect(adapter(unsupported.executor).preflight(await fixture())).resolves.toMatchObject({
      code: "cli_unsupported",
    });

    const invalidPlan = fakeClawHub({ dryRunStatus: "submitted" });
    await expect(adapter(invalidPlan.executor).preflight(await fixture())).resolves.toMatchObject({
      code: "projection_rejected",
    });

    const wrongIdentity = fakeClawHub({ identity: "attacker" });
    await expect(adapter(wrongIdentity.executor).preflight(await fixture())).resolves.toMatchObject(
      {
        code: "auth_missing",
      },
    );
  });

  it("requires explicit MIT-0 consent and compatible canonical licensing", async () => {
    expect(() =>
      createClawHubPublicationAdapter({
        owner: "mushanyoung",
        licenseConsent: "MIT" as "MIT-0",
      }),
    ).toThrow(/explicit MIT-0/u);
    expect(() =>
      createClawHubPublicationAdapter({ owner: "bad/owner", licenseConsent: "MIT-0" }),
    ).toThrow(/handle/u);
    expect(() =>
      createClawHubPublicationAdapter({
        owner: "mushanyoung",
        licenseConsent: "MIT-0",
        executable: "",
      }),
    ).toThrow(/executable/u);

    const context = await fixture("Apache-2.0");
    const provider = fakeClawHub();
    await expect(adapter(provider.executor).preflight(context)).resolves.toMatchObject({
      code: "projection_invalid",
    });

    const alreadyMit0 = await fixture("MIT-0");
    await expect(projectClawHubSkill(alreadyMit0)).resolves.toMatchObject({
      skillMarkdown: expect.stringContaining("license: MIT-0"),
    });

    const nonString = await fixture("123");
    await expect(projectClawHubSkill(nonString)).rejects.toThrow(/license/u);

    const malformed = await fixture("[");
    await expect(projectClawHubSkill(malformed)).rejects.toThrow(/license/u);
  });

  it("rejects unexpected files injected into an idempotent projection", async () => {
    const context = await fixture();
    const projected = await projectClawHubSkill(context);
    await writeFile(join(projected.root, "injected.txt"), "attacker\n");
    await expect(projectClawHubSkill(context)).rejects.toThrow(/unexpected/u);

    const changedContext = await fixture();
    const changed = await projectClawHubSkill(changedContext);
    await writeFile(join(changed.root, "references/guide.md"), "changed\n");
    await expect(projectClawHubSkill(changedContext)).rejects.toThrow(/idempotency/u);

    const linkedContext = await fixture();
    const linked = await projectClawHubSkill(linkedContext);
    await rm(join(linked.root, "references/guide.md"));
    await symlink(join(linked.root, "SKILL.md"), join(linked.root, "references/guide.md"));
    await expect(projectClawHubSkill(linkedContext)).rejects.toThrow(/unsafe|idempotency/u);
  });

  it("fails execution on unknown steps, identity changes, and unexpected publish results", async () => {
    const context = await fixture();
    const normal = fakeClawHub();
    await expect(adapter(normal.executor).execute?.(context, "wrong")).rejects.toThrow(/Unknown/u);

    const changedIdentity = fakeClawHub({ identity: "attacker" });
    await expect(
      adapter(changedIdentity.executor).execute?.(context, "publish-skill"),
    ).rejects.toThrow(/identity/u);

    const badPublish = fakeClawHub({ publishStatus: "would-publish" });
    await expect(adapter(badPublish.executor).execute?.(context, "publish-skill")).rejects.toThrow(
      /unexpected identity/u,
    );

    const rejected = fakeClawHub({ initialRemote: "rejected" });
    await expect(adapter(rejected.executor).execute?.(context, "publish-skill")).rejects.toThrow(
      /conflicting, or rejected/u,
    );

    const changedCli = fakeClawHub({ cliVersion: "0.1.0" });
    await expect(adapter(changedCli.executor).execute?.(context, "publish-skill")).rejects.toThrow(
      /CLI changed/u,
    );
  });

  it("bounds pending verification and validates polling configuration", async () => {
    expect(() =>
      createClawHubPublicationAdapter({
        owner: "mushanyoung",
        licenseConsent: "MIT-0",
        verificationAttempts: 0,
      }),
    ).toThrow(/attempts/u);
    expect(() =>
      createClawHubPublicationAdapter({
        owner: "mushanyoung",
        licenseConsent: "MIT-0",
        verificationIntervalMs: -1,
      }),
    ).toThrow(/interval/u);

    const context = await fixture();
    const provider = fakeClawHub({ initialRemote: "pending" });
    const publication = createClawHubPublicationAdapter({
      owner: "mushanyoung",
      licenseConsent: "MIT-0",
      verificationAttempts: 1,
      verificationIntervalMs: 0,
      executor: provider.executor,
    });
    await expect(publication.verify(context)).resolves.toEqual({ ok: false });

    const rejected = fakeClawHub({ initialRemote: "rejected" });
    await expect(adapter(rejected.executor).verify(await fixture())).resolves.toEqual({
      ok: false,
    });

    const invalidPlan = fakeClawHub({ dryRunStatus: "submitted" });
    await expect(adapter(invalidPlan.executor).verify(await fixture())).resolves.toEqual({
      ok: false,
    });

    const sleeping = fakeClawHub({ initialRemote: "pending" });
    const waits = createClawHubPublicationAdapter({
      owner: "mushanyoung",
      licenseConsent: "MIT-0",
      verificationAttempts: 2,
      verificationIntervalMs: 1,
      executor: sleeping.executor,
    });
    await expect(waits.verify(await fixture())).resolves.toEqual({ ok: false });
  });

  it("rejects malformed manifests and security-only failures", async () => {
    const malformed = fakeClawHub({
      initialRemote: "clean",
      mutateInspection: (value) => {
        const files = (value.version as Record<string, unknown>).files as Array<
          Record<string, unknown>
        >;
        const first = files[0];
        if (first === undefined) throw new Error("fixture manifest is empty");
        first.path = "../escape";
      },
    });
    await expect(adapter(malformed.executor).preflight(await fixture())).resolves.toMatchObject({
      code: "version_conflict",
    });

    const securityFailure = fakeClawHub({
      initialRemote: "clean",
      mutateInspection: (value) => {
        (value.version as Record<string, unknown>).security = {
          status: "error",
          passed: false,
          hasWarnings: true,
        };
      },
    });
    await expect(
      adapter(securityFailure.executor).preflight(await fixture()),
    ).resolves.toMatchObject({ code: "security_rejected" });
  });
});
