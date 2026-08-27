import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const maximumOutput = 16 * 1024 * 1024;

function fail(message) {
  throw new Error(`Package verification failed: ${message}`);
}

async function run(command, args, cwd = root) {
  return execFileAsync(command, args, { cwd, maxBuffer: maximumOutput });
}

function packResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail("npm pack did not return JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0] === null) {
    fail("npm pack returned an unexpected result count");
  }
  return parsed[0];
}

function paths(result) {
  if (!Array.isArray(result.files)) fail("npm pack omitted its file manifest");
  const values = result.files.map((file) => file.path);
  if (values.length === 0 || values.length > 512 || new Set(values).size !== values.length) {
    fail("the package file manifest is empty, oversized, or duplicated");
  }
  for (const path of values) {
    if (
      typeof path !== "string" ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").includes("..") ||
      !(
        path.startsWith("dist/") ||
        path.startsWith("schemas/") ||
        path.startsWith("LICENSES/") ||
        ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "package.json"].includes(path)
      )
    ) {
      fail(`unexpected package path: ${String(path)}`);
    }
  }
  for (const required of [
    "LICENSE",
    "LICENSES/Unicode-3.0.txt",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "dist/bin.js",
    "dist/index.js",
    "package.json",
    "schemas/skill-press.schema.json",
    "schemas/package-provenance.schema.json",
    "schemas/submission-manifest.schema.json",
    "schemas/submission-resource.schema.json",
    "schemas/submission-receipt.schema.json",
    "schemas/improve-adapter-request.schema.json",
    "schemas/improve-adapter-response.schema.json",
  ]) {
    if (!values.includes(required)) fail(`required package path is missing: ${required}`);
  }
  return values;
}

function digest(algorithm, bytes) {
  return createHash(algorithm)
    .update(bytes)
    .digest(algorithm === "sha512" ? "base64" : "hex");
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const temporaryBase = await realpath(
  process.env.RUNNER_TEMP ?? (process.platform === "darwin" ? "/private/tmp" : tmpdir()),
);
const temporary = await mkdtemp(join(temporaryBase, "skill-press-package-"));

try {
  const dryRun = packResult((await run(npm, ["pack", "--dry-run", "--json", "--silent"])).stdout);
  const dryPaths = paths(dryRun);
  if (
    dryRun.name !== packageJson.name ||
    dryRun.version !== packageJson.version ||
    dryRun.id !== `${packageJson.name}@${packageJson.version}`
  ) {
    fail("npm pack identity does not match package.json");
  }
  if (dryRun.size > 1024 * 1024 || dryRun.unpackedSize > 4 * 1024 * 1024) {
    fail("package exceeds the release size policy");
  }

  const packed = packResult(
    (await run(npm, ["pack", "--json", "--silent", "--pack-destination", temporary])).stdout,
  );
  const packedPaths = paths(packed);
  if (
    packed.id !== dryRun.id ||
    packed.name !== dryRun.name ||
    packed.version !== dryRun.version ||
    JSON.stringify(packedPaths) !== JSON.stringify(dryPaths)
  ) {
    fail("dry-run and actual package identities or file manifests differ");
  }
  const tarball = join(temporary, packed.filename);
  const metadata = await stat(tarball);
  const bytes = await readFile(tarball);
  if (
    !metadata.isFile() ||
    metadata.size !== packed.size ||
    digest("sha1", bytes) !== packed.shasum
  ) {
    fail("tarball bytes do not match npm's SHA-1 metadata");
  }
  if (packed.integrity !== `sha512-${digest("sha512", bytes)}`) {
    fail("tarball bytes do not match npm's SHA-512 integrity metadata");
  }

  const installRoot = join(temporary, "install-smoke");
  await mkdir(installRoot, { mode: 0o700 });
  await writeFile(
    join(installRoot, "package.json"),
    `${JSON.stringify({ name: "skill-press-install-smoke", private: true })}\n`,
    { mode: 0o600 },
  );
  await run(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball],
    installRoot,
  );
  const installedBinary = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "skpress.cmd" : "skpress",
  );
  const version = (await run(installedBinary, ["--version"], installRoot)).stdout.trim();
  if (version !== packageJson.version) fail("installed CLI returned the wrong version");
  const apiProbe =
    'const api = await import("@skill-press/cli");' +
    'if (typeof api.checkProject !== "function" || typeof api.runSkillSubmission !== "function") process.exit(1);';
  await run(process.execPath, ["--input-type=module", "--eval", apiProbe], installRoot);

  const releaseOutput = process.env.SKILL_PRESS_PACKAGE_OUTPUT_DIR;
  if (releaseOutput !== undefined) {
    if (!isAbsolute(releaseOutput)) fail("release output directory must be absolute");
    const destination = resolve(releaseOutput);
    const sourceCommit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
    if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) fail("source commit is invalid");
    const sourceStatus = (
      await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    ).stdout;
    if (sourceStatus.length !== 0) fail("release source is not clean");
    await mkdir(destination, { mode: 0o700 });
    const outputTarball = join(destination, packed.filename);
    await copyFile(tarball, outputTarball, constants.COPYFILE_EXCL);
    const verifierFilename = "verify-npm-registry-release.mjs";
    const verifierSource = join(root, "scripts", verifierFilename);
    const verifierBytes = await readFile(verifierSource);
    await copyFile(verifierSource, join(destination, verifierFilename), constants.COPYFILE_EXCL);
    const repositoryUrl = packageJson.repository?.url;
    const repositoryMatch =
      typeof repositoryUrl === "string"
        ? /^git\+(https:\/\/github[.]com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)[.]git$/u.exec(
            repositoryUrl,
          )
        : null;
    if (repositoryMatch === null) fail("repository URL is not canonical GitHub HTTPS");
    await writeFile(
      join(destination, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        package: packed.id,
        name: packed.name,
        version: packed.version,
        repository: repositoryMatch[1],
        filename: packed.filename,
        bytes: packed.size,
        shasum: packed.shasum,
        integrity: packed.integrity,
        sha256: digest("sha256", bytes),
        sourceCommit,
        verifier: {
          filename: verifierFilename,
          bytes: verifierBytes.byteLength,
          sha256: digest("sha256", verifierBytes),
        },
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      package: dryRun.id,
      files: dryPaths.length,
      bytes: packed.size,
      shasum: packed.shasum,
      integrity: packed.integrity,
      cliVersion: version,
    })}\n`,
  );
} finally {
  await rm(temporary, { force: true, recursive: true });
}
