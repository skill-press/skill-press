import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
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
      "npm exec -- tsc -p tsconfig.submission-tests.json",
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
    expect(verify?.if).toContain("skill-press/skill-press");
    expect(verify?.permissions).toEqual({ contents: "read" });
    expect(verify?.if).toBe(
      "github.repository == 'skill-press/skill-press' && !github.event.release.prerelease && github.run_attempt == 1",
    );
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
        .slice(0, 7),
    ).toEqual([
      "node scripts/verify-release.mjs",
      "npm ci --ignore-scripts",
      "npm run check",
      "npm exec -- tsc -p tsconfig.submission-tests.json",
      "node scripts/verify-github-release-assets.mjs",
      "npm run security:audit",
      "npm run package:verify",
    ]);
    expect(publish?.environment).toBe("npm");
    expect(publish?.if).toBe(
      "github.repository == 'skill-press/skill-press' && !github.event.release.prerelease && github.run_attempt == 1",
    );
    expect(publish?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(publish?.["runs-on"]).toBe("ubuntu-latest");
    expect(publish?.["timeout-minutes"]).toBe(60);
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
    const registryWaitStep = publish?.steps?.find((step) =>
      step.run?.includes("npm publish-time scan pending"),
    );
    expect(publishStep?.if).toBe("steps.registry-before.outputs.publish_required == 'true'");
    expect(registryWaitStep?.run).not.toContain("if node");
    expect(source).toContain(`npm publish "${runnerTemp}/npm-release/"*.tgz --access public`);
    expect(source).toContain("verify-npm-registry-release.mjs");
    expect(source).toContain('while [ "$attempt" -le 200 ]');
    expect(source).toContain("sleep 15");
    expect(source).toContain('if [ "$status" != "absent" ]');
    expect(source).toContain('state.status !== "absent" && state.status !== "match"');
    expect(source).toContain("manifest.verifier.sha256");
    expect(source).toContain('remote.status !== "match"');
    expect(source).toContain("npm audit signatures");
    expect(source).toContain("--include-attestations");
    expect(source).toContain("installed?.integrity !== manifest.integrity");
    expect(source).toContain('v.status !== "audit-match"');
    expect(source).toContain("skillpress.npm-trusted-release");
    expect(source).toContain("SKILL_PRESS_PACKAGE_OUTPUT_DIR");
    expect(source).toContain('manifest.name !== "@skill-press/cli"');
    expect(source).toContain(
      'manifest.repository !== "https://github.com/skill-press/skill-press"',
    );
    expect(source).toMatch(
      /manifest[.]filename !== `skill-press-cli-\$\{manifest[.]version\}[.]tgz`/u,
    );
    expect(source).not.toContain("@mushanyoung/skillpress");
    expect(source).not.toContain("mushanyoung/skillpress");
    expect(source).not.toContain("npm view");
    expect(source).not.toMatch(/(?:NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.)/u);
    expect(source).not.toContain("workflow_dispatch");
  });

  it("locks the canonical package, executable, repository, and schema inventory", async () => {
    const packageJson = await json("package.json");
    const packageLock = await json("package-lock.json");
    const lockRoot = (packageLock.packages as Record<string, Record<string, unknown>>)[""];

    expect(packageJson).toMatchObject({
      name: "@skill-press/cli",
      description: "Build, verify, submit, and install trusted agent skills.",
      repository: {
        type: "git",
        url: "git+https://github.com/skill-press/skill-press.git",
      },
      homepage: "https://skill-press.com",
      bugs: { url: "https://github.com/skill-press/skill-press/issues" },
      bin: { skpress: "./dist/bin.js" },
    });
    expect(packageJson.bin).toEqual({ skpress: "./dist/bin.js" });
    expect(lockRoot).toMatchObject({
      name: "@skill-press/cli",
      bin: { skpress: "dist/bin.js" },
    });

    const schemaNames = [
      "skill-press",
      "submission-manifest",
      "submission-resource",
      "submission-receipt",
      "release-resource",
      "release-attestation",
      "trust-statement",
      "current-trust-checkpoint",
      "signed-envelope",
    ] as const;
    const schemas = await Promise.all(
      schemaNames.map(async (name) => [name, await json(`schemas/${name}.schema.json`)] as const),
    );
    for (const [name, schema] of schemas) {
      expect(schema.$id).toBe(
        `https://raw.githubusercontent.com/skill-press/skill-press/main/schemas/${name}.schema.json`,
      );
    }

    const project = schemas[0][1];
    const projectProperties = project.properties as Record<string, unknown>;
    expect((projectProperties.schemaVersion as Record<string, unknown>).const).toBe(2);
    expect(project.required).toContain("registry");
    expect(projectProperties).not.toHaveProperty("publish");
    expect(project.required).not.toContain("publish");

    const manifest = schemas[1][1];
    const manifestProperties = manifest.properties as Record<string, Record<string, unknown>>;
    expect(manifestProperties.configSchemaVersion.const).toBe(2);
    expect(manifest.required).toContain("registry");
    expect(
      (manifestProperties.tool.properties as Record<string, Record<string, unknown>>).name.const,
    ).toBe("@skill-press/cli");

    expect(schemas[2][1].required).toContain("namespace");
    expect(
      (schemas[3][1].properties as Record<string, Record<string, unknown>>).registry.required,
    ).toContain("namespace");

    await expect(
      readFile(new URL("../schemas/skillpress.schema.json", import.meta.url), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(new URL("../schemas/publication-receipt.schema.json", import.meta.url), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
