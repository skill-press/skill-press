import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";
import { packageStagedSkill, SkillPackageError } from "../src/package/archive.js";
import { stageCanonicalSkill } from "../src/package/stage.js";

const execFileAsync = promisify(execFile);
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function project(): Promise<string> {
  const parent = await mkdtemp(join(temporaryRoot, "skillpress-archive-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "project");
  await writeRenderedProject(renderCapabilityProject(await loadCapabilityBrief(briefPath)), root);
  await mkdir(join(root, "skills/incident-summary/scripts"));
  await writeFile(join(root, "skills/incident-summary/scripts/run.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "skills/incident-summary/scripts/run.sh"), 0o755);
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=SkillPress Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  return root;
}

describe("deterministic package archives", () => {
  it("produces byte-identical valid .skill and .zip artifacts with provenance", async () => {
    const root = await project();
    const first = await packageStagedSkill(root, await stageCanonicalSkill(root));
    const second = await packageStagedSkill(root, await stageCanonicalSkill(root));
    const firstBytes = await readFile(join(root, first.artifactsPath, first.skillArchive));
    const firstZip = await readFile(join(root, first.artifactsPath, first.zipArchive));
    const secondBytes = await readFile(join(root, second.artifactsPath, second.skillArchive));
    expect(firstBytes).toEqual(firstZip);
    expect(firstBytes).toEqual(secondBytes);
    expect(firstBytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(first.artifactSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.provenanceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.checksumsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.provenanceBytes).toBeGreaterThan(0);
    expect(first.checksumsBytes).toBeGreaterThan(0);
    const provenance = JSON.parse(
      await readFile(join(root, first.artifactsPath, first.provenance), "utf8"),
    );
    expect(provenance).toMatchObject({
      provenanceType: "skillpress.package",
      archive: { compression: "store", timestamp: "1980-01-01T00:00:00.000Z" },
      artifacts: [
        { name: "incident-summary-0.1.0.skill", sha256: first.artifactSha256 },
        { name: "incident-summary-0.1.0.zip", sha256: first.artifactSha256 },
      ],
    });
    await expect(
      readFile(join(root, first.artifactsPath, first.checksums), "utf8"),
    ).resolves.toContain(`${first.provenanceSha256}  provenance.json`);
    const listing = await execFileAsync("unzip", [
      "-Z1",
      join(root, first.artifactsPath, first.zipArchive),
    ]);
    expect(listing.stdout.trim().split("\n")).toEqual([
      "incident-summary/LICENSE",
      "incident-summary/SKILL.md",
      "incident-summary/scripts/run.sh",
    ]);
  });

  it("rejects changed configuration, staged content, and staged identity", async () => {
    const configRoot = await project();
    const configStage = await stageCanonicalSkill(configRoot);
    await writeFile(
      join(configRoot, "skillpress.yaml"),
      `${await readFile(join(configRoot, "skillpress.yaml"), "utf8")}\n`,
    );
    await expect(packageStagedSkill(configRoot, configStage)).rejects.toBeInstanceOf(
      SkillPackageError,
    );

    const contentRoot = await project();
    const contentStage = await stageCanonicalSkill(contentRoot);
    await writeFile(
      join(contentRoot, contentStage.stagingPath, contentStage.skillPath, "LICENSE"),
      "changed\n",
    );
    await expect(packageStagedSkill(contentRoot, contentStage)).rejects.toBeInstanceOf(
      SkillPackageError,
    );

    const identityRoot = await project();
    const identityStage = structuredClone(await stageCanonicalSkill(identityRoot));
    identityStage.skillPath = "canonical/wrong";
    await expect(packageStagedSkill(identityRoot, identityStage)).rejects.toBeInstanceOf(
      SkillPackageError,
    );
  });

  it("rejects staged file metadata drift even when the tree remains readable", async () => {
    const root = await project();
    const staged = structuredClone(await stageCanonicalSkill(root));
    staged.files[0].sha256 = "0".repeat(64);
    await expect(packageStagedSkill(root, staged)).rejects.toBeInstanceOf(SkillPackageError);
  });
});
