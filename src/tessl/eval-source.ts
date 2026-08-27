import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { digestBoundedTree } from "../evidence/tree-digest.js";
import { validateAgentSkill } from "../validate/agent-skill.js";

export interface TesslEvalSourceInspection {
  readonly structureValid: boolean;
  readonly contextExclusive: boolean;
  readonly skillValid: boolean;
  readonly embeddedSkillSha256: string | null;
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function isRealFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)),
    );
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function hasMetadataOnlyPluginManifest(path: string): Promise<boolean> {
  const manifest = await readJsonRecord(path);
  return (
    manifest !== undefined &&
    Object.keys(manifest).every((name) =>
      ["description", "name", "private", "version"].includes(name),
    ) &&
    typeof manifest.name === "string" &&
    typeof manifest.version === "string" &&
    (manifest.description === undefined || typeof manifest.description === "string") &&
    manifest.private === true
  );
}

async function hasDependencyFreeProject(path: string): Promise<boolean> {
  const project = await readJsonRecord(path);
  return (
    project !== undefined &&
    Object.keys(project).every((name) => ["dependencies", "mode", "name"].includes(name)) &&
    typeof project.name === "string" &&
    project.mode === "vendored" &&
    isRecord(project.dependencies) &&
    Object.keys(project.dependencies).length === 0
  );
}

/** Inspect the plugin content that Tessl will inject into paired eval runs. */
export async function inspectTesslEvalSource(
  source: string,
  skillName: string,
): Promise<TesslEvalSourceInspection> {
  const skills = join(source, "skills");
  const embeddedSkill = join(source, "skills", skillName);
  const structureValid =
    (await isRealDirectory(source)) &&
    (await isRealDirectory(join(source, ".tessl-plugin"))) &&
    (await isRealFile(join(source, ".tessl-plugin", "plugin.json"))) &&
    (await isRealDirectory(join(source, "evals"))) &&
    (await isRealDirectory(skills)) &&
    (await isRealDirectory(embeddedSkill));
  if (!structureValid) {
    return Object.freeze({
      structureValid: false,
      contextExclusive: false,
      skillValid: false,
      embeddedSkillSha256: null,
    });
  }
  const rootEntries = (await readdir(source)).sort();
  const pluginEntries = (await readdir(join(source, ".tessl-plugin"))).sort();
  const skillEntries = (await readdir(skills)).sort();
  const projectFile = join(source, "tessl.json");
  const contextExclusive =
    rootEntries.every((name) =>
      [".tessl-plugin", "evals", "skills", "tessl.json"].includes(name),
    ) &&
    [".tessl-plugin", "evals", "skills"].every((name) => rootEntries.includes(name)) &&
    pluginEntries.length === 1 &&
    pluginEntries[0] === "plugin.json" &&
    (await hasMetadataOnlyPluginManifest(join(source, ".tessl-plugin", "plugin.json"))) &&
    skillEntries.length === 1 &&
    skillEntries[0] === skillName &&
    (!rootEntries.includes("tessl.json") ||
      ((await isRealFile(projectFile)) && (await hasDependencyFreeProject(projectFile))));
  const report = await validateAgentSkill(embeddedSkill, { expectedName: skillName });
  return Object.freeze({
    structureValid: true,
    contextExclusive,
    skillValid: report.ok,
    embeddedSkillSha256: report.ok ? await digestBoundedTree(embeddedSkill) : null,
  });
}
