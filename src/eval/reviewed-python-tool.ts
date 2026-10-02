import { randomBytes, createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createSandboxInvocation, DEFAULT_SANDBOX_RESOURCE_POLICY } from "./sandbox.js";
import { executeSandboxInvocation } from "./sandbox-execute.js";

export interface ReviewedToolFile {
  readonly path: string;
  readonly content: string;
}

export interface ReviewedPythonToolRequest {
  readonly python: string;
  readonly image: string;
  readonly inputs: readonly ReviewedToolFile[];
  readonly skillFiles: readonly ReviewedToolFile[];
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function validateFiles(files: readonly ReviewedToolFile[]): void {
  if (!Array.isArray(files) || files.length > 16) throw new Error("Too many tool files.");
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (
      typeof file.path !== "string" ||
      file.path.length > 200 ||
      !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(file.path) ||
      file.path.split("/").some((part: string) => part === "." || part === "..") ||
      file.path.split("/")[0] === "__tool.py" ||
      typeof file.content !== "string" ||
      Buffer.byteLength(file.content) > 256 * 1024 ||
      [...seen].some(
        (path) =>
          path === file.path ||
          path.startsWith(`${file.path}/`) ||
          file.path.startsWith(`${path}/`),
      )
    )
      throw new Error("Invalid tool file.");
    seen.add(file.path);
    total += Buffer.byteLength(file.content);
  }
  if (total > 1024 * 1024) throw new Error("Tool inputs exceed the byte limit.");
}

/** Internal first-party tool primitive, not a public third-party evaluator or release receipt.
 * Caller supplies reviewed synthetic bytes; generated Python runs only in Docker.
 * Each call is stateless, has a 30-second bound and never mounts writable host storage.
 */
export async function runReviewedPythonTool(request: ReviewedPythonToolRequest) {
  const input = structuredClone(request);
  if (
    typeof input.python !== "string" ||
    !input.python.trim() ||
    Buffer.byteLength(input.python) > 64 * 1024
  )
    throw new Error("Python tool code must be nonempty and bounded.");
  if (!/^python@sha256:[a-f0-9]{64}$/u.test(input.image))
    throw new Error("A pinned Python image is required.");
  validateFiles(input.inputs);
  validateFiles(input.skillFiles);
  const root = await mkdtemp(join(tmpdir(), "skillpress-python-tool-"));
  try {
    const stage = async (name: string, files: readonly ReviewedToolFile[]) => {
      const directory = join(root, name);
      await mkdir(directory, { mode: 0o755 });
      for (const file of files) {
        const path = join(directory, file.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o755 });
        await writeFile(path, file.content, { mode: 0o444, flag: "wx" });
      }
      return directory;
    };
    const skill = await stage("skill", input.skillFiles);
    const fixtures = await stage("input", [
      ...input.inputs,
      { path: "__tool.py", content: input.python },
    ]);
    const invocation = createSandboxInvocation({
      backend: "docker",
      runId: randomBytes(16).toString("hex"),
      image: input.image,
      command: ["python3", "-I", "-B", "/input/__tool.py"],
      network: "none",
      outputStorage: "tmpfs",
      mounts: [
        { source: skill, target: "/skill", mode: "read-only" },
        { source: fixtures, target: "/input", mode: "read-only" },
      ],
      policy: {
        ...DEFAULT_SANDBOX_RESOURCE_POLICY,
        timeoutSeconds: 30,
        tmpfsMib: 8,
        maxOutputBytes: 64 * 1024,
      },
    });
    const execution = await executeSandboxInvocation(invocation);
    return Object.freeze({
      kind: "skillpress.reviewed-python-tool.v1" as const,
      image: input.image,
      pythonSha256: hash(input.python),
      inputs: input.inputs.map((file) => ({ path: file.path, sha256: hash(file.content) })),
      skillFiles: input.skillFiles.map((file) => ({ path: file.path, sha256: hash(file.content) })),
      network: "none" as const,
      outputStorage: "tmpfs" as const,
      policy: invocation.policy,
      execution,
      releaseEligible: false as const,
    });
  } finally {
    // Only this invocation's private mkdtemp directory, never caller-owned paths.
    await rm(root, { recursive: true, force: true });
  }
}
