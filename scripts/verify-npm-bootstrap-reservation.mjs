import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultReservationDirectory = join(repositoryRoot, "npm", "bootstrap-reservation");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedFiles = Object.freeze(["LICENSE", "README.md", "package.json"]);
const maximumOutputBytes = 1024 * 1024;
const maximumPackageBytes = 16 * 1024;
const maximumUnpackedArchiveBytes = 64 * 1024;
const expectedTarballFilename = "skill-press-cli-0.0.0.tgz";

function fail(message) {
  throw new Error(`npm bootstrap reservation verification failed: ${message}`);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function exactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function validateBootstrapManifest(input) {
  const manifest = record(input);
  const repository = record(manifest?.repository);
  const publishConfig = record(manifest?.publishConfig);
  if (
    manifest === null ||
    !exactKeys(manifest, [
      "name",
      "version",
      "description",
      "license",
      "repository",
      "homepage",
      "files",
      "publishConfig",
    ]) ||
    manifest.name !== "@skill-press/cli" ||
    manifest.version !== "0.0.0" ||
    manifest.description !== "Inert name reservation for the future Skill Press CLI release." ||
    manifest.license !== "MIT" ||
    repository === null ||
    !exactKeys(repository, ["type", "url"]) ||
    repository.type !== "git" ||
    repository.url !== "git+https://github.com/skill-press/skill-press.git" ||
    manifest.homepage !== "https://skill-press.com" ||
    !Array.isArray(manifest.files) ||
    JSON.stringify(manifest.files) !== JSON.stringify(["README.md", "LICENSE"]) ||
    publishConfig === null ||
    !exactKeys(publishConfig, ["access", "tag", "provenance", "registry"]) ||
    publishConfig.access !== "public" ||
    publishConfig.tag !== "bootstrap" ||
    publishConfig.provenance !== false ||
    publishConfig.registry !== "https://registry.npmjs.org/"
  ) {
    fail("package.json is not the exact inert @skill-press/cli@0.0.0 reservation");
  }
  return Object.freeze(manifest);
}

function parsePackResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail("npm pack did not return JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || record(parsed[0]) === null) {
    fail("npm pack returned an unexpected result count");
  }
  return parsed[0];
}

export function validateBootstrapPackResult(input) {
  const result = record(input);
  const files = Array.isArray(result?.files) ? result.files : [];
  const paths = files.map((entry) => record(entry)?.path).sort();
  if (
    result === null ||
    result.name !== "@skill-press/cli" ||
    result.version !== "0.0.0" ||
    result.id !== "@skill-press/cli@0.0.0" ||
    result.filename !== "skill-press-cli-0.0.0.tgz" ||
    result.entryCount !== expectedFiles.length ||
    JSON.stringify(paths) !== JSON.stringify(expectedFiles) ||
    files.some((entry) => {
      const file = record(entry);
      return (
        file === null ||
        typeof file.path !== "string" ||
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        !Number.isSafeInteger(file.mode) ||
        file.mode !== 0o644
      );
    }) ||
    !Array.isArray(result.bundled) ||
    result.bundled.length !== 0 ||
    !Number.isSafeInteger(result.size) ||
    result.size < 1 ||
    result.size > maximumPackageBytes ||
    !Number.isSafeInteger(result.unpackedSize) ||
    result.unpackedSize < 1 ||
    result.unpackedSize > maximumPackageBytes ||
    typeof result.shasum !== "string" ||
    !/^[a-f0-9]{40}$/u.test(result.shasum) ||
    typeof result.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(result.integrity)
  ) {
    fail("npm pack did not produce the exact three-file inert reservation");
  }
  return Object.freeze({ result, paths: Object.freeze(paths) });
}

function packEnvironment() {
  const environment = { ...process.env };
  for (const name of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "NPM_CONFIG_OTP", "npm_config_otp"]) {
    delete environment[name];
  }
  environment.NPM_CONFIG_AUDIT = "false";
  environment.NPM_CONFIG_FUND = "false";
  environment.NPM_CONFIG_IGNORE_SCRIPTS = "true";
  environment.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  return environment;
}

async function runPack(reservationDirectory, args) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      npm,
      ["pack", "--json", "--silent", "--ignore-scripts", ...args],
      {
        cwd: reservationDirectory,
        env: packEnvironment(),
        maxBuffer: maximumOutputBytes,
      },
    ));
  } catch {
    fail("npm pack failed");
  }
  if (Buffer.byteLength(stdout) > maximumOutputBytes) fail("npm pack output exceeded its bound");
  return validateBootstrapPackResult(parsePackResult(stdout));
}

async function readBoundedRegularFile(path, label, maximumBytes = maximumPackageBytes) {
  let before;
  try {
    before = await lstat(path);
  } catch {
    fail(`${label} does not exist`);
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !Number.isSafeInteger(before.size) ||
    before.size < 1 ||
    before.size > maximumBytes
  ) {
    fail(`${label} must be a bounded regular file`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path).catch(() => fail(`${label} changed while it was read`));
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    bytes.byteLength !== before.size
  ) {
    fail(`${label} changed while it was read`);
  }
  return bytes;
}

async function validateReservationDirectory(directory) {
  const reservationDirectory = await realpath(directory).catch(() =>
    fail("reservation directory does not exist"),
  );
  const metadata = await lstat(reservationDirectory);
  if (!metadata.isDirectory()) fail("reservation path is not a directory");
  const entries = await readdir(reservationDirectory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    JSON.stringify(names) !== JSON.stringify(expectedFiles) ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    fail(
      "reservation directory must contain only regular package.json, README.md, and LICENSE files",
    );
  }

  const packageJson = await readBoundedRegularFile(
    join(reservationDirectory, "package.json"),
    "reservation package.json",
  );
  const readme = await readBoundedRegularFile(
    join(reservationDirectory, "README.md"),
    "reservation README.md",
  );
  const license = await readBoundedRegularFile(
    join(reservationDirectory, "LICENSE"),
    "reservation LICENSE",
  );
  const rootLicense = await readBoundedRegularFile(
    join(repositoryRoot, "LICENSE"),
    "repository LICENSE",
  );
  let manifest;
  try {
    manifest = JSON.parse(packageJson.toString("utf8"));
  } catch {
    fail("package.json is not valid JSON");
  }
  validateBootstrapManifest(manifest);
  const readmeText = readme.toString("utf8");
  if (
    !readmeText.includes("inert, one-time reservation") ||
    !readmeText.includes("no executable") ||
    !readmeText.includes("lifecycle scripts") ||
    !readmeText.includes("0.1.0") ||
    !license.equals(rootLicense)
  ) {
    fail("reservation README or LICENSE does not preserve the inert package contract");
  }
  return Object.freeze({
    reservationDirectory,
    files: new Map([
      ["LICENSE", license],
      ["README.md", readme],
      ["package.json", packageJson],
    ]),
  });
}

function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function tarText(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  const value = field.subarray(0, end === -1 ? field.length : end).toString("ascii");
  if (!/^[\x20-\x7e]*$/u.test(value)) fail("prepared tarball contains a non-ASCII header");
  return value;
}

function tarOctal(header, offset, length) {
  const value = tarText(header, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) fail("prepared tarball contains an invalid numeric header");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail("prepared tarball contains an out-of-range numeric header");
  }
  return parsed;
}

function validateTarHeader(header) {
  const recordedChecksum = tarOctal(header, 148, 8);
  let computedChecksum = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    computedChecksum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (recordedChecksum !== computedChecksum) fail("prepared tarball contains an invalid header");

  const name = tarText(header, 0, 100);
  const prefix = tarText(header, 345, 155);
  const path = prefix === "" ? name : `${prefix}/${name}`;
  const type = header[156];
  if (
    !path.startsWith("package/") ||
    (type !== 0 && type !== 0x30) ||
    tarOctal(header, 100, 8) !== 0o644
  ) {
    fail("prepared tarball contains a non-regular or unsafe entry");
  }
  return Object.freeze({ path: path.slice("package/".length), size: tarOctal(header, 124, 12) });
}

export function validateBootstrapTarball(bytes, sourceFiles) {
  let archive;
  try {
    archive = gunzipSync(bytes, { maxOutputLength: maximumUnpackedArchiveBytes });
  } catch {
    fail("prepared tarball is not a bounded gzip archive");
  }
  const packedFiles = new Map();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks === 2) break;
      continue;
    }
    if (zeroBlocks !== 0) fail("prepared tarball has a malformed end marker");
    const entry = validateTarHeader(header);
    if (!expectedFiles.includes(entry.path) || packedFiles.has(entry.path)) {
      fail("prepared tarball contains an unexpected or duplicate entry");
    }
    const contentStart = offset + 512;
    const contentEnd = contentStart + entry.size;
    const nextOffset = contentStart + Math.ceil(entry.size / 512) * 512;
    if (contentEnd > archive.byteLength || nextOffset > archive.byteLength) {
      fail("prepared tarball contains a truncated entry");
    }
    if (archive.subarray(contentEnd, nextOffset).some((byte) => byte !== 0)) {
      fail("prepared tarball contains nonzero entry padding");
    }
    packedFiles.set(entry.path, Buffer.from(archive.subarray(contentStart, contentEnd)));
    offset = nextOffset;
  }
  if (
    zeroBlocks !== 2 ||
    archive.subarray(offset).some((byte) => byte !== 0) ||
    JSON.stringify([...packedFiles.keys()].sort()) !== JSON.stringify(expectedFiles)
  ) {
    fail("prepared tarball does not have the exact bounded entry inventory");
  }
  for (const name of expectedFiles) {
    if (!packedFiles.get(name)?.equals(sourceFiles.get(name))) {
      fail("prepared tarball content differs from the verified reservation source");
    }
  }
}

function archiveSummary(tarball, bytes) {
  return Object.freeze({
    tarball,
    bytes: bytes.byteLength,
    shasum: digest("sha1", bytes, "hex"),
    sha256: digest("sha256", bytes, "hex"),
    integrity: `sha512-${digest("sha512", bytes, "base64")}`,
  });
}

async function readAndValidatePreparedTarball(tarball, sourceFiles) {
  if (!isAbsolute(tarball)) fail("prepared tarball path must be absolute");
  const resolvedTarball = resolve(tarball);
  if (basename(resolvedTarball) !== expectedTarballFilename) {
    fail(`prepared tarball must be named ${expectedTarballFilename}`);
  }
  const bytes = await readBoundedRegularFile(resolvedTarball, "prepared tarball");
  validateBootstrapTarball(bytes, sourceFiles);
  return archiveSummary(resolvedTarball, bytes);
}

function validatePackSizes(pack, sourceFiles) {
  const sizes = new Map(pack.result.files.map((entry) => [entry.path, entry.size]));
  const total = [...sourceFiles.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  if (
    pack.result.unpackedSize !== total ||
    expectedFiles.some((name) => sizes.get(name) !== sourceFiles.get(name)?.byteLength)
  ) {
    fail("npm pack sizes differ from the verified reservation source");
  }
}

export async function verifyNpmBootstrapReservation(options = {}) {
  const source = await validateReservationDirectory(
    options.reservationDirectory ?? defaultReservationDirectory,
  );
  const dryRun = await runPack(source.reservationDirectory, ["--dry-run"]);
  validatePackSizes(dryRun, source.files);
  const summary = {
    status: "verified",
    package: dryRun.result.id,
    tag: "bootstrap",
    files: dryRun.paths,
  };
  if (options.packDestination === undefined) return Object.freeze(summary);

  if (!isAbsolute(options.packDestination)) fail("pack destination must be absolute");
  const destination = await realpath(options.packDestination).catch(() =>
    fail("pack destination must already exist"),
  );
  const destinationMetadata = await lstat(destination);
  if (!destinationMetadata.isDirectory()) fail("pack destination is not a directory");
  const repositoryRelative = relative(resolve(repositoryRoot), resolve(destination));
  const insideRepository =
    repositoryRelative === "" ||
    (!repositoryRelative.startsWith("..") && !isAbsolute(repositoryRelative));
  if (insideRepository || (await readdir(destination)).length !== 0) {
    fail("pack destination must be an empty directory outside the repository");
  }

  const packed = await runPack(source.reservationDirectory, ["--pack-destination", destination]);
  validatePackSizes(packed, source.files);
  if (
    packed.result.id !== dryRun.result.id ||
    JSON.stringify(packed.paths) !== JSON.stringify(dryRun.paths)
  ) {
    fail("actual package identity or file inventory differed from the dry run");
  }
  const tarball = join(destination, packed.result.filename);
  const archive = await readAndValidatePreparedTarball(tarball, source.files);
  if (
    archive.bytes !== packed.result.size ||
    archive.shasum !== packed.result.shasum ||
    archive.integrity !== packed.result.integrity ||
    JSON.stringify(await readdir(destination)) !== JSON.stringify([packed.result.filename])
  ) {
    fail("prepared tarball did not match npm pack metadata");
  }
  return Object.freeze({
    ...summary,
    ...archive,
  });
}

export async function verifyPreparedNpmBootstrapTarball(
  tarball,
  reservationDirectory = defaultReservationDirectory,
) {
  const source = await validateReservationDirectory(reservationDirectory);
  const dryRun = await runPack(source.reservationDirectory, ["--dry-run"]);
  validatePackSizes(dryRun, source.files);
  const archive = await readAndValidatePreparedTarball(tarball, source.files);
  const directoryEntries = await readdir(dirname(archive.tarball));
  if (
    JSON.stringify(directoryEntries) !== JSON.stringify([expectedTarballFilename]) ||
    archive.bytes !== dryRun.result.size ||
    archive.shasum !== dryRun.result.shasum ||
    archive.integrity !== dryRun.result.integrity
  ) {
    fail("prepared tarball must be the exact current npm pack output and sole directory entry");
  }
  return Object.freeze({
    status: "verified",
    package: dryRun.result.id,
    tag: "bootstrap",
    files: dryRun.paths,
    ...archive,
  });
}

function parseArguments(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--pack-destination" && argv[1] !== "") {
    return { packDestination: argv[1] };
  }
  if (argv.length === 2 && argv[0] === "--verify-tarball" && argv[1] !== "") {
    return { preparedTarball: argv[1] };
  }
  fail(
    "usage: verify-npm-bootstrap-reservation.mjs [--pack-destination <absolute-empty-directory> | --verify-tarball <absolute-tarball>]",
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result =
    options.preparedTarball === undefined
      ? await verifyNpmBootstrapReservation(options)
      : await verifyPreparedNpmBootstrapTarball(options.preparedTarball);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

let invokedDirectly = false;
try {
  invokedDirectly =
    process.argv[1] !== undefined &&
    (await realpath(fileURLToPath(import.meta.url))) === (await realpath(resolve(process.argv[1])));
} catch {
  invokedDirectly = false;
}

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "verification failed"}\n`);
    process.exitCode = 1;
  });
}
