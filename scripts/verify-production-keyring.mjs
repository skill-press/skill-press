#!/usr/bin/env node

import { createHash, webcrypto } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const { subtle } = webcrypto;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const MAXIMUM_MANIFEST_BYTES = 16 * 1024;
const MAXIMUM_SOURCE_BYTES = 128 * 1024;
const MAXIMUM_SIGNATURES_BYTES = 128 * 1024;
const MAXIMUM_INDEX_BYTES = 512 * 1024;
const MANIFEST_PATH = "production-public-keys.json";
const SOURCE_PATH = "src/install/production-keys.ts";
const SIGNATURES_PATH = "src/install/signatures.ts";
const INSTALL_INDEX_PATH = "src/install/index.ts";
const ROOT_INDEX_PATH = "src/index.ts";
const SHA256 = /^[a-f0-9]{64}$/u;
const COORDINATE = /^[A-Za-z0-9_-]{43}$/u;
const INLINE_KEY_ID = /["']skill-press-[a-z0-9._-]*p256[a-z0-9._-]*["']/u;
const INLINE_COORDINATE = /["'][A-Za-z0-9_-]{43}["']/u;
const TOP_LEVEL_FIELDS = Object.freeze(["schemaVersion", "keyringType", "keys"]);
const JWK_FIELDS = Object.freeze(["kty", "crv", "x", "y"]);
const ATTESTATION_FIELDS = Object.freeze([
  "role",
  "binding",
  "keyId",
  "validFrom",
  "validUntil",
  "jwk",
  "thumbprintSha256",
]);
const SEQUENCED_FIELDS = Object.freeze([
  "role",
  "binding",
  "keyId",
  "validFrom",
  "validUntil",
  "minimumTrustSequence",
  "jwk",
  "thumbprintSha256",
]);
const PRODUCTION_KEY_SPECS = Object.freeze([
  Object.freeze({
    role: "release-attestation",
    binding: "ATTESTATION_SIGNING_PRIVATE_JWK",
    keyId: "skill-press-attestation-p256-2026-08-28",
    validFrom: "2026-08-28T00:00:00.000Z",
    validUntil: "2027-08-31T23:59:59.999Z",
  }),
  Object.freeze({
    role: "trust-event",
    binding: "TRUST_SIGNING_PRIVATE_JWK",
    keyId: "skill-press-trust-p256-2026-08-28",
    validFrom: "2026-08-28T00:00:00.000Z",
    validUntil: "2027-08-31T23:59:59.999Z",
    minimumTrustSequence: 1,
  }),
  Object.freeze({
    role: "current-trust",
    binding: "CHECKPOINT_SIGNING_PRIVATE_JWK",
    keyId: "skill-press-checkpoint-p256-2026-08-28",
    validFrom: "2026-08-28T00:00:00.000Z",
    validUntil: "2027-08-31T23:59:59.999Z",
    minimumTrustSequence: 1,
  }),
]);
export const RETIRED_PRODUCTION_KEY_IDS = Object.freeze([
  "skill-press-p256-2026-08-01",
  "skill-press-trust-p256-2026-08-27",
  "skill-press-checkpoint-p256-2026-08-27",
]);

function fail(message) {
  throw new Error(`Production keyring verification failed: ${message}`);
}

function exactOrderedFields(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is not an exact object`);
  }
  const fields = Object.keys(value);
  if (fields.length !== expected.length) fail(`${label} has an unexpected field set`);
  for (let index = 0; index < expected.length; index += 1) {
    if (fields[index] !== expected[index]) fail(`${label} fields are not in canonical order`);
  }
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

export function isReviewedRelativePath(value, separator, absolute) {
  return (
    typeof value === "string" &&
    (separator === "/" || separator === "\\") &&
    absolute === false &&
    value !== "" &&
    value !== ".." &&
    !value.startsWith(`..${separator}`)
  );
}

async function readReviewedFile(root, relativePath, maximumBytes) {
  const path = resolve(root, relativePath);
  const remainder = relative(root, path);
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    dirname(path) === path ||
    !isReviewedRelativePath(remainder, sep, isAbsolute(remainder))
  ) {
    fail("a reviewed path escaped the repository root");
  }
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
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      (before.mode & 0o022) !== 0 ||
      before.size < 2 ||
      before.size > maximumBytes
    ) {
      fail(`${relativePath} has unsafe storage or size`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathMetadata = await lstat(path);
    if (
      bytes.byteLength !== before.size ||
      !sameIdentity(before, after) ||
      !sameIdentity(before, pathMetadata) ||
      (await realpath(path)) !== path
    ) {
      bytes.fill(0);
      fail(`${relativePath} changed while it was read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function canonicalCoordinate(value, label) {
  if (typeof value !== "string" || !COORDINATE.test(value))
    fail(`${label} is not canonical base64url`);
  const bytes = Buffer.from(value, "base64url");
  try {
    if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value) {
      fail(`${label} is not a 32-byte P-256 coordinate`);
    }
  } finally {
    bytes.fill(0);
  }
  return value;
}

function thumbprint(jwk) {
  return createHash("sha256")
    .update(JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y }), "utf8")
    .digest("hex");
}

async function verifiedEntry(value, spec, index) {
  const sequenced = spec.minimumTrustSequence !== undefined;
  exactOrderedFields(value, sequenced ? SEQUENCED_FIELDS : ATTESTATION_FIELDS, `keys[${index}]`);
  if (
    value.role !== spec.role ||
    value.binding !== spec.binding ||
    value.keyId !== spec.keyId ||
    value.validFrom !== spec.validFrom ||
    value.validUntil !== spec.validUntil ||
    (sequenced && value.minimumTrustSequence !== 1)
  ) {
    fail(`keys[${index}] does not match the sole launch key policy`);
  }
  exactOrderedFields(value.jwk, JWK_FIELDS, `keys[${index}].jwk`);
  const jwk = Object.freeze({
    kty: value.jwk.kty,
    crv: value.jwk.crv,
    x: canonicalCoordinate(value.jwk.x, `keys[${index}].jwk.x`),
    y: canonicalCoordinate(value.jwk.y, `keys[${index}].jwk.y`),
  });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") fail(`keys[${index}] is not EC P-256`);
  try {
    await subtle.importKey(
      "jwk",
      { ...jwk, ext: true, key_ops: ["verify"] },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    fail(`keys[${index}] is not a valid P-256 point`);
  }
  const expectedThumbprint = thumbprint(jwk);
  if (typeof value.thumbprintSha256 !== "string" || !SHA256.test(value.thumbprintSha256)) {
    fail(`keys[${index}] thumbprint is malformed`);
  }
  if (value.thumbprintSha256 !== expectedThumbprint)
    fail(`keys[${index}] thumbprint does not match its JWK`);
  return Object.freeze({ ...value, jwk });
}

function renderSource(keys, manifestSha256) {
  let source = 'import type { SkillPressPinnedKey } from "./types.js";\n\n';
  source += `// Generated from production-public-keys.json (sha256:${manifestSha256}). Do not edit.\n`;
  source +=
    "export const SKILL_PRESS_PINNED_KEYS: readonly SkillPressPinnedKey[] = Object.freeze([\n";
  for (const entry of keys) {
    source += "  Object.freeze({\n";
    source += `    keyId: ${JSON.stringify(entry.keyId)},\n`;
    source += `    roles: Object.freeze([${JSON.stringify(entry.role)}] as const),\n`;
    source += `    validFrom: ${JSON.stringify(entry.validFrom)},\n`;
    source += `    validUntil: ${JSON.stringify(entry.validUntil)},\n`;
    if (entry.minimumTrustSequence !== undefined) {
      source += `    minimumTrustSequence: ${entry.minimumTrustSequence},\n`;
    }
    source += "    jwk: Object.freeze({\n";
    source += '      kty: "EC" as const,\n      crv: "P-256" as const,\n';
    source += `      x: ${JSON.stringify(entry.jwk.x)},\n      y: ${JSON.stringify(entry.jwk.y)},\n`;
    source += "    }),\n  }),\n";
  }
  source += "]);\n";
  return Buffer.from(source, "utf8");
}

function singleOccurrence(source, expected, label) {
  if (
    source.indexOf(expected) === -1 ||
    source.indexOf(expected) !== source.lastIndexOf(expected)
  ) {
    fail(`${label} is not the sole canonical occurrence`);
  }
}

function assertCanonicalSignaturesSource(bytes) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail(`${SIGNATURES_PATH} is not valid UTF-8`);
  }
  if (source.includes("\r")) fail(`${SIGNATURES_PATH} does not use canonical newlines`);
  const importLine = 'import { SKILL_PRESS_PINNED_KEYS } from "./production-keys.js";';
  const exportLine = 'export { SKILL_PRESS_PINNED_KEYS } from "./production-keys.js";';
  const defaultLine = "  suppliedKeys: readonly SkillPressPinnedKey[] = SKILL_PRESS_PINNED_KEYS,";
  singleOccurrence(source, importLine, "production keyring import");
  singleOccurrence(source, exportLine, "production keyring re-export");
  singleOccurrence(source, defaultLine, "production verifier default keyring");
  if (
    source.indexOf(importLine) > source.indexOf(exportLine) ||
    source.indexOf(exportLine) > source.indexOf(defaultLine)
  ) {
    fail("production keyring import, re-export, and verifier use are not in canonical order");
  }
  if ((source.match(/\bSKILL_PRESS_PINNED_KEYS\b/gu) ?? []).length !== 3) {
    fail("signatures.ts does not use the generated keyring through only the canonical path");
  }
  if ((source.match(/["']\.\/production-keys[.]js["']/gu) ?? []).length !== 2) {
    fail("signatures.ts has an alternate production keyring module path");
  }
  const expectedModules = Object.freeze([
    "node:crypto",
    "./contract.js",
    "./errors.js",
    "./production-keys.js",
    "./types.js",
    "./production-keys.js",
  ]);
  const actualModules = [...source.matchAll(/\bfrom\s+"([^"]+)";/gu)].map((match) => match[1]);
  if (
    actualModules.length !== expectedModules.length ||
    actualModules.some((module, index) => module !== expectedModules[index]) ||
    /\bimport\s*\(/u.test(source) ||
    /\brequire\s*\(/u.test(source)
  ) {
    fail("signatures.ts imports an alternate runtime keyring path");
  }
  singleOccurrence(
    source,
    "  for (const supplied of suppliedKeys) {",
    "production verifier keyring traversal",
  );
  if (/\bsuppliedKeys\s*=/u.test(source)) {
    fail("signatures.ts reassigns the verified production keyring");
  }
  if (
    RETIRED_PRODUCTION_KEY_IDS.some((keyId) => source.includes(keyId)) ||
    INLINE_KEY_ID.test(source) ||
    INLINE_COORDINATE.test(source)
  ) {
    fail("signatures.ts contains an inline or retired signing key fallback");
  }
}

function decodeCanonicalSource(bytes, path) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail(`${path} is not valid UTF-8`);
  }
  if (source.includes("\r")) fail(`${path} does not use canonical newlines`);
  return source;
}

function assertCanonicalKeyringExportSource(bytes, path, expectedLine, expectedModule, first) {
  const source = decodeCanonicalSource(bytes, path);
  singleOccurrence(source, expectedLine, `${path} production keyring export`);
  if (first && !source.startsWith(`${expectedLine}\n`)) {
    fail(`${path} does not establish the production keyring as its first runtime dependency`);
  }
  if (
    (source.match(/\bSKILL_PRESS_PINNED_KEYS\b/gu) ?? []).length !== 1 ||
    (source.match(new RegExp(`["']${expectedModule.replaceAll(".", "[.]")}["']`, "gu")) ?? [])
      .length !== 1 ||
    /\bexport\s*\*/u.test(source) ||
    RETIRED_PRODUCTION_KEY_IDS.some((keyId) => source.includes(keyId)) ||
    INLINE_KEY_ID.test(source) ||
    INLINE_COORDINATE.test(source)
  ) {
    fail(`${path} has an alternate, shadowed, inline, or ambiguous production keyring export`);
  }
}

function runtimeProjection(keys) {
  return Object.freeze(
    keys.map((entry) =>
      Object.freeze({
        keyId: entry.keyId,
        roles: Object.freeze([entry.role]),
        validFrom: entry.validFrom,
        validUntil: entry.validUntil,
        ...(entry.minimumTrustSequence === undefined
          ? {}
          : { minimumTrustSequence: entry.minimumTrustSequence }),
        jwk: Object.freeze({
          kty: entry.jwk.kty,
          crv: entry.jwk.crv,
          x: entry.jwk.x,
          y: entry.jwk.y,
        }),
      }),
    ),
  );
}

export async function verifyProductionKeyring(repositoryRoot = REPOSITORY_ROOT) {
  const root = resolve(repositoryRoot);
  if (root !== repositoryRoot || (await realpath(root)) !== root)
    fail("repository root is not canonical");
  const rootMetadata = await lstat(root);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    (rootMetadata.mode & 0o022) !== 0
  ) {
    fail("repository root is not an owner-controlled directory");
  }
  let manifestBytes;
  let sourceBytes;
  let signaturesBytes;
  let installIndexBytes;
  let rootIndexBytes;
  let expectedSource;
  try {
    [manifestBytes, sourceBytes, signaturesBytes, installIndexBytes, rootIndexBytes] =
      await Promise.all([
        readReviewedFile(root, MANIFEST_PATH, MAXIMUM_MANIFEST_BYTES),
        readReviewedFile(root, SOURCE_PATH, MAXIMUM_SOURCE_BYTES),
        readReviewedFile(root, SIGNATURES_PATH, MAXIMUM_SIGNATURES_BYTES),
        readReviewedFile(root, INSTALL_INDEX_PATH, MAXIMUM_INDEX_BYTES),
        readReviewedFile(root, ROOT_INDEX_PATH, MAXIMUM_INDEX_BYTES),
      ]);
    assertCanonicalSignaturesSource(signaturesBytes);
    assertCanonicalKeyringExportSource(
      installIndexBytes,
      INSTALL_INDEX_PATH,
      'export { SKILL_PRESS_PINNED_KEYS } from "./signatures.js";',
      "./signatures.js",
      false,
    );
    assertCanonicalKeyringExportSource(
      rootIndexBytes,
      ROOT_INDEX_PATH,
      'export { SKILL_PRESS_PINNED_KEYS } from "./install/production-keys.js";',
      "./install/production-keys.js",
      true,
    );
    let manifestText;
    let manifest;
    try {
      manifestText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        manifestBytes,
      );
      manifest = JSON.parse(manifestText);
    } catch {
      fail("production-public-keys.json is not valid UTF-8 JSON");
    }
    exactOrderedFields(manifest, TOP_LEVEL_FIELDS, "manifest");
    if (
      manifest.schemaVersion !== 1 ||
      manifest.keyringType !== "skillpress.production-signing-keyring" ||
      !Array.isArray(manifest.keys) ||
      manifest.keys.length !== PRODUCTION_KEY_SPECS.length ||
      `${JSON.stringify(manifest, null, 2)}\n` !== manifestText
    ) {
      fail("manifest is not the sole canonical three-key production keyring");
    }
    const keys = [];
    for (let index = 0; index < PRODUCTION_KEY_SPECS.length; index += 1) {
      const entry = await verifiedEntry(manifest.keys[index], PRODUCTION_KEY_SPECS[index], index);
      for (let prior = 0; prior < keys.length; prior += 1) {
        if (
          entry.thumbprintSha256 === keys[prior].thumbprintSha256 ||
          (entry.jwk.x === keys[prior].jwk.x && entry.jwk.y === keys[prior].jwk.y)
        ) {
          fail("production roles do not use three independent keys");
        }
      }
      keys.push(entry);
    }
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    expectedSource = renderSource(keys, manifestSha256);
    if (!sourceBytes.equals(expectedSource)) {
      fail("generated CLI keyring does not exactly match the reviewed production manifest");
    }
    const result = Object.freeze({
      status: "verified",
      manifestSha256,
      keyIds: Object.freeze(keys.map((entry) => entry.keyId)),
      pinnedKeys: runtimeProjection(keys),
    });
    return result;
  } finally {
    manifestBytes?.fill(0);
    sourceBytes?.fill(0);
    signaturesBytes?.fill(0);
    installIndexBytes?.fill(0);
    rootIndexBytes?.fill(0);
    expectedSource?.fill(0);
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const quiet = process.argv.length === 3 && process.argv[2] === "--quiet";
  if (process.argv.length > (quiet ? 3 : 2)) {
    process.stderr.write("Usage: verify-production-keyring.mjs [--quiet]\n");
    process.exitCode = 1;
  } else {
    verifyProductionKeyring()
      .then((result) => {
        if (!quiet) process.stdout.write(`${JSON.stringify(result)}\n`);
      })
      .catch((error) => {
        process.stderr.write(
          `${error instanceof Error ? error.message : "Production keyring verification failed"}\n`,
        );
        process.exitCode = 1;
      });
  }
}
