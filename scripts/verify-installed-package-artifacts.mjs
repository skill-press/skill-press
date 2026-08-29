import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { types as utilTypes } from "node:util";

const MAXIMUM_FILES = 512;
const MAXIMUM_FILE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_TOTAL_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const isProxy = utilTypes.isProxy.bind(utilTypes);
const snapshots = new WeakMap();

export const REVIEWED_KEYRING_ARTIFACT_PATHS = Object.freeze([
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/install/production-keys.js",
  "dist/install/production-keys.d.ts",
  "dist/install/signatures.js",
  "dist/install/signatures.d.ts",
]);

function fail(message) {
  throw new Error(`Installed package artifact verification failed: ${message}`);
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function isContainedRelativePath(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    value !== ".." &&
    !value.startsWith(`..${sep}`) &&
    !isAbsolute(value)
  );
}

function safePackagePath(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }
  const parts = value.split("/");
  if (parts.length < 1 || parts.length > 32) return false;
  for (let index = 0; index < parts.length; index += 1) {
    if (
      parts[index] === "" ||
      parts[index] === "." ||
      parts[index] === ".." ||
      !/^[A-Za-z0-9@._+-]+$/u.test(parts[index])
    ) {
      return false;
    }
  }
  return true;
}

function sortedPaths(value) {
  if (isProxy(value) || !Array.isArray(value) || value.length < 1 || value.length > MAXIMUM_FILES) {
    fail("the package file manifest is not exact and bounded");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || ownKeys[ownKeys.length - 1] !== "length") {
    fail("the package file manifest is not dense");
  }
  const result = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true ||
      !safePackagePath(descriptor.value) ||
      seen.has(descriptor.value)
    ) {
      fail("the package file manifest contains an unsafe or duplicate path");
    }
    seen.add(descriptor.value);
    let destination = result.length;
    while (destination > 0 && result[destination - 1] > descriptor.value) destination -= 1;
    result.splice(destination, 0, descriptor.value);
  }
  for (const required of REVIEWED_KEYRING_ARTIFACT_PATHS) {
    if (!seen.has(required)) fail(`required static artifact is missing: ${required}`);
  }
  return Object.freeze(result);
}

function ownerUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function safeDirectory(metadata) {
  const uid = ownerUid();
  return (
    metadata.isDirectory() &&
    !metadata.isSymbolicLink() &&
    (metadata.mode & 0o022) === 0 &&
    (uid === null || metadata.uid === uid)
  );
}

async function canonicalRoot(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    fail(`${label} is not a canonical absolute path`);
  }
  let resolved;
  let metadata;
  try {
    [resolved, metadata] = await Promise.all([realpath(value), lstat(value)]);
  } catch {
    fail(`${label} is missing or unsafe`);
  }
  if (resolved !== value || !safeDirectory(metadata)) {
    fail(`${label} is not an owner-controlled canonical directory`);
  }
  return Object.freeze({ metadata, path: value });
}

async function assertStableRoot(root, label) {
  let resolved;
  let metadata;
  try {
    [resolved, metadata] = await Promise.all([realpath(root.path), lstat(root.path)]);
  } catch {
    fail(`${label} changed during verification`);
  }
  if (
    resolved !== root.path ||
    !safeDirectory(metadata) ||
    !sameIdentity(root.metadata, metadata)
  ) {
    fail(`${label} changed during verification`);
  }
}

async function directoryRecordsForPaths(root, paths) {
  const seen = new Set();
  const records = [];
  for (const relativePath of paths) {
    const parts = relativePath.split("/");
    parts.pop();
    let current = root.path;
    for (const part of parts) {
      current = join(current, part);
      if (seen.has(current)) continue;
      const [resolved, metadata] = await Promise.all([realpath(current), lstat(current)]);
      if (resolved !== current || !safeDirectory(metadata)) {
        fail("a package path contains an unsafe directory");
      }
      seen.add(current);
      records.push(Object.freeze({ metadata, path: current }));
    }
  }
  return Object.freeze(records);
}

async function assertStableDirectories(records) {
  for (const record of records) {
    let resolved;
    let metadata;
    try {
      [resolved, metadata] = await Promise.all([realpath(record.path), lstat(record.path)]);
    } catch {
      fail("a package directory changed during verification");
    }
    if (
      resolved !== record.path ||
      !safeDirectory(metadata) ||
      !sameIdentity(record.metadata, metadata)
    ) {
      fail("a package directory changed during verification");
    }
  }
}

async function assertSafeFileAncestors(root, path) {
  const parent = dirname(path);
  const remainder = relative(root.path, parent);
  if (remainder === "") return;
  if (!isContainedRelativePath(remainder)) fail("a package file parent escaped its reviewed root");
  let current = root.path;
  for (const part of remainder.split(sep)) {
    current = join(current, part);
    const [resolved, metadata] = await Promise.all([realpath(current), lstat(current)]);
    if (resolved !== current || !safeDirectory(metadata)) {
      fail("a package file has an unsafe ancestor directory");
    }
  }
}

async function readExactBytes(handle, size, relativePath) {
  const bytes = Buffer.alloc(size);
  const trailing = Buffer.alloc(1);
  let offset = 0;
  try {
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, offset);
      if (!Number.isSafeInteger(result?.bytesRead) || result.bytesRead < 1) {
        fail(`${relativePath} ended before its reviewed size`);
      }
      offset += result.bytesRead;
    }
    const result = await handle.read(trailing, 0, 1, size);
    if (!Number.isSafeInteger(result?.bytesRead) || result.bytesRead !== 0) {
      fail(`${relativePath} grew beyond its reviewed size`);
    }
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  } finally {
    trailing.fill(0);
  }
}

async function readStableFile(root, relativePath) {
  const path = resolve(root.path, relativePath);
  const remainder = relative(root.path, path);
  if (!isContainedRelativePath(remainder)) fail("a package path escaped its reviewed root");
  await assertSafeFileAncestors(root, path);
  try {
    if ((await realpath(path)) !== path) fail(`${relativePath} is not canonical`);
  } catch {
    fail(`${relativePath} is missing or not canonical`);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail(`${relativePath} is missing or unsafe`);
  }
  let bytes;
  try {
    const before = await handle.stat();
    const uid = ownerUid();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      (before.mode & 0o022) !== 0 ||
      (uid !== null && before.uid !== uid) ||
      before.size < 1 ||
      before.size > MAXIMUM_FILE_BYTES
    ) {
      fail(`${relativePath} has unsafe storage or size`);
    }
    bytes = await readExactBytes(handle, before.size, relativePath);
    const after = await handle.stat();
    const pathMetadata = await lstat(path);
    if (
      bytes.byteLength !== before.size ||
      !sameIdentity(before, after) ||
      !sameIdentity(before, pathMetadata) ||
      (await realpath(path)) !== path
    ) {
      fail(`${relativePath} changed while it was read`);
    }
    await assertSafeFileAncestors(root, path);
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    throw error;
  } finally {
    await handle.close();
  }
}

function exactPackageJson(bytes) {
  let value;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail("package.json is not strict UTF-8 JSON");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.name !== "@skill-press/cli" ||
    value.type !== "module" ||
    value.exports === null ||
    typeof value.exports !== "object" ||
    Array.isArray(value.exports) ||
    value.exports["."] === null ||
    typeof value.exports["."] !== "object" ||
    Array.isArray(value.exports["."]) ||
    Object.keys(value.exports).length !== 1 ||
    Object.keys(value.exports["."]).join("\0") !== "types\0import" ||
    value.exports["."].types !== "./dist/index.d.ts" ||
    value.exports["."].import !== "./dist/index.js" ||
    `${JSON.stringify(value, null, 2)}\n` !== text
  ) {
    fail("package.json does not expose the sole canonical CLI entry");
  }
}

function decodeStaticText(bytes, label) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail(`${label} is not strict UTF-8`);
  }
  if (source.includes("\r") || source.startsWith("\uFEFF")) {
    fail(`${label} is not canonical text`);
  }
  return source;
}

function expectedProductionKeysJavaScript(proof) {
  if (
    proof === null ||
    typeof proof !== "object" ||
    proof.status !== "verified" ||
    typeof proof.manifestSha256 !== "string" ||
    !SHA256.test(proof.manifestSha256) ||
    !Array.isArray(proof.pinnedKeys) ||
    proof.pinnedKeys.length !== 3
  ) {
    fail("the production keyring proof is not exact");
  }
  let source = `// Generated from production-public-keys.json (sha256:${proof.manifestSha256}). Do not edit.\n`;
  source += "export const SKILL_PRESS_PINNED_KEYS = Object.freeze([\n";
  for (const entry of proof.pinnedKeys) {
    source += "    Object.freeze({\n";
    source += `        keyId: ${JSON.stringify(entry.keyId)},\n`;
    source += `        roles: Object.freeze([${JSON.stringify(entry.roles[0])}]),\n`;
    source += `        validFrom: ${JSON.stringify(entry.validFrom)},\n`;
    source += `        validUntil: ${JSON.stringify(entry.validUntil)},\n`;
    if (entry.minimumTrustSequence !== undefined) {
      source += `        minimumTrustSequence: ${entry.minimumTrustSequence},\n`;
    }
    source += "        jwk: Object.freeze({\n";
    source += '            kty: "EC",\n            crv: "P-256",\n';
    source += `            x: ${JSON.stringify(entry.jwk.x)},\n`;
    source += `            y: ${JSON.stringify(entry.jwk.y)},\n`;
    source += "        }),\n    }),\n";
  }
  source += "]);\n//# sourceMappingURL=production-keys.js.map";
  return Buffer.from(source, "utf8");
}

function exactOccurrence(source, expected, label) {
  if (
    source.indexOf(expected) === -1 ||
    source.indexOf(expected) !== source.lastIndexOf(expected)
  ) {
    fail(`${label} is not the sole canonical occurrence`);
  }
}

function assertStaticBindings(files, proof) {
  exactPackageJson(files.get("package.json"));
  const expectedKeys = expectedProductionKeysJavaScript(proof);
  try {
    if (!files.get("dist/install/production-keys.js").equals(expectedKeys)) {
      fail("the built production keyring is not the exact manifest projection");
    }
  } finally {
    expectedKeys.fill(0);
  }

  const rootIndex = decodeStaticText(files.get("dist/index.js"), "dist/index.js");
  const rootExport = 'export { SKILL_PRESS_PINNED_KEYS } from "./install/production-keys.js";';
  exactOccurrence(rootIndex, rootExport, "root production keyring export");
  if (
    !rootIndex.startsWith(`${rootExport}\n`) ||
    (rootIndex.match(/\bSKILL_PRESS_PINNED_KEYS\b/gu) ?? []).length !== 1 ||
    /\bexport\s*\*/u.test(rootIndex)
  ) {
    fail("the root production keyring export is alternate, shadowed, or ambiguous");
  }
  const rootDeclaration = decodeStaticText(files.get("dist/index.d.ts"), "dist/index.d.ts");
  exactOccurrence(rootDeclaration, rootExport, "root production keyring declaration export");
  if (
    !rootDeclaration.startsWith(`${rootExport}\n`) ||
    (rootDeclaration.match(/\bSKILL_PRESS_PINNED_KEYS\b/gu) ?? []).length !== 1 ||
    /\bexport\s*\*/u.test(rootDeclaration)
  ) {
    fail("the root production keyring declaration is alternate, shadowed, or ambiguous");
  }

  const signatures = decodeStaticText(
    files.get("dist/install/signatures.js"),
    "dist/install/signatures.js",
  );
  const importLine = 'import { SKILL_PRESS_PINNED_KEYS } from "./production-keys.js";';
  const exportLine = 'export { SKILL_PRESS_PINNED_KEYS } from "./production-keys.js";';
  const verifierDefault =
    "export async function createTrustedSignatureVerifier(suppliedKeys = SKILL_PRESS_PINNED_KEYS, now = () => new Date()) {";
  exactOccurrence(signatures, importLine, "runtime production keyring import");
  exactOccurrence(signatures, exportLine, "runtime production keyring re-export");
  exactOccurrence(signatures, verifierDefault, "runtime verifier default keyring");
  if (
    (signatures.match(/\bSKILL_PRESS_PINNED_KEYS\b/gu) ?? []).length !== 3 ||
    (signatures.match(/["'][.]\/production-keys[.]js["']/gu) ?? []).length !== 2 ||
    /\bexport\s*\*/u.test(signatures) ||
    /\bimport\s*\(/u.test(signatures) ||
    /\brequire\s*\(/u.test(signatures) ||
    /["']skill-press-[a-z0-9._-]*p256[a-z0-9._-]*["']/u.test(signatures) ||
    /["'][A-Za-z0-9_-]{43}["']/u.test(signatures)
  ) {
    fail("the runtime verifier has an alternate, inline, or ambiguous production keyring");
  }
}

async function captureExpected(rootPath, paths, proof) {
  const root = await canonicalRoot(rootPath, "expected package root");
  const directories = await directoryRecordsForPaths(root, paths);
  const files = new Map();
  let totalBytes = 0;
  try {
    for (const path of paths) {
      const bytes = await readStableFile(root, path);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAXIMUM_TOTAL_BYTES) {
        bytes.fill(0);
        fail("the expected package exceeds the aggregate byte bound");
      }
      files.set(path, bytes);
    }
    for (const path of paths) {
      const second = await readStableFile(root, path);
      try {
        if (!second.equals(files.get(path)))
          fail(`${path} changed during the closing snapshot pass`);
      } finally {
        second.fill(0);
      }
    }
    await assertStableDirectories(directories);
    await assertStableRoot(root, "expected package root");
    assertStaticBindings(files, proof);
    return { files, paths, totalBytes };
  } catch (error) {
    for (const bytes of files.values()) bytes.fill(0);
    throw error;
  }
}

async function assertOwnerControlledDescendants(anchor, root) {
  const remainder = relative(anchor.path, root.path);
  if (!isContainedRelativePath(remainder))
    fail("installed package root escaped its private anchor");
  const parts = remainder.split(sep);
  let current = anchor.path;
  for (const part of parts) {
    current = join(current, part);
    const [resolved, metadata] = await Promise.all([realpath(current), lstat(current)]);
    if (resolved !== current || !safeDirectory(metadata)) {
      fail("the installed package path contains an unsafe directory");
    }
  }
}

async function installedPaths(root) {
  const paths = [];
  const directories = [];
  let entryCount = 0;
  async function walk(directory, prefix, depth) {
    if (depth > 32) fail("the installed package tree is too deep");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAXIMUM_FILES * 2) fail("the installed package tree has too many entries");
      if (!safePackagePath(entry.name)) fail("the installed package tree has an unsafe entry name");
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      const resolved = await realpath(path);
      if (resolved !== path) fail(`${relativePath} is not canonical`);
      if (entry.isDirectory()) {
        const metadata = await lstat(path);
        if (!safeDirectory(metadata)) fail(`${relativePath} is an unsafe directory`);
        directories.push(Object.freeze({ metadata, path }));
        await walk(path, relativePath, depth + 1);
      } else if (entry.isFile()) {
        paths.push(relativePath);
      } else {
        fail(`${relativePath} is not a regular file or directory`);
      }
    }
  }
  await walk(root.path, "", 0);
  return Object.freeze({ directories: Object.freeze(directories), paths: sortedPaths(paths) });
}

function consumeSnapshot(capability) {
  if (
    capability === null ||
    typeof capability !== "object" ||
    isProxy(capability) ||
    Object.getPrototypeOf(capability) !== null ||
    !Object.isFrozen(capability) ||
    Reflect.ownKeys(capability).length !== 0
  ) {
    fail("the package snapshot capability is not exact");
  }
  const state = snapshots.get(capability);
  if (state === undefined || state.active !== true || state.consumed !== false) {
    fail("the package snapshot capability is inactive or consumed");
  }
  state.consumed = true;
  return state;
}

export async function verifyInstalledPackageArtifactSnapshot(...inputs) {
  if (inputs.length !== 3) fail("installed verification inputs are not exact");
  const state = consumeSnapshot(inputs[0]);
  const anchor = await canonicalRoot(inputs[1], "private installation anchor");
  const installed = await canonicalRoot(inputs[2], "installed package root");
  await assertOwnerControlledDescendants(anchor, installed);
  const inventory = await installedPaths(installed);
  const actualPaths = inventory.paths;
  if (
    actualPaths.length !== state.paths.length ||
    actualPaths.some((path, index) => path !== state.paths[index])
  ) {
    fail("the installed package file inventory differs from npm pack");
  }
  const artifacts = [];
  let totalBytes = 0;
  for (const path of state.paths) {
    const bytes = await readStableFile(installed, path);
    try {
      totalBytes += bytes.byteLength;
      if (totalBytes > MAXIMUM_TOTAL_BYTES || !bytes.equals(state.files.get(path))) {
        fail(`${path} differs between the captured build and installed package`);
      }
      artifacts.push(
        Object.freeze({
          bytes: bytes.byteLength,
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
    } finally {
      bytes.fill(0);
    }
  }
  for (const path of state.paths) {
    const closingBytes = await readStableFile(installed, path);
    try {
      if (!closingBytes.equals(state.files.get(path))) {
        fail(`${path} changed during the installed closing pass`);
      }
    } finally {
      closingBytes.fill(0);
    }
  }
  await assertStableDirectories(inventory.directories);
  await assertStableRoot(anchor, "private installation anchor");
  await assertStableRoot(installed, "installed package root");
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    files: artifacts.length,
    status: "verified",
    totalBytes,
  });
}

export async function withCapturedPackageArtifactSnapshot(...inputs) {
  if (inputs.length !== 4 || typeof inputs[3] !== "function" || isProxy(inputs[3])) {
    fail("snapshot inputs are not exact");
  }
  const paths = sortedPaths(inputs[1]);
  const state = await captureExpected(inputs[0], paths, inputs[2]);
  state.active = true;
  state.consumed = false;
  const capability = Object.freeze(Object.create(null));
  snapshots.set(capability, state);
  let operationError;
  let operationFailed = false;
  let operationResult;
  try {
    try {
      operationResult = await inputs[3](capability);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
  } finally {
    state.active = false;
    snapshots.delete(capability);
    for (const bytes of state.files.values()) bytes.fill(0);
    state.files.clear();
  }
  if (operationFailed) throw operationError;
  if (operationResult !== undefined || state.consumed !== true) {
    fail("the package snapshot operation did not consume its authority exactly once");
  }
}
