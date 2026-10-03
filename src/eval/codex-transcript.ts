/**
 * Decode the bounded text-only protocol observed with Codex CLI 0.159.3/0.160.0.
 * This is not a sandbox, a model-identity attestation, or release evidence.
 * Rejecting a tool event cannot undo a tool call: callers must prevent tools
 * before execution and separately enforce process/time/output limits.
 */
export interface CodexTextResponse {
  readonly text: string;
  readonly diagnostics: readonly string[];
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  };
  readonly releaseEligible: false;
}

export const MAX_CODEX_TRANSCRIPT_BYTES = 1024 * 1024;
export const CODE_MODE_DISABLED_DIAGNOSTIC =
  "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.";

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
  if (lines.length !== 4 && lines.length !== 5) invalid();
  const events = lines.map((line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalid();
    }
    return record(value);
  });
  const diagnostics: string[] = [];
  if (events.length === 5) {
    const diagnostic = record(events[1]);
    const item = record(diagnostic.item);
    if (
      diagnostic.type !== "item.completed" ||
      item.type !== "error" ||
      item.message !== CODE_MODE_DISABLED_DIAGNOSTIC
    )
      invalid();
    diagnostics.push(CODE_MODE_DISABLED_DIAGNOSTIC);
    events.splice(1, 1);
  }
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
    diagnostics: Object.freeze(diagnostics),
    usage: Object.freeze({ inputTokens, cachedInputTokens, outputTokens }),
    releaseEligible: false,
  });
}
