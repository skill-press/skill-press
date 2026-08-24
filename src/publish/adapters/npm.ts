import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  PublicationAdapter,
  PublicationContext,
  PublicationPreflight,
  PublicationVerification,
} from "../saga.js";
import {
  jsonRecord,
  passed,
  type PublicationAdapterRuntime,
  runProviderCommand as runCommand,
  runProviderHttp,
  text,
} from "./command.js";

interface NpmPackage {
  readonly name: string;
  readonly version: string;
  readonly repositoryUrl: string;
  readonly publicAccess: boolean;
  readonly provenance: boolean;
}

function npmEnvironment(): Readonly<Record<string, string>> {
  const names = [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "GITHUB_ACTIONS",
    "GITHUB_REF",
    "GITHUB_REPOSITORY",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW_REF",
  ] as const;
  return Object.freeze({
    ...Object.fromEntries(
      names.flatMap((name) => {
        const value = process.env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    ),
    NPM_CONFIG_PROVENANCE: "true",
    NO_COLOR: "1",
  });
}

function runNpm(
  root: string,
  argv: readonly [string, ...string[]],
  runtime: PublicationAdapterRuntime,
) {
  return runCommand(root, argv, runtime, npmEnvironment());
}

async function packageContract(root: string): Promise<NpmPackage | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    const repository = record.repository;
    const publishConfig = record.publishConfig;
    if (
      typeof record.name !== "string" ||
      typeof record.version !== "string" ||
      repository === null ||
      typeof repository !== "object" ||
      Array.isArray(repository) ||
      publishConfig === null ||
      typeof publishConfig !== "object" ||
      Array.isArray(publishConfig)
    ) {
      return null;
    }
    const repositoryUrl = (repository as Readonly<Record<string, unknown>>).url;
    const config = publishConfig as Readonly<Record<string, unknown>>;
    return typeof repositoryUrl === "string"
      ? Object.freeze({
          name: record.name,
          version: record.version,
          repositoryUrl,
          publicAccess: config.access === "public",
          provenance: config.provenance === true,
        })
      : null;
  } catch {
    return null;
  }
}

function packageSpec(value: NpmPackage): string {
  return `${value.name}@${value.version}`;
}

function provenanceUrl(value: Readonly<Record<string, unknown>>): string | null {
  const dist = value.dist;
  if (dist === null || typeof dist !== "object" || Array.isArray(dist)) return null;
  const record = dist as Readonly<Record<string, unknown>>;
  const attestations = record.attestations;
  if (
    typeof record.integrity !== "string" ||
    typeof record.shasum !== "string" ||
    typeof record.tarball !== "string" ||
    !Array.isArray(record.signatures) ||
    record.signatures.length === 0 ||
    attestations === null ||
    typeof attestations !== "object" ||
    Array.isArray(attestations)
  ) {
    return null;
  }
  const attestation = attestations as Readonly<Record<string, unknown>>;
  const provenance = attestation.provenance;
  return typeof attestation.url === "string" &&
    provenance !== null &&
    typeof provenance === "object" &&
    !Array.isArray(provenance) &&
    (provenance as Readonly<Record<string, unknown>>).predicateType ===
      "https://slsa.dev/provenance/v1"
    ? attestation.url
    : null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function attestationUrlMatches(url: string, contract: NpmPackage): boolean {
  try {
    const parsed = new URL(url);
    const prefix = "/-/npm/v1/attestations/";
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "registry.npmjs.org" &&
      parsed.pathname.startsWith(prefix) &&
      decodeURIComponent(parsed.pathname.slice(prefix.length)) === packageSpec(contract)
    );
  } catch {
    return false;
  }
}

function sourceAttestationMatches(
  body: string,
  integrity: string,
  context: PublicationContext,
  contract: NpmPackage,
): boolean {
  try {
    const root = record(JSON.parse(body));
    if (root === null || !Array.isArray(root.attestations)) return false;
    const slsa = root.attestations
      .map(record)
      .find((entry) => entry?.predicateType === "https://slsa.dev/provenance/v1");
    const bundle = record(slsa?.bundle);
    const envelope = record(bundle?.dsseEnvelope);
    const payloadText = envelope?.payload;
    const payload =
      typeof payloadText === "string"
        ? record(JSON.parse(Buffer.from(payloadText, "base64").toString("utf8")))
        : null;
    const subjects = Array.isArray(payload?.subject) ? payload.subject.map(record) : [];
    const expectedDigest = integrity.startsWith("sha512-")
      ? Buffer.from(integrity.slice(7), "base64").toString("hex")
      : "";
    const subjectMatches = subjects.some((subject) => {
      const digest = record(subject?.digest);
      return (
        subject?.name === `pkg:npm/${contract.name.replace("@", "%40")}@${contract.version}` &&
        digest?.sha512 === expectedDigest &&
        expectedDigest.length === 128
      );
    });
    const predicate = record(payload?.predicate);
    const definition = record(predicate?.buildDefinition);
    const external = record(definition?.externalParameters);
    const workflow = record(external?.workflow);
    const dependencies = Array.isArray(definition?.resolvedDependencies)
      ? definition.resolvedDependencies.map(record)
      : [];
    const runDetails = record(predicate?.runDetails);
    const builder = record(runDetails?.builder);
    const verification = record(bundle?.verificationMaterial);
    const tlog = verification?.tlogEntries;
    const signatures = envelope?.signatures;
    return (
      payload?.predicateType === "https://slsa.dev/provenance/v1" &&
      subjectMatches &&
      workflow?.repository === context.project.repository &&
      dependencies.some(
        (dependency) => record(dependency?.digest)?.gitCommit === context.sourceCommit,
      ) &&
      builder?.id === "https://github.com/actions/runner/github-hosted" &&
      Array.isArray(tlog) &&
      tlog.length > 0 &&
      Array.isArray(signatures) &&
      signatures.length > 0
    );
  } catch {
    return false;
  }
}

async function verifyNpm(
  context: PublicationContext,
  contract: NpmPackage,
  runtime: PublicationAdapterRuntime,
): Promise<PublicationVerification> {
  const value = jsonRecord(
    await runNpm(
      context.root,
      ["npm", "view", packageSpec(contract), "name", "version", "dist", "--json"],
      runtime,
    ),
  );
  const url = value === null ? null : provenanceUrl(value);
  const dist = record(value?.dist);
  const integrity = dist?.integrity;
  const attestation =
    typeof url === "string" && typeof integrity === "string" && attestationUrlMatches(url, contract)
      ? await runProviderHttp({ method: "GET", url }, runtime)
      : null;
  const ok =
    value?.name === contract.name &&
    value.version === contract.version &&
    attestation?.status === 200 &&
    typeof integrity === "string" &&
    sourceAttestationMatches(attestation.body, integrity, context, contract);
  return Object.freeze({
    ok,
    ...(ok
      ? {
          remoteId: packageSpec(contract),
          url: `https://www.npmjs.com/package/${contract.name}/v/${contract.version}`,
        }
      : {}),
  });
}

function trustedPublishingContext(context: PublicationContext): boolean {
  const repo = new URL(context.project.repository).pathname
    .replace(/^\//u, "")
    .replace(/[.]git$/u, "");
  return (
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_REPOSITORY === repo &&
    process.env.GITHUB_SHA === context.sourceCommit &&
    typeof process.env.ACTIONS_ID_TOKEN_REQUEST_URL === "string" &&
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL.length > 0 &&
    typeof process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === "string" &&
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0
  );
}

function supportedNpmVersion(input: string): boolean {
  const match = /^(\d+)[.](\d+)[.](\d+)$/u.exec(input);
  if (match === null) return false;
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  return major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
}

/** Publish the scoped CLI only through npm trusted publishing with required provenance. */
export function createNpmPublicationAdapter(
  runtime: PublicationAdapterRuntime = {},
): PublicationAdapter {
  return Object.freeze({
    id: "npm",
    capability: "publish",
    auth: Object.freeze(["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]),
    rollback: "npm versions are immutable; deprecation or policy-compliant unpublish is manual",
    steps: Object.freeze(["publish-package"]),
    preflight: async (context: PublicationContext): Promise<PublicationPreflight> => {
      const contract = await packageContract(context.root);
      if (
        contract === null ||
        contract.name !== "@mushanyoung/skillpress" ||
        contract.version !== context.project.version ||
        contract.repositoryUrl !== `git+${context.project.repository}.git` ||
        !contract.publicAccess ||
        !contract.provenance
      ) {
        return Object.freeze({
          ok: false,
          code: "package_invalid",
          message: "scoped npm package metadata must match the release contract",
        });
      }
      if ((await verifyNpm(context, contract, runtime)).ok) {
        return Object.freeze({ ok: true, code: "ready", message: "npm version already verified" });
      }
      if (!trustedPublishingContext(context)) {
        return Object.freeze({
          ok: false,
          code: "trusted_publishing_required",
          message: "run from the bound GitHub Actions trusted-publisher workflow",
        });
      }
      const version = await runNpm(context.root, ["npm", "--version"], runtime);
      if (!passed(version) || !supportedNpmVersion(text(version))) {
        return Object.freeze({
          ok: false,
          code: "npm_version_unsupported",
          message: "npm 11.5.1 or newer is required for trusted publishing",
        });
      }
      const ping = await runNpm(context.root, ["npm", "ping", "--json"], runtime);
      const pack = await runNpm(context.root, ["npm", "pack", "--dry-run", "--json"], runtime);
      if (!passed(ping) || !passed(pack)) {
        return Object.freeze({
          ok: false,
          code: "npm_preflight_failed",
          message: "npm registry or package dry-run preflight failed",
        });
      }
      return Object.freeze({ ok: true, code: "ready", message: "npm publication is ready" });
    },
    execute: async (context: PublicationContext, step: string) => {
      if (step !== "publish-package") throw new Error("Unknown npm publication step");
      const contract = await packageContract(context.root);
      if (contract === null) throw new Error("npm package contract disappeared");
      const existing = await verifyNpm(context, contract, runtime);
      if (!existing.ok) {
        const result = await runNpm(
          context.root,
          ["npm", "publish", "--access", "public"],
          runtime,
        );
        if (!passed(result)) throw new Error("npm trusted publication failed");
      }
      return Object.freeze({
        remoteId: packageSpec(contract),
        url: `https://www.npmjs.com/package/${contract.name}/v/${contract.version}`,
      });
    },
    verify: async (context: PublicationContext) => {
      const contract = await packageContract(context.root);
      return contract === null
        ? Object.freeze({ ok: false })
        : verifyNpm(context, contract, runtime);
    },
  });
}
