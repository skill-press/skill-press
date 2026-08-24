import {
  runCapturedCommand,
  type CapturedCommand,
  type CapturedCommandResult,
} from "../../process/capture.js";

export type PublicationCommandExecutor = (
  command: CapturedCommand,
) => Promise<CapturedCommandResult>;

export interface PublicationAdapterRuntime {
  readonly executor?: PublicationCommandExecutor;
  readonly httpClient?: PublicationHttpClient;
}

export interface PublicationHttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface PublicationHttpResult {
  readonly status: number;
  readonly body: string;
}

export type PublicationHttpClient = (
  request: PublicationHttpRequest,
) => Promise<PublicationHttpResult>;

const MAX_PROVIDER_OUTPUT_BYTES = 4 * 1024 * 1024;
const fetchSnapshot = globalThis.fetch.bind(globalThis);

export async function runProviderCommand(
  root: string,
  argv: readonly [string, ...string[]],
  runtime: PublicationAdapterRuntime,
  env: Readonly<Record<string, string>> = Object.freeze({ NO_COLOR: "1" }),
): Promise<CapturedCommandResult> {
  return (runtime.executor ?? runCapturedCommand)({
    argv,
    cwd: root,
    timeoutSeconds: 120,
    maxOutputBytes: MAX_PROVIDER_OUTPUT_BYTES,
    env,
  });
}

export async function runProviderHttp(
  request: PublicationHttpRequest,
  runtime: PublicationAdapterRuntime,
): Promise<PublicationHttpResult> {
  if (runtime.httpClient !== undefined) return runtime.httpClient(Object.freeze({ ...request }));
  try {
    const response = await fetchSnapshot(request.url, {
      method: request.method,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.body === null) return Object.freeze({ status: response.status, body: "" });
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      total += chunk.byteLength;
      if (total > MAX_PROVIDER_OUTPUT_BYTES) {
        await reader.cancel();
        return Object.freeze({ status: 0, body: "" });
      }
      chunks.push(chunk);
    }
    return Object.freeze({ status: response.status, body: Buffer.concat(chunks).toString("utf8") });
  } catch {
    return Object.freeze({ status: 0, body: "" });
  }
}

export function passed(result: CapturedCommandResult): boolean {
  return result.status === "passed" && result.exitCode === 0 && result.signal === null;
}

export function text(result: CapturedCommandResult): string {
  return result.stdout.toString("utf8").trim();
}

export function jsonRecord(
  result: CapturedCommandResult,
): Readonly<Record<string, unknown>> | null {
  if (!passed(result)) return null;
  try {
    const value: unknown = JSON.parse(text(result));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}
