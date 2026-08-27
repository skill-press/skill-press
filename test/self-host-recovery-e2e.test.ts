import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { loadProjectConfig } from "../src/config/load.js";
import { packageStagedSkill } from "../src/package/archive.js";
import { stageCanonicalSkill } from "../src/package/stage.js";
import {
  type PublicationAdapter,
  type PublicationCapability,
  runPublicationSaga,
} from "../src/publish/saga.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const generatedPaths: string[] = [];
const expectedTargets = [
  "tessl",
  "skills-sh",
  "askill-sh",
  "agentskillhub-dev",
  "agent-skills-hub-catalog",
  "github",
] as const;

afterEach(async () => {
  await Promise.all(
    generatedPaths
      .splice(0)
      .map((path) => rm(join(repositoryRoot, path), { force: true, recursive: true })),
  );
});

function track(path: string): void {
  expect(path).toMatch(
    /^\.skillpress\/(?:staging|publications)\/[a-f0-9]{64}(?:\/receipt\.json)?$/u,
  );
  generatedPaths.push(path.endsWith("/receipt.json") ? dirname(path) : path);
}

interface FakeProviderState {
  readonly preflights: string[];
  readonly executions: string[];
  readonly verifications: string[];
  failAt?: string;
}

function fakeAdapter(
  id: (typeof expectedTargets)[number],
  state: FakeProviderState,
): PublicationAdapter {
  const capability: PublicationCapability =
    id === "skills-sh" ? "derived" : id === "agent-skills-hub-catalog" ? "submit" : "publish";
  const steps = capability === "derived" ? [] : ["prepare", "publish"];
  return {
    id,
    capability,
    auth: capability === "derived" ? [] : ["SKILLPRESS_E2E_TOKEN"],
    rollback: capability === "derived" ? "no remote mutation" : "fixture rollback is manual",
    steps,
    preflight: async () => {
      state.preflights.push(id);
      return { ok: true, code: "ready", message: "fixture ready" };
    },
    ...(capability === "derived"
      ? {}
      : {
          execute: async (_context, step: string) => {
            const call = `${id}:${step}`;
            state.executions.push(call);
            if (state.failAt === call) throw new Error("fixture credential must not leak");
            return {
              remoteId: `${id}-${step}`,
              url: `https://example.invalid/${id}/${step}`,
            };
          },
        }),
    verify: async () => {
      state.verifications.push(id);
      return {
        ok: true,
        remoteId: `${id}-verified`,
        url: `https://example.invalid/${id}`,
      };
    },
  };
}

describe("SkillPress self-hosting and publication recovery", () => {
  it("packages the tracked canonical skill reproducibly with source provenance", async () => {
    const firstStage = await stageCanonicalSkill(repositoryRoot);
    const secondStage = await stageCanonicalSkill(repositoryRoot);
    track(firstStage.stagingPath);
    track(secondStage.stagingPath);

    const first = await packageStagedSkill(repositoryRoot, firstStage);
    const second = await packageStagedSkill(repositoryRoot, secondStage);
    const firstArchive = await readFile(
      join(repositoryRoot, first.artifactsPath, first.skillArchive),
    );
    const secondArchive = await readFile(
      join(repositoryRoot, second.artifactsPath, second.skillArchive),
    );
    const firstProvenance = await readFile(
      join(repositoryRoot, first.artifactsPath, first.provenance),
      "utf8",
    );
    const secondProvenance = await readFile(
      join(repositoryRoot, second.artifactsPath, second.provenance),
      "utf8",
    );
    const head = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout.trim();
    const listing = await execFileAsync("unzip", [
      "-Z1",
      join(repositoryRoot, first.artifactsPath, first.skillArchive),
    ]);

    expect(firstStage.sourceCommit).toBe(head);
    expect(firstStage.skillSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstStage.files.map((file) => file.path)).toEqual([
      "LICENSE",
      "SKILL.md",
      "references/authoring-and-evaluation.md",
      "references/evidence-and-release-gates.md",
      "references/publication-and-recovery.md",
    ]);
    expect(firstArchive).toEqual(secondArchive);
    expect(firstProvenance).toBe(secondProvenance);
    expect(first.artifactSha256).toBe(second.artifactSha256);
    expect(JSON.parse(firstProvenance)).toMatchObject({
      sourceCommit: head,
      skillSha256: firstStage.skillSha256,
      artifacts: [
        { name: "skillpress-0.1.0.skill", sha256: first.artifactSha256 },
        { name: "skillpress-0.1.0.zip", sha256: first.artifactSha256 },
      ],
    });
    expect(listing.stdout.trim().split("\n")).toEqual(
      firstStage.files.map((file) => `skillpress/${file.path}`),
    );
  });

  it("recovers all configured targets after a partial failure without duplicate mutation", async () => {
    const config = await loadProjectConfig(repositoryRoot);
    expect(config.publish.targets).toEqual(expectedTargets);
    const staged = await stageCanonicalSkill(repositoryRoot);
    track(staged.stagingPath);
    const packaged = await packageStagedSkill(repositoryRoot, staged);
    const artifacts = { ...packaged, sourceCommit: staged.sourceCommit };
    const state: FakeProviderState = {
      preflights: [],
      executions: [],
      verifications: [],
      failAt: "github:publish",
    };
    const adapters = expectedTargets.map((id) => fakeAdapter(id, state));

    const dryRun = await runPublicationSaga(repositoryRoot, artifacts, adapters);
    expect(dryRun).toMatchObject({ execute: false, status: "dry_run", storagePath: null });
    expect(
      dryRun.targets.map(({ id, capability, status }) => ({ id, capability, status })),
    ).toEqual([
      { id: "tessl", capability: "publish", status: "planned" },
      { id: "skills-sh", capability: "derived", status: "planned" },
      { id: "askill-sh", capability: "publish", status: "planned" },
      { id: "agentskillhub-dev", capability: "publish", status: "planned" },
      { id: "agent-skills-hub-catalog", capability: "submit", status: "planned" },
      { id: "github", capability: "publish", status: "planned" },
    ]);
    expect(state.executions).toEqual([]);
    expect(state.verifications).toEqual([]);

    state.preflights.splice(0);
    const failed = await runPublicationSaga(repositoryRoot, artifacts, adapters, { execute: true });
    expect(failed.status).toBe("failed");
    expect(failed.storagePath).not.toBeNull();
    track(failed.storagePath as string);
    expect(state.preflights).toEqual(expectedTargets);
    expect(state.executions).toEqual([
      "tessl:prepare",
      "tessl:publish",
      "askill-sh:prepare",
      "askill-sh:publish",
      "agentskillhub-dev:prepare",
      "agentskillhub-dev:publish",
      "agent-skills-hub-catalog:prepare",
      "agent-skills-hub-catalog:publish",
      "github:prepare",
      "github:publish",
    ]);
    expect(state.verifications).toEqual([
      "tessl",
      "skills-sh",
      "askill-sh",
      "agentskillhub-dev",
      "agent-skills-hub-catalog",
    ]);
    expect(failed.targets.map(({ id, status }) => ({ id, status }))).toMatchObject([
      { id: "tessl", status: "verified" },
      { id: "skills-sh", status: "derived" },
      { id: "askill-sh", status: "verified" },
      { id: "agentskillhub-dev", status: "verified" },
      { id: "agent-skills-hub-catalog", status: "verified" },
      { id: "github", status: "failed" },
    ]);
    if (process.platform !== "win32") {
      expect((await stat(join(repositoryRoot, failed.storagePath as string))).mode & 0o777).toBe(
        0o600,
      );
    }

    state.failAt = undefined;
    state.preflights.splice(0);
    const resumed = await runPublicationSaga(repositoryRoot, artifacts, adapters, {
      execute: true,
      resumeReceiptPath: failed.storagePath as string,
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.targets.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "tessl", status: "verified" },
      { id: "skills-sh", status: "derived" },
      { id: "askill-sh", status: "verified" },
      { id: "agentskillhub-dev", status: "verified" },
      { id: "agent-skills-hub-catalog", status: "verified" },
      { id: "github", status: "verified" },
    ]);
    expect(state.preflights).toEqual(["github"]);
    expect(state.executions).toEqual([
      "tessl:prepare",
      "tessl:publish",
      "askill-sh:prepare",
      "askill-sh:publish",
      "agentskillhub-dev:prepare",
      "agentskillhub-dev:publish",
      "agent-skills-hub-catalog:prepare",
      "agent-skills-hub-catalog:publish",
      "github:prepare",
      "github:publish",
      "github:publish",
    ]);
    expect(state.verifications).toEqual([
      "tessl",
      "skills-sh",
      "askill-sh",
      "agentskillhub-dev",
      "agent-skills-hub-catalog",
      "github",
    ]);
    expect(JSON.stringify(resumed)).not.toContain("fixture credential must not leak");

    const callsBeforeReplay = structuredClone(state);
    const replay = await runPublicationSaga(repositoryRoot, artifacts, adapters, {
      execute: true,
      resumeReceiptPath: resumed.storagePath as string,
    });
    expect(replay.status).toBe("completed");
    expect(state).toEqual(callsBeforeReplay);
  });
});
