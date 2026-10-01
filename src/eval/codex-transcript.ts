/**
 * Decode the bounded text-only protocol observed with Codex CLI 0.159.3.
 * This is not a sandbox, a model-identity attestation, or release evidence.
 * Rejecting a tool event cannot undo a tool call: callers must prevent tools
 * before execution and separately enforce process/time/output limits.
 */
export interface CodexTextResponse {
  readonly text: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  };
  readonly releaseEligible: false;
}

export const MAX_CODEX_TRANSCRIPT_BYTES = 1024 * 1024;

function invalid(): never {
  // Never echo a provider error, model output, thread ID or credential.
  throw new Error("Invalid or unsupported Codex text-only response.");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function tokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

/** No subprocesses, credentials, filesystem access, retries or billing fallback. */
export function parseCodexTextResponse(stdout: string, exitCode: number | null): CodexTextResponse {
  if (exitCode !== 0 || Buffer.byteLength(stdout, "utf8") > MAX_CODEX_TRANSCRIPT_BYTES) invalid();
  const lines = stdout.trim().split(/\r?\n/u);
  // A single successful text turn: thread, turn, one message, completion.
  // Unknown/new events require explicit adapter review rather than silent acceptance.
  if (lines.length !== 4) invalid();
  const events = lines.map((line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalid();
    }
    return record(value);
  });
  const [thread, turn, message, completion] = events as [
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  if (
    thread.type !== "thread.started" ||
    typeof thread.thread_id !== "string" ||
    thread.thread_id.length === 0 ||
    turn.type !== "turn.started" ||
    message.type !== "item.completed" ||
    completion.type !== "turn.completed"
  )
    invalid();
  const item = record(message.item);
  if (item.type !== "agent_message" || typeof item.text !== "string" || !item.text.trim())
    invalid();
  const usage = record(completion.usage);
  const inputTokens = tokens(usage.input_tokens);
  const cachedInputTokens = tokens(usage.cached_input_tokens);
  const outputTokens = tokens(usage.output_tokens);
  if (cachedInputTokens > inputTokens) invalid();
  return Object.freeze({
    text: item.text,
    usage: Object.freeze({ inputTokens, cachedInputTokens, outputTokens }),
    releaseEligible: false,
  });
}
