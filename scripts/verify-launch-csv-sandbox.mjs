import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { executeSandboxInvocation } from "../dist/eval/sandbox-execute.js";
import { createSandboxInvocation, DEFAULT_SANDBOX_RESOURCE_POLICY } from "../dist/eval/sandbox.js";

// Explicit locally available pinned image only. No pull, provider call or credentials.
const image = process.argv[2];
if (process.argv.length !== 3 || !/^python@sha256:[a-f0-9]{64}$/u.test(image ?? "")) {
  throw new Error("Usage: node scripts/verify-launch-csv-sandbox.mjs python@sha256:<digest>");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "skills/csv-quality-check/scripts/profile.py");
const fixture = join(root, "examples/launch-skills/import.csv");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceBefore = sha256(await readFile(source));
const fixtureBefore = sha256(await readFile(fixture));
const temporary = await mkdtemp(join(tmpdir(), "skillpress-csv-sandbox-"));
const results = [];
try {
  const skill = join(temporary, "skill");
  const input = join(temporary, "input");
  const output = join(temporary, "output");
  for (const directory of [skill, input, output]) await mkdir(directory, { mode: 0o755 });
  await chmod(output, 0o777);
  await copyFile(source, join(skill, "profile.py"));
  await copyFile(fixture, join(input, "import.csv"));
  await writeFile(join(input, "malformed.csv"), 'id,note\n1,"unterminated\n');
  await writeFile(join(input, "invalid-utf8.csv"), Buffer.from([0xff, 0xfe, 0x61]));
  await writeFile(join(input, "oversized.csv"), Buffer.alloc(10 * 1024 * 1024 + 1, 65));
  await writeFile(join(input, "empty.csv"), "");
  const hashes = async () =>
    Object.fromEntries(
      await Promise.all(
        (await readdir(input))
          .sort()
          .map(async (name) => [name, sha256(await readFile(join(input, name)))]),
      ),
    );
  const inputsBefore = await hashes();
  for (const name of [
    "import.csv",
    "malformed.csv",
    "invalid-utf8.csv",
    "oversized.csv",
    "empty.csv",
    "missing.csv",
  ]) {
    const invocation = createSandboxInvocation({
      backend: "docker",
      runId: randomBytes(16).toString("hex"),
      image,
      command: ["python3", "-I", "-B", "/skill/profile.py", `/input/${name}`],
      network: "none",
      mounts: [
        { source: skill, target: "/skill", mode: "read-only" },
        { source: input, target: "/input", mode: "read-only" },
        { source: output, target: "/output", mode: "read-write" },
      ],
      policy: { ...DEFAULT_SANDBOX_RESOURCE_POLICY, timeoutSeconds: 30 },
    });
    const result = await executeSandboxInvocation(invocation);
    const valid = name === "import.csv";
    assert.equal(result.status, valid ? "passed" : "failed", `${name}: ${result.status}`);
    assert.equal(result.exitCode, valid ? 0 : 2, name);
    assert.equal(valid ? result.stderrText : result.stdoutText, "", name);
    const report = JSON.parse(valid ? result.stdoutText : result.stderrText);
    assert.deepEqual(
      report,
      valid
        ? {
            ok: true,
            dataRecords: 5,
            columns: 3,
            emptyHeaderPositions: [],
            duplicateHeaderCount: 0,
            widthMismatchRecords: [5],
            blankCellsByColumn: [0, 1, 0],
            duplicateRecords: 1,
            possibleFormulaCells: 1,
          }
        : {
            ok: false,
            error:
              "Cannot profile input: check readability, UTF-8 encoding, CSV syntax, header and the 10 MiB limit.",
          },
    );
    results.push({
      name,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      report,
    });
  }
  assert.deepEqual(await hashes(), inputsBefore);
  assert.deepEqual(await readdir(output), []);
  assert.equal(sha256(await readFile(join(skill, "profile.py"))), sourceBefore);
  assert.equal(sha256(await readFile(source)), sourceBefore);
  assert.equal(sha256(await readFile(fixture)), fixtureBefore);
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      kind: "skillpress.csv-script-smoke",
      image,
      sourceSha256: sourceBefore,
      fixtureSha256: fixtureBefore,
      inputsSha256: inputsBefore,
      inputUnchanged: true,
      outputFiles: 0,
      network: "none",
      user: "65532:65532",
      readOnlyRoot: true,
      results,
      releaseEligible: false,
      modelCalls: 0,
      productionMutation: false,
    }),
  );
} finally {
  // Only this invocation's mkdtemp directory; no repository or shared image cleanup.
  await rm(temporary, { recursive: true, force: true });
}
