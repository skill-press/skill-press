import { describe, expect, it } from "vitest";

import {
  MAX_CODEX_TRANSCRIPT_BYTES,
  parseCodexTextResponse,
} from "../src/eval/codex-transcript.js";

function events(): Record<string, unknown>[] {
  return [
    { type: "thread.started", thread_id: "private-thread-id" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "Draft only. 草稿。" } },
    {
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 12 },
    },
  ];
}

function encode(value: unknown[]): string {
  return `${value.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

describe("Codex text-only response decoding", () => {
  it("retains text and usage, not thread IDs or release eligibility", () => {
    const result = parseCodexTextResponse(encode(events()), 0);
    expect(result).toEqual({
      text: "Draft only. 草稿。",
      usage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 12 },
      releaseEligible: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-thread-id");
    expect(parseCodexTextResponse(encode(events()).replaceAll("\n", "\r\n"), 0)).toEqual(result);
  });

  it.each([null, 1, -1])("rejects unsuccessful process status %s", (code) => {
    expect(() => parseCodexTextResponse(encode(events()), code)).toThrow(/Invalid/);
  });

  it.each(["", "not-json\n{}\n{}\n{}", "{}\n{}\n{}", "\n".repeat(5)])(
    "rejects malformed or incomplete streams: %j",
    (text) => {
      expect(() => parseCodexTextResponse(text, 0)).toThrow(/Invalid/);
    },
  );

  it("limits UTF-8 bytes, not JavaScript character count", () => {
    const stream = events();
    stream[2] = {
      type: "item.completed",
      item: { type: "agent_message", text: "界".repeat(MAX_CODEX_TRANSCRIPT_BYTES / 2) },
    };
    expect(() => parseCodexTextResponse(encode(stream), 0)).toThrow(/Invalid/);
  });

  it.each([null, [], true, "secret-provider-error", 42])("rejects non-object events", (value) => {
    const stream: unknown[] = events();
    stream[0] = value;
    expect(() => parseCodexTextResponse(encode(stream), 0)).toThrow(
      "Invalid or unsupported Codex text-only response.",
    );
  });

  it.each([
    [0, { type: "thread.resumed", thread_id: "id" }],
    [0, { type: "thread.started" }],
    [0, { type: "thread.started", thread_id: "" }],
    [1, { type: "turn.failed" }],
    [2, { type: "item.started", item: { type: "agent_message", text: "x" } }],
    [2, { type: "item.completed", item: null }],
    [2, { type: "item.completed", item: { type: "command_execution", text: "x" } }],
    [2, { type: "item.completed", item: { type: "agent_message", text: 1 } }],
    [2, { type: "item.completed", item: { type: "agent_message", text: " " } }],
    [3, { type: "turn.failed", error: { message: "secret-provider-error" } }],
    [3, { type: "turn.completed", usage: [] }],
  ] as const)("rejects unexpected lifecycle or message shape at index %s", (index, value) => {
    const stream = events();
    stream[index] = value;
    expect(() => parseCodexTextResponse(encode(stream), 0)).toThrow(
      "Invalid or unsupported Codex text-only response.",
    );
  });

  it.each(["command_execution", "mcp_tool_call", "web_search", "reasoning"])(
    "rejects additional %s events even if followed by valid text",
    (type) => {
      const stream = events();
      stream.splice(2, 0, { type: "item.completed", item: { type } });
      expect(() => parseCodexTextResponse(encode(stream), 0)).toThrow(/Invalid/);
    },
  );

  it.each([undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "100"])(
    "rejects missing or invalid token counters: %s",
    (value) => {
      for (const key of ["input_tokens", "cached_input_tokens", "output_tokens"]) {
        const stream = events();
        stream[3] = {
          type: "turn.completed",
          usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 12, [key]: value },
        };
        expect(() => parseCodexTextResponse(encode(stream), 0)).toThrow(/Invalid/);
      }
    },
  );

  it("rejects impossible cache usage and accepts zero usage", () => {
    const stream = events();
    stream[3] = {
      type: "turn.completed",
      usage: { input_tokens: 0, cached_input_tokens: 1, output_tokens: 0 },
    };
    expect(() => parseCodexTextResponse(encode(stream), 0)).toThrow(/Invalid/);
    stream[3] = {
      type: "turn.completed",
      usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    };
    expect(parseCodexTextResponse(encode(stream), 0).usage.inputTokens).toBe(0);
  });
});
