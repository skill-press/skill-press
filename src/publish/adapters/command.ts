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
}

const MAX_PROVIDER_OUTPUT_BYTES = 4 * 1024 * 1024;

export async function runProviderCommand(
  root: string,
  argv: readonly [string, ...string[]],
  runtime: PublicationAdapterRuntime,
): Promise<CapturedCommandResult> {
  const env = Object.freeze({
    ...(process.env.GH_TOKEN === undefined ? {} : { GH_TOKEN: process.env.GH_TOKEN }),
    ...(process.env.GITHUB_TOKEN === undefined ? {} : { GITHUB_TOKEN: process.env.GITHUB_TOKEN }),
    NO_COLOR: "1",
  });
  return (runtime.executor ?? runCapturedCommand)({
    argv,
    cwd: root,
    timeoutSeconds: 120,
    maxOutputBytes: MAX_PROVIDER_OUTPUT_BYTES,
    env,
  });
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
