import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/eval/sandbox-execute.js", () => ({ executeSandboxInvocation: vi.fn() }));
import { executeSandboxInvocation } from "../src/eval/sandbox-execute.js";
import {
  runReviewedPythonTool,
  type ReviewedPythonToolRequest,
} from "../src/eval/reviewed-python-tool.js";

const request = (): ReviewedPythonToolRequest => ({
  python: "print('synthetic')",
  image: `python@sha256:${"a".repeat(64)}`,
  inputs: [{ path: "input.csv", content: "id\n001\n" }],
  skillFiles: [{ path: "scripts/profile.py", content: "print('profile')" }],
});
afterEach(() => vi.resetAllMocks());

it.each([false, true])(
  "stages only supplied bytes and cleans private staging (executor throws=%s)",
  async (throws) => {
    let root = "";
    vi.mocked(executeSandboxInvocation).mockImplementation(async (invocation) => {
      expect(invocation.argv).toContain("--tmpfs=/output:rw,noexec,nosuid,nodev,size=8m,mode=1777");
      expect(invocation.policy).toMatchObject({ timeoutSeconds: 30, maxOutputBytes: 65536 });
      const mounts = invocation.argv.filter((arg) => arg.startsWith("type=bind"));
      expect(mounts).toHaveLength(2);
      const skill = mounts[0].split(",")[1].slice(4);
      const input = mounts[1].split(",")[1].slice(4);
      root = dirname(input);
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      expect(await readFile(join(skill, "scripts/profile.py"), "utf8")).toBe(
        request().skillFiles[0].content,
      );
      expect(await readFile(join(input, "input.csv"), "utf8")).toBe(request().inputs[0].content);
      expect(await readFile(join(input, "__tool.py"), "utf8")).toBe(request().python);
      expect((await lstat(join(input, "__tool.py"))).mode & 0o777).toBe(0o444);
      if (throws) throw new Error("synthetic executor failure");
      return { status: "passed", stdoutText: "synthetic\n" } as Awaited<
        ReturnType<typeof executeSandboxInvocation>
      >;
    });
    if (throws)
      await expect(runReviewedPythonTool(request())).rejects.toThrow("synthetic executor failure");
    else
      expect(await runReviewedPythonTool(request())).toMatchObject({
        kind: "skillpress.reviewed-python-tool.v1",
        releaseEligible: false,
        execution: { status: "passed" },
        inputs: [{ path: "input.csv", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }],
      });
    expect(root).not.toBe("");
    await expect(lstat(root)).rejects.toThrow();
  },
);

it("allows empty skill mounts for an equivalent baseline tool", async () => {
  vi.mocked(executeSandboxInvocation).mockResolvedValue({ status: "passed" } as Awaited<
    ReturnType<typeof executeSandboxInvocation>
  >);
  expect(await runReviewedPythonTool({ ...request(), inputs: [], skillFiles: [] })).toMatchObject({
    inputs: [],
    skillFiles: [],
    releaseEligible: false,
  });
});

it.each([
  { python: "" },
  { python: " " },
  { python: "x".repeat(65537) },
  { image: "python:latest" },
  { image: `other@sha256:${"a".repeat(64)}` },
  ...[
    "../secret",
    "/absolute",
    "a/../b",
    ".",
    "a/./b",
    "a\\b",
    "__tool.py",
    "__tool.py/sub",
    "x".repeat(201),
  ].map((path) => ({ inputs: [{ path, content: "x" }] })),
  { inputs: Array.from({ length: 17 }, (_, i) => ({ path: `f${i}`, content: "x" })) },
  { inputs: [{ path: "a", content: "x".repeat(256 * 1024 + 1) }] },
  {
    inputs: Array.from({ length: 5 }, (_, i) => ({
      path: `f${i}`,
      content: "x".repeat(256 * 1024),
    })),
  },
  ...[
    ["a", "a"],
    ["a", "a/b"],
    ["a/b", "a"],
  ].map((paths) => ({ skillFiles: paths.map((path) => ({ path, content: "x" })) })),
])("rejects unsafe or oversized tool requests before execution: %j", async (change) => {
  await expect(runReviewedPythonTool({ ...request(), ...change })).rejects.toThrow();
  expect(executeSandboxInvocation).not.toHaveBeenCalled();
});
