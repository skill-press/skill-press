import { copyFile, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  validateBootstrapManifest,
  validateBootstrapPackResult,
  validateBootstrapTarball,
  verifyNpmBootstrapReservation,
  verifyPreparedNpmBootstrapTarball,
} from "../scripts/verify-npm-bootstrap-reservation.mjs";

const temporaryDirectories = [];
const reservationDirectory = new URL("../npm/bootstrap-reservation/", import.meta.url);
const reservationFiles = ["LICENSE", "README.md", "package.json"];

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function readReservationFiles() {
  return new Map(
    await Promise.all(
      reservationFiles.map(async (name) => [
        name,
        await readFile(new URL(name, reservationDirectory)),
      ]),
    ),
  );
}

function tarEntrySpan(archive, offset = 0) {
  const sizeField = archive
    .subarray(offset + 124, offset + 136)
    .toString("ascii")
    .replaceAll("\0", "")
    .trim();
  const size = Number.parseInt(sizeField, 8);
  return 512 + Math.ceil(size / 512) * 512;
}

function updateTarChecksum(archive, offset = 0) {
  archive.fill(0x20, offset + 148, offset + 156);
  let checksum = 0;
  for (const byte of archive.subarray(offset, offset + 512)) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(archive, offset + 148);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("inert npm bootstrap reservation", () => {
  it("keeps the formal package at 0.1.0 and documents the one-time ceremony", async () => {
    const formalPackage = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    const formalLock = JSON.parse(
      await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
    );
    const operations = await readFile(new URL("../docs/OPERATIONS.md", import.meta.url), "utf8");

    expect(formalPackage.version).toBe("0.1.0");
    expect(formalLock.version).toBe("0.1.0");
    expect(formalLock.packages[""].version).toBe("0.1.0");
    expect(formalPackage.scripts).toMatchObject({
      "npm:bootstrap:verify": "node scripts/verify-npm-bootstrap-reservation.mjs",
      "npm:bootstrap:prepare":
        "node scripts/verify-npm-bootstrap-reservation.mjs --pack-destination",
      "npm:bootstrap:verify-tarball":
        "node scripts/verify-npm-bootstrap-reservation.mjs --verify-tarball",
    });
    for (const command of [
      "npm run npm:bootstrap:verify",
      "npm run --silent npm:bootstrap:prepare --",
      "npm run --silent npm:bootstrap:verify-tarball --",
      "npm view '@skill-press/cli@*' versions dist-tags --json",
      "set -euo pipefail",
      "--access public --tag bootstrap --ignore-scripts",
      "name version bin scripts dependencies dist-tags dist.integrity dist.shasum --json",
      "npm dist-tag ls @skill-press/cli --registry=https://registry.npmjs.org/",
      "npm trust github @skill-press/cli --repo skill-press/skill-press",
      "--file release.yml --env npm --allow-publish --yes",
      "npm trust list @skill-press/cli --json --registry=https://registry.npmjs.org/",
    ]) {
      expect(operations).toContain(command);
    }
    expect(
      operations.match(/--registry=https:\/\/registry[.]npmjs[.]org\//gu)?.length,
    ).toBeGreaterThanOrEqual(7);
    const failFast = operations.indexOf("set -euo pipefail");
    const reverify = operations.indexOf("npm run --silent npm:bootstrap:verify-tarball --");
    const publish = operations.indexOf('npm publish "$BOOTSTRAP_TARBALL"');
    expect(failFast).toBeGreaterThan(operations.indexOf("npm view '@skill-press/cli@*'"));
    expect(reverify).toBeGreaterThan(failFast);
    expect(publish).toBeGreaterThan(reverify);
    expect(operations).toMatch(/never publish `0[.]1[.]0`\s+manually/u);
  });

  it("dry-runs and prepares only the verified three-file package", async () => {
    const destination = await temporaryDirectory("skill-press-bootstrap-pack-");
    const result = await verifyNpmBootstrapReservation({ packDestination: destination });

    expect(result).toMatchObject({
      status: "verified",
      package: "@skill-press/cli@0.0.0",
      tag: "bootstrap",
      files: ["LICENSE", "README.md", "package.json"],
    });
    expect(result.tarball).toBe(join(await realpath(destination), "skill-press-cli-0.0.0.tgz"));
    expect(result.shasum).toMatch(/^[a-f0-9]{40}$/u);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.integrity).toMatch(/^sha512-/u);
    await expect(readdir(destination)).resolves.toEqual(["skill-press-cli-0.0.0.tgz"]);

    await expect(verifyPreparedNpmBootstrapTarball(result.tarball)).resolves.toEqual(result);
  });

  it("rejects corrupted, unsafe, duplicate, truncated, and oversized tar archives", async () => {
    const destination = await temporaryDirectory("skill-press-bootstrap-hostile-pack-");
    const result = await verifyNpmBootstrapReservation({ packDestination: destination });
    const tarball = await readFile(result.tarball);
    const sourceFiles = await readReservationFiles();
    const unpacked = gunzipSync(tarball);

    expect(() => validateBootstrapTarball(tarball, sourceFiles)).not.toThrow();

    const badChecksum = Buffer.from(unpacked);
    badChecksum[0] ^= 1;

    const nonRegular = Buffer.from(unpacked);
    nonRegular[156] = "2".charCodeAt(0);
    updateTarChecksum(nonRegular);

    const duplicate = Buffer.concat([unpacked.subarray(0, tarEntrySpan(unpacked)), unpacked]);

    const tamperedManifest = Buffer.from(unpacked);
    const manifestNeedle = Buffer.from('"version": "0.0.0"');
    const manifestOffset = tamperedManifest.indexOf(manifestNeedle);
    expect(manifestOffset).toBeGreaterThanOrEqual(0);
    tamperedManifest[manifestOffset + manifestNeedle.byteLength - 2] = "1".charCodeAt(0);

    for (const [hostileTarball, expectedError] of [
      [tarball.subarray(0, tarball.byteLength - 8), /bounded gzip/u],
      [gzipSync(Buffer.alloc(64 * 1024 + 1)), /bounded gzip/u],
      [gzipSync(badChecksum), /invalid header/u],
      [gzipSync(nonRegular), /non-regular/u],
      [gzipSync(duplicate), /duplicate/u],
      [gzipSync(tamperedManifest), /content differs/u],
    ]) {
      expect(() => validateBootstrapTarball(hostileTarball, sourceFiles)).toThrow(expectedError);
    }
  });

  it("rejects executable, lifecycle, dependency, and release-tag metadata", () => {
    const base = {
      name: "@skill-press/cli",
      version: "0.0.0",
      description: "Inert name reservation for the future Skill Press CLI release.",
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/skill-press/skill-press.git",
      },
      homepage: "https://skill-press.com",
      files: ["README.md", "LICENSE"],
      publishConfig: {
        access: "public",
        tag: "bootstrap",
        provenance: false,
        registry: "https://registry.npmjs.org/",
      },
    };
    for (const changed of [
      { ...base, bin: { skpress: "index.js" } },
      { ...base, scripts: { prepack: "node index.js" } },
      { ...base, dependencies: { example: "1.0.0" } },
      { ...base, publishConfig: { ...base.publishConfig, tag: "latest" } },
      { ...base, version: "0.1.0" },
    ]) {
      expect(() => validateBootstrapManifest(changed)).toThrow(/exact inert/u);
    }
  });

  it("rejects an unexpected packed path and an unexpected source file", async () => {
    expect(() =>
      validateBootstrapPackResult({
        name: "@skill-press/cli",
        version: "0.0.0",
        id: "@skill-press/cli@0.0.0",
        filename: "skill-press-cli-0.0.0.tgz",
        entryCount: 4,
        size: 100,
        unpackedSize: 100,
        shasum: "a".repeat(40),
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        bundled: [],
        files: [
          { path: "LICENSE", size: 1, mode: 0o644 },
          { path: "README.md", size: 1, mode: 0o644 },
          { path: "index.js", size: 1, mode: 0o644 },
          { path: "package.json", size: 1, mode: 0o644 },
        ],
      }),
    ).toThrow(/three-file/u);

    const copy = await temporaryDirectory("skill-press-bootstrap-source-");
    for (const name of reservationFiles) {
      await copyFile(new URL(name, reservationDirectory), join(copy, name));
    }
    await writeFile(join(copy, "index.js"), "throw new Error('must not ship');\n");
    await expect(verifyNpmBootstrapReservation({ reservationDirectory: copy })).rejects.toThrow(
      /only regular/u,
    );
  });
});
