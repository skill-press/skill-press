import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly environment?: string;
  readonly if?: string;
  readonly permissions?: Record<string, string>;
  readonly "runs-on"?: string;
  readonly steps?: WorkflowStep[];
  readonly strategy?: { readonly matrix?: { readonly [key: string]: unknown } };
}

interface Workflow {
  readonly jobs?: Record<string, WorkflowJob>;
  readonly on?: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
}

const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const setupNode = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const uploadArtifact = "actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4";
const downloadArtifact = "actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0";
const matrixNodeVersion = ["$", "{{ matrix.node-version }}"].join("");
const releaseTag = ["$", "{{ github.event.release.tag_name }}"].join("");
const runnerTemp = ["$", "{RUNNER_TEMP}"].join("");

async function workflow(
  name: string,
): Promise<{ readonly source: string; readonly value: Workflow }> {
  const source = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
  return { source, value: parse(source) as Workflow };
}

describe("GitHub Actions release contracts", () => {
  it("runs the complete gates on every supported Node.js major", async () => {
    const { value } = await workflow("ci.yml");
    const job = value.jobs?.quality;
    expect(Object.keys(value.on ?? {}).sort()).toEqual(["pull_request", "push"]);
    expect(value.permissions).toEqual({ contents: "read" });
    expect(job?.["runs-on"]).toBe("ubuntu-latest");
    expect(job?.strategy?.matrix?.["node-version"]).toEqual([22, 24, 26]);
    expect(job?.steps?.map((step) => step.uses).filter(Boolean)).toEqual([checkout, setupNode]);
    expect(job?.steps?.find((step) => step.uses === checkout)?.with).toMatchObject({
      "persist-credentials": false,
    });
    expect(job?.steps?.find((step) => step.uses === setupNode)?.with).toMatchObject({
      "node-version": matrixNodeVersion,
      "package-manager-cache": false,
    });
    expect(job?.steps?.map((step) => step.run).filter(Boolean)).toEqual([
      "npm ci --ignore-scripts",
      "npm run check",
      "npm run security:audit",
      "npm run package:verify",
    ]);
    expect(job?.steps?.at(-2)?.if).toBe("matrix.node-version == 26");
    expect(job?.steps?.at(-1)?.if).toBe("matrix.node-version == 26");
  });

  it("publishes only a verified formal release through tokenless OIDC", async () => {
    const { source, value } = await workflow("release.yml");
    const verify = value.jobs?.verify;
    const publish = value.jobs?.publish;
    expect(value.on).toEqual({ release: { types: ["published"] } });
    expect(value.permissions).toEqual({ contents: "read" });
    expect(verify?.environment).toBeUndefined();
    expect(verify?.permissions).toEqual({ contents: "read" });
    expect(verify?.steps?.map((step) => step.uses).filter(Boolean)).toEqual([
      checkout,
      setupNode,
      uploadArtifact,
    ]);
    expect(verify?.steps?.find((step) => step.uses === checkout)?.with).toMatchObject({
      ref: releaseTag,
      "persist-credentials": false,
      "fetch-depth": 0,
    });
    expect(
      verify?.steps
        ?.map((step) => step.run)
        .filter(Boolean)
        .slice(0, 6),
    ).toEqual([
      "node scripts/verify-release.mjs",
      "npm ci --ignore-scripts",
      "npm run check",
      "node scripts/verify-github-release-assets.mjs",
      "npm run security:audit",
      "npm run package:verify",
    ]);
    expect(publish?.environment).toBe("npm");
    expect(publish?.if).toContain("mushanyoung/skillpress");
    expect(publish?.if).toContain("!github.event.release.prerelease");
    expect(publish?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(publish?.["runs-on"]).toBe("ubuntu-latest");
    expect(publish?.steps?.map((step) => step.uses).filter(Boolean)).toEqual([
      setupNode,
      downloadArtifact,
      uploadArtifact,
    ]);
    expect(publish?.steps?.find((step) => step.uses === setupNode)?.with).toEqual({
      "node-version": 26,
      "registry-url": "https://registry.npmjs.org",
      "package-manager-cache": false,
    });
    expect(publish?.steps?.map((step) => step.run).filter(Boolean)).toHaveLength(6);
    const publishStep = publish?.steps?.find((step) => step.run?.includes("npm publish"));
    expect(publishStep?.if).toBe("steps.registry-before.outputs.publish_required == 'true'");
    expect(source).toContain(`npm publish "${runnerTemp}/npm-release/"*.tgz --access public`);
    expect(source).toContain("verify-npm-registry-release.mjs");
    expect(source).toContain('state.status !== "absent" && state.status !== "match"');
    expect(source).toContain("manifest.verifier.sha256");
    expect(source).toContain('remote.status !== "match"');
    expect(source).toContain("npm audit signatures");
    expect(source).toContain("--include-attestations");
    expect(source).toContain("installed?.integrity !== manifest.integrity");
    expect(source).toContain('v.status !== "audit-match"');
    expect(source).toContain("skillpress.npm-trusted-release");
    expect(source).not.toContain("npm view");
    expect(source).not.toMatch(/(?:NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.)/u);
    expect(source).not.toContain("workflow_dispatch");
  });
});
