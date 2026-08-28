import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";
import {
  loadPackagedSkill,
  packageStagedSkill,
  SkillPackageError,
} from "../src/package/archive.js";
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

async function commitProject(root: string): Promise<void> {
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
      "fixture update",
    ],
    { cwd: root },
  );
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
      join(configRoot, "skill-press.yaml"),
      `${await readFile(join(configRoot, "skill-press.yaml"), "utf8")}\n`,
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

  it("rejects installer-reserved portable names and paths deeper than the registry contract", async () => {
    const reservedRoot = await project();
    await writeFile(
      join(reservedRoot, "skills/incident-summary/.skill-press-installing-skill.md"),
      "reserved\n",
    );
    await commitProject(reservedRoot);
    await expect(
      packageStagedSkill(reservedRoot, await stageCanonicalSkill(reservedRoot)),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "package.archive.invalid" })],
    });

    const deepRoot = await project();
    const components = Array.from(
      { length: 31 },
      (_, index) => `d${String(index).padStart(2, "0")}`,
    );
    const directory = join(deepRoot, "skills/incident-summary", ...components);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "deep.txt"), "deep\n");
    await commitProject(deepRoot);
    await expect(
      packageStagedSkill(deepRoot, await stageCanonicalSkill(deepRoot)),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "package.archive.path" })],
    });
  });

  it("rejects forged staged paths before resolving them on disk", async () => {
    const root = await project();
    const staged = structuredClone(await stageCanonicalSkill(root));
    const license = staged.files.find((file) => file.path === "LICENSE");
    if (license === undefined) throw new Error("missing fixture LICENSE");
    license.path = "nested/../LICENSE";

    await expect(packageStagedSkill(root, staged)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "package.archive.path" })],
    });
  });

  it("rejects forged staged inventory and file-size claims", async () => {
    const root = await project();
    const empty = structuredClone(await stageCanonicalSkill(root));
    empty.files = [];
    await expect(packageStagedSkill(root, empty)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "package.stage.inventory" })],
    });

    for (const bytes of [Number.NaN, -1, 32 * 1024 * 1024 + 1]) {
      const staged = structuredClone(await stageCanonicalSkill(root));
      const first = staged.files[0];
      if (first === undefined) throw new Error("missing staged fixture file");
      first.bytes = bytes;
      await expect(packageStagedSkill(root, staged)).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: "package.stage.file" })],
      });
    }
  });

  it("enforces the server-portable Markdown inventory before submission", async () => {
    const oversizedRoot = await project();
    await writeFile(
      join(oversizedRoot, "skills/incident-summary/unreachable.md"),
      "x".repeat(512 * 1024 + 1),
    );
    await commitProject(oversizedRoot);
    await expect(
      packageStagedSkill(oversizedRoot, await stageCanonicalSkill(oversizedRoot)),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "package.archive.markdown" })],
    });

    const countRoot = await project();
    for (let index = 0; index < 256; index += 1) {
      await writeFile(
        join(
          countRoot,
          "skills/incident-summary",
          `unreachable-${String(index).padStart(3, "0")}.md`,
        ),
        "bounded\n",
      );
    }
    await commitProject(countRoot);
    await expect(
      packageStagedSkill(countRoot, await stageCanonicalSkill(countRoot)),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "package.archive.markdown" })],
    });

    const totalRoot = await project();
    for (let index = 0; index < 17; index += 1) {
      await writeFile(
        join(
          totalRoot,
          "skills/incident-summary",
          `unreachable-${String(index).padStart(2, "0")}.md`,
        ),
        "x".repeat(512 * 1024),
      );
    }
    await commitProject(totalRoot);
    await expect(
      packageStagedSkill(totalRoot, await stageCanonicalSkill(totalRoot)),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "package.archive.markdown" })],
    });
  });

  it("reloads an exact private package for resumable submission", async () => {
    const root = await project();
    const staged = await stageCanonicalSkill(root);
    const packaged = await packageStagedSkill(root, staged);

    await expect(loadPackagedSkill(root, packaged.artifactsPath)).resolves.toEqual({
      ...packaged,
      sourceCommit: staged.sourceCommit,
      projectConfigSha256: staged.projectConfigSha256,
      skillSha256: staged.skillSha256,
    });
  });

  it("rejects unsafe paths, inventory drift, permissive files, and checksum tampering", async () => {
    const pathRoot = await project();
    await expect(
      loadPackagedSkill(pathRoot, ".skill-press/staging/not-a-run/artifacts"),
    ).rejects.toBeInstanceOf(SkillPackageError);

    const inventoryRoot = await project();
    const inventory = await packageStagedSkill(
      inventoryRoot,
      await stageCanonicalSkill(inventoryRoot),
    );
    await writeFile(join(inventoryRoot, inventory.artifactsPath, "extra"), "x", { mode: 0o600 });
    await expect(loadPackagedSkill(inventoryRoot, inventory.artifactsPath)).rejects.toBeInstanceOf(
      SkillPackageError,
    );

    if (process.platform !== "win32") {
      const modeRoot = await project();
      const mode = await packageStagedSkill(modeRoot, await stageCanonicalSkill(modeRoot));
      await chmod(join(modeRoot, mode.artifactsPath, mode.skillArchive), 0o644);
      await expect(loadPackagedSkill(modeRoot, mode.artifactsPath)).rejects.toBeInstanceOf(
        SkillPackageError,
      );
    }

    const checksumRoot = await project();
    const checksum = await packageStagedSkill(
      checksumRoot,
      await stageCanonicalSkill(checksumRoot),
    );
    await writeFile(join(checksumRoot, checksum.artifactsPath, checksum.checksums), "0".repeat(64));
    await expect(loadPackagedSkill(checksumRoot, checksum.artifactsPath)).rejects.toBeInstanceOf(
      SkillPackageError,
    );
  });

  it("rejects unsafe parent storage, divergent archives, invalid provenance, and stale bindings", async () => {
    if (process.platform !== "win32") {
      const parentRoot = await project();
      const parent = await packageStagedSkill(parentRoot, await stageCanonicalSkill(parentRoot));
      await chmod(join(parentRoot, ".skill-press"), 0o755);
      await expect(loadPackagedSkill(parentRoot, parent.artifactsPath)).rejects.toBeInstanceOf(
        SkillPackageError,
      );
    }

    const divergentRoot = await project();
    const divergent = await packageStagedSkill(
      divergentRoot,
      await stageCanonicalSkill(divergentRoot),
    );
    const divergentZipPath = join(divergentRoot, divergent.artifactsPath, divergent.zipArchive);
    const divergentBytes = await readFile(divergentZipPath);
    const finalIndex = divergentBytes.length - 1;
    divergentBytes[finalIndex] = (divergentBytes[finalIndex] as number) ^ 1;
    await writeFile(divergentZipPath, divergentBytes);
    await expect(loadPackagedSkill(divergentRoot, divergent.artifactsPath)).rejects.toBeInstanceOf(
      SkillPackageError,
    );

    const invalidRoot = await project();
    const invalid = await packageStagedSkill(invalidRoot, await stageCanonicalSkill(invalidRoot));
    await writeFile(join(invalidRoot, invalid.artifactsPath, invalid.provenance), "not-json\n");
    await expect(loadPackagedSkill(invalidRoot, invalid.artifactsPath)).rejects.toBeInstanceOf(
      SkillPackageError,
    );

    const staleRoot = await project();
    const stale = await packageStagedSkill(staleRoot, await stageCanonicalSkill(staleRoot));
    const provenancePath = join(staleRoot, stale.artifactsPath, stale.provenance);
    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    provenance.project.name = "different";
    await writeFile(provenancePath, `${JSON.stringify(provenance)}\n`);
    await expect(loadPackagedSkill(staleRoot, stale.artifactsPath)).rejects.toBeInstanceOf(
      SkillPackageError,
    );
  });

  it("rejects coherently rewritten archives, provenance, and checksums", async () => {
    const root = await project();
    const packaged = await packageStagedSkill(root, await stageCanonicalSkill(root));
    const output = join(root, packaged.artifactsPath);
    const archive = Buffer.concat([
      await readFile(join(output, packaged.skillArchive)),
      Buffer.from("foreign archive payload"),
    ]);
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    await writeFile(join(output, packaged.skillArchive), archive);
    await writeFile(join(output, packaged.zipArchive), archive);
    const provenancePath = join(output, packaged.provenance);
    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    for (const artifact of provenance.artifacts) {
      artifact.sha256 = archiveSha256;
      artifact.bytes = archive.byteLength;
    }
    const provenanceBytes = Buffer.from(`${JSON.stringify(provenance)}\n`);
    await writeFile(provenancePath, provenanceBytes);
    const provenanceSha256 = createHash("sha256").update(provenanceBytes).digest("hex");
    await writeFile(
      join(output, packaged.checksums),
      `${archiveSha256}  ${packaged.skillArchive}\n${archiveSha256}  ${packaged.zipArchive}\n${provenanceSha256}  ${packaged.provenance}\n`,
    );

    await expect(loadPackagedSkill(root, packaged.artifactsPath)).rejects.toBeInstanceOf(
      SkillPackageError,
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects a staged canonical root redirected through a symbolic link",
    async () => {
      const root = await project();
      const staged = await stageCanonicalSkill(root);
      const packaged = await packageStagedSkill(root, staged);
      const canonical = join(root, staged.stagingPath, staged.skillPath);
      const redirected = join(root, staged.stagingPath, "redirected-canonical");
      await rename(canonical, redirected);
      await symlink(redirected, canonical, "dir");

      await expect(loadPackagedSkill(root, packaged.artifactsPath)).rejects.toBeInstanceOf(
        SkillPackageError,
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a current canonical root redirected through a symbolic link",
    async () => {
      const root = await project();
      const staged = await stageCanonicalSkill(root);
      const packaged = await packageStagedSkill(root, staged);
      const canonical = join(root, "skills/incident-summary");
      const redirected = join(root, "skills/redirected-incident-summary");
      await rename(canonical, redirected);
      await symlink(redirected, canonical, "dir");

      await expect(loadPackagedSkill(root, packaged.artifactsPath)).rejects.toBeInstanceOf(
        SkillPackageError,
      );
    },
  );
});
