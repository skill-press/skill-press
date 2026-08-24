import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { CapturedCommandResult } from "../src/process/capture.js";
import {
  jsonRecord,
  passed,
  runProviderCommand,
  runProviderHttp,
  text,
} from "../src/publish/adapters/command.js";

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
    await runProviderCommand(
      root,
      ["gh", "api", "user"],
      {
        executor: async (command) => {
          environment = command.env;
          return result("{}");
        },
      },
      Object.freeze({
        GH_TOKEN: process.env.GH_TOKEN,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
        NO_COLOR: "1",
      }),
    );
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

  it("bounds production HTTP responses and supports injected clients", async () => {
    await expect(
      runProviderHttp({ method: "GET", url: "data:application/json,%7B%22ok%22%3Atrue%7D" }, {}),
    ).resolves.toEqual({ status: 200, body: '{"ok":true}' });
    await expect(runProviderHttp({ method: "GET", url: "not-a-url" }, {})).resolves.toEqual({
      status: 0,
      body: "",
    });
    await expect(
      runProviderHttp(
        {
          method: "POST",
          url: "data:application/json,%7B%7D",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
        {},
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      runProviderHttp(
        { method: "GET", url: `data:text/plain,${"x".repeat(4 * 1024 * 1024 + 1)}` },
        {},
      ),
    ).resolves.toEqual({ status: 0, body: "" });
    await expect(
      runProviderHttp(
        { method: "POST", url: "https://provider.invalid", body: "{}" },
        { httpClient: async (request) => ({ status: 201, body: request.body ?? "" }) },
      ),
    ).resolves.toEqual({ status: 201, body: "{}" });
  });
});
