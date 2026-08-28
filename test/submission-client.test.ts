import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createCanonicalSubmissionClient,
  SKILL_PRESS_API_BASE,
  SubmissionClientError,
} from "../src/submission/client.js";
import type { SkillPressSubmissionResource } from "../src/submission/generated-resource.js";
import type { PreparedSubmissionPayload } from "../src/submission/manifest.js";

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function prepared(): PreparedSubmissionPayload {
  const artifactBytes = Buffer.from("artifact");
  const provenanceBytes = Buffer.from("{}\n");
  const checksumsBytes = Buffer.from("checksums\n");
  const reviewEvidenceBytes = Buffer.from('{"quality":95}\n');
  const evalEvidenceBytes = Buffer.from('{"impact":96}\n');
  const manifest: PreparedSubmissionPayload["manifest"] = {
    schemaVersion: 1 as const,
    manifestType: "skillpress.submission-manifest" as const,
    configSchemaVersion: 2 as const,
    project: {
      name: "example-skill",
      version: "1.2.3",
      repository: "https://github.com/example/example-skill",
      license: "MIT",
      author: { name: "Example Author", github: "example" },
    },
    registry: { namespace: "example" },
    skill: { name: "example-skill", path: "skills/example-skill", risk: "moderate" as const },
    source: {
      commit: "1".repeat(40),
      projectConfigSha256: "2".repeat(64),
      skillSha256: "3".repeat(64),
    },
    package: {
      artifact: {
        name: "example-skill-1.2.3.skill",
        sha256: sha256(artifactBytes),
        bytes: artifactBytes.byteLength,
        mediaType: "application/zip" as const,
      },
      provenance: {
        name: "provenance.json",
        sha256: sha256(provenanceBytes),
        bytes: provenanceBytes.byteLength,
        mediaType: "application/json" as const,
      },
      checksums: {
        name: "SHA256SUMS",
        sha256: sha256(checksumsBytes),
        bytes: checksumsBytes.byteLength,
        mediaType: "text/plain" as const,
      },
    },
    evidence: {
      advisory: true as const,
      review: {
        name: "review-evidence.json",
        sha256: sha256(reviewEvidenceBytes),
        bytes: reviewEvidenceBytes.byteLength,
        mediaType: "application/json" as const,
      },
      evaluation: {
        name: "eval-evidence.json",
        sha256: sha256(evalEvidenceBytes),
        bytes: evalEvidenceBytes.byteLength,
        mediaType: "application/json" as const,
      },
      evalSource: "tessl-evals",
      evalSourceSha256: "4".repeat(64),
    },
    serverValidationRequired: true as const,
    tool: { name: "@skill-press/cli" as const },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  return {
    manifest,
    manifestBytes,
    manifestSha256: sha256(manifestBytes),
    idempotencyKey: "5".repeat(64),
    artifactBytes,
    provenanceBytes,
    checksumsBytes,
    reviewEvidenceBytes,
    evalEvidenceBytes,
  };
}

function remote(
  payload: PreparedSubmissionPayload,
  overrides: Partial<SkillPressSubmissionResource> = {},
): SkillPressSubmissionResource {
  return {
    schemaVersion: 1,
    resourceType: "skillpress.submission",
    id: "submission_12345678",
    idempotencyKey: payload.idempotencyKey,
    namespace: payload.manifest.registry.namespace,
    status: "received",
    statusVersion: 1,
    sourceCommit: payload.manifest.source.commit,
    artifactSha256: payload.manifest.package.artifact.sha256,
    projectVersion: payload.manifest.project.version,
    url: "https://skill-press.com/api/v1/submissions/submission_12345678",
    receivedAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("canonical submission client", () => {
  it("uses only fixed canonical endpoints and binds every staged upload", async () => {
    const payload = prepared();
    const resource = remote(payload);
    const finalized = remote(payload, {
      status: "automated-review",
      statusVersion: 2,
      updatedAt: "2026-08-27T12:00:01.000Z",
    });
    const responses = [
      jsonResponse({ schemaVersion: 1, sessionType: "skillpress.session", authenticated: true }),
      jsonResponse(resource, 201),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      jsonResponse(finalized, 202),
      jsonResponse(resource),
    ];
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return responses.shift() as Response;
    }) as unknown as typeof globalThis.fetch;
    const client = createCanonicalSubmissionClient({ token: "test-token", fetcher });

    await expect(client.checkSession()).resolves.toMatchObject({ authenticated: true });
    await expect(client.submit(payload)).resolves.toEqual(finalized);
    await expect(client.getSubmission(resource.id)).resolves.toEqual(resource);

    expect(calls.map((call) => call.url)).toEqual([
      `${SKILL_PRESS_API_BASE}/session`,
      `${SKILL_PRESS_API_BASE}/submissions`,
      `${SKILL_PRESS_API_BASE}/submissions/${resource.id}/objects/provenance`,
      `${SKILL_PRESS_API_BASE}/submissions/${resource.id}/objects/checksums`,
      `${SKILL_PRESS_API_BASE}/submissions/${resource.id}/objects/review-evidence`,
      `${SKILL_PRESS_API_BASE}/submissions/${resource.id}/objects/eval-evidence`,
      `${SKILL_PRESS_API_BASE}/submissions/${resource.id}/objects/artifact`,
      `${SKILL_PRESS_API_BASE}/submissions/${resource.id}/finalize`,
      `${SKILL_PRESS_API_BASE}/submissions/${resource.id}`,
    ]);
    for (const call of calls) {
      expect(call.url.startsWith(`${SKILL_PRESS_API_BASE}/`)).toBe(true);
      expect(call.init.redirect).toBe("error");
      expect(call.init.credentials).toBe("omit");
      expect(call.init.referrerPolicy).toBe("no-referrer");
      expect(call.init.headers).toMatchObject({
        accept: "application/json",
        authorization: "Bearer test-token",
        "skill-press-protocol-version": "1",
      });
    }
    expect(calls[1]?.init.headers).toMatchObject({
      "content-length": String(payload.manifestBytes.byteLength),
      "content-type": "application/json",
      "idempotency-key": payload.idempotencyKey,
    });
    expect(Buffer.from(calls[1]?.init.body as Uint8Array)).toEqual(payload.manifestBytes);
    const uploadBytes = [
      payload.provenanceBytes,
      payload.checksumsBytes,
      payload.reviewEvidenceBytes,
      payload.evalEvidenceBytes,
      payload.artifactBytes,
    ];
    for (const [index, bytes] of uploadBytes.entries()) {
      const call = calls[index + 2];
      expect(call?.init.method).toBe("PUT");
      expect(call?.init.headers).toMatchObject({ "content-length": String(bytes.byteLength) });
      expect(Buffer.from(call?.init.body as Uint8Array)).toEqual(bytes);
    }
    expect(calls[7]?.init).toMatchObject({ method: "POST" });
  });

  it("rejects missing authentication, invalid sessions, redirects, and malformed resources", async () => {
    expect(() => createCanonicalSubmissionClient({ token: " contains-space" })).toThrowError(
      SubmissionClientError,
    );

    const invalidSession = createCanonicalSubmissionClient({
      token: "token",
      fetcher: (async () =>
        jsonResponse({
          schemaVersion: 1,
          sessionType: "skillpress.session",
          authenticated: true,
          unexpected: true,
        })) as typeof globalThis.fetch,
    });
    await expect(invalidSession.checkSession()).rejects.toMatchObject({ code: "session_invalid" });

    const redirect = createCanonicalSubmissionClient({
      token: "token",
      fetcher: (async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        return new Response("", {
          status: 302,
          headers: { location: "https://attacker.invalid/collect" },
        });
      }) as typeof globalThis.fetch,
    });
    await expect(redirect.checkSession()).rejects.toMatchObject({ code: "registry_rejected" });

    const payload = prepared();
    const malformed = createCanonicalSubmissionClient({
      token: "token",
      fetcher: (async () =>
        jsonResponse({ ...remote(payload), unexpected: true }, 201)) as typeof globalThis.fetch,
    });
    await expect(malformed.submit(payload)).rejects.toMatchObject({
      code: "response_contract_invalid",
    });
    await expect(malformed.getSubmission("short")).rejects.toMatchObject({
      code: "submission_id_invalid",
    });

    const invalidUtf8 = createCanonicalSubmissionClient({
      token: "token",
      fetcher: (async () =>
        new Response(Uint8Array.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    });
    await expect(invalidUtf8.checkSession()).rejects.toMatchObject({ code: "response_invalid" });
  });

  it("fails closed on invalid client settings and every bounded response failure", async () => {
    expect(() => createCanonicalSubmissionClient({ token: "token", timeoutMs: 0 })).toThrowError(
      SubmissionClientError,
    );

    const unavailable = createCanonicalSubmissionClient({
      token: "token",
      fetcher: (async () => {
        throw new Error("network detail must not escape");
      }) as typeof globalThis.fetch,
    });
    await expect(unavailable.checkSession()).rejects.toMatchObject({
      code: "registry_unavailable",
      message: "The canonical Skill Press registry is unavailable.",
    });

    const interrupted = createCanonicalSubmissionClient({
      token: "token",
      fetcher: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("stream detail must not escape"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof globalThis.fetch,
    });
    await expect(interrupted.checkSession()).rejects.toMatchObject({
      code: "registry_unavailable",
      message: "The canonical Skill Press registry response was interrupted.",
    });

    const oversized = createCanonicalSubmissionClient({
      token: "token",
      fetcher: (async () =>
        new Response(new Uint8Array(1024 * 1024 + 1), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    });
    await expect(oversized.checkSession()).rejects.toMatchObject({ code: "response_oversized" });

    const unauthorized = createCanonicalSubmissionClient({
      token: "token",
      fetcher: (async () => jsonResponse({ error: "denied" }, 401)) as typeof globalThis.fetch,
    });
    await expect(unauthorized.checkSession()).rejects.toMatchObject({
      code: "authentication_rejected",
    });

    const wrongMediaType = createCanonicalSubmissionClient({
      token: "token",
      fetcher: (async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "text/plain" },
        })) as typeof globalThis.fetch,
    });
    await expect(wrongMediaType.checkSession()).rejects.toMatchObject({ code: "response_invalid" });

    const malformedJson = createCanonicalSubmissionClient({
      token: "token",
      fetcher: (async () =>
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    });
    await expect(malformedJson.checkSession()).rejects.toMatchObject({ code: "response_invalid" });

    const emptyBody = createCanonicalSubmissionClient({
      token: "token",
      fetcher: (async () =>
        new Response(null, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    });
    await expect(emptyBody.checkSession()).rejects.toMatchObject({ code: "response_invalid" });
  });

  it("rejects schema-valid resources with noncanonical URLs, dates, or release bindings", async () => {
    const payload = prepared();
    const invalidResources: SkillPressSubmissionResource[] = [
      remote(payload, {
        url: "https://skill-press.com/api/v1/submissions/a-different-submission",
      }),
      remote(payload, { namespace: "different-namespace" }),
      remote(payload, {
        receivedAt: "2026-02-31T12:00:00.000Z",
        updatedAt: "2026-03-03T12:00:00.000Z",
      }),
      remote(payload, {
        receivedAt: "2026-08-27T13:00:00.000Z",
        updatedAt: "2026-08-27T12:00:00.000Z",
      }),
      remote(payload, {
        status: "published",
        release: {
          locator: "example/other-skill@1.2.3",
          version: "1.2.3",
          artifactSha256: payload.manifest.package.artifact.sha256,
          canonicalUrl: "https://skill-press.com/skills/example/other-skill/1.2.3",
          attestationUrl: "https://skill-press.com/attestations/example/other-skill/1.2.3",
          trust: {
            status: "trusted",
            sequence: 1,
            updatedAt: "2026-08-27T13:00:00.000Z",
          },
        },
      }),
      remote(payload, {
        status: "published",
        release: {
          locator: "example/example-skill@1.2.3",
          version: "1.2.3",
          artifactSha256: payload.manifest.package.artifact.sha256,
          canonicalUrl: "https://skill-press.com/skills/example/example-skill/9.9.9",
          attestationUrl: "https://skill-press.com/attestations/example/example-skill/1.2.3",
          trust: {
            status: "trusted",
            sequence: 1,
            updatedAt: "2026-08-27T13:00:00.000Z",
          },
        },
      }),
      remote(payload, {
        status: "published",
        release: {
          locator: "example/example-skill@1.2.3",
          version: "1.2.3",
          artifactSha256: payload.manifest.package.artifact.sha256,
          canonicalUrl: "https://skill-press.com/skills/example/example-skill/1.2.3",
          attestationUrl: "https://skill-press.com/attestations/example/example-skill/1.2.3",
          trust: {
            status: "trusted",
            sequence: 1,
            updatedAt: "2026-08-27T11:59:59.999Z",
          },
        },
      }),
    ];

    for (const invalid of invalidResources) {
      const client = createCanonicalSubmissionClient({
        token: "token",
        fetcher: (async () => jsonResponse(invalid, 201)) as typeof globalThis.fetch,
      });
      await expect(client.submit(payload)).rejects.toMatchObject({
        code: "response_contract_invalid",
      });
    }
  });

  it("keeps review workflow status distinct from mutable release trust status", async () => {
    const payload = prepared();
    const published = remote(payload, {
      status: "published",
      statusVersion: 8,
      release: {
        locator: "example/example-skill@1.2.3",
        version: "1.2.3",
        artifactSha256: payload.manifest.package.artifact.sha256,
        canonicalUrl: "https://skill-press.com/skills/example/example-skill/1.2.3",
        attestationUrl: "https://skill-press.com/attestations/example/example-skill/1.2.3",
        trust: {
          status: "quarantined",
          sequence: 3,
          updatedAt: "2026-08-27T13:00:00.000Z",
          reasonCode: "security_review",
        },
      },
    });
    const client = createCanonicalSubmissionClient({
      token: "token",
      fetcher: (async () => jsonResponse(published, 201)) as typeof globalThis.fetch,
    });
    const result = await client.submit(payload);
    expect(result.status).toBe("published");
    expect(result.release?.trust.status).toBe("quarantined");
    expect(result.release?.artifactSha256).toBe(result.artifactSha256);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.release)).toBe(true);
    expect(Object.isFrozen(result.release?.trust)).toBe(true);
  });

  it.each(["publication-blocked", "withdrawn"] as const)(
    "accepts non-publication review state %s without inventing a release",
    async (status) => {
      const payload = prepared();
      const blocked = remote(payload, {
        status,
        statusVersion: 9,
      });
      const client = createCanonicalSubmissionClient({
        token: "token",
        fetcher: (async () => jsonResponse(blocked, 201)) as typeof globalThis.fetch,
      });

      await expect(client.submit(payload)).resolves.toMatchObject({
        status,
        statusVersion: 9,
      });
      expect((await client.submit(payload)).release).toBeUndefined();
    },
  );
});
