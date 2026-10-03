import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("skills/report-brief/scripts/render.py");
const example = resolve("examples/launch-skills/report-brief-example.json");

async function fixture() {
  return JSON.parse(await readFile(example, "utf8"));
}

async function run(input: unknown) {
  const root = await mkdtemp(join(tmpdir(), "report-brief-test-"));
  try {
    const path = join(root, "input.json");
    const bytes = typeof input === "string" ? input : JSON.stringify(input);
    await writeFile(path, bytes);
    const result = spawnSync("python3", [script, path], { encoding: "utf8" });
    expect(await readFile(path, "utf8")).toBe(bytes);
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("report brief source-linked rendering", () => {
  it("renders the real script example, omitting known status but retaining its selected claim's known condition", async () => {
    const result = await run(await fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      report:
        "报告编辑仍夹带多余过程，首发价值尚未得到证明。下一步从原报告抽取有来源的事实，再由脚本生成简报。",
      included: ["result", "qualification", "new_action"],
      omitted: [{ id: "candidate", reason: "already-known" }],
      semanticExtractionVerified: false,
    });
  });

  it.each(["scope", "topic", "key"])("rejects replacement across %s", async (field) => {
    const data = await fixture();
    data.facts[4][field] = "different";
    const result = await run(data);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error).toContain("same topic, key and scope");
  });

  it("rejects a non-later replacement", async () => {
    const data = await fixture();
    data.sources.s2.order = 1;
    const result = await run(data);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error).toContain("later source");
  });

  it("rejects invented or empty source quotes without printing their contents", async () => {
    for (const quote of ["PRIVATE_UNSUPPORTED_TEXT", ""]) {
      const data = await fixture();
      data.facts[0].source.quote = quote;
      const result = await run(data);
      expect(result.status).toBe(2);
      expect(result.stderr).not.toContain("PRIVATE_UNSUPPORTED_TEXT");
      expect(result.stdout).toBe("");
    }
  });

  it("rejects selecting superseded facts", async () => {
    const data = await fixture();
    data.include.push("old_action");
    const result = await run(data);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error).toContain("superseded");
  });

  it("does not silently lose an old action's trigger during replacement", async () => {
    const data = await fixture();
    data.facts[3].qualifies.push("old_action");
    const failure = await run(data);
    expect(failure.status).toBe(2);
    expect(JSON.parse(failure.stderr).error).toContain("prior conditions");
    data.facts[3].qualifies.push("new_action");
    const result = await run(data);
    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(result.stdout).included.filter((id: string) => id === "qualification"),
    ).toHaveLength(1);
  });

  it("rejects evidence as recipient prose", async () => {
    const data = await fixture();
    data.facts[0].kind = "evidence";
    const result = await run(data);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error).toContain("not evidence");
  });

  it("preserves a declared changed fact even when marked known", async () => {
    const data = await fixture();
    data.facts[4].known = true;
    const result = await run(data);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).included).toContain("new_action");
  });

  it("produces a bounded no-change statement for unchanged known selections", async () => {
    const data = await fixture();
    data.include = ["candidate"];
    const result = await run(data);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).report).toBe("本次没有新增进展。");
  });

  it("rejects duplicate IDs and invalid source relationships", async () => {
    const duplicate = await fixture();
    duplicate.facts.push(duplicate.facts[0]);
    expect((await run(duplicate)).status).toBe(2);
    const missing = await fixture();
    missing.facts[3].qualifies = ["missing"];
    expect((await run(missing)).status).toBe(2);
    const self = await fixture();
    self.facts[4].supersedes = ["new_action"];
    expect((await run(self)).status).toBe(2);
  });

  it("rejects malformed, duplicate-key and oversized input", async () => {
    for (const invalid of ["{", '{"version":1,"version":1}', " ".repeat(2 * 1024 * 1024 + 1)]) {
      expect((await run(invalid)).status).toBe(2);
    }
  });
});
