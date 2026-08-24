import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

function fail(message) {
  throw new Error(`Release verification failed: ${message}`);
}

function versionAtLeast(input, minimum) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(input);
  if (match === null) return false;
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

const tag = process.env.RELEASE_TAG;
if (tag !== `v${packageJson.version}` || !/^v\d+\.\d+\.\d+$/u.test(tag)) {
  fail("release tag must exactly match the package version");
}
if (
  packageJson.name !== "@mushanyoung/skillpress" ||
  packageJson.repository?.url !== "git+https://github.com/mushanyoung/skillpress.git" ||
  packageJson.publishConfig?.access !== "public" ||
  packageJson.publishConfig?.provenance !== true
) {
  fail("package identity, repository, access, or provenance policy changed");
}
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_REPOSITORY !== "mushanyoung/skillpress" ||
  process.env.GITHUB_REF_TYPE !== "tag" ||
  process.env.GITHUB_REF_NAME !== tag
) {
  fail("release must run for the exact tag in the canonical GitHub repository");
}
if (process.env.NODE_AUTH_TOKEN !== undefined || process.env.NPM_TOKEN !== undefined) {
  fail("long-lived npm write tokens are forbidden in trusted publishing");
}
if (!versionAtLeast(process.versions.node, [22, 14, 0])) {
  fail("trusted publishing requires Node.js 22.14.0 or newer");
}
const npmVersion = (await execFileAsync(npm, ["--version"], { cwd: root })).stdout.trim();
if (!versionAtLeast(npmVersion, [11, 5, 1])) {
  fail("trusted publishing requires npm 11.5.1 or newer");
}
const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
const tagged = (
  await execFileAsync("git", ["rev-list", "-n", "1", `refs/tags/${tag}`], { cwd: root })
).stdout.trim();
if (!/^[a-f0-9]{40}$/u.test(head) || head !== tagged) {
  fail("checked-out source is not the immutable release tag commit");
}

process.stdout.write(
  `${JSON.stringify({ tag, sourceCommit: head, node: process.version, npm: npmVersion })}\n`,
);
