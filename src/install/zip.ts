import { TextDecoder } from "node:util";

import { profileObservedResourceName } from "../validate/resource-name-profile.js";
import { TrustedInstallError } from "./errors.js";

export interface StoredArchiveFile {
  readonly relativePath: string;
  readonly contents: Buffer;
  readonly executable: boolean;
}

export interface StoredSkillArchive {
  readonly files: readonly StoredArchiveFile[];
  readonly totalBytes: number;
}

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ENTRIES = 2048;
export const MAX_PATH_BYTES = 4096;
export const MAX_PATH_COMPONENTS = 32;
export const MAX_CENTRAL_DIRECTORY_BYTES = 2 * 1024 * 1024;
const RESERVED_INSTALL_PATHS = new Set([
  ".skill-press-installing-SKILL.md",
  ".skill-press-installing.json",
]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  CRC_TABLE[index] = value >>> 0;
}

function invalid(message: string): never {
  throw new TrustedInstallError("artifact_invalid", message);
}

function range(bytes: Buffer, offset: number, length: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset <= bytes.byteLength - length
  );
}

function u16(bytes: Buffer, offset: number): number {
  return range(bytes, offset, 2) ? bytes.readUInt16LE(offset) : invalid("The ZIP is truncated.");
}

function u32(bytes: Buffer, offset: number): number {
  return range(bytes, offset, 4) ? bytes.readUInt32LE(offset) : invalid("The ZIP is truncated.");
}

function slice(bytes: Buffer, offset: number, length: number): Buffer {
  return range(bytes, offset, length)
    ? bytes.subarray(offset, offset + length)
    : invalid("The ZIP contains an out-of-range field.");
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  return (crc ^ 0xffffffff) >>> 0;
}

interface PathState {
  readonly kinds: Map<string, "directory" | "file">;
  readonly portableNames: Map<string, Map<string, string>>;
}

function profileComponent(component: string): { readonly key: string } {
  let profile: ReturnType<typeof profileObservedResourceName>;
  try {
    profile = profileObservedResourceName(component);
  } catch {
    return invalid("The ZIP contains a component that cannot be safely profiled.");
  }
  if (!profile.ok || !profile.isNfc) {
    invalid("The ZIP contains a non-portable or non-NFC path component.");
  }
  return profile;
}

const RESERVED_INSTALL_KEYS = new Set(
  [...RESERVED_INSTALL_PATHS].map((path) => profileComponent(path).key),
);

function isReservedInstallPath(relativePath: string): boolean {
  return (
    !relativePath.includes("/") && RESERVED_INSTALL_KEYS.has(profileComponent(relativePath).key)
  );
}

function validatePath(nameBytes: Buffer, expectedSkill: string, state: PathState): string {
  if (nameBytes.byteLength < 1 || nameBytes.byteLength > MAX_PATH_BYTES) {
    invalid("The ZIP contains an invalid path length.");
  }
  let name: string;
  try {
    name = UTF8.decode(nameBytes);
  } catch {
    return invalid("The ZIP contains an invalid UTF-8 path.");
  }
  if (
    Buffer.from(name, "utf8").compare(nameBytes) !== 0 ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    invalid("The ZIP contains an ambiguous path encoding.");
  }
  const components = name.split("/");
  if (
    components.length < 2 ||
    components.length > MAX_PATH_COMPONENTS ||
    components[0] !== expectedSkill
  ) {
    invalid("The ZIP must contain one canonical skill root.");
  }

  let parent = "";
  let current = "";
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index] as string;
    const profile = profileComponent(component);
    const siblings = state.portableNames.get(parent) ?? new Map<string, string>();
    const prior = siblings.get(profile.key);
    if (prior !== undefined && prior !== component) {
      invalid("The ZIP contains a case-folded or Unicode-confusable path collision.");
    }
    siblings.set(profile.key, component);
    state.portableNames.set(parent, siblings);
    current = current === "" ? component : `${current}/${component}`;
    const final = index === components.length - 1;
    const kind = state.kinds.get(current);
    if (final) {
      if (kind !== undefined) invalid("The ZIP contains a duplicate or file/directory collision.");
      state.kinds.set(current, "file");
    } else {
      if (kind === "file") invalid("The ZIP contains a file/directory collision.");
      state.kinds.set(current, "directory");
    }
    parent = current;
  }
  return components.slice(1).join("/");
}

/** Parse the exact deterministic, UTF-8, stored ZIP format emitted by `skpress package`. */
export function parseStoredSkillArchive(bytes: Buffer, expectedSkill: string): StoredSkillArchive {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 22 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new TrustedInstallError("artifact_oversized", "The skill ZIP has an invalid size.");
  }
  const endOffset = bytes.byteLength - 22;
  if (
    u32(bytes, endOffset) !== 0x06054b50 ||
    u16(bytes, endOffset + 4) !== 0 ||
    u16(bytes, endOffset + 6) !== 0 ||
    u16(bytes, endOffset + 20) !== 0
  ) {
    invalid("The ZIP end record is not canonical.");
  }
  const diskEntries = u16(bytes, endOffset + 8);
  const entryCount = u16(bytes, endOffset + 10);
  const centralSize = u32(bytes, endOffset + 12);
  const centralOffset = u32(bytes, endOffset + 16);
  if (
    entryCount < 1 ||
    entryCount > MAX_ENTRIES ||
    centralSize > MAX_CENTRAL_DIRECTORY_BYTES ||
    diskEntries !== entryCount ||
    centralOffset + centralSize !== endOffset ||
    centralOffset > endOffset
  ) {
    invalid("The ZIP central directory is invalid or exceeds installation limits.");
  }

  const files: StoredArchiveFile[] = [];
  const pathState: PathState = { kinds: new Map(), portableNames: new Map() };
  let centralCursor = centralOffset;
  let localCursor = 0;
  let totalBytes = 0;
  let priorName: Buffer | undefined;
  let hasSkillDocument = false;
  for (let ordinal = 0; ordinal < entryCount; ordinal += 1) {
    if (!range(bytes, centralCursor, 46) || u32(bytes, centralCursor) !== 0x02014b50) {
      invalid("The ZIP central directory entry is truncated or invalid.");
    }
    const versionMadeBy = u16(bytes, centralCursor + 4);
    const versionNeeded = u16(bytes, centralCursor + 6);
    const flags = u16(bytes, centralCursor + 8);
    const method = u16(bytes, centralCursor + 10);
    const modifiedTime = u16(bytes, centralCursor + 12);
    const modifiedDate = u16(bytes, centralCursor + 14);
    const expectedCrc = u32(bytes, centralCursor + 16);
    const compressedSize = u32(bytes, centralCursor + 20);
    const uncompressedSize = u32(bytes, centralCursor + 24);
    const nameLength = u16(bytes, centralCursor + 28);
    const extraLength = u16(bytes, centralCursor + 30);
    const commentLength = u16(bytes, centralCursor + 32);
    const disk = u16(bytes, centralCursor + 34);
    const internalAttributes = u16(bytes, centralCursor + 36);
    const externalAttributes = u32(bytes, centralCursor + 38);
    const localOffset = u32(bytes, centralCursor + 42);
    const mode = externalAttributes >>> 16;
    if (
      versionMadeBy !== 0x0314 ||
      versionNeeded !== 20 ||
      flags !== 0x0800 ||
      method !== 0 ||
      modifiedTime !== 0 ||
      modifiedDate !== 33 ||
      compressedSize !== uncompressedSize ||
      uncompressedSize > MAX_FILE_BYTES ||
      nameLength < 1 ||
      extraLength !== 0 ||
      commentLength !== 0 ||
      disk !== 0 ||
      internalAttributes !== 0 ||
      (externalAttributes & 0xffff) !== 0 ||
      (mode !== 0o100644 && mode !== 0o100755) ||
      localOffset !== localCursor
    ) {
      invalid("The ZIP contains a non-deterministic, compressed, linked, or unsafe entry.");
    }
    const nameBytes = slice(bytes, centralCursor + 46, nameLength);
    if (priorName !== undefined && Buffer.compare(priorName, nameBytes) >= 0) {
      invalid("The ZIP entries are duplicated or not in deterministic byte order.");
    }
    priorName = nameBytes;
    centralCursor += 46 + nameLength;

    if (!range(bytes, localCursor, 30) || u32(bytes, localCursor) !== 0x04034b50) {
      invalid("The ZIP local entry is truncated or invalid.");
    }
    if (
      u16(bytes, localCursor + 4) !== versionNeeded ||
      u16(bytes, localCursor + 6) !== flags ||
      u16(bytes, localCursor + 8) !== method ||
      u16(bytes, localCursor + 10) !== modifiedTime ||
      u16(bytes, localCursor + 12) !== modifiedDate ||
      u32(bytes, localCursor + 14) !== expectedCrc ||
      u32(bytes, localCursor + 18) !== compressedSize ||
      u32(bytes, localCursor + 22) !== uncompressedSize ||
      u16(bytes, localCursor + 26) !== nameLength ||
      u16(bytes, localCursor + 28) !== 0
    ) {
      invalid("The ZIP local entry does not match its central directory.");
    }
    const localName = slice(bytes, localCursor + 30, nameLength);
    if (!localName.equals(nameBytes)) invalid("The ZIP contains inconsistent entry names.");
    const contents = slice(bytes, localCursor + 30 + nameLength, uncompressedSize);
    if (crc32(contents) !== expectedCrc) invalid("The ZIP contains a file with an invalid CRC-32.");
    localCursor += 30 + nameLength + uncompressedSize;
    totalBytes += uncompressedSize;
    if (totalBytes > MAX_ARCHIVE_BYTES) invalid("The ZIP expands beyond installation limits.");
    const relativePath = validatePath(nameBytes, expectedSkill, pathState);
    if (isReservedInstallPath(relativePath)) {
      invalid("The ZIP contains a Skill Press installation-reserved path.");
    }
    if (relativePath === "SKILL.md") hasSkillDocument = true;
    files.push(
      Object.freeze({
        relativePath,
        contents: Buffer.from(contents),
        executable: mode === 0o100755,
      }),
    );
  }
  if (
    centralCursor !== endOffset ||
    centralCursor - centralOffset !== centralSize ||
    localCursor !== centralOffset ||
    !hasSkillDocument
  ) {
    invalid("The ZIP layout is non-canonical or is missing its root SKILL.md.");
  }
  return Object.freeze({ files: Object.freeze(files), totalBytes });
}
