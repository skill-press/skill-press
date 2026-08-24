import { createHash } from "node:crypto";

/** Hash a Tessl invocation without exposing or depending on the local executable path. */
export function tesslCommandDigest(executableSha256: string, args: readonly string[]): string {
  return createHash("sha256")
    .update(`${JSON.stringify([`sha256:${executableSha256}`, ...args])}\n`)
    .digest("hex");
}
