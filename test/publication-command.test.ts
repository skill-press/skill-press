import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { CapturedCommandResult } from "../src/process/capture.js";
import { jsonRecord, passed, runProviderCommand, text } from "../src/publish/adapters/command.js";

const root = realpathSync(tmpdir());
const oldGhToken = process.env.GH_TOKEN;
const oldGithubToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  if (oldGhToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = oldGhToken;
  if (oldGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = oldGithubToken;
});

function result(stdout: string, ok = true): CapturedCommandResult {
  return {
    status: ok ? "passed" : "failed",
    exitCode: ok ? 0 : 1,
    signal: null,
    durationMs: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    stdoutSha256: "unused",
    stderrSha256: "unused",
  };
}

describe("publication provider commands", () => {
  it("runs the production executor without a shell and captures bounded text", async () => {
    const commandResult = await runProviderCommand(
      root,
      [process.execPath, "-e", 'process.stdout.write("ok\\n")'],
      {},
    );
    expect(passed(commandResult)).toBe(true);
    expect(text(commandResult)).toBe("ok");
  });

  it("passes only provider tokens to injected commands", async () => {
    process.env.GH_TOKEN = "gh-test";
    process.env.GITHUB_TOKEN = "github-test";
    let environment: Readonly<Record<string, string>> | undefined;
    await runProviderCommand(root, ["gh", "api", "user"], {
      executor: async (command) => {
        environment = command.env;
        return result("{}");
      },
    });
    expect(environment).toEqual({
      GH_TOKEN: "gh-test",
      GITHUB_TOKEN: "github-test",
      NO_COLOR: "1",
    });
  });

  it("parses only passed JSON objects", () => {
    expect(jsonRecord(result('{"ok":true}'))).toEqual({ ok: true });
    expect(jsonRecord(result("[]"))).toBeNull();
    expect(jsonRecord(result("null"))).toBeNull();
    expect(jsonRecord(result("not-json"))).toBeNull();
    expect(jsonRecord(result("{}", false))).toBeNull();
    expect(passed({ ...result(""), signal: "SIGTERM" })).toBe(false);
  });
});
