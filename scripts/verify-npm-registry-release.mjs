import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const maximumBodyBytes = 4 * 1024 * 1024;
const slsaPredicate = "https://slsa.dev/provenance/v1";
const githubHostedBuilder = "https://github.com/actions/runner/github-hosted";
const githubActionsBuildType =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const releaseWorkflowPath = ".github/workflows/release.yml";

function fail(message) {
  throw new Error(`npm registry release verification failed: ${message}`);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function manifestContract(value) {
  const manifest = record(value);
  if (
    manifest?.schemaVersion !== 2 ||
    manifest.name !== "@mushanyoung/skillpress" ||
    typeof manifest.version !== "string" ||
    !/^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)$/u.test(manifest.version) ||
    manifest.package !== `${manifest.name}@${manifest.version}` ||
    manifest.repository !== "https://github.com/mushanyoung/skillpress" ||
    typeof manifest.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(manifest.integrity) ||
    typeof manifest.shasum !== "string" ||
    !/^[a-f0-9]{40}$/u.test(manifest.shasum) ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.sha256) ||
    typeof manifest.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(manifest.sourceCommit)
  ) {
    fail("manifest identity or digest contract is invalid");
  }
  return manifest;
}

async function responseText(response) {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximumBodyBytes) {
      await reader.cancel();
      fail("registry response exceeds the bounded size limit");
    }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function request(url, fetcher) {
  let response;
  try {
    response = await fetcher(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("registry request was unavailable");
  }
  return { response, body: await responseText(response) };
}

function json(body, label) {
  try {
    const value = record(JSON.parse(body));
    if (value === null) fail(`${label} is not a JSON object`);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("npm registry release verification")) {
      throw error;
    }
    fail(`${label} is not valid JSON`);
  }
}

function canonicalAttestationUrl(input, manifest) {
  if (typeof input !== "string") fail("provenance URL is missing");
  let url;
  try {
    url = new URL(input);
  } catch {
    fail("provenance URL is invalid");
  }
  const prefix = "/-/npm/v1/attestations/";
  let packageSpec;
  try {
    packageSpec = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    fail("provenance URL encoding is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "registry.npmjs.org" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith(prefix) ||
    packageSpec !== manifest.package
  ) {
    fail("provenance URL does not bind the exact npm package");
  }
  return url.href;
}

function verifyAttestation(body, manifest) {
  const root = json(body, "attestation response");
  if (!Array.isArray(root.attestations)) fail("attestation inventory is missing");
  const candidates = root.attestations
    .map(record)
    .filter((entry) => entry?.predicateType === slsaPredicate);
  if (candidates.length !== 1) fail("exactly one SLSA provenance attestation is required");
  const bundle = record(candidates[0]?.bundle);
  const envelope = record(bundle?.dsseEnvelope);
  if (
    envelope?.payloadType !== "application/vnd.in-toto+json" ||
    typeof envelope.payload !== "string" ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length === 0 ||
    !envelope.signatures.every((entry) => record(entry) !== null)
  ) {
    fail("DSSE envelope is incomplete");
  }
  let payload;
  try {
    payload = json(Buffer.from(envelope.payload, "base64").toString("utf8"), "DSSE payload");
  } catch {
    fail("DSSE payload is invalid");
  }
  const expectedDigest = Buffer.from(manifest.integrity.slice(7), "base64").toString("hex");
  const subjects = Array.isArray(payload.subject) ? payload.subject.map(record) : [];
  const subject = subjects[0];
  if (
    payload._type !== "https://in-toto.io/Statement/v1" ||
    payload.predicateType !== slsaPredicate ||
    subjects.length !== 1 ||
    subject?.name !== `pkg:npm/${manifest.name.replace("@", "%40")}@${manifest.version}` ||
    record(subject?.digest)?.sha512 !== expectedDigest ||
    expectedDigest.length !== 128
  ) {
    fail("provenance subject does not bind the exact tarball integrity");
  }
  const predicate = record(payload.predicate);
  const definition = record(predicate?.buildDefinition);
  const workflow = record(record(definition?.externalParameters)?.workflow);
  const dependencies = Array.isArray(definition?.resolvedDependencies)
    ? definition.resolvedDependencies.map(record)
    : [];
  const builder = record(record(predicate?.runDetails)?.builder);
  const tlogEntries = record(bundle?.verificationMaterial)?.tlogEntries;
  const releaseRef = `refs/tags/v${manifest.version}`;
  if (
    definition?.buildType !== githubActionsBuildType ||
    workflow?.repository !== manifest.repository ||
    workflow.path !== releaseWorkflowPath ||
    workflow.ref !== releaseRef ||
    !dependencies.some(
      (dependency) =>
        dependency?.uri === `git+${manifest.repository}@${releaseRef}` &&
        record(dependency.digest)?.gitCommit === manifest.sourceCommit,
    ) ||
    builder?.id !== githubHostedBuilder ||
    !Array.isArray(tlogEntries) ||
    tlogEntries.length === 0 ||
    !tlogEntries.every((entry) => record(entry) !== null)
  ) {
    fail("provenance source, builder, signature, or transparency evidence does not match");
  }
}

export async function verifyRegistryRelease(input, fetcher = globalThis.fetch.bind(globalThis)) {
  const manifest = manifestContract(input);
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
  const metadataResult = await request(metadataUrl, fetcher);
  if (metadataResult.response.status === 404) {
    return Object.freeze({ status: "absent", package: manifest.package });
  }
  if (metadataResult.response.status !== 200) {
    fail(`registry metadata returned HTTP ${metadataResult.response.status}`);
  }
  const metadata = json(metadataResult.body, "registry metadata");
  const dist = record(metadata.dist);
  const attestations = record(dist?.attestations);
  const signatures = dist?.signatures;
  if (
    metadata.name !== manifest.name ||
    metadata.version !== manifest.version ||
    dist?.integrity !== manifest.integrity ||
    dist?.shasum !== manifest.shasum ||
    typeof dist.tarball !== "string" ||
    !Array.isArray(signatures) ||
    signatures.length === 0 ||
    !signatures.every((entry) => record(entry) !== null) ||
    record(attestations?.provenance)?.predicateType !== slsaPredicate
  ) {
    fail("registry package conflicts with the verified release manifest");
  }
  const provenanceUrl = canonicalAttestationUrl(attestations?.url, manifest);
  const attestationResult = await request(provenanceUrl, fetcher);
  if (attestationResult.response.status !== 200) {
    fail(`registry attestation returned HTTP ${attestationResult.response.status}`);
  }
  verifyAttestation(attestationResult.body, manifest);
  return Object.freeze({
    status: "match",
    package: manifest.package,
    integrity: manifest.integrity,
    provenanceUrl,
  });
}

export function verifyAuditResult(input, auditInput) {
  const manifest = manifestContract(input);
  const audit = record(auditInput);
  if (
    !Array.isArray(audit?.invalid) ||
    audit.invalid.length !== 0 ||
    !Array.isArray(audit.missing) ||
    audit.missing.length !== 0 ||
    !Array.isArray(audit.verified)
  ) {
    fail("npm cryptographic audit reported invalid, missing, or incomplete evidence");
  }
  const targets = audit.verified
    .map(record)
    .filter((entry) => entry?.name === manifest.name && entry.version === manifest.version);
  if (targets.length !== 1) fail("npm cryptographic audit did not identify the exact package");
  const target = targets[0];
  const attestations = record(target.attestations);
  if (
    target.location !== `node_modules/${manifest.name}` ||
    target.registry !== "https://registry.npmjs.org/" ||
    canonicalAttestationUrl(attestations?.url, manifest) !== attestations?.url ||
    record(attestations?.provenance)?.predicateType !== slsaPredicate ||
    !Array.isArray(target.attestationBundles)
  ) {
    fail("npm cryptographic audit identity does not match the release manifest");
  }
  verifyAttestation(JSON.stringify({ attestations: target.attestationBundles }), manifest);
  return Object.freeze({ status: "audit-match", package: manifest.package });
}

async function readJsonFile(path, maximumBytes = maximumBodyBytes) {
  const bytes = await readFile(resolve(path));
  if (bytes.byteLength > maximumBytes) fail("verification input exceeds the bounded size limit");
  return JSON.parse(bytes.toString("utf8"));
}

async function main() {
  if (process.argv.length !== 3 && process.argv.length !== 4) {
    fail("usage: verify-npm-registry-release.mjs <manifest.json> [npm-audit.json]");
  }
  const manifest = await readJsonFile(process.argv[2]);
  const result =
    process.argv[3] === undefined
      ? await verifyRegistryRelease(manifest)
      : verifyAuditResult(manifest, await readJsonFile(process.argv[3], 16 * 1024 * 1024));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

let invokedDirectly = false;
try {
  invokedDirectly =
    process.argv[1] !== undefined &&
    realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
} catch {
  invokedDirectly = false;
}

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "verification failed"}\n`);
    process.exitCode = 1;
  });
}
