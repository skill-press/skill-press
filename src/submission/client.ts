import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { Ajv, type ValidateFunction } from "ajv";

import type { SkillPressSubmissionResource } from "./generated-resource.js";
import type { PreparedSubmissionPayload } from "./manifest.js";

export const SKILL_PRESS_ORIGIN = "https://skill-press.com" as const;
export const SKILL_PRESS_API_BASE = `${SKILL_PRESS_ORIGIN}/api/v1` as const;
export const SKILL_PRESS_TOKEN_ENV = "SKILL_PRESS_TOKEN" as const;

export interface SkillPressSession {
  readonly schemaVersion: 1;
  readonly sessionType: "skillpress.session";
  readonly authenticated: true;
}

export interface SkillPressSubmissionClient {
  readonly checkSession: () => Promise<SkillPressSession>;
  readonly submit: (payload: PreparedSubmissionPayload) => Promise<SkillPressSubmissionResource>;
  readonly getSubmission: (id: string) => Promise<SkillPressSubmissionResource>;
}

export interface CanonicalSubmissionClientOptions {
  readonly fetcher?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly token?: string;
}

export class SubmissionClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SubmissionClientError";
    this.code = code;
  }
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const resourceSchema = JSON.parse(
  await readFile(new URL("../../schemas/submission-resource.schema.json", import.meta.url), "utf8"),
) as object;
const validateResource = new Ajv({ allErrors: true, strict: true }).compile(
  resourceSchema,
) as ValidateFunction<SkillPressSubmissionResource>;

function tokenFrom(options: CanonicalSubmissionClientOptions): string {
  const token = options.token ?? process.env[SKILL_PRESS_TOKEN_ENV];
  if (
    token === undefined ||
    token.length < 1 ||
    token.length > 4096 ||
    token.trim() !== token ||
    /\s/u.test(token)
  ) {
    throw new SubmissionClientError(
      "authentication_missing",
      `${SKILL_PRESS_TOKEN_ENV} must contain a valid Skill Press access token.`,
    );
  }
  return token;
}

async function boundedBody(response: Response): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SubmissionClientError(
        "response_oversized",
        "Skill Press returned an oversized response.",
      );
    }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks);
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SubmissionClientError("response_invalid", `Skill Press returned invalid ${label}.`);
  }
}

function canonicalTimestamp(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null;
  return milliseconds;
}

function hasCanonicalResourceSemantics(
  value: SkillPressSubmissionResource,
  expectedSkill?: string,
): boolean {
  const receivedAt = canonicalTimestamp(value.receivedAt);
  const updatedAt = canonicalTimestamp(value.updatedAt);
  if (
    receivedAt === null ||
    updatedAt === null ||
    updatedAt < receivedAt ||
    value.url !== `${SKILL_PRESS_ORIGIN}/submissions/${encodeURIComponent(value.id)}`
  ) {
    return false;
  }
  if (value.release === undefined) return value.status !== "published";
  if (value.status !== "published") return false;
  const locator = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)@(.+)$/u.exec(
    value.release.locator,
  );
  if (locator === null) return false;
  const [, namespace, skill, version] = locator;
  const releasePath = `${encodeURIComponent(namespace as string)}/${encodeURIComponent(skill as string)}/${encodeURIComponent(version as string)}`;
  const trustUpdatedAt = canonicalTimestamp(value.release.trust.updatedAt);
  return (
    namespace === value.namespace &&
    (expectedSkill === undefined || skill === expectedSkill) &&
    version === value.projectVersion &&
    value.release.version === value.projectVersion &&
    value.release.artifactSha256 === value.artifactSha256 &&
    value.release.canonicalUrl === `${SKILL_PRESS_ORIGIN}/skills/${releasePath}` &&
    value.release.attestationUrl === `${SKILL_PRESS_ORIGIN}/attestations/${releasePath}` &&
    trustUpdatedAt !== null &&
    trustUpdatedAt >= receivedAt
  );
}

function resource(
  value: unknown,
  expected?: PreparedSubmissionPayload,
): SkillPressSubmissionResource {
  if (!validateResource(value)) {
    throw new SubmissionClientError(
      "response_contract_invalid",
      "Skill Press returned a resource that violated the submission contract.",
    );
  }
  if (!hasCanonicalResourceSemantics(value, expected?.manifest.skill.name)) {
    throw new SubmissionClientError(
      "response_contract_invalid",
      "Skill Press returned a resource with inconsistent canonical bindings.",
    );
  }
  if (
    expected !== undefined &&
    (value.idempotencyKey !== expected.idempotencyKey ||
      value.namespace !== expected.manifest.registry.namespace ||
      value.sourceCommit !== expected.manifest.source.commit ||
      value.artifactSha256 !== expected.manifest.package.artifact.sha256 ||
      value.projectVersion !== expected.manifest.project.version)
  ) {
    throw new SubmissionClientError(
      "response_contract_invalid",
      "Skill Press returned a resource that did not bind the submitted candidate.",
    );
  }
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Create the production client. Its origin is fixed so project input cannot redirect credentials. */
export function createCanonicalSubmissionClient(
  options: CanonicalSubmissionClientOptions = {},
): SkillPressSubmissionClient {
  const token = tokenFrom(options);
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new SubmissionClientError(
      "client_configuration_invalid",
      "Submission timeout is invalid.",
    );
  }
  const request = async (url: string, init: RequestInit, expected: readonly number[]) => {
    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          ...init.headers,
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "skill-press-protocol-version": "1",
        },
      });
    } catch {
      throw new SubmissionClientError(
        "registry_unavailable",
        "The canonical Skill Press registry is unavailable.",
      );
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    let body: Buffer;
    try {
      body = await boundedBody(response);
    } catch (error) {
      if (error instanceof SubmissionClientError) throw error;
      throw new SubmissionClientError(
        "registry_unavailable",
        "The canonical Skill Press registry response was interrupted.",
      );
    }
    if (!expected.includes(response.status)) {
      const code =
        response.status === 401 || response.status === 403
          ? "authentication_rejected"
          : "registry_rejected";
      throw new SubmissionClientError(
        code,
        `Skill Press rejected the request with HTTP ${response.status}.`,
      );
    }
    if (contentType !== "application/json") {
      throw new SubmissionClientError("response_invalid", "Skill Press did not return JSON.");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new SubmissionClientError("response_invalid", "Skill Press returned invalid UTF-8.");
    }
    return parseJson(text, "JSON");
  };
  return Object.freeze({
    checkSession: async () => {
      const value = await request(`${SKILL_PRESS_API_BASE}/session`, { method: "GET" }, [200]);
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Reflect.ownKeys(value).length !== 3 ||
        (value as Record<string, unknown>).schemaVersion !== 1 ||
        (value as Record<string, unknown>).sessionType !== "skillpress.session" ||
        (value as Record<string, unknown>).authenticated !== true
      ) {
        throw new SubmissionClientError(
          "session_invalid",
          "Skill Press returned an invalid session.",
        );
      }
      return Object.freeze({
        schemaVersion: 1,
        sessionType: "skillpress.session",
        authenticated: true,
      });
    },
    submit: async (payload: PreparedSubmissionPayload) => {
      const form = new FormData();
      form.set(
        "manifest",
        new Blob([payload.manifestBytes], { type: "application/json" }),
        "manifest.json",
      );
      form.set(
        "artifact",
        new Blob([payload.artifactBytes], { type: "application/zip" }),
        payload.manifest.package.artifact.name,
      );
      form.set(
        "provenance",
        new Blob([payload.provenanceBytes], { type: "application/json" }),
        payload.manifest.package.provenance.name,
      );
      form.set(
        "checksums",
        new Blob([payload.checksumsBytes], { type: "text/plain" }),
        payload.manifest.package.checksums.name,
      );
      form.set(
        "reviewEvidence",
        new Blob([payload.reviewEvidenceBytes], { type: "application/json" }),
        "review-evidence.json",
      );
      form.set(
        "evalEvidence",
        new Blob([payload.evalEvidenceBytes], { type: "application/json" }),
        "eval-evidence.json",
      );
      return resource(
        await request(
          `${SKILL_PRESS_API_BASE}/submissions`,
          {
            method: "POST",
            headers: { "idempotency-key": payload.idempotencyKey },
            body: form,
          },
          [200, 201],
        ),
        payload,
      );
    },
    getSubmission: async (id: string) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(id)) {
        throw new SubmissionClientError("submission_id_invalid", "Submission ID is invalid.");
      }
      return resource(
        await request(
          `${SKILL_PRESS_API_BASE}/submissions/${encodeURIComponent(id)}`,
          { method: "GET" },
          [200],
        ),
      );
    },
  });
}
