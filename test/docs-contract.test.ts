import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadProjectConfig } from "../src/config/load.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const documents = [
  "README.md",
  "docs/OPERATIONS.md",
  "docs/PLAN.md",
  "docs/RELEASE_GATES.md",
  "docs/SECURITY.md",
  "docs/REGISTRIES.md",
  "docs/TESSL.md",
];

async function source(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

describe("operating documentation contracts", () => {
  it("keeps every local Markdown link resolvable", async () => {
    for (const document of documents) {
      const markdown = await source(document);
      const destinations = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map(
        (match) => match[1] as string,
      );
      for (const destination of destinations) {
        if (/^(?:https?:|#)/u.test(destination)) continue;
        const path = resolve(root, dirname(document), destination.split("#", 1)[0] as string);
        await expect(stat(path), `${document} -> ${destination}`).resolves.toBeDefined();
      }
    }
  });

  it("documents the canonical submission, trust, and release boundaries", async () => {
    const readme = await source("README.md");
    const operations = await source("docs/OPERATIONS.md");
    const security = await source("docs/SECURITY.md");
    const registries = await source("docs/REGISTRIES.md");
    const tessl = await source("docs/TESSL.md");
    const config = await loadProjectConfig(root);

    expect(readme).toContain("docs/OPERATIONS.md");
    expect(readme).toContain("docs/SECURITY.md");
    expect(readme).toContain("docs/REGISTRIES.md");
    for (const command of [
      "init",
      "improve",
      "check",
      "test",
      "eval",
      "tessl",
      "package",
      "submit",
      "status",
      "doctor",
    ]) {
      expect(operations).toContain(`\`${command}\``);
    }
    expect(config.schemaVersion).toBe(2);
    expect(config).not.toHaveProperty("publish");
    expect(readme).toContain("@skill-press/cli");
    expect(readme).toContain("skpress init");
    expect(readme).toContain("skpress submit");
    expect(operations).toContain("https://skill-press.com/api/v1");
    expect(operations).toContain("SKILL_PRESS_TOKEN");
    expect(operations).toContain("--dry-run");
    expect(operations).toContain("--training-evidence");
    expect(operations).toContain("checkTesslReleaseGate");
    expect(operations).toContain("resumeReceiptPath");
    expect(operations).toContain("npm run package:verify");
    expect(operations).toContain("tessl api-key create");
    expect(tessl).toContain("tessl api-key create");
    expect(tessl).toContain("0.101.0");
    expect(tessl).toContain("tessl review run quality --json --force");
    expect(tessl).toContain("tessl eval run --json --force");
    expect(tessl).toContain("--executable <absolute-versioned-binary>");
    expect(tessl).toContain("fresh private temporary HOME");
    expect(operations).not.toContain("tessl auth token");
    expect(registries).toContain("Skill Press does not provide author-facing multi-publish.");
    expect(readme).toContain("`skpress add` / `skpress install` are not live yet.");
    expect(registries).toMatch(/Tessl[\s\S]*external evidence/iu);
    expect(registries).toContain("Skill Press does not publish the canonical skill to Tessl");
    for (const status of [
      "received",
      "automated-review",
      "curator-review",
      "changes-requested",
      "accepted",
      "published",
      "rejected",
    ]) {
      expect(registries).toContain(`\`${status}\``);
    }
    for (const trust of ["trusted", "quarantined", "revoked"]) {
      expect(registries).toContain(`\`${trust}\``);
    }
    for (const descriptor of [
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "TESSL_TOKEN",
      "SKILL_PRESS_TOKEN",
    ]) {
      expect(security).toContain(descriptor);
    }
    const activeDocs = `${readme}\n${operations}\n${security}\n${registries}`;
    expect(activeDocs).not.toContain("publish.targets");
    expect(activeDocs).not.toContain("runPublicationSaga");
    expect(activeDocs).not.toContain("ASKILL_LOGIN");
    expect(activeDocs).not.toContain("CLAWHUB_LOGIN");
    expect(activeDocs).not.toContain("CLAWHUB_MIT0_CONSENT");
    expect(activeDocs).not.toMatch(/\bskillpress (?:create|check|test|eval|publish)\b/u);
  });
});
