import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { loadCapabilityBrief } from "../src/create/load.js";
import { renderCapabilityProject } from "../src/create/render.js";
import { writeRenderedProject } from "../src/create/write.js";
import { SkillStagingError, stageCanonicalSkill } from "../src/package/stage.js";

const execFileAsync = promisify(execFile);
const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const briefPath = fileURLToPath(new URL("fixtures/create/complete-brief.yaml", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function project(): Promise<string> {
  const parent = await mkdtemp(join(temporaryRoot, "skillpress-stage-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "project");
  await writeRenderedProject(renderCapabilityProject(await loadCapabilityBrief(briefPath)), root);
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

describe("tracked-only canonical staging", () => {
  it("copies the complete clean tracked skill into private digest-identical staging", async () => {
    const root = await project();
    const staged = await stageCanonicalSkill(root);
    expect(staged).toMatchObject({
      schemaVersion: 1,
      skillPath: "canonical/incident-summary",
      files: expect.arrayContaining([
        expect.objectContaining({ path: "SKILL.md", executable: false }),
        expect.objectContaining({ path: "LICENSE", executable: false }),
      ]),
    });
    expect(staged.sourceCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(staged.skillSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(staged.files)).toBe(true);
    const storage = join(root, staged.stagingPath);
    expect((await stat(storage)).mode & 0o777).toBe(0o700);
    await expect(readFile(join(storage, staged.skillPath, "SKILL.md"), "utf8")).resolves.toContain(
      "name: incident-summary",
    );
  });

  it.each(["tracked", "untracked", "ignored"])("rejects %s input drift", async (kind) => {
    const root = await project();
    if (kind === "tracked") {
      await writeFile(join(root, "skills/incident-summary/LICENSE"), "changed\n");
    } else if (kind === "untracked") {
      await writeFile(join(root, "skills/incident-summary/extra.txt"), "extra\n");
    } else {
      await writeFile(
        join(root, ".gitignore"),
        ".skillpress/\nskills/incident-summary/ignored.txt\n",
      );
      await execFileAsync("git", ["add", ".gitignore"], { cwd: root });
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
          "ignore fixture",
        ],
        { cwd: root },
      );
      await writeFile(join(root, "skills/incident-summary/ignored.txt"), "ignored\n");
    }
    await expect(stageCanonicalSkill(root)).rejects.toBeInstanceOf(SkillStagingError);
  });

  it("rejects a dirty project configuration", async () => {
    const root = await project();
    await writeFile(
      join(root, "skillpress.yaml"),
      `${await readFile(join(root, "skillpress.yaml"), "utf8")}\n`,
    );
    await expect(stageCanonicalSkill(root)).rejects.toBeInstanceOf(SkillStagingError);
  });

  it("rejects invalid skills, untracked skill roots, and unsafe staging storage", async () => {
    const invalid = await project();
    await writeFile(join(invalid, "skills/incident-summary/SKILL.md"), "invalid\n");
    await execFileAsync("git", ["add", "."], { cwd: invalid });
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
        "invalid",
      ],
      { cwd: invalid },
    );
    await expect(stageCanonicalSkill(invalid)).rejects.toBeInstanceOf(SkillStagingError);

    const untracked = await project();
    await execFileAsync("git", ["rm", "--cached", "-r", "skills/incident-summary"], {
      cwd: untracked,
    });
    await expect(stageCanonicalSkill(untracked)).rejects.toBeInstanceOf(SkillStagingError);

    const unsafe = await project();
    const outside = join(unsafe, "outside");
    await mkdir(outside);
    await symlink(outside, join(unsafe, ".skillpress"));
    await expect(stageCanonicalSkill(unsafe)).rejects.toBeInstanceOf(SkillStagingError);
  });

  it("preserves tracked executable bits only", async () => {
    const root = await project();
    const script = join(root, "skills/incident-summary/scripts/run.sh");
    await mkdir(join(root, "skills/incident-summary/scripts"));
    await writeFile(script, "#!/bin/sh\nexit 0\n");
    await chmod(script, 0o755);
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
        "script",
      ],
      { cwd: root },
    );
    const staged = await stageCanonicalSkill(root);
    expect(staged.files).toContainEqual(
      expect.objectContaining({ path: "scripts/run.sh", executable: true }),
    );
    expect(
      (await stat(join(root, staged.stagingPath, staged.skillPath, "scripts/run.sh"))).mode & 0o777,
    ).toBe(0o700);
  });

  it("rejects a skill resolving outside the project and a project without Git HEAD", async () => {
    const outside = await project();
    const original = join(outside, "skills/incident-summary");
    const external = join(outside, "..", "external-skill");
    await rename(original, external);
    await symlink(external, original);
    await expect(stageCanonicalSkill(outside)).rejects.toBeInstanceOf(SkillStagingError);

    const parent = await mkdtemp(join(temporaryRoot, "skillpress-stage-no-git-"));
    temporaryDirectories.push(parent);
    const noGit = join(parent, "project");
    await writeRenderedProject(
      renderCapabilityProject(await loadCapabilityBrief(briefPath)),
      noGit,
    );
    await expect(stageCanonicalSkill(noGit)).rejects.toBeInstanceOf(SkillStagingError);
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when private storage cannot be created",
    async () => {
      const root = await project();
      await chmod(root, 0o500);
      try {
        await expect(stageCanonicalSkill(root)).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await chmod(root, 0o700);
      }
    },
  );
});
