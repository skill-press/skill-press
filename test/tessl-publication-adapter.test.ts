import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { digestBoundedTree } from "../src/evidence/tree-digest.js";
import type { CapturedCommand, CapturedCommandResult } from "../src/process/capture.js";
import { createTesslPublicationAdapter } from "../src/publish/adapters/tessl.js";
import { projectTesslPlugin } from "../src/publish/projection.js";
import type { PublicationContext } from "../src/publish/saga.js";

const temporaryRoot = realpathSync(tmpdir());
const temporaryDirectories: string[] = [];
const markdown = `---
name: skillpress
description: Reliable skill delivery.
license: MIT
---
# SkillPress
`;
const remoteId = "mushanyoung/skillpress@0.1.0";
const remoteUrl = "https://tessl.io/registry/mushanyoung/skillpress/0.1.0";
const trustedExecutableSha256 = "60db8f2be553fd2221d097dca6f748f9372f54af42ad1329149ae4c180d7dd39";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(source = markdown): Promise<PublicationContext> {
  const root = await mkdtemp(join(temporaryRoot, "skillpress-tessl-publish-"));
  temporaryDirectories.push(root);
  const canonical = join(root, ".skillpress/staging/x/canonical/skillpress");
  const artifacts = join(root, ".skillpress/staging/x/artifacts");
  await mkdir(join(canonical, "scripts"), { recursive: true });
  await mkdir(join(canonical, "references"), { recursive: true });
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(canonical, "SKILL.md"), source);
  await writeFile(join(canonical, "scripts/check.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(canonical, "references/guide.md"), "# Guide\n");
  const provenance = Buffer.from(
    `${JSON.stringify({
      provenanceType: "skillpress.package",
      sourceCommit: "c".repeat(40),
      skillSha256: await digestBoundedTree(canonical),
      project: { skillName: "skillpress" },
    })}\n`,
  );
  await writeFile(join(artifacts, "provenance.json"), provenance);
  return Object.freeze({
    root,
    project: Object.freeze({
      name: "skillpress",
      version: "0.1.0",
      repository: "https://github.com/mushanyoung/skillpress",
    }),
    skill: Object.freeze({ name: "skillpress", path: "skills/skillpress" }),
    sourceCommit: "c".repeat(40),
    artifactSha256: "a".repeat(64),
    artifactsPath: ".skillpress/staging/x/artifacts",
    artifacts: Object.freeze({
      skillArchive: Object.freeze({ name: "x.skill", sha256: "a".repeat(64), bytes: 1 }),
      zipArchive: Object.freeze({ name: "x.zip", sha256: "b".repeat(64), bytes: 1 }),
      checksums: Object.freeze({ name: "SHA256SUMS", sha256: "d".repeat(64), bytes: 2 }),
      provenance: Object.freeze({
        name: "provenance.json",
        sha256: digest(provenance),
        bytes: provenance.byteLength,
      }),
    }),
    idempotencyKey: "e".repeat(64),
  });
}

function commandResult(
  stdout: string | Buffer,
  ok = true,
  stderr: string | Buffer = "",
): CapturedCommandResult {
  const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const errors = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr);
  return {
    status: ok ? "passed" : "failed",
    exitCode: ok ? 0 : 1,
    signal: null,
    durationMs: 1,
    stdout: output,
    stderr: errors,
    stdoutBytes: output.byteLength,
    stderrBytes: errors.byteLength,
    stdoutSha256: digest(output),
    stderrSha256: digest(errors),
  };
}

function absent(): CapturedCommandResult {
  return commandResult(
    JSON.stringify({ error: { title: "Not Found", status: 404, message: "Not Found" } }),
    false,
  );
}

function identity(scope: "workspace" | "org" = "workspace", workspace = "mushanyoung"): string {
  return JSON.stringify({
    authenticated: true,
    method: "api-key",
    source: "TESSL_TOKEN",
    key: {
      id: "key_1",
      name: "release",
      scope,
      org: scope === "org" ? { id: "org_1", name: "example" } : null,
      workspace: scope === "workspace" ? { id: "ws_1", name: workspace } : null,
    },
  });
}

interface TreeFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly mode: number;
  readonly type?: number;
}

async function tree(root: string, directory = ""): Promise<TreeFile[]> {
  const files: TreeFile[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
    const absolute = join(root, ...path.split("/"));
    if (entry.isDirectory()) files.push(...(await tree(root, path)));
    else {
      const metadata = await stat(absolute);
      files.push({ path, bytes: await readFile(absolute), mode: metadata.mode & 0o777 });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function tar(files: readonly TreeFile[], corruptChecksum = false): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    header.write(file.path, 0, 100, "utf8");
    octal(header, 100, 8, file.mode);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, file.bytes.byteLength);
    octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = file.type ?? 0x30;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0) + (corruptChecksum ? 1 : 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header, file.bytes, Buffer.alloc((512 - (file.bytes.byteLength % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

async function archive(
  context: PublicationContext,
  mutate?: (files: TreeFile[]) => void,
  corruptChecksum = false,
): Promise<Buffer> {
  const projected = await projectTesslPlugin(context, "mushanyoung");
  const files = await tree(projected.root);
  mutate?.(files);
  return gzipSync(tar(files, corruptChecksum));
}

function adapter(
  executor: (command: CapturedCommand) => Promise<CapturedCommandResult>,
  token: string | null = "tessl-secret",
) {
  return createTesslPublicationAdapter({
    workspace: "mushanyoung",
    executable: "tessl-official",
    executableSha256: trustedExecutableSha256,
    ...(token === null ? {} : { token }),
    executor,
  });
}

function operation(command: CapturedCommand): string {
  return command.argv.slice(1, 3).join(" ");
}

describe("Tessl publication adapter", () => {
  it("creates a private complete public-plugin projection and passes the official dry run", async () => {
    const context = await fixture();
    const calls: CapturedCommand[] = [];
    const publication = adapter(async (command) => {
      calls.push(command);
      if (command.argv[1] === "--version") return commandResult("0.99.0\n");
      if (operation(command) === "api --raw") return absent();
      if (operation(command) === "auth whoami") return commandResult(identity());
      return commandResult("Dry run complete — all pre-publish checks passed\n");
    });

    expect(publication).toMatchObject({
      id: "tessl",
      capability: "publish",
      auth: ["TESSL_TOKEN"],
      steps: ["publish-plugin"],
    });
    expect(publication.rollback).toContain("cannot become private");
    await expect(publication.preflight(context)).resolves.toEqual({
      ok: true,
      code: "ready",
      message: "Tessl publication is ready",
    });
    expect(calls.map((call) => call.argv)).toEqual([
      ["tessl-official", "--version"],
      [
        "tessl-official",
        "api",
        "--raw",
        "--header",
        "accept:application/gzip",
        "/v1/tiles/mushanyoung/skillpress/versions/0.1.0/files",
      ],
      ["tessl-official", "auth", "whoami", "--json"],
      [
        "tessl-official",
        "plugin",
        "publish",
        "--dry-run",
        "--skip-evals",
        "--verbose",
        expect.stringContaining("/.skillpress/projections/"),
      ],
    ]);
    expect(calls[1]?.env).toEqual({ NO_COLOR: "1", TESSL_AUTO_UPDATE_INTERVAL_MINUTES: "0" });
    expect(calls[2]?.env).toEqual({
      NO_COLOR: "1",
      TESSL_AUTO_UPDATE_INTERVAL_MINUTES: "0",
      TESSL_TOKEN: "tessl-secret",
    });
    expect(JSON.stringify(calls[1])).not.toContain("tessl-secret");

    const projected = await projectTesslPlugin(context, "mushanyoung");
    expect(JSON.parse(projected.manifest)).toEqual({
      name: "mushanyoung/skillpress",
      version: "0.1.0",
      description: "Reliable skill delivery.",
      private: false,
      skills: ["skills/skillpress"],
    });
    expect(await readFile(join(projected.root, "skills/skillpress/SKILL.md"), "utf8")).toBe(
      markdown,
    );
    expect(
      (await stat(join(projected.root, "skills/skillpress/scripts/check.sh"))).mode & 0o777,
    ).toBe(0o700);
    expect((await stat(join(projected.root, ".tessl-plugin/plugin.json"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("reuses and verifies only an exact immutable downloaded package", async () => {
    const context = await fixture();
    const calls: CapturedCommand[] = [];
    const publication = adapter(async (command) => {
      calls.push(command);
      return command.argv[1] === "--version"
        ? commandResult("0.99.0\n")
        : commandResult(await archive(context));
    });
    await expect(publication.preflight(context)).resolves.toEqual({
      ok: true,
      code: "ready",
      message: "Tessl version already verified",
    });
    await expect(publication.execute?.(context, "publish-plugin")).resolves.toEqual({
      remoteId,
      url: remoteUrl,
    });
    await expect(publication.verify(context)).resolves.toEqual({
      ok: true,
      remoteId,
      url: remoteUrl,
    });
    expect(
      calls.every((call) => call.argv[1] === "--version" || operation(call) === "api --raw"),
    ).toBe(true);
  });

  it("publishes once, confirms the exact receipt identity, and verifies downloaded bytes", async () => {
    const context = await fixture();
    let published = false;
    const calls: CapturedCommand[] = [];
    const publication = adapter(async (command) => {
      calls.push(command);
      if (command.argv[1] === "--version") return commandResult("0.99.0\n");
      if (operation(command) === "api --raw") {
        return published ? commandResult(await archive(context)) : absent();
      }
      if (operation(command) === "auth whoami") return commandResult(identity("org"));
      if (operation(command) === "plugin publish" && command.argv.includes("--dry-run")) {
        return commandResult("Dry run complete — all pre-publish checks passed\n");
      }
      published = true;
      return commandResult(`Published ${remoteId} to ${remoteUrl}\n`);
    });
    await expect(publication.execute?.(context, "publish-plugin")).resolves.toEqual({
      remoteId,
      url: remoteUrl,
    });
    await expect(publication.verify(context)).resolves.toMatchObject({ ok: true, remoteId });
    expect(
      calls.filter(
        (call) => operation(call) === "plugin publish" && !call.argv.includes("--dry-run"),
      ),
    ).toHaveLength(1);
  });

  it.each([
    [
      "extra file",
      (files: TreeFile[]) => files.push({ path: "extra.md", bytes: Buffer.from("x"), mode: 0o600 }),
    ],
    ["missing file", (files: TreeFile[]) => files.pop()],
    [
      "changed bytes",
      (files: TreeFile[]) => {
        (files[0] as { bytes: Buffer }).bytes = Buffer.from("changed");
      },
    ],
    [
      "changed executable mode",
      (files: TreeFile[]) => {
        (files.find((file) => file.path.endsWith("check.sh")) as { mode: number }).mode = 0o600;
      },
    ],
  ])("rejects remote %s as an immutable conflict", async (_name, mutate) => {
    const context = await fixture();
    const publication = adapter(async (command) =>
      command.argv[1] === "--version"
        ? commandResult("0.99.0")
        : commandResult(await archive(context, mutate)),
    );
    await expect(publication.preflight(context)).resolves.toMatchObject({
      ok: false,
      code: "version_conflict",
    });
  });

  it.each([
    ["plain text", async () => Buffer.from("not gzip")],
    ["bad checksum", async (context: PublicationContext) => archive(context, undefined, true)],
    [
      "duplicate path",
      async (context: PublicationContext) =>
        archive(context, (files) => files.push(files[0] as TreeFile)),
    ],
    [
      "traversal path",
      async (context: PublicationContext) =>
        archive(context, (files) => {
          (files[0] as { path: string }).path = "../escape";
        }),
    ],
    [
      "symbolic-link entry",
      async (context: PublicationContext) =>
        archive(context, (files) => {
          (files[0] as { type?: number }).type = 0x32;
        }),
    ],
    ["empty archive", async () => gzipSync(Buffer.alloc(1024))],
  ])("rejects a malformed remote archive with %s", async (_name, makeArchive) => {
    const context = await fixture();
    const publication = adapter(async (command) =>
      command.argv[1] === "--version"
        ? commandResult("0.99.0")
        : commandResult(await makeArchive(context)),
    );
    await expect(publication.verify(context)).resolves.toEqual({ ok: false });
  });

  it("classifies CLI, provider, credential, identity, and approval failures", async () => {
    const context = await fixture();
    await expect(
      adapter(async () => commandResult("0.98.0")).preflight(context),
    ).resolves.toMatchObject({ code: "cli_unsupported" });
    await expect(
      createTesslPublicationAdapter({
        workspace: "mushanyoung",
        executable: "tessl-official",
        executableSha256: "0".repeat(64),
        executor: async () => commandResult("0.99.0"),
      }).preflight(context),
    ).resolves.toMatchObject({ code: "cli_unsupported" });
    await writeFile(join(context.root, "fake-tessl"), "not an official executable", {
      mode: 0o755,
    });
    await expect(
      createTesslPublicationAdapter({
        workspace: "mushanyoung",
        executable: "./fake-tessl",
        executor: async () => commandResult("0.99.0"),
      }).preflight(context),
    ).resolves.toMatchObject({ code: "cli_unsupported" });
    await expect(
      createTesslPublicationAdapter({
        workspace: "mushanyoung",
        executable: "definitely-missing-tessl",
        executor: async () => commandResult("0.99.0"),
      }).preflight(context),
    ).resolves.toMatchObject({ code: "cli_unsupported" });
    await mkdir(join(context.root, "fake-tessl-directory"));
    await expect(
      createTesslPublicationAdapter({
        workspace: "mushanyoung",
        executable: "./fake-tessl-directory",
        executor: async () => commandResult("0.99.0"),
      }).preflight(context),
    ).resolves.toMatchObject({ code: "cli_unsupported" });
    await expect(
      adapter(async (command) =>
        command.argv[1] === "--version"
          ? commandResult("0.99.0")
          : commandResult('{"error":{"status":500}}', false),
      ).preflight(context),
    ).resolves.toMatchObject({ code: "provider_unavailable" });
    await expect(
      adapter(
        async (command) => (command.argv[1] === "--version" ? commandResult("0.99.0") : absent()),
        null,
      ).preflight(context),
    ).resolves.toMatchObject({ code: "auth_missing" });

    for (const invalidIdentity of [
      "not-json",
      JSON.stringify({ authenticated: false }),
      identity("workspace", "other"),
      JSON.stringify({
        authenticated: true,
        method: "api-key",
        source: "OTHER",
        key: { scope: "org" },
      }),
    ]) {
      await expect(
        adapter(async (command) => {
          if (command.argv[1] === "--version") return commandResult("0.99.0");
          if (operation(command) === "api --raw") return absent();
          return commandResult(invalidIdentity);
        }).preflight(context),
      ).resolves.toMatchObject({ code: "auth_invalid" });
    }

    for (const dryRun of [commandResult("failed", false), commandResult("unexpected success")]) {
      await expect(
        adapter(async (command) => {
          if (command.argv[1] === "--version") return commandResult("0.99.0");
          if (operation(command) === "api --raw") return absent();
          if (operation(command) === "auth whoami") return commandResult(identity());
          return dryRun;
        }).preflight(context),
      ).resolves.toMatchObject({ code: "approval_or_validation_required" });
    }
  });

  it("fails closed on projection changes, unknown steps, state races, and publish output", async () => {
    const context = await fixture();
    const canonical = join(
      context.root,
      ".skillpress/staging/x/canonical/skillpress/references/guide.md",
    );
    await writeFile(canonical, "changed\n");
    const invalid = adapter(async (command) =>
      command.argv[1] === "--version" ? commandResult("0.99.0") : absent(),
    );
    await expect(invalid.preflight(context)).resolves.toMatchObject({
      code: "provider_unavailable",
    });

    const valid = await fixture();
    const readyExecutor = async (command: CapturedCommand) => {
      if (command.argv[1] === "--version") return commandResult("0.99.0");
      if (operation(command) === "api --raw") return absent();
      if (operation(command) === "auth whoami") return commandResult(identity());
      return commandResult("Dry run complete — all pre-publish checks passed");
    };
    await expect(adapter(readyExecutor).execute?.(valid, "other")).rejects.toThrow(/Unknown/u);

    let inspections = 0;
    const racing = adapter(async (command) => {
      if (command.argv[1] === "--version") return commandResult("0.99.0");
      if (operation(command) === "api --raw") {
        inspections += 1;
        return inspections === 1 ? absent() : commandResult('{"error":{"status":500}}', false);
      }
      if (operation(command) === "auth whoami") return commandResult(identity());
      return commandResult("Dry run complete — all pre-publish checks passed");
    });
    await expect(racing.execute?.(valid, "publish-plugin")).rejects.toThrow(/state changed/u);

    const malformedPublish = adapter(async (command) => {
      if (command.argv[1] === "--version") return commandResult("0.99.0");
      if (operation(command) === "api --raw") return absent();
      if (operation(command) === "auth whoami") return commandResult(identity());
      if (command.argv.includes("--dry-run")) {
        return commandResult("Dry run complete — all pre-publish checks passed");
      }
      return commandResult("published something else");
    });
    await expect(malformedPublish.execute?.(valid, "publish-plugin")).rejects.toThrow(/confirm/u);
    await expect(adapter(async () => commandResult("0.98.0")).verify(valid)).resolves.toEqual({
      ok: false,
    });

    let changedDuringIdentity = false;
    const projectionRace = adapter(async (command) => {
      if (command.argv[1] === "--version") return commandResult("0.99.0");
      if (operation(command) === "api --raw") return absent();
      if (operation(command) === "auth whoami") {
        if (!changedDuringIdentity) {
          changedDuringIdentity = true;
          await writeFile(
            join(valid.root, ".skillpress/staging/x/canonical/skillpress/SKILL.md"),
            `${markdown}\nchanged`,
          );
        }
        return commandResult(identity());
      }
      return commandResult("Dry run complete — all pre-publish checks passed");
    });
    await expect(projectionRace.preflight(valid)).resolves.toMatchObject({
      code: "projection_invalid",
    });
  });

  it("treats unsafe local projection files as unavailable and ignores valid tar directories", async () => {
    const context = await fixture();
    const projection = await projectTesslPlugin(context, "mushanyoung");
    const linkedPath = join(projection.root, "skills/skillpress/references/guide.md");
    const linkTarget = join(context.root, "link-target");
    await writeFile(linkTarget, "# Guide\n");
    await rm(linkedPath);
    await symlink(linkTarget, linkedPath);
    const unsafe = adapter(async (command) =>
      command.argv[1] === "--version" ? commandResult("0.99.0") : commandResult("unreachable"),
    );
    await expect(unsafe.preflight(context)).resolves.toMatchObject({
      code: "provider_unavailable",
    });

    const clean = await fixture();
    const withDirectory = adapter(async (command) =>
      command.argv[1] === "--version"
        ? commandResult("0.99.0")
        : commandResult(
            await archive(clean, (files) =>
              files.unshift({ path: "skills", bytes: Buffer.alloc(0), mode: 0o755, type: 0x35 }),
            ),
          ),
    );
    await expect(withDirectory.verify(clean)).resolves.toMatchObject({ ok: true });
  });

  it("rejects unsafe options and projection storage reuse", async () => {
    expect(() => createTesslPublicationAdapter({ workspace: "Bad Workspace" })).toThrow(
      /workspace/u,
    );
    expect(() =>
      createTesslPublicationAdapter({ workspace: "mushanyoung", executable: "" }),
    ).toThrow(/executable/u);
    expect(() =>
      createTesslPublicationAdapter({ workspace: "mushanyoung", executableSha256: "bad" }),
    ).toThrow(/SHA-256/u);
    expect(() => createTesslPublicationAdapter({ workspace: "mushanyoung", token: "" })).toThrow(
      /token/u,
    );
    expect(() =>
      createTesslPublicationAdapter({ workspace: "mushanyoung", token: " token " }),
    ).toThrow(/token/u);

    const context = await fixture();
    const projected = await projectTesslPlugin(context, "mushanyoung");
    await writeFile(join(projected.root, "unexpected"), "x");
    await expect(projectTesslPlugin(context, "mushanyoung")).rejects.toThrow(/unexpected/u);
    await rm(join(projected.root, "unexpected"));
    await rm(join(projected.root, "skills/skillpress/references/guide.md"));
    await expect(projectTesslPlugin(context, "mushanyoung")).resolves.toMatchObject({
      root: projected.root,
    });
    await writeFile(join(projected.root, "skills/skillpress/references/guide.md"), "changed\n");
    await expect(projectTesslPlugin(context, "mushanyoung")).rejects.toThrow(
      /unexpected|idempotency/u,
    );

    const linked = await fixture();
    const linkedProjection = await projectTesslPlugin(linked, "mushanyoung");
    await rm(join(linkedProjection.root, ".tessl-plugin/plugin.json"));
    await mkdir(join(linkedProjection.root, ".tessl-plugin/plugin.json"));
    await expect(projectTesslPlugin(linked, "mushanyoung")).rejects.toThrow(/idempotency/u);
    expect(
      (await lstat(join(linkedProjection.root, ".tessl-plugin/plugin.json"))).isDirectory(),
    ).toBe(true);
  });

  it.each([
    ["missing frontmatter", "# SkillPress\n"],
    ["invalid frontmatter", "---\ndescription: one\ndescription: two\n---\n# SkillPress\n"],
    ["null frontmatter", "---\nnull\n---\n# SkillPress\n"],
    ["array frontmatter", "---\n- one\n---\n# SkillPress\n"],
    ["missing description", "---\nname: skillpress\n---\n# SkillPress\n"],
    ["non-string description", "---\nname: skillpress\ndescription: 42\n---\n# SkillPress\n"],
    ["empty description", "---\nname: skillpress\ndescription: ''\n---\n# SkillPress\n"],
  ])("rejects %s when generating Tessl metadata", async (_name, source) => {
    const context = await fixture(source);
    await expect(projectTesslPlugin(context, "mushanyoung")).rejects.toThrow(
      /frontmatter|description/u,
    );
  });
});
