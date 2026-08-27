import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

function fail(message) {
  throw new Error(`GitHub release asset verification failed: ${message}`);
}

let assets;
try {
  assets = JSON.parse(process.env.RELEASE_ASSETS_JSON ?? "");
} catch {
  fail("release asset metadata is not valid JSON");
}
if (!Array.isArray(assets)) fail("release asset metadata must be an array");
const baseName = `skill-press-${packageJson.version}`;
const expectedNames = [
  "SHA256SUMS",
  "provenance.json",
  `${baseName}.skill`,
  `${baseName}.zip`,
].sort();
const names = assets.map((asset) => asset?.name).sort();
if (names.join("\0") !== expectedNames.join("\0")) fail("release asset inventory is not exact");

const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
if (!/^[a-f0-9]{40}$/u.test(head)) fail("source commit is invalid");
const runId = createHash("sha256")
  .update(`${process.env.GITHUB_RUN_ID ?? ""}:${head}`)
  .digest("hex");
const relativeRun = `.skill-press/staging/${runId}`;
const runRoot = join(root, relativeRun);
const canonical = join(runRoot, "canonical", "skill-press");
const artifacts = join(runRoot, "artifacts");

try {
  await mkdir(join(runRoot, "canonical"), { recursive: true, mode: 0o700 });
  await mkdir(artifacts, { mode: 0o700 });
  for (const privateDirectory of [
    join(root, ".skill-press"),
    join(root, ".skill-press", "staging"),
    runRoot,
    join(runRoot, "canonical"),
    artifacts,
  ]) {
    await chmod(privateDirectory, 0o700);
  }
  await cp(join(root, "skills", "skill-press"), canonical, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  for (const asset of assets) {
    if (
      asset === null ||
      typeof asset !== "object" ||
      typeof asset.name !== "string" ||
      typeof asset.browser_download_url !== "string" ||
      typeof asset.digest !== "string" ||
      typeof asset.size !== "number"
    ) {
      fail("release asset metadata is incomplete");
    }
    const url = new URL(asset.browser_download_url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      !url.pathname.startsWith(
        `/skill-press/skill-press/releases/download/${encodeURIComponent(process.env.RELEASE_TAG)}/`,
      )
    ) {
      fail("release asset URL is not canonical");
    }
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) fail(`could not download ${asset.name}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > 64 * 1024 * 1024 ||
      bytes.byteLength !== asset.size
    ) {
      fail(`release asset size changed for ${asset.name}`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (asset.digest !== `sha256:${digest}`) fail(`release asset digest changed for ${asset.name}`);
    await writeFile(join(artifacts, asset.name), bytes, { flag: "wx", mode: 0o600 });
  }

  const { loadPackagedSkill } = await import("../dist/package/archive.js");
  const loaded = await loadPackagedSkill(root, `${relativeRun}/artifacts`);
  if (loaded.sourceCommit !== head) fail("release artifacts do not bind the checked-out source");
  process.stdout.write(
    `${JSON.stringify({ sourceCommit: head, artifactSha256: loaded.artifactSha256 })}\n`,
  );
} finally {
  await rm(runRoot, { recursive: true, force: true });
}
