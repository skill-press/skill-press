import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalProjectRoot, prepareAtomicInstallation } from "../src/install/atomic.js";
import { createCanonicalInstallClient } from "../src/install/client.js";
import {
  parseAttestationPayload,
  parseJsonBytes,
  parseReleaseResource,
  parseSignedEnvelope,
  parseTrustPayload,
} from "../src/install/contract.js";
import {
  addTrustedSkill,
  installTrustedSkills,
  parseStoredSkillArchive,
  TrustedInstallError,
} from "../src/install/index.js";
import { isExactSemver, isSkillPressName, parseExactSkillLocator } from "../src/install/locator.js";
import {
  acquireSkillMutationLock,
  readSkillLock,
  readSkillLockSnapshot,
  withSkillLockEntry,
  writeSkillLock,
} from "../src/install/lock.js";
import { createTrustedSignatureVerifier } from "../src/install/signatures.js";
import type {
  SkillPressPinnedKey,
  SkillPressCurrentTrustCheckpoint,
  SkillPressReleaseAttestation,
  SkillPressReleaseResource,
  SkillPressSignedEnvelope,
  SkillPressTrustStatement,
} from "../src/install/types.js";

const temporaryPaths: string[] = [];
const execFileAsync = promisify(execFile);
const VALID_SKILL_DOCUMENT =
  "---\nname: example-skill\ndescription: A useful example skill for tests.\nlicense: MIT\n---\n\n# Example\n";
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  CRC_TABLE[index] = value >>> 0;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(async (path) => rm(path, { recursive: true })));
});

describe("Git-local trusted installation policy", () => {
  it("allows installation outside a Git worktree", async () => {
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    await expect(
      addTrustedSkill({
        locator: fixture.locator.locator,
        projectRoot,
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).resolves.toMatchObject({ changed: true });
    expect(fixture.calls).toHaveLength(5);
  });

  it("allows an untracked target covered by an anchored Git ignore rule", async () => {
    const projectRoot = await temporaryProject();
    await initializeGitProject(projectRoot);
    await writeFile(join(projectRoot, ".gitignore"), "/.agents/skills/\n");
    const fixture = registryFixture();
    await expect(
      addTrustedSkill({
        locator: fixture.locator.locator,
        projectRoot,
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).resolves.toMatchObject({ changed: true });
    expect(fixture.calls).toHaveLength(5);
  });

  it("rejects an unignored Git target before network or persistent mutation", async () => {
    const projectRoot = await temporaryProject();
    await initializeGitProject(projectRoot);
    const fixture = registryFixture();
    await expect(
      addTrustedSkill({
        locator: fixture.locator.locator,
        projectRoot,
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
    expect(fixture.calls).toEqual([]);
    await expect(lstat(join(projectRoot, "skill-lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(join(projectRoot, ".skill-lock.json.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(join(projectRoot, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an ignore rule that covers only SKILL.md rather than the installation tree", async () => {
    const projectRoot = await temporaryProject();
    await initializeGitProject(projectRoot);
    await writeFile(join(projectRoot, ".gitignore"), "/.agents/skills/*/SKILL.md\n");
    const fixture = registryFixture();
    await expect(
      addTrustedSkill({
        locator: fixture.locator.locator,
        projectRoot,
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
    expect(fixture.calls).toEqual([]);
    await expect(lstat(join(projectRoot, "skill-lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a tracked target even when Git ignore rules would otherwise cover it", async () => {
    const projectRoot = await temporaryProject();
    await initializeGitProject(projectRoot);
    await writeFile(join(projectRoot, ".gitignore"), "/.agents/skills/\n");
    const target = join(projectRoot, ".agents/skills/example-skill");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), VALID_SKILL_DOCUMENT);
    await execFileAsync("git", ["add", "--force", "--", ".agents/skills/example-skill/SKILL.md"], {
      cwd: projectRoot,
    });
    const fixture = registryFixture();
    await expect(
      addTrustedSkill({
        locator: fixture.locator.locator,
        projectRoot,
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
    expect(fixture.calls).toEqual([]);
    await expect(lstat(join(projectRoot, "skill-lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(target, "SKILL.md"), "utf8")).resolves.toBe(VALID_SKILL_DOCUMENT);
  });

  it("rechecks the Git policy during install before any registry request", async () => {
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    await addTrustedSkill({
      locator: fixture.locator.locator,
      projectRoot,
      fetcher: fixture.fetcher,
      keyring: [fixture.key.pinned],
      now: NOW,
    });
    const lockBefore = await readFile(join(projectRoot, "skill-lock.json"));
    await initializeGitProject(projectRoot);
    fixture.calls.splice(0);
    await expect(
      installTrustedSkills({
        projectRoot,
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
    expect(fixture.calls).toEqual([]);
    await expect(readFile(join(projectRoot, "skill-lock.json"))).resolves.toEqual(lockBefore);
    await expect(lstat(join(projectRoot, ".skill-lock.json.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["ignore-removed", "target-force-added"] as const)(
    "rechecks Git at the final publication gate when policy changes: %s",
    async (change) => {
      const projectRoot = await temporaryProject();
      await initializeGitProject(projectRoot);
      const ignorePath = join(projectRoot, ".gitignore");
      await writeFile(ignorePath, "/.agents/skills/\n");
      const fixture = registryFixture();
      const target = join(projectRoot, ".agents/skills/example-skill");
      const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === fixture.release.checkpoint.url) {
          if (change === "ignore-removed") await rm(ignorePath);
          else {
            await mkdir(target, { recursive: true });
            await writeFile(join(target, "SKILL.md"), VALID_SKILL_DOCUMENT);
            await execFileAsync(
              "git",
              ["add", "--force", "--", ".agents/skills/example-skill/SKILL.md"],
              { cwd: projectRoot },
            );
            await rm(target, { recursive: true });
          }
        }
        return fixture.fetcher(input, init);
      }) as typeof globalThis.fetch;
      await expect(
        addTrustedSkill({
          locator: fixture.locator.locator,
          projectRoot,
          fetcher,
          keyring: [fixture.key.pinned],
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: "install_path_unsafe" });
      expect((await readSkillLock(projectRoot)).skills[0]?.locator).toBe(fixture.locator.locator);
      await expect(lstat(join(target, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

async function temporaryProject(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "skillpress-install-test-"));
  temporaryPaths.push(path);
  return path;
}

async function initializeGitProject(projectRoot: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet"], { cwd: projectRoot });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipInput {
  readonly path: string;
  readonly contents: string;
  readonly mode?: number;
}

function storedZip(input: readonly ZipInput[], sorted = true): Buffer {
  const files = input.map((file) => ({
    ...file,
    name: Buffer.from(file.path),
    bytes: Buffer.from(file.contents),
  }));
  if (sorted) files.sort((left, right) => Buffer.compare(left.name, right.name));
  const body: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const crc = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.bytes.byteLength, 18);
    local.writeUInt32LE(file.bytes.byteLength, 22);
    local.writeUInt16LE(file.name.byteLength, 26);
    body.push(local, file.name, file.bytes);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(33, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(file.bytes.byteLength, 20);
    header.writeUInt32LE(file.bytes.byteLength, 24);
    header.writeUInt16LE(file.name.byteLength, 28);
    header.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, file.name);
    offset += local.byteLength + file.name.byteLength + file.bytes.byteLength;
  }
  const centralSize = central.reduce((total, part) => total + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, ...central, end]);
}

function signingKey() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const exported = pair.publicKey.export({ format: "jwk" });
  const pinned: SkillPressPinnedKey = {
    keyId: "release-2026-08",
    roles: ["release-attestation", "trust-event", "current-trust"],
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-12-31T23:59:59.999Z",
    minimumTrustSequence: 1,
    jwk: { kty: "EC", crv: "P-256", x: exported.x as string, y: exported.y as string },
  };
  const envelope = (
    type: SkillPressSignedEnvelope["envelopeType"],
    statement:
      | SkillPressCurrentTrustCheckpoint
      | SkillPressReleaseAttestation
      | SkillPressTrustStatement,
  ): SkillPressSignedEnvelope => {
    const payload = Buffer.from(JSON.stringify(statement));
    return {
      schemaVersion: 1,
      envelopeType: type,
      keyId: pinned.keyId,
      algorithm: "ES256",
      payload: payload.toString("base64url"),
      signature: sign("sha256", payload, {
        key: pair.privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url"),
    };
  };
  return { pinned, envelope };
}

interface FixtureOverrides {
  readonly locator?: string;
  readonly skillDocument?: string;
  readonly release?: (value: SkillPressReleaseResource) => unknown;
  readonly attestation?: (value: SkillPressSignedEnvelope) => unknown;
  readonly trust?: (value: SkillPressSignedEnvelope) => unknown;
  readonly checkpoint?: (value: SkillPressSignedEnvelope) => unknown;
  readonly artifact?: Buffer;
  readonly artifactResponse?: Buffer;
  readonly attestationEnvelope?: SkillPressSignedEnvelope;
  readonly attestationStatement?: (
    value: SkillPressReleaseAttestation,
  ) => SkillPressReleaseAttestation;
  readonly trustStatement?: (value: SkillPressTrustStatement) => SkillPressTrustStatement;
  readonly checkpointStatement?: (
    value: SkillPressCurrentTrustCheckpoint,
  ) => SkillPressCurrentTrustCheckpoint;
  readonly trustStatus?: "trusted" | "quarantined" | "revoked";
  readonly currentTrustStatus?: "trusted" | "quarantined" | "revoked";
  readonly trustSequence?: number;
  readonly currentTrustSequence?: number;
  readonly issuedAt?: string;
  readonly updatedAt?: string;
  readonly checkpointIssuedAt?: string;
  readonly checkpointExpiresAt?: string;
  readonly key?: ReturnType<typeof signingKey>;
}

function registryFixture(overrides: FixtureOverrides = {}) {
  const locator = parseExactSkillLocator(overrides.locator ?? "example/example-skill@1.2.3");
  const key = overrides.key ?? signingKey();
  const artifact =
    overrides.artifact ??
    storedZip([
      {
        path: `${locator.skill}/SKILL.md`,
        contents: overrides.skillDocument ?? VALID_SKILL_DOCUMENT,
      },
      { path: `${locator.skill}/scripts/run.sh`, contents: "#!/bin/sh\n", mode: 0o100755 },
    ]);
  const issuedAt = overrides.issuedAt ?? "2026-08-27T10:00:00.000Z";
  const updatedAt = overrides.updatedAt ?? "2026-08-27T11:00:00.000Z";
  const baseAttestation: SkillPressReleaseAttestation = {
    schemaVersion: 1,
    statementType: "skillpress.release-attestation",
    ...locator,
    artifactSha256: sha256(artifact),
    artifactBytes: artifact.byteLength,
    artifactMediaType: "application/zip",
    issuedAt,
    submissionId: "submission_12345678",
    automatedReviewSha256: "a".repeat(64),
    curatorDecisionSha256: "b".repeat(64),
  };
  const attestationStatement = overrides.attestationStatement?.(baseAttestation) ?? baseAttestation;
  const attestationEnvelope =
    overrides.attestationEnvelope ??
    key.envelope("skillpress.signed-attestation", attestationStatement);
  const attestationBytes = Buffer.from(JSON.stringify(attestationEnvelope));
  const status = overrides.trustStatus ?? "trusted";
  const currentStatus = overrides.currentTrustStatus ?? status;
  const sequence = overrides.trustSequence ?? 7;
  const currentSequence = overrides.currentTrustSequence ?? sequence;
  const trustBase = {
    schemaVersion: 1 as const,
    statementType: "skillpress.trust-statement" as const,
    ...locator,
    artifactSha256: sha256(artifact),
    attestationSha256: sha256(attestationBytes),
    sequence: currentSequence,
    status: currentStatus,
    updatedAt,
  };
  const baseTrustStatement: SkillPressTrustStatement =
    currentStatus === "trusted" ? trustBase : { ...trustBase, reasonCode: "security_review" };
  const trustStatement = overrides.trustStatement?.(baseTrustStatement) ?? baseTrustStatement;
  const trustEnvelope = key.envelope("skillpress.signed-trust", trustStatement);
  const checkpointBase: SkillPressCurrentTrustCheckpoint = {
    schemaVersion: 1,
    statementType: "skillpress.current-trust-checkpoint",
    ...locator,
    artifactSha256: sha256(artifact),
    attestationSha256: sha256(attestationBytes),
    trustSequence: trustStatement.sequence,
    trustStatus: trustStatement.status,
    trustUpdatedAt: trustStatement.updatedAt,
    trustEnvelopeSha256: sha256(Buffer.from(JSON.stringify(trustEnvelope))),
    issuedAt: overrides.checkpointIssuedAt ?? "2026-08-27T11:59:00.000Z",
    expiresAt: overrides.checkpointExpiresAt ?? "2026-08-27T12:10:00.000Z",
  };
  const checkpointStatement = overrides.checkpointStatement?.(checkpointBase) ?? checkpointBase;
  const checkpointEnvelope = key.envelope("skillpress.signed-current-trust", checkpointStatement);
  const path = `${locator.namespace}/${locator.skill}/${locator.version}`;
  const release: SkillPressReleaseResource = {
    schemaVersion: 1,
    resourceType: "skillpress.release",
    ...locator,
    artifact: {
      url: `https://skill-press.com/artifacts/${path}`,
      sha256: sha256(artifact),
      bytes: artifact.byteLength,
      mediaType: "application/zip",
    },
    attestation: {
      url: `https://skill-press.com/attestations/${path}`,
      sha256: sha256(attestationBytes),
      keyId: key.pinned.keyId,
      algorithm: "ES256",
    },
    trust: {
      url: `https://skill-press.com/trust/${path}`,
      sequence,
      status,
      updatedAt,
      keyId: key.pinned.keyId,
      algorithm: "ES256",
    },
    checkpoint: {
      url: `https://skill-press.com/checkpoints/${path}`,
      keyId: key.pinned.keyId,
      algorithm: "ES256",
    },
  };
  const values = new Map<string, { readonly value: unknown | Buffer; readonly type: string }>([
    [
      `https://skill-press.com/api/v1/releases/${path}`,
      { value: overrides.release?.(release) ?? release, type: "application/json" },
    ],
    [
      release.attestation.url,
      {
        value: overrides.attestation?.(attestationEnvelope) ?? attestationEnvelope,
        type: "application/json",
      },
    ],
    [
      release.artifact.url,
      { value: overrides.artifactResponse ?? artifact, type: "application/zip" },
    ],
    [
      release.trust.url,
      { value: overrides.trust?.(trustEnvelope) ?? trustEnvelope, type: "application/json" },
    ],
    [
      release.checkpoint.url,
      {
        value: overrides.checkpoint?.(checkpointEnvelope) ?? checkpointEnvelope,
        type: "application/json",
      },
    ],
  ]);
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    expect(init?.headers).toMatchObject({
      "cache-control": "no-cache, no-store, max-age=0",
      "accept-encoding": "identity",
      "skill-press-protocol-version": "1",
    });
    const match = values.get(url);
    if (match === undefined) return new Response("missing", { status: 404 });
    const body = Buffer.isBuffer(match.value)
      ? match.value
      : Buffer.from(JSON.stringify(match.value));
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": match.type,
        "content-length": String(body.byteLength),
        "cache-control": "no-store",
        age: "0",
      },
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    locator,
    key,
    artifact,
    attestationEnvelope,
    trustEnvelope,
    checkpointEnvelope,
    release,
    fetcher,
    calls,
  };
}

const NOW = () => new Date("2026-08-27T12:00:00.000Z");

describe("trusted Skill Press installation", () => {
  it("returns an immutable empty result for a project without locked skills", async () => {
    const projectRoot = await temporaryProject();
    await expect(installTrustedSkills({ projectRoot })).resolves.toEqual([]);
  });

  it("adds an exact signed release to the standard project skill path and writes a deterministic lock", async () => {
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    const result = await addTrustedSkill({
      locator: fixture.locator.locator,
      projectRoot,
      fetcher: fixture.fetcher,
      keyring: [fixture.key.pinned],
      now: NOW,
    });

    const physicalRoot = await realpath(projectRoot);
    expect(result).toMatchObject({
      changed: true,
      installedPath: join(physicalRoot, ".agents/skills/example-skill"),
    });
    await expect(readFile(join(result.installedPath, "SKILL.md"), "utf8")).resolves.toBe(
      VALID_SKILL_DOCUMENT,
    );
    expect((await lstat(result.installedPath)).isDirectory()).toBe(true);
    expect((await lstat(result.installedPath)).isSymbolicLink()).toBe(false);
    expect((await readFile(join(result.installedPath, "scripts/run.sh"))).toString()).toBe(
      "#!/bin/sh\n",
    );
    if (process.platform !== "win32") {
      expect((await stat(join(result.installedPath, "scripts/run.sh"))).mode & 0o111).not.toBe(0);
    }
    const lockBytes = await readFile(join(projectRoot, "skill-lock.json"), "utf8");
    expect(lockBytes.endsWith("\n")).toBe(true);
    expect(JSON.parse(lockBytes)).toEqual({
      schemaVersion: 1,
      lockfileType: "skillpress.lock",
      registry: { origin: "https://skill-press.com", protocolVersion: 1 },
      skills: [
        {
          locator: fixture.locator.locator,
          namespace: "example",
          skill: "example-skill",
          version: "1.2.3",
          artifact: { sha256: sha256(fixture.artifact), bytes: fixture.artifact.byteLength },
          attestation: {
            sha256: fixture.release.attestation.sha256,
            keyId: fixture.key.pinned.keyId,
          },
          trust: {
            sequence: 7,
            status: "trusted",
            keyId: fixture.key.pinned.keyId,
            sha256: sha256(Buffer.from(JSON.stringify(fixture.trustEnvelope))),
            updatedAt: "2026-08-27T11:00:00.000Z",
          },
          installedPath: ".agents/skills/example-skill",
        },
      ],
    });
    expect(fixture.calls).toEqual([
      "https://skill-press.com/api/v1/releases/example/example-skill/1.2.3",
      "https://skill-press.com/attestations/example/example-skill/1.2.3",
      "https://skill-press.com/artifacts/example/example-skill/1.2.3",
      "https://skill-press.com/trust/example/example-skill/1.2.3",
      "https://skill-press.com/checkpoints/example/example-skill/1.2.3",
    ]);
  });

  it("is idempotent, and install rehydrates only exact locked bytes after trust advances", async () => {
    const projectRoot = await temporaryProject();
    const first = registryFixture();
    await addTrustedSkill({
      locator: first.locator.locator,
      projectRoot,
      fetcher: first.fetcher,
      keyring: [first.key.pinned],
      now: NOW,
    });
    const again = await addTrustedSkill({
      locator: first.locator.locator,
      projectRoot,
      fetcher: first.fetcher,
      keyring: [first.key.pinned],
      now: NOW,
    });
    expect(again.changed).toBe(false);

    await rm(join(projectRoot, ".agents/skills/example-skill"), { recursive: true });
    const advanced = registryFixture({
      key: first.key,
      trustSequence: 8,
      artifact: first.artifact,
      attestationEnvelope: first.attestationEnvelope,
    });
    const results = await installTrustedSkills({
      projectRoot,
      fetcher: advanced.fetcher,
      keyring: [first.key.pinned],
      now: NOW,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ changed: true });
    expect((await readSkillLock(projectRoot)).skills[0]?.trust.sequence).toBe(8);
    await expect(
      readFile(join(projectRoot, ".agents/skills/example-skill/SKILL.md"), "utf8"),
    ).resolves.toContain("# Example\n");
  });

  it("commits each locked skill before resolving the next and rolls earlier commits back on failure", async () => {
    const projectRoot = await temporaryProject();
    const first = registryFixture();
    const second = registryFixture({
      locator: "zeta/second-skill@2.0.0",
      key: first.key,
      skillDocument:
        "---\nname: second-skill\ndescription: A second useful skill for tests.\nlicense: MIT\n---\n\n# Second\n",
    });
    await addTrustedSkill({
      locator: first.locator.locator,
      projectRoot,
      fetcher: first.fetcher,
      keyring: [first.key.pinned],
      now: NOW,
    });
    await addTrustedSkill({
      locator: second.locator.locator,
      projectRoot,
      fetcher: second.fetcher,
      keyring: [second.key.pinned],
      now: NOW,
    });
    const firstTarget = join(projectRoot, ".agents/skills/example-skill");
    const secondTarget = join(projectRoot, ".agents/skills/second-skill");
    await rm(firstTarget, { recursive: true });
    await rm(secondTarget, { recursive: true });

    let firstWasVisibleBeforeSecondResolve = false;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://skill-press.com/api/v1/releases/zeta/second-skill/2.0.0") {
        firstWasVisibleBeforeSecondResolve =
          (await readFile(join(firstTarget, "SKILL.md"), "utf8")) === VALID_SKILL_DOCUMENT;
        throw new Error("second registry request failed");
      }
      return url.includes("/zeta/second-skill/")
        ? second.fetcher(input, init)
        : first.fetcher(input, init);
    }) as typeof globalThis.fetch;

    await expect(
      installTrustedSkills({
        projectRoot,
        fetcher,
        keyring: [first.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "registry_unavailable" });
    expect(firstWasVisibleBeforeSecondResolve).toBe(true);
    await expect(lstat(firstTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(secondTarget)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists each observed higher trust sequence before install activation", async () => {
    const projectRoot = await temporaryProject();
    const initial = registryFixture({ trustSequence: 1, currentTrustSequence: 1 });
    await addTrustedSkill({
      locator: initial.locator.locator,
      projectRoot,
      fetcher: initial.fetcher,
      keyring: [initial.key.pinned],
      now: NOW,
    });
    await rm(join(projectRoot, ".agents/skills/example-skill"), { recursive: true });
    const advanced = registryFixture({
      key: initial.key,
      artifact: initial.artifact,
      attestationEnvelope: initial.attestationEnvelope,
      trustSequence: 3,
      currentTrustSequence: 3,
    });
    const failingCommitFetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === advanced.release.checkpoint.url) {
        const stagingRoot = join(projectRoot, ".skill-press/staging");
        const stage = (await readdir(stagingRoot)).find((name) => name.startsWith(".release-"));
        expect(stage).toBeDefined();
        await rm(join(stagingRoot, stage as string), { recursive: true });
      }
      return advanced.fetcher(input, init);
    }) as typeof globalThis.fetch;
    await expect(
      installTrustedSkills({
        projectRoot,
        fetcher: failingCommitFetcher,
        keyring: [initial.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_failed" });
    expect((await readSkillLock(projectRoot)).skills[0]?.trust.sequence).toBe(3);
    await expect(lstat(join(projectRoot, ".agents/skills/example-skill"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const replay = registryFixture({
      key: initial.key,
      artifact: initial.artifact,
      attestationEnvelope: initial.attestationEnvelope,
      trustSequence: 1,
      currentTrustSequence: 1,
    });
    await expect(
      installTrustedSkills({
        projectRoot,
        fetcher: replay.fetcher,
        keyring: [initial.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "lock_rollback" });
  });

  it("rejects a same-sequence trust envelope change even when the replacement is validly signed", async () => {
    const projectRoot = await temporaryProject();
    const first = registryFixture();
    await addTrustedSkill({
      locator: first.locator.locator,
      projectRoot,
      fetcher: first.fetcher,
      keyring: [first.key.pinned],
      now: NOW,
    });
    const replacement = registryFixture({
      key: first.key,
      artifact: first.artifact,
      attestationEnvelope: first.attestationEnvelope,
      trustSequence: 7,
    });
    expect(sha256(Buffer.from(JSON.stringify(replacement.trustEnvelope)))).not.toBe(
      sha256(Buffer.from(JSON.stringify(first.trustEnvelope))),
    );
    await expect(
      installTrustedSkills({
        projectRoot,
        fetcher: replacement.fetcher,
        keyring: [first.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "lock_rollback" });
  });

  it("rejects any resolver change to immutable bytes recorded in the lock", async () => {
    const projectRoot = await temporaryProject();
    const initial = registryFixture();
    await addTrustedSkill({
      locator: initial.locator.locator,
      projectRoot,
      fetcher: initial.fetcher,
      keyring: [initial.key.pinned],
      now: NOW,
    });
    const replacement = registryFixture({
      key: initial.key,
      artifact: storedZip([
        { path: "example-skill/SKILL.md", contents: VALID_SKILL_DOCUMENT },
        { path: "example-skill/changed.txt", contents: "changed" },
      ]),
    });
    await expect(
      installTrustedSkills({
        projectRoot,
        fetcher: replacement.fetcher,
        keyring: [initial.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "lock_invalid" });
  });

  it("never overwrites conflicting target content or a different locked exact version", async () => {
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    await mkdir(join(projectRoot, ".agents/skills/example-skill"), { recursive: true });
    await writeFile(join(projectRoot, ".agents/skills/example-skill/SKILL.md"), "untrusted");
    await expect(
      addTrustedSkill({
        locator: fixture.locator.locator,
        projectRoot,
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_conflict" });
    await expect(
      readFile(join(projectRoot, ".agents/skills/example-skill/SKILL.md"), "utf8"),
    ).resolves.toBe("untrusted");
    await expect(readFile(join(projectRoot, "skill-lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await rm(join(projectRoot, ".agents"), { recursive: true });
    await addTrustedSkill({
      locator: fixture.locator.locator,
      projectRoot,
      fetcher: fixture.fetcher,
      keyring: [fixture.key.pinned],
      now: NOW,
    });
    await expect(
      addTrustedSkill({
        locator: "example/example-skill@2.0.0",
        projectRoot,
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_conflict" });
  });

  it.each(["quarantined", "revoked"] as const)(
    "fails closed before downloading an artifact when resolver trust is %s",
    async (status) => {
      const fixture = registryFixture({ trustStatus: status });
      const client = createCanonicalInstallClient({
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      });
      await expect(client.resolve(fixture.locator.locator)).rejects.toMatchObject({
        code: "trust_rejected",
      });
      expect(fixture.calls).toHaveLength(1);
    },
  );

  it("rejects a validly signed current revocation even when the resolver summary was trusted", async () => {
    const fixture = registryFixture({ trustStatus: "trusted", currentTrustStatus: "revoked" });
    await expect(
      createCanonicalInstallClient({
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }).resolve(fixture.locator.locator),
    ).rejects.toMatchObject({ code: "trust_rejected" });
    expect(fixture.calls.at(-1)).toBe("https://skill-press.com/trust/example/example-skill/1.2.3");
  });

  it("rejects a newly revoked signed trust statement and a signed sequence rollback", async () => {
    const revoked = registryFixture({
      trust: (value) => {
        const key = signingKey();
        void key;
        return { ...value, signature: "A".repeat(86) };
      },
    });
    const client = createCanonicalInstallClient({
      fetcher: revoked.fetcher,
      keyring: [revoked.key.pinned],
      now: NOW,
    });
    await expect(client.resolve(revoked.locator.locator)).rejects.toMatchObject({
      code: "signature_invalid",
    });

    const valid = registryFixture();
    await expect(
      createCanonicalInstallClient({
        fetcher: valid.fetcher,
        keyring: [valid.key.pinned],
        now: NOW,
      }).resolve(valid.locator.locator, 8),
    ).rejects.toMatchObject({ code: "lock_rollback" });
  });

  it("rejects offline metadata/artifacts, transport deviations, digest changes, and bad signatures", async () => {
    const offline = createCanonicalInstallClient({
      fetcher: (async () => {
        throw new Error("offline detail");
      }) as typeof globalThis.fetch,
      keyring: [signingKey().pinned],
      now: NOW,
    });
    await expect(offline.resolve("example/example-skill@1.2.3")).rejects.toMatchObject({
      code: "registry_unavailable",
      message: "The canonical Skill Press registry is unavailable.",
    });

    const changedArtifact = registryFixture({ artifact: Buffer.from("not a zip") });
    const invalidRoot = await temporaryProject();
    await expect(
      addTrustedSkill({
        locator: changedArtifact.locator.locator,
        projectRoot: invalidRoot,
        fetcher: changedArtifact.fetcher,
        keyring: [changedArtifact.key.pinned],
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(TrustedInstallError);

    const badAttestation = registryFixture({
      attestation: (value) => ({ ...value, signature: "A".repeat(86) }),
    });
    await expect(
      createCanonicalInstallClient({
        fetcher: badAttestation.fetcher,
        keyring: [badAttestation.key.pinned],
        now: NOW,
      }).resolve(badAttestation.locator.locator),
    ).rejects.toMatchObject({ code: "signature_invalid" });

    const wrongUrl = registryFixture({
      release: (value) => ({
        ...value,
        artifact: { ...value.artifact, url: "https://evil.invalid/artifact" },
      }),
    });
    await expect(
      createCanonicalInstallClient({
        fetcher: wrongUrl.fetcher,
        keyring: [wrongUrl.key.pinned],
        now: NOW,
      }).resolve(wrongUrl.locator.locator),
    ).rejects.toMatchObject({ code: "registry_contract_invalid" });
  });

  it("independently validates a signed extracted Agent Skill before exposing the target", async () => {
    const projectRoot = await temporaryProject();
    const invalidSkill = registryFixture({
      artifact: storedZip([
        { path: "example-skill/SKILL.md", contents: "# Missing required frontmatter\n" },
      ]),
    });
    await expect(
      addTrustedSkill({
        locator: invalidSkill.locator.locator,
        projectRoot,
        fetcher: invalidSkill.fetcher,
        keyring: [invalidSkill.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "artifact_invalid" });
    await expect(
      readFile(join(projectRoot, ".agents/skills/example-skill/SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(projectRoot, "skill-lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed on bounded-response and transport metadata violations", async () => {
    const key = signingKey();
    const resolveWith = async (response: Response, addFreshHeaders = true) => {
      if (response.status === 200 && addFreshHeaders) {
        response.headers.set("cache-control", "no-store");
        response.headers.set("age", "0");
      }
      return createCanonicalInstallClient({
        fetcher: (async () => response) as typeof globalThis.fetch,
        keyring: [key.pinned],
        now: NOW,
      }).resolve("example/example-skill@1.2.3");
    };

    await expect(resolveWith(new Response("missing", { status: 404 }))).rejects.toMatchObject({
      code: "registry_rejected",
    });
    let canceled = false;
    const rejectedStream = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    await expect(resolveWith(new Response(rejectedStream, { status: 404 }))).rejects.toMatchObject({
      code: "registry_rejected",
    });
    expect(canceled).toBe(true);
    await expect(
      resolveWith(new Response("{}", { status: 200, headers: { "content-type": "text/plain" } })),
    ).rejects.toMatchObject({ code: "registry_contract_invalid" });
    await expect(
      resolveWith(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "content-encoding": "gzip" },
        }),
      ),
    ).rejects.toMatchObject({ code: "registry_contract_invalid" });
    await expect(
      resolveWith(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        false,
      ),
    ).rejects.toMatchObject({ code: "registry_contract_invalid" });
    await expect(
      resolveWith(
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            age: "1",
          },
        }),
        false,
      ),
    ).rejects.toMatchObject({ code: "registry_contract_invalid" });
    await expect(
      resolveWith(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "01" },
        }),
      ),
    ).rejects.toMatchObject({ code: "registry_contract_invalid" });
    await expect(
      resolveWith(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "3" },
        }),
      ),
    ).rejects.toMatchObject({ code: "registry_contract_invalid" });
    await expect(
      resolveWith(
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(256 * 1024 + 1),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "registry_contract_invalid" });
    const redirected = new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(redirected, "redirected", { value: true });
    await expect(resolveWith(redirected)).rejects.toMatchObject({
      code: "registry_contract_invalid",
    });
    await expect(
      resolveWith(
        new Response(Buffer.alloc(256 * 1024 + 1), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).rejects.toMatchObject({ code: "response_oversized" });
    await expect(
      resolveWith(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("interrupted"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ).rejects.toMatchObject({ code: "registry_unavailable" });
  });

  it("accepts a valid resolver body delivered as bounded one-byte chunks", async () => {
    const fixture = registryFixture();
    const resolverPath = [fixture.locator.namespace, fixture.locator.skill, fixture.locator.version]
      .map(encodeURIComponent)
      .join("/");
    const resolverUrl = `https://skill-press.com/api/v1/releases/${resolverPath}`;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fixture.fetcher(input, init);
      if (String(input) !== resolverUrl) {
        return response;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(offset, offset + 1));
          offset += 1;
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(bytes.byteLength),
          "cache-control": "no-store",
          age: "0",
        },
      });
    }) as typeof globalThis.fetch;
    await expect(
      createCanonicalInstallClient({
        fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }).resolve(fixture.locator.locator),
    ).resolves.toMatchObject({ locator: fixture.locator });
  });

  it("rejects invalid timeout, trust floor, signed bindings, artifact bytes, and chronology", async () => {
    expect(() => createCanonicalInstallClient({ timeoutMs: 0 })).toThrowError(TrustedInstallError);
    const valid = registryFixture();
    const client = createCanonicalInstallClient({
      fetcher: valid.fetcher,
      keyring: [valid.key.pinned],
      now: NOW,
    });
    await expect(client.resolve(valid.locator.locator, -1)).rejects.toMatchObject({
      code: "lock_invalid",
    });

    const attestationMismatch = registryFixture({
      release: (value) => ({
        ...value,
        artifact: { ...value.artifact, sha256: "c".repeat(64) },
      }),
    });
    await expect(
      createCanonicalInstallClient({
        fetcher: attestationMismatch.fetcher,
        keyring: [attestationMismatch.key.pinned],
        now: NOW,
      }).resolve(attestationMismatch.locator.locator),
    ).rejects.toMatchObject({ code: "registry_contract_invalid" });

    const changedBytes = Buffer.from(valid.artifact);
    changedBytes[0] = (changedBytes[0] as number) ^ 1;
    const artifactMismatch = registryFixture({
      key: valid.key,
      artifact: valid.artifact,
      attestationEnvelope: valid.attestationEnvelope,
      artifactResponse: changedBytes,
    });
    await expect(
      createCanonicalInstallClient({
        fetcher: artifactMismatch.fetcher,
        keyring: [valid.key.pinned],
        now: NOW,
      }).resolve(artifactMismatch.locator.locator),
    ).rejects.toMatchObject({ code: "artifact_invalid" });

    const trustMismatch = registryFixture({
      trustStatement: (value) => ({ ...value, artifactSha256: "c".repeat(64) }),
    });
    await expect(
      createCanonicalInstallClient({
        fetcher: trustMismatch.fetcher,
        keyring: [trustMismatch.key.pinned],
        now: NOW,
      }).resolve(trustMismatch.locator.locator),
    ).rejects.toMatchObject({ code: "trust_rejected" });

    const revokedLater = registryFixture({
      currentTrustStatus: "revoked",
      currentTrustSequence: 8,
    });
    await expect(
      createCanonicalInstallClient({
        fetcher: revokedLater.fetcher,
        keyring: [revokedLater.key.pinned],
        now: NOW,
      }).resolve(revokedLater.locator.locator),
    ).rejects.toMatchObject({ code: "trust_rejected" });

    const chronological = registryFixture({
      issuedAt: "2026-08-27T11:00:00.000Z",
      updatedAt: "2026-08-27T10:00:00.000Z",
    });
    await expect(
      createCanonicalInstallClient({
        fetcher: chronological.fetcher,
        keyring: [chronological.key.pinned],
        now: NOW,
      }).resolve(chronological.locator.locator),
    ).rejects.toMatchObject({ code: "trust_rejected" });
  });

  it("stages and validates before fetching a fresh checkpoint, then commits immediately", async () => {
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    let observedReadyStage = false;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === fixture.release.checkpoint.url) {
        const stages = await readdir(join(projectRoot, ".skill-press/staging"));
        observedReadyStage = stages.some((name) => name.startsWith(".release-"));
        await expect(
          lstat(join(projectRoot, ".agents/skills/example-skill/SKILL.md")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      return fixture.fetcher(input, init);
    }) as typeof globalThis.fetch;
    await addTrustedSkill({
      locator: fixture.locator.locator,
      projectRoot,
      fetcher,
      keyring: [fixture.key.pinned],
      now: NOW,
    });
    expect(observedReadyStage).toBe(true);
    await expect(
      readFile(join(projectRoot, ".agents/skills/example-skill/SKILL.md"), "utf8"),
    ).resolves.toBe(VALID_SKILL_DOCUMENT);
  });

  it("persists the trust floor before activation so a commit crash is locked-but-absent", async () => {
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === fixture.release.checkpoint.url) {
        const stagingRoot = join(projectRoot, ".skill-press/staging");
        const stage = (await readdir(stagingRoot)).find((name) => name.startsWith(".release-"));
        expect(stage).toBeDefined();
        await rm(join(stagingRoot, stage as string), { recursive: true });
      }
      return fixture.fetcher(input, init);
    }) as typeof globalThis.fetch;
    await expect(
      addTrustedSkill({
        locator: fixture.locator.locator,
        projectRoot,
        fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_failed" });
    expect((await readSkillLock(projectRoot)).skills[0]?.locator).toBe(fixture.locator.locator);
    await expect(
      lstat(join(projectRoot, ".agents/skills/example-skill/SKILL.md")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects expired, insufficient-lifetime, wrongly bound, or wrong-role checkpoints", async () => {
    const rejected = [
      registryFixture({ checkpointExpiresAt: "2026-08-27T11:59:59.999Z" }),
      registryFixture({ checkpointExpiresAt: "2026-08-27T12:00:29.999Z" }),
      registryFixture({ checkpointExpiresAt: "2026-08-27T12:15:00.001Z" }),
      registryFixture({
        checkpointStatement: (value) => ({ ...value, trustEnvelopeSha256: "c".repeat(64) }),
      }),
    ];
    for (const fixture of rejected) {
      const projectRoot = await temporaryProject();
      await expect(
        addTrustedSkill({
          locator: fixture.locator.locator,
          projectRoot,
          fetcher: fixture.fetcher,
          keyring: [fixture.key.pinned],
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(TrustedInstallError);
      await expect(lstat(join(projectRoot, ".agents/skills/example-skill"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await readSkillLock(projectRoot)).skills[0]?.locator).toBe(fixture.locator.locator);
    }

    const roleFixture = registryFixture();
    const withoutCheckpointRole: SkillPressPinnedKey = {
      ...roleFixture.key.pinned,
      roles: ["release-attestation", "trust-event"],
    };
    await expect(
      addTrustedSkill({
        locator: roleFixture.locator.locator,
        projectRoot: await temporaryProject(),
        fetcher: roleFixture.fetcher,
        keyring: [withoutCheckpointRole],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("rejects a cached checkpoint response with a positive Age", async () => {
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fixture.fetcher(input, init);
      if (String(input) !== fixture.release.checkpoint.url) return response;
      const bytes = await response.arrayBuffer();
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(bytes.byteLength),
          "cache-control": "no-store",
          age: "1",
        },
      });
    }) as typeof globalThis.fetch;
    await expect(
      addTrustedSkill({
        locator: fixture.locator.locator,
        projectRoot,
        fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "registry_contract_invalid" });
  });

  it("rechecks checkpoint lifetime at the final SKILL.md publication point", async () => {
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    let calls = 0;
    const advancingNow = (): Date => {
      calls += 1;
      return new Date(calls >= 6 ? "2026-08-27T12:10:00.000Z" : "2026-08-27T12:00:00.000Z");
    };
    await expect(
      addTrustedSkill({
        locator: fixture.locator.locator,
        projectRoot,
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: advancingNow,
      }),
    ).rejects.toMatchObject({ code: "trust_rejected" });
    expect(calls).toBeGreaterThanOrEqual(6);
    expect((await readSkillLock(projectRoot)).skills[0]?.locator).toBe(fixture.locator.locator);
    await expect(lstat(join(projectRoot, ".agents/skills/example-skill"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("classifies an interrupted artifact download as artifact unavailability", async () => {
    const fixture = registryFixture();
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === fixture.release.artifact.url) throw new Error("artifact offline");
      return fixture.fetcher(input, init);
    }) as typeof globalThis.fetch;
    await expect(
      createCanonicalInstallClient({
        fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }).resolve(fixture.locator.locator),
    ).rejects.toMatchObject({ code: "artifact_unavailable" });
  });
});

describe("safe deterministic ZIP installation parser", () => {
  it("accepts only stored regular files under the exact root", () => {
    const archive = storedZip([
      { path: "example-skill/SKILL.md", contents: "# Skill\n" },
      { path: "example-skill/scripts/run.sh", contents: "run", mode: 0o100755 },
    ]);
    expect(parseStoredSkillArchive(archive, "example-skill")).toMatchObject({
      totalBytes: 11,
      files: [
        { relativePath: "SKILL.md", executable: false },
        { relativePath: "scripts/run.sh", executable: true },
      ],
    });
  });

  it.each([
    [[{ path: "other/SKILL.md", contents: "x" }], "wrong root"],
    [[{ path: "example-skill/../escape", contents: "x" }], "traversal"],
    [[{ path: "example-skill/a\\b", contents: "x" }], "backslash"],
    [
      [
        { path: "example-skill/A", contents: "x" },
        { path: "example-skill/a", contents: "y" },
      ],
      "case collision",
    ],
    [
      [
        { path: "example-skill/K", contents: "x" },
        { path: "example-skill/K", contents: "y" },
      ],
      "fold collision",
    ],
    [[{ path: "example-skill/Å", contents: "x" }], "non-NFC"],
    [[{ path: "example-skill/link", contents: "x", mode: 0o120777 }], "symlink mode"],
    [
      [
        { path: "example-skill/SKILL.md", contents: "x" },
        { path: "example-skill/.skill-press-installing-SKILL.md", contents: "x" },
      ],
      "installer-reserved path",
    ],
    [
      [
        { path: "example-skill/SKILL.md", contents: "x" },
        { path: "example-skill/.skill-press-installing-skill.md", contents: "x" },
      ],
      "case-folded installer-reserved path",
    ],
    [
      [
        { path: "example-skill/SKILL.md", contents: "x" },
        { path: "example-skill/.skill-press-installing.json", contents: "x" },
      ],
      "installer state marker",
    ],
    [[{ path: "example-skill/readme", contents: "x" }], "missing SKILL.md"],
  ] as const)("rejects unsafe path inventory: %s (%s)", (files) => {
    expect(() => parseStoredSkillArchive(storedZip(files), "example-skill")).toThrowError(
      TrustedInstallError,
    );
  });

  it("rejects duplicates, unsorted entries, compression, CRC corruption, trailers, and truncation", () => {
    const duplicate = storedZip([
      { path: "example-skill/SKILL.md", contents: "x" },
      { path: "example-skill/SKILL.md", contents: "x" },
    ]);
    expect(() => parseStoredSkillArchive(duplicate, "example-skill")).toThrowError();

    const unsorted = storedZip(
      [
        { path: "example-skill/z", contents: "z" },
        { path: "example-skill/SKILL.md", contents: "x" },
      ],
      false,
    );
    expect(() => parseStoredSkillArchive(unsorted, "example-skill")).toThrowError();

    const compressed = Buffer.from(storedZip([{ path: "example-skill/SKILL.md", contents: "x" }]));
    compressed.writeUInt16LE(8, 8);
    expect(() => parseStoredSkillArchive(compressed, "example-skill")).toThrowError();

    const corrupt = Buffer.from(storedZip([{ path: "example-skill/SKILL.md", contents: "x" }]));
    corrupt[30 + Buffer.byteLength("example-skill/SKILL.md")] = 0x79;
    expect(() => parseStoredSkillArchive(corrupt, "example-skill")).toThrowError();

    const valid = storedZip([{ path: "example-skill/SKILL.md", contents: "x" }]);
    expect(() =>
      parseStoredSkillArchive(Buffer.concat([valid, Buffer.from("trailer")]), "example-skill"),
    ).toThrowError();
    expect(() =>
      parseStoredSkillArchive(valid.subarray(0, valid.byteLength - 1), "example-skill"),
    ).toThrowError();
    expect(() => parseStoredSkillArchive(Buffer.alloc(0), "example-skill")).toThrowError();
  });
});

describe("strict release protocol contracts", () => {
  it("rejects non-records, unexpected keys, locator changes, and every non-canonical public URL", () => {
    const fixture = registryFixture();
    expect(() => parseReleaseResource(null, fixture.locator)).toThrowError(TrustedInstallError);
    expect(() =>
      parseReleaseResource({ ...fixture.release, unexpected: true }, fixture.locator),
    ).toThrowError(TrustedInstallError);
    expect(() =>
      parseReleaseResource({ ...fixture.release, namespace: "different" }, fixture.locator),
    ).toThrowError(TrustedInstallError);
    expect(() =>
      parseReleaseResource(
        {
          ...fixture.release,
          attestation: { ...fixture.release.attestation, url: "https://skill-press.com/wrong" },
        },
        fixture.locator,
      ),
    ).toThrowError(TrustedInstallError);
    expect(() =>
      parseReleaseResource(
        {
          ...fixture.release,
          trust: { ...fixture.release.trust, url: "https://skill-press.com/wrong" },
        },
        fixture.locator,
      ),
    ).toThrowError(TrustedInstallError);
  });

  it("rejects malformed envelope encoding and malformed signed JSON bytes", () => {
    const fixture = registryFixture();
    expect(() =>
      parseSignedEnvelope(
        { ...fixture.attestationEnvelope, payload: "AB" },
        "skillpress.signed-attestation",
      ),
    ).not.toThrow();
    expect(() => parseAttestationPayload("AB", fixture.locator)).toThrowError(TrustedInstallError);
    expect(() => parseAttestationPayload("wyg", fixture.locator)).toThrowError(TrustedInstallError);
    expect(() =>
      parseAttestationPayload(Buffer.from("{").toString("base64url"), fixture.locator),
    ).toThrowError(TrustedInstallError);
    expect(() =>
      parseSignedEnvelope(
        { ...fixture.attestationEnvelope, signature: "bad=" },
        "skillpress.signed-attestation",
      ),
    ).toThrowError(TrustedInstallError);
  });

  it("rejects invalid attestation IDs, reason codes, and semantically valid non-canonical order", () => {
    const fixture = registryFixture();
    const attestation = JSON.parse(
      Buffer.from(fixture.attestationEnvelope.payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(() =>
      parseAttestationPayload(
        Buffer.from(JSON.stringify({ ...attestation, submissionId: "bad" })).toString("base64url"),
        fixture.locator,
      ),
    ).toThrowError(TrustedInstallError);
    const trust = JSON.parse(
      Buffer.from(fixture.trustEnvelope.payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(() =>
      parseTrustPayload(
        Buffer.from(JSON.stringify({ ...trust, reasonCode: "INVALID-CODE" })).toString("base64url"),
        fixture.locator,
      ),
    ).toThrowError(TrustedInstallError);
    const { schemaVersion, ...rest } = trust;
    expect(() =>
      parseTrustPayload(
        Buffer.from(JSON.stringify({ ...rest, schemaVersion })).toString("base64url"),
        fixture.locator,
      ),
    ).toThrowError(TrustedInstallError);
  });

  it("rejects invalid UTF-8 and invalid JSON response bodies", () => {
    expect(() => parseJsonBytes(Buffer.from([0xc3, 0x28]), "vector")).toThrowError(
      TrustedInstallError,
    );
    expect(() => parseJsonBytes(Buffer.from("{"), "vector")).toThrowError(TrustedInstallError);
  });
});

describe("atomic installation transaction", () => {
  function validArchive() {
    return parseStoredSkillArchive(
      storedZip([
        { path: "example-skill/SKILL.md", contents: VALID_SKILL_DOCUMENT },
        { path: "example-skill/a/one.txt", contents: "one" },
        { path: "example-skill/a/deep/three.txt", contents: "three" },
        { path: "example-skill/b/two.txt", contents: "two" },
      ]),
      "example-skill",
    );
  }

  it("canonicalizes the default project root", async () => {
    await expect(canonicalProjectRoot(undefined)).resolves.toBe(await realpath(process.cwd()));
  });

  it("classifies a non-EEXIST installation-root creation failure", async () => {
    if (process.platform === "win32") return;
    const root = await canonicalProjectRoot(await temporaryProject());
    await chmod(root, 0o555);
    try {
      await expect(
        prepareAtomicInstallation(root, "example-skill", validArchive()),
      ).rejects.toMatchObject({ code: "install_failed" });
    } finally {
      await chmod(root, 0o755);
    }
  });

  it("can abort an unpublished stage and refuses to commit it afterward", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const prepared = await prepareAtomicInstallation(root, "example-skill", validArchive());
    await prepared.abort();
    await prepared.abort();
    await expect(prepared.commit()).rejects.toMatchObject({ code: "install_failed" });
    await expect(
      readFile(join(root, ".agents/skills/example-skill/SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("commits a real directory and rolls back only its frozen ownership snapshot", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const prepared = await prepareAtomicInstallation(root, "example-skill", validArchive());
    const committed = await prepared.commit();
    await expect(readFile(join(committed.targetPath, "SKILL.md"), "utf8")).resolves.toBe(
      VALID_SKILL_DOCUMENT,
    );
    await committed.rollback();
    await committed.rollback();
    await expect(readFile(join(committed.targetPath, "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves a committed tree when a file is modified in place before rollback", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const prepared = await prepareAtomicInstallation(root, "example-skill", validArchive());
    const committed = await prepared.commit();
    const ownedFile = join(committed.targetPath, "a/one.txt");
    const before = await lstat(ownedFile);
    await writeFile(ownedFile, "ONE");
    expect((await lstat(ownedFile)).ino).toBe(before.ino);
    await committed.rollback();
    await expect(readFile(ownedFile, "utf8")).resolves.toBe("ONE");
  });

  it("preserves both paths if a committed target directory is swapped before rollback", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const prepared = await prepareAtomicInstallation(root, "example-skill", validArchive());
    const committed = await prepared.commit();
    const displaced = join(root, ".agents/skills/displaced-example-skill");
    await rename(committed.targetPath, displaced);
    await mkdir(committed.targetPath);
    await writeFile(join(committed.targetPath, "external"), "keep");
    await committed.rollback();
    await expect(readFile(join(committed.targetPath, "external"), "utf8")).resolves.toBe("keep");
    await expect(readFile(join(displaced, "SKILL.md"), "utf8")).resolves.toBe(VALID_SKILL_DOCUMENT);
  });

  it("fails closed if a target appears between staging and commit", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const prepared = await prepareAtomicInstallation(root, "example-skill", validArchive());
    await mkdir(prepared.targetPath);
    await writeFile(join(prepared.targetPath, "external"), "keep");
    await expect(prepared.commit()).rejects.toMatchObject({ code: "install_conflict" });
    await expect(readFile(join(prepared.targetPath, "external"), "utf8")).resolves.toBe("keep");
    await expect(readFile(join(prepared.targetPath, "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await prepared.abort();
  });

  it("reports a generic commit failure if its private stage disappears", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const prepared = await prepareAtomicInstallation(root, "example-skill", validArchive());
    const stagingRoot = join(root, ".skill-press/staging");
    const stageName = (await readdir(stagingRoot)).find((name) => name.startsWith(".release-"));
    expect(stageName).toBeDefined();
    await rm(join(stagingRoot, stageName as string), { recursive: true });
    await expect(prepared.commit()).rejects.toMatchObject({ code: "install_failed" });
    await expect(lstat(prepared.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an externally injected partial target and never publishes SKILL.md", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const files: ZipInput[] = [
      { path: "example-skill/SKILL.md", contents: VALID_SKILL_DOCUMENT },
      ...Array.from({ length: 200 }, (_, index) => ({
        path: `example-skill/resources/file-${String(index).padStart(3, "0")}.txt`,
        contents: `file ${index}`,
      })),
    ];
    const archive = parseStoredSkillArchive(storedZip(files), "example-skill");
    const prepared = await prepareAtomicInstallation(root, "example-skill", archive);
    const stagingRoot = join(root, ".skill-press/staging");
    const stageName = (await readdir(stagingRoot)).find((name) => name.startsWith(".release-"));
    expect(stageName).toBeDefined();
    await rm(join(stagingRoot, stageName as string, "example-skill/resources/file-199.txt"));

    const external = join(prepared.targetPath, "external-owner-file");
    const inject = async (): Promise<void> => {
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        try {
          await writeFile(external, "preserve me", { flag: "wx" });
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await new Promise<void>((resolveAttempt) => setImmediate(resolveAttempt));
        }
      }
      throw new Error("target reservation was not observed");
    };
    const injection = inject();
    await expect(prepared.commit()).rejects.toMatchObject({ code: "install_conflict" });
    await injection;
    await expect(readFile(external, "utf8")).resolves.toBe("preserve me");
    await expect(lstat(join(prepared.targetPath, "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rm(external);
    const resumed = await prepareAtomicInstallation(root, "example-skill", archive);
    await resumed.commit();
    await expect(readFile(join(prepared.targetPath, "SKILL.md"), "utf8")).resolves.toBe(
      VALID_SKILL_DOCUMENT,
    );
  });

  it("preserves a same-inode file mutation when a partial commit later fails", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const files: ZipInput[] = [
      { path: "example-skill/SKILL.md", contents: VALID_SKILL_DOCUMENT },
      ...Array.from({ length: 200 }, (_, index) => ({
        path: `example-skill/resources/file-${String(index).padStart(3, "0")}.txt`,
        contents: `file ${index}`,
      })),
    ];
    const archive = parseStoredSkillArchive(storedZip(files), "example-skill");
    const prepared = await prepareAtomicInstallation(root, "example-skill", archive);
    const stageName = (await readdir(join(root, ".skill-press/staging"))).find((name) =>
      name.startsWith(".release-"),
    );
    expect(stageName).toBeDefined();
    await rm(
      join(
        root,
        ".skill-press/staging",
        stageName as string,
        "example-skill/resources/file-199.txt",
      ),
    );

    const firstFile = join(prepared.targetPath, "resources/file-000.txt");
    const mutateInPlace = async (): Promise<void> => {
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        try {
          const identity = await lstat(firstFile);
          await writeFile(firstFile, "FILE 0");
          expect((await lstat(firstFile)).ino).toBe(identity.ino);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await new Promise<void>((resolveAttempt) => setImmediate(resolveAttempt));
        }
      }
      throw new Error("owned file was not observed");
    };
    const mutation = mutateInPlace();
    await expect(prepared.commit()).rejects.toMatchObject({ code: "install_conflict" });
    await mutation;
    await expect(readFile(firstFile, "utf8")).resolves.toBe("FILE 0");
    await expect(lstat(join(prepared.targetPath, "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects unsafe direct targets and duplicate staged writes", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    await expect(prepareAtomicInstallation(root, "..", validArchive())).rejects.toMatchObject({
      code: "install_path_unsafe",
    });
    await expect(prepareAtomicInstallation(root, "", validArchive())).rejects.toMatchObject({
      code: "install_path_unsafe",
    });
    await expect(
      prepareAtomicInstallation(root, "../outside", validArchive()),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
    const file = Object.freeze({
      relativePath: "SKILL.md",
      contents: Buffer.from(VALID_SKILL_DOCUMENT),
      executable: false,
    });
    await expect(
      prepareAtomicInstallation(root, "example-skill", {
        files: Object.freeze([file, file]),
        totalBytes: file.contents.byteLength * 2,
      }),
    ).rejects.toMatchObject({ code: "install_failed" });
    await expect(
      prepareAtomicInstallation(root, "example-skill", {
        files: Object.freeze([]),
        totalBytes: 0,
      }),
    ).rejects.toMatchObject({ code: "artifact_invalid" });
    await expect(
      prepareAtomicInstallation(root, "example-skill", {
        files: Object.freeze([
          file,
          Object.freeze({
            relativePath: "../outside",
            contents: Buffer.from("escape"),
            executable: false,
          }),
        ]),
        totalBytes: file.contents.byteLength + 6,
      }),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
  });

  it("treats an exact existing tree as immutable and rejects linked or non-directory targets", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const first = await prepareAtomicInstallation(root, "example-skill", validArchive());
    await first.commit();
    const exact = await prepareAtomicInstallation(root, "example-skill", validArchive());
    expect(exact.changed).toBe(false);
    const noChange = await exact.commit();
    await noChange.rollback();
    await exact.abort();

    await symlink(
      join(root, ".agents/skills/example-skill/SKILL.md"),
      join(root, ".agents/skills/example-skill/linked.md"),
    );
    await expect(
      prepareAtomicInstallation(root, "example-skill", validArchive()),
    ).rejects.toMatchObject({ code: "install_conflict" });

    await rm(join(root, ".agents/skills/example-skill"), { recursive: true });
    await writeFile(join(root, ".agents/skills/example-skill"), "not a directory");
    await expect(
      prepareAtomicInstallation(root, "example-skill", validArchive()),
    ).rejects.toMatchObject({ code: "install_conflict" });
  });

  it("revalidates an exact existing tree at commit and rejects extra empty directories", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const initial = await prepareAtomicInstallation(root, "example-skill", validArchive());
    await initial.commit();

    const inert = await prepareAtomicInstallation(root, "example-skill", validArchive());
    await writeFile(join(inert.targetPath, "SKILL.md"), "MUTATED");
    await expect(inert.commit()).rejects.toMatchObject({ code: "install_conflict" });
    await expect(readFile(join(inert.targetPath, "SKILL.md"), "utf8")).resolves.toBe("MUTATED");

    await rm(inert.targetPath, { recursive: true });
    const replacement = await prepareAtomicInstallation(root, "example-skill", validArchive());
    await replacement.commit();
    await mkdir(join(replacement.targetPath, "unexpected-empty"));
    await expect(
      prepareAtomicInstallation(root, "example-skill", validArchive()),
    ).rejects.toMatchObject({ code: "install_conflict" });

    await rm(join(replacement.targetPath, "unexpected-empty"), { recursive: true });
    await writeFile(join(replacement.targetPath, "unexpected.txt"), "unexpected");
    await expect(
      prepareAtomicInstallation(root, "example-skill", validArchive()),
    ).rejects.toMatchObject({ code: "install_conflict" });
  });

  it("revalidates a pending crash-recovery tree again at commit", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const archive = validArchive();
    const initial = await prepareAtomicInstallation(root, "example-skill", archive);
    await initial.abort();
    await mkdir(initial.targetPath);
    for (const file of archive.files) {
      const relativePath =
        file.relativePath === "SKILL.md" ? ".skill-press-installing-SKILL.md" : file.relativePath;
      const destination = join(initial.targetPath, ...relativePath.split("/"));
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, file.contents, { mode: file.executable ? 0o755 : 0o644 });
    }
    const resumed = await prepareAtomicInstallation(root, "example-skill", archive);
    await writeFile(join(resumed.targetPath, ".skill-press-installing-SKILL.md"), "MUTATED");
    await expect(resumed.commit()).rejects.toMatchObject({ code: "install_conflict" });
    await expect(lstat(join(resumed.targetPath, "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["directory-file", "symlink-file", "same-size-content", "directory-mode"] as const)(
    "rejects exact-tree metadata deviation: %s",
    async (deviation) => {
      if (deviation === "directory-mode" && process.platform === "win32") return;
      const root = await canonicalProjectRoot(await temporaryProject());
      const initial = await prepareAtomicInstallation(root, "example-skill", validArchive());
      await initial.commit();
      const file = join(initial.targetPath, "a/one.txt");
      if (deviation === "directory-file") {
        await rm(file);
        await mkdir(file);
      } else if (deviation === "symlink-file") {
        await rm(file);
        await symlink(join(initial.targetPath, "b/two.txt"), file);
      } else if (deviation === "same-size-content") {
        await writeFile(file, "ONE");
      } else {
        await chmod(join(initial.targetPath, "a"), 0o700);
      }
      await expect(
        prepareAtomicInstallation(root, "example-skill", validArchive()),
      ).rejects.toMatchObject({ code: "install_conflict" });
    },
  );

  it("rejects a published-pending tree whose SKILL files do not share one inode", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const archive = validArchive();
    const initial = await prepareAtomicInstallation(root, "example-skill", archive);
    await initial.abort();
    await mkdir(initial.targetPath);
    for (const file of archive.files) {
      const relativePath =
        file.relativePath === "SKILL.md" ? ".skill-press-installing-SKILL.md" : file.relativePath;
      const destination = join(initial.targetPath, ...relativePath.split("/"));
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, file.contents, { mode: file.executable ? 0o755 : 0o644 });
    }
    await writeFile(join(initial.targetPath, "SKILL.md"), VALID_SKILL_DOCUMENT, { mode: 0o644 });
    await expect(prepareAtomicInstallation(root, "example-skill", archive)).rejects.toMatchObject({
      code: "install_conflict",
    });
  });

  it("rechecks published-pending inode identity after the final publication guard", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const archive = validArchive();
    const initial = await prepareAtomicInstallation(root, "example-skill", archive);
    await initial.abort();
    await mkdir(initial.targetPath);
    for (const file of archive.files) {
      const relativePath =
        file.relativePath === "SKILL.md" ? ".skill-press-installing-SKILL.md" : file.relativePath;
      const destination = join(initial.targetPath, ...relativePath.split("/"));
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, file.contents, { mode: file.executable ? 0o755 : 0o644 });
    }
    const pending = join(initial.targetPath, ".skill-press-installing-SKILL.md");
    const published = join(initial.targetPath, "SKILL.md");
    await link(pending, published);
    const resumed = await prepareAtomicInstallation(root, "example-skill", archive);
    const failure = await resumed
      .commit(async () => {
        await unlink(published);
        await writeFile(published, VALID_SKILL_DOCUMENT, { mode: 0o644 });
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({ code: "install_conflict" });
    expect((await lstat(pending)).ino).not.toBe((await lstat(published)).ino);
  });

  it("never publishes SKILL.md when the pending tree changes during the final guard", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const prepared = await prepareAtomicInstallation(root, "example-skill", validArchive());
    const pending = join(prepared.targetPath, ".skill-press-installing-SKILL.md");
    await expect(
      prepared.commit(async () => {
        await writeFile(pending, "MUTATED");
      }),
    ).rejects.toMatchObject({
      code: "install_conflict",
      message: "The failed installation target was externally modified and was preserved.",
    });
    await expect(lstat(join(prepared.targetPath, "SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(pending, "utf8")).resolves.toBe("MUTATED");
  });

  it("safely resumes an empty no-SKILL reservation without overwriting content", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const initial = await prepareAtomicInstallation(root, "example-skill", validArchive());
    await initial.abort();
    await mkdir(initial.targetPath);
    const resumed = await prepareAtomicInstallation(root, "example-skill", validArchive());
    await resumed.commit();
    await expect(readFile(join(resumed.targetPath, "SKILL.md"), "utf8")).resolves.toBe(
      VALID_SKILL_DOCUMENT,
    );
  });

  it("rejects an arbitrary archive subset that lacks an installer ownership marker", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const initial = await prepareAtomicInstallation(root, "example-skill", validArchive());
    await initial.abort();
    await mkdir(join(initial.targetPath, "a"), { recursive: true });
    await writeFile(join(initial.targetPath, "a/one.txt"), "one");
    await expect(
      prepareAtomicInstallation(root, "example-skill", validArchive()),
    ).rejects.toMatchObject({ code: "install_conflict" });
    await expect(readFile(join(initial.targetPath, "a/one.txt"), "utf8")).resolves.toBe("one");
  });

  it("rejects a forged installation marker and a raced unsafe directory component", async () => {
    const root = await canonicalProjectRoot(await temporaryProject());
    const initial = await prepareAtomicInstallation(root, "example-skill", validArchive());
    await initial.abort();
    await mkdir(initial.targetPath);
    await writeFile(join(initial.targetPath, ".skill-press-installing.json"), "forged\n");
    await expect(
      prepareAtomicInstallation(root, "example-skill", validArchive()),
    ).rejects.toMatchObject({ code: "install_conflict" });

    await rm(initial.targetPath, { recursive: true });
    const files: ZipInput[] = [
      { path: "example-skill/SKILL.md", contents: VALID_SKILL_DOCUMENT },
      ...Array.from({ length: 100 }, (_, index) => ({
        path: `example-skill/resources/file-${String(index).padStart(3, "0")}.txt`,
        contents: String(index),
      })),
      { path: "example-skill/z/last.txt", contents: "last" },
    ];
    const archive = parseStoredSkillArchive(storedZip(files), "example-skill");
    await mkdir(initial.targetPath);
    const raced = await prepareAtomicInstallation(root, "example-skill", archive);
    const unsafeComponent = join(raced.targetPath, "z");
    const inject = async (): Promise<void> => {
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        try {
          await lstat(join(raced.targetPath, ".skill-press-installing.json"));
          await writeFile(unsafeComponent, "external", { flag: "wx" });
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await new Promise<void>((resolveAttempt) => setImmediate(resolveAttempt));
        }
      }
      throw new Error("installation marker was not observed");
    };
    const injection = inject();
    await expect(raced.commit()).rejects.toMatchObject({ code: "install_conflict" });
    await injection;
    await expect(readFile(unsafeComponent, "utf8")).resolves.toBe("external");
  });

  it.each([false, true])(
    "safely resumes a validated pending installation (already published: %s)",
    async (alreadyPublished) => {
      const root = await canonicalProjectRoot(await temporaryProject());
      const archive = validArchive();
      const initial = await prepareAtomicInstallation(root, "example-skill", archive);
      await initial.abort();
      await mkdir(initial.targetPath);
      for (const file of archive.files) {
        const relativePath =
          file.relativePath === "SKILL.md" ? ".skill-press-installing-SKILL.md" : file.relativePath;
        const destination = join(initial.targetPath, ...relativePath.split("/"));
        await mkdir(join(destination, ".."), { recursive: true });
        await writeFile(destination, file.contents, { mode: 0o600 });
      }
      const pending = join(initial.targetPath, ".skill-press-installing-SKILL.md");
      if (alreadyPublished) {
        if (process.platform !== "win32") {
          for (const file of archive.files) {
            const relativePath =
              file.relativePath === "SKILL.md"
                ? ".skill-press-installing-SKILL.md"
                : file.relativePath;
            await chmod(
              join(initial.targetPath, ...relativePath.split("/")),
              file.executable ? 0o755 : 0o644,
            );
          }
        }
        await link(pending, join(initial.targetPath, "SKILL.md"));
      }

      const resumed = await prepareAtomicInstallation(root, "example-skill", archive);
      const committed = await resumed.commit();
      expect(committed.changed).toBe(true);
      expect((await lstat(committed.targetPath)).isSymbolicLink()).toBe(false);
      await expect(readFile(join(committed.targetPath, "SKILL.md"), "utf8")).resolves.toBe(
        VALID_SKILL_DOCUMENT,
      );
      await committed.rollback();
      await expect(readFile(join(committed.targetPath, "SKILL.md"), "utf8")).resolves.toBe(
        VALID_SKILL_DOCUMENT,
      );
      await expect(lstat(pending)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects a regular file as the project root", async () => {
    const root = await temporaryProject();
    const file = join(root, "file");
    await writeFile(file, "x");
    await expect(canonicalProjectRoot(file)).rejects.toMatchObject({ code: "install_path_unsafe" });
  });
});

describe("locator, signature keyring, and lockfile boundaries", () => {
  it.each(["example/skill@1.0.0", "example-org/my-skill@0.0.1-alpha.1+build.5"])(
    "accepts canonical exact locator %s",
    (locator) => {
      expect(parseExactSkillLocator(locator).locator).toBe(locator);
    },
  );

  it.each([
    "example/skill",
    "example/skill@latest",
    "Example/skill@1.0.0",
    "example/skill@01.0.0",
    "example/skill@1.0.0-01",
    "example//skill@1.0.0",
    "",
  ])("rejects non-exact or non-canonical locator %s", (locator) => {
    expect(() => parseExactSkillLocator(locator)).toThrowError(TrustedInstallError);
  });

  it("bounds standalone names and canonical exact semantic versions", () => {
    expect(isSkillPressName("skill-name")).toBe(true);
    expect(isSkillPressName("a".repeat(65))).toBe(false);
    expect(isExactSemver("1.0.0-alpha.1+build.01")).toBe(true);
    expect(isExactSemver("1.0.0-01")).toBe(false);
    expect(isExactSemver("latest")).toBe(false);
    expect(() => parseExactSkillLocator(`${"a".repeat(65)}/skill@1.0.0`)).toThrowError(
      TrustedInstallError,
    );
  });

  it("rejects empty, malformed, duplicate, unknown, and cryptographically wrong keyrings", async () => {
    await expect(createTrustedSignatureVerifier()).resolves.toBeDefined();
    await expect(createTrustedSignatureVerifier([])).rejects.toMatchObject({
      code: "keyring_invalid",
    });
    const key = signingKey();
    await expect(createTrustedSignatureVerifier([key.pinned, key.pinned])).rejects.toMatchObject({
      code: "keyring_invalid",
    });
    await expect(
      createTrustedSignatureVerifier([{ ...key.pinned, jwk: { ...key.pinned.jwk, x: "bad" } }]),
    ).rejects.toMatchObject({ code: "keyring_invalid" });

    const fixture = registryFixture();
    const other = signingKey();
    await expect(
      createCanonicalInstallClient({
        fetcher: fixture.fetcher,
        keyring: [other.pinned],
        now: NOW,
      }).resolve(fixture.locator.locator),
    ).rejects.toMatchObject({ code: "signature_invalid" });

    const expiredKey: SkillPressPinnedKey = {
      ...fixture.key.pinned,
      validUntil: "2026-08-27T09:59:59.999Z",
    };
    await expect(
      createCanonicalInstallClient({
        fetcher: fixture.fetcher,
        keyring: [expiredKey],
        now: NOW,
      }).resolve(fixture.locator.locator),
    ).rejects.toMatchObject({ code: "signature_invalid" });

    const laterSequenceKey: SkillPressPinnedKey = {
      ...fixture.key.pinned,
      minimumTrustSequence: 8,
    };
    await expect(
      createCanonicalInstallClient({
        fetcher: fixture.fetcher,
        keyring: [laterSequenceKey],
        now: NOW,
      }).resolve(fixture.locator.locator),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("verifies the reusable ES256 P-1363 cross-runtime protocol vector", async () => {
    const vectorKey: SkillPressPinnedKey = {
      keyId: "cross-runtime-vector-1",
      roles: ["release-attestation"],
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-12-31T23:59:59.999Z",
      jwk: {
        kty: "EC",
        crv: "P-256",
        x: "YlOEif08cL7uC1_S4nj7xEnbfLlUKWA-c7MzFmZrj38",
        y: "LC9Nb2MKdPP1C1FkYC6Pte0r9pj5lYT29KEy82VSRoU",
      },
    };
    const envelope: SkillPressSignedEnvelope = {
      schemaVersion: 1,
      envelopeType: "skillpress.signed-attestation",
      keyId: vectorKey.keyId,
      algorithm: "ES256",
      payload: Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          statementType: "skillpress.release-attestation",
          locator: "vector/vector-skill@1.0.0",
          namespace: "vector",
          skill: "vector-skill",
          version: "1.0.0",
          artifactSha256: "0123456789abcdef".repeat(4),
          artifactBytes: 1234,
          artifactMediaType: "application/zip",
          issuedAt: "2026-08-27T00:00:00.000Z",
          submissionId: "submission_vector_01",
          automatedReviewSha256: "a".repeat(64),
          curatorDecisionSha256: "b".repeat(64),
        }),
      ).toString("base64url"),
      signature:
        "qUYW8jR6U71lsGo2ll0X2b_xOFPdje6OaWfypP5wL4tyt1zfLYQyHUIgIMJMOJmhAD1UKnFR1Ozc8TqA7Sg9JA",
    };
    const verifier = await createTrustedSignatureVerifier([vectorKey], NOW);
    await expect(
      verifier.verifyAttestation(envelope, parseExactSkillLocator("vector/vector-skill@1.0.0")),
    ).resolves.toMatchObject({
      statement: { artifactMediaType: "application/zip", artifactBytes: 1234 },
    });
  });

  it("rejects malformed and linked lockfiles without touching their targets", async () => {
    const projectRoot = await temporaryProject();
    await writeFile(join(projectRoot, "skill-lock.json"), "{}\n");
    await expect(readSkillLock(projectRoot)).rejects.toMatchObject({ code: "lock_invalid" });
    await rm(join(projectRoot, "skill-lock.json"));
    const outside = join(projectRoot, "outside.json");
    await writeFile(outside, "{}\n");
    await symlink(outside, join(projectRoot, "skill-lock.json"));
    await expect(readSkillLock(projectRoot)).rejects.toMatchObject({ code: "lock_invalid" });
    await expect(readFile(outside, "utf8")).resolves.toBe("{}\n");
  });

  it("rejects invalid UTF-8, empty, oversized, and semantically inconsistent lockfiles", async () => {
    await expect(readSkillLock("\0-invalid-root")).rejects.toMatchObject({
      code: "lock_invalid",
    });
    const projectRoot = await temporaryProject();
    const lockPath = join(projectRoot, "skill-lock.json");
    await writeFile(lockPath, Buffer.from([0xc3, 0x28]));
    await expect(readSkillLock(projectRoot)).rejects.toMatchObject({ code: "lock_invalid" });
    await writeFile(lockPath, Buffer.alloc(0));
    await expect(readSkillLock(projectRoot)).rejects.toMatchObject({ code: "lock_invalid" });
    await writeFile(lockPath, Buffer.alloc(1024 * 1024 + 1));
    await expect(readSkillLock(projectRoot)).rejects.toMatchObject({ code: "lock_invalid" });

    const fixture = registryFixture();
    const seededRoot = await temporaryProject();
    await addTrustedSkill({
      locator: fixture.locator.locator,
      projectRoot: seededRoot,
      fetcher: fixture.fetcher,
      keyring: [fixture.key.pinned],
      now: NOW,
    });
    const valid = JSON.parse(await readFile(join(seededRoot, "skill-lock.json"), "utf8")) as {
      skills: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    valid.skills[0] = { ...valid.skills[0], installedPath: ".agents/skills/other-skill" };
    await writeFile(lockPath, `${JSON.stringify(valid)}\n`);
    await expect(readSkillLock(projectRoot)).rejects.toMatchObject({ code: "lock_invalid" });
  });

  it("enforces immutable entry conflicts and deterministic lock ordering", async () => {
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    await addTrustedSkill({
      locator: fixture.locator.locator,
      projectRoot,
      fetcher: fixture.fetcher,
      keyring: [fixture.key.pinned],
      now: NOW,
    });
    const lock = await readSkillLock(projectRoot);
    const entry = lock.skills[0];
    expect(entry).toBeDefined();
    const base = entry as NonNullable<typeof entry>;
    const conflicts: Array<typeof base> = [
      { ...base, artifact: { ...base.artifact, sha256: "c".repeat(64) } },
      { ...base, artifact: { ...base.artifact, bytes: base.artifact.bytes + 1 } },
      { ...base, attestation: { ...base.attestation, sha256: "c".repeat(64) } },
      { ...base, attestation: { ...base.attestation, keyId: "different-key" } },
      { ...base, trust: { ...base.trust, sequence: base.trust.sequence - 1 } },
      { ...base, trust: { ...base.trust, updatedAt: "2026-08-27T10:59:59.999Z" } },
      { ...base, trust: { ...base.trust, keyId: "different-key" } },
      { ...base, trust: { ...base.trust, sha256: "c".repeat(64) } },
      { ...base, trust: { ...base.trust, updatedAt: "2026-08-27T11:00:00.001Z" } },
    ];
    for (const changed of conflicts) {
      expect(() => withSkillLockEntry(lock, changed)).toThrowError(TrustedInstallError);
    }
    const other = {
      ...base,
      locator: "alpha/alpha-skill@1.0.0",
      namespace: "alpha",
      skill: "alpha-skill",
      version: "1.0.0",
      installedPath: ".agents/skills/alpha-skill",
    };
    expect(() =>
      withSkillLockEntry(lock, { ...other, installedPath: base.installedPath }),
    ).toThrowError(TrustedInstallError);
    expect(() =>
      withSkillLockEntry(lock, {
        ...base,
        locator: "example/example-skill@2.0.0",
        version: "2.0.0",
        installedPath: ".agents/skills/different-skill",
      }),
    ).toThrowError(TrustedInstallError);
    expect(withSkillLockEntry(lock, other).skills.map((value) => value.locator)).toEqual([
      other.locator,
      base.locator,
    ]);
  });

  it("fails closed on a concurrent mutation lock before network access and preserves its identity", async () => {
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    const mutationPath = join(projectRoot, ".skill-lock.json.lock");
    await writeFile(mutationPath, "other-operation\n", { mode: 0o600 });
    const fetcher = vi.fn(fixture.fetcher);
    await expect(
      addTrustedSkill({
        locator: fixture.locator.locator,
        projectRoot,
        fetcher: fetcher as unknown as typeof globalThis.fetch,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_conflict" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(readFile(mutationPath, "utf8")).resolves.toBe("other-operation\n");
  });

  it("reclaims only a well-formed mutation lock whose owning process is dead", async () => {
    if (process.platform === "win32") return;
    const projectRoot = await temporaryProject();
    const mutationPath = join(projectRoot, ".skill-lock.json.lock");
    await writeFile(mutationPath, "999999999 12345678-1234-4123-8123-123456789abc\n", {
      mode: 0o600,
    });
    const release = await acquireSkillMutationLock(projectRoot);
    expect((await readFile(mutationPath, "utf8")).startsWith(`${process.pid} `)).toBe(true);
    await release();
    await release();
    await expect(lstat(mutationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never releases a replaced mutation lock and rejects unsafe stale-lock shapes", async () => {
    const projectRoot = await temporaryProject();
    const mutationPath = join(projectRoot, ".skill-lock.json.lock");
    const release = await acquireSkillMutationLock(projectRoot);
    const prior = join(projectRoot, "prior-mutation-lock");
    await rename(mutationPath, prior);
    await writeFile(mutationPath, "replacement\n");
    await expect(release()).rejects.toMatchObject({ code: "install_failed" });
    await expect(readFile(mutationPath, "utf8")).resolves.toBe("replacement\n");

    const otherRoot = await temporaryProject();
    await mkdir(join(otherRoot, ".skill-lock.json.lock"));
    await expect(acquireSkillMutationLock(otherRoot)).rejects.toMatchObject({
      code: "install_conflict",
    });
    await expect(acquireSkillMutationLock(join(otherRoot, "missing"))).rejects.toMatchObject({
      code: "install_failed",
    });
  });

  it("uses the read revision as a no-clobber lockfile compare-and-swap", async () => {
    const projectRoot = await temporaryProject();
    const absent = await readSkillLockSnapshot(projectRoot);
    await writeFile(join(projectRoot, "skill-lock.json"), "external\n");
    await expect(writeSkillLock(projectRoot, absent.lock, absent.revision)).rejects.toMatchObject({
      code: "install_conflict",
    });
    await expect(readFile(join(projectRoot, "skill-lock.json"), "utf8")).resolves.toBe(
      "external\n",
    );

    await rm(join(projectRoot, "skill-lock.json"));
    await writeSkillLock(projectRoot, absent.lock);
    const existing = await readSkillLockSnapshot(projectRoot);
    const externallyChanged = `${await readFile(join(projectRoot, "skill-lock.json"), "utf8")} `;
    await writeFile(join(projectRoot, "skill-lock.json"), externallyChanged);
    await expect(
      writeSkillLock(projectRoot, existing.lock, existing.revision),
    ).rejects.toMatchObject({ code: "install_conflict" });
    await expect(readFile(join(projectRoot, "skill-lock.json"), "utf8")).resolves.toBe(
      externallyChanged,
    );
  });

  it("classifies unsafe CAS targets and unwritable project paths without overwriting", async () => {
    const projectRoot = await temporaryProject();
    const absent = await readSkillLockSnapshot(projectRoot);
    await mkdir(join(projectRoot, "skill-lock.json"));
    await expect(writeSkillLock(projectRoot, absent.lock, absent.revision)).rejects.toMatchObject({
      code: "install_conflict",
    });
    const missingRoot = join(projectRoot, "missing");
    await expect(writeSkillLock(missingRoot, absent.lock)).rejects.toMatchObject({
      code: "install_failed",
    });
  });

  it("preserves an external lockfile created during resolution and rolls back the target", async () => {
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    const externalBytes = "externally-created-lock\n";
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === fixture.release.trust.url) {
        await writeFile(join(projectRoot, "skill-lock.json"), externalBytes, { flag: "wx" });
      }
      return fixture.fetcher(input, init);
    }) as typeof globalThis.fetch;
    await expect(
      addTrustedSkill({
        locator: fixture.locator.locator,
        projectRoot,
        fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_conflict" });
    await expect(readFile(join(projectRoot, "skill-lock.json"), "utf8")).resolves.toBe(
      externalBytes,
    );
    await expect(lstat(join(projectRoot, ".agents/skills/example-skill"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preflights installed-path conflicts across namespaces before resolving the new release", async () => {
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    await addTrustedSkill({
      locator: fixture.locator.locator,
      projectRoot,
      fetcher: fixture.fetcher,
      keyring: [fixture.key.pinned],
      now: NOW,
    });
    const fetcher = vi.fn(async () => {
      throw new Error("must not resolve");
    }) as unknown as typeof globalThis.fetch;
    await expect(
      addTrustedSkill({
        locator: "another/example-skill@1.2.3",
        projectRoot,
        fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_conflict" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects lockfiles over the aggregate artifact budget without fetching any artifact", async () => {
    const projectRoot = await temporaryProject();
    const skills = Array.from({ length: 9 }, (_, index) => {
      const skill = `skill-${index}`;
      const marker = index.toString(16);
      return {
        locator: `example/${skill}@1.0.0`,
        namespace: "example",
        skill,
        version: "1.0.0",
        artifact: { sha256: marker.repeat(64), bytes: 64 * 1024 * 1024 },
        attestation: { sha256: "a".repeat(64), keyId: "test-key" },
        trust: {
          sequence: 1,
          status: "trusted",
          keyId: "test-key",
          sha256: "b".repeat(64),
          updatedAt: "2026-08-27T00:00:00.000Z",
        },
        installedPath: `.agents/skills/${skill}`,
      };
    });
    await writeFile(
      join(projectRoot, "skill-lock.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        lockfileType: "skillpress.lock",
        registry: { origin: "https://skill-press.com", protocolVersion: 1 },
        skills,
      })}\n`,
    );
    const fetcher = vi.fn() as unknown as typeof globalThis.fetch;
    await expect(installTrustedSkills({ projectRoot, fetcher })).rejects.toMatchObject({
      code: "lock_invalid",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects symlinked install roots and unsafe project roots", async () => {
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    const outside = await temporaryProject();
    await symlink(outside, join(projectRoot, ".agents"));
    await expect(
      addTrustedSkill({
        locator: fixture.locator.locator,
        projectRoot,
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
    expect(await readFile(join(outside, "marker"), "utf8").catch(() => "missing")).toBe("missing");

    await expect(
      addTrustedSkill({
        locator: fixture.locator.locator,
        projectRoot: join(projectRoot, "missing"),
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_path_unsafe" });
  });

  it("does not silently accept executable-bit changes in an existing installation", async () => {
    if (process.platform === "win32") return;
    const projectRoot = await temporaryProject();
    const fixture = registryFixture();
    await addTrustedSkill({
      locator: fixture.locator.locator,
      projectRoot,
      fetcher: fixture.fetcher,
      keyring: [fixture.key.pinned],
      now: NOW,
    });
    await chmod(join(projectRoot, ".agents/skills/example-skill/scripts/run.sh"), 0o644);
    await expect(
      installTrustedSkills({
        projectRoot,
        fetcher: fixture.fetcher,
        keyring: [fixture.key.pinned],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "install_conflict" });
  });
});
