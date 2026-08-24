import { stat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadProjectConfig } from "../src/config/load.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const documents = [
  "README.md",
  "docs/OPERATIONS.md",
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

  it("documents the actual interface, targets, credentials, and release boundary", async () => {
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
      "create",
      "improve",
      "check",
      "test",
      "eval",
      "tessl",
      "package",
      "publish",
      "status",
      "doctor",
    ]) {
      expect(operations).toContain(`\`${command}\``);
    }
    expect(operations).toContain("Publication is a dry run unless `--execute` is explicit");
    expect(operations).toContain("--training-evidence");
    expect(operations).toContain("checkTesslReleaseGate");
    expect(operations).toContain("resumeReceiptPath");
    expect(operations).toContain("npm run package:verify");
    expect(operations).toContain("tessl api-key create");
    expect(tessl).toContain("tessl api-key create");
    expect(operations).not.toContain("tessl auth token");
    for (const target of config.publish.targets) expect(registries).toContain(`\`${target}\``);
    for (const descriptor of [
      "GH_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "TESSL_TOKEN",
      "ASKILL_LOGIN",
      "CLAWHUB_LOGIN",
      "CLAWHUB_MIT0_CONSENT",
    ]) {
      expect(security).toContain(descriptor);
    }
    expect(registries).toContain("open PR is `pr_review_required`, not publication");
    expect(registries).toContain("receipt remains `derived`");
  });
});
