import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CODE_MODE_DISABLED_DIAGNOSTIC } from "../eval/codex-transcript.js";
import {
  createReviewedToolActorPrompt,
  parseToolActorAction,
  validateReviewedToolActorInput,
  type ReviewedToolActorInput,
  type runReviewedToolActor,
} from "../eval/reviewed-tool-actor.js";
import { DEFAULT_SANDBOX_RESOURCE_POLICY } from "../eval/sandbox.js";
import { TOOL_ACTION_SCHEMA_JSON } from "../eval/tool-action-schema.js";

type Actor = Awaited<ReturnType<typeof runReviewedToolActor>>;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Pure consistency check against trusted prepared bytes; never execution attestation.
 * Ingestion must bound JSON size before parsing. No I/O, inference or admission authority.
 * Only checked-field associations are validated, not an exhaustive wire schema.
 * Complete text trajectories require lossless UTF-8 output; raw executor hashes stay unchanged.
 */
export function assessReviewedToolTrajectory(value: unknown, input: ReviewedToolActorInput) {
  try {
    validateReviewedToolActorInput(input);
    const actor = value as Actor;
    assert.equal(actor.kind, "skillpress.reviewed-tool-actor.v2");
    assert.equal(actor.status, "complete");
    assert.equal(actor.failure, undefined);
    assert.equal(actor.releaseEligible, false);
    assert.ok(Array.isArray(actor.steps) && actor.steps.length >= 1 && actor.steps.length <= 4);
    assert.equal(actor.modelInvocations, actor.steps.length);
    let tools = 0;
    for (const [index, step] of actor.steps.entries()) {
      assert.equal(step.index, index);
      assert.equal(step.failure, undefined);
      const prompt = createReviewedToolActorPrompt(input, actor.steps.slice(0, index));
      assert.deepEqual(step.prompt, prompt);
      const response = step.response;
      assert.ok(response);
      assert.equal(response.inputSha256, prompt.sha256);
      assert.equal(response.outputSha256, hash(response.text));
      assert.equal(response.outputSchemaSha256, hash(TOOL_ACTION_SCHEMA_JSON));
      assert.equal(response.requestedModel, "gpt-6.1-sol");
      assert.equal(response.effort, "medium");
      assert.equal(response.authentication, "forced-chatgpt");
      assert.equal(response.cliVersion, "0.160.0");
      assert.equal(response.execution, "reviewed-host-text-pilot");
      assert.equal(response.releaseEligible, false);
      assert.ok(Array.isArray(response.diagnostics) && response.diagnostics.length <= 1);
      assert.ok(response.diagnostics.every((d) => d === CODE_MODE_DISABLED_DIAGNOSTIC));
      for (const count of [
        response.usage.inputTokens,
        response.usage.cachedInputTokens,
        response.usage.outputTokens,
      ])
        assert.ok(Number.isSafeInteger(count) && count >= 0);
      assert.ok(response.usage.cachedInputTokens <= response.usage.inputTokens);
      assert.ok(Number.isFinite(response.durationMs) && response.durationMs >= 0);
      const action = parseToolActorAction(response.text);
      assert.deepEqual(step.action, action);
      if (action.kind === "answer") {
        assert.equal(index, actor.steps.length - 1);
        assert.equal(step.tool, undefined);
        assert.equal(actor.answer, action.text);
        continue;
      }
      assert.ok(index < actor.steps.length - 1 && index < 3);
      tools++;
      const tool = step.tool;
      assert.ok(tool);
      assert.equal(tool.kind, "skillpress.reviewed-python-tool.v1");
      assert.equal(tool.image, input.image);
      assert.equal(tool.pythonSha256, hash(action.code));
      assert.equal(tool.releaseEligible, false);
      assert.equal(tool.network, "none");
      assert.equal(tool.outputStorage, "tmpfs");
      assert.deepEqual(
        tool.inputs,
        (input.scenario.fixture?.files ?? []).map((f) => ({
          path: f.path,
          sha256: hash(f.content),
        })),
      );
      assert.deepEqual(
        tool.skillFiles,
        input.skillFiles.map((f) => ({ path: f.path, sha256: hash(f.content) })),
      );
      assert.deepEqual(tool.policy, {
        ...DEFAULT_SANDBOX_RESOURCE_POLICY,
        timeoutSeconds: 30,
        tmpfsMib: 8,
        maxOutputBytes: 64 * 1024,
      });
      const execution = tool.execution;
      assert.equal(execution.signal, null);
      assert.ok(
        (execution.status === "passed" && execution.exitCode === 0) ||
          (execution.status === "failed" && [1, 2].includes(execution.exitCode ?? -1)),
      );
      assert.equal(typeof execution.cleanupAttempted, "boolean");
      assert.equal(typeof execution.cleanupOk, "boolean");
      assert.ok(!execution.cleanupAttempted || execution.cleanupOk);
      assert.ok(Number.isFinite(execution.durationMs) && execution.durationMs >= 0);
      for (const stream of ["stdout", "stderr"] as const) {
        const text = execution[`${stream}Text`];
        assert.equal(typeof text, "string");
        assert.equal(execution[`${stream}Bytes`], Buffer.byteLength(text));
        assert.equal(execution[`${stream}Sha256`], hash(text));
      }
      assert.ok(execution.stdoutBytes + execution.stderrBytes <= tool.policy.maxOutputBytes);
    }
    assert.equal(actor.steps.at(-1)?.action?.kind, "answer");
    assert.equal(actor.toolInvocations, tools);
    return Object.freeze({
      consistent: true,
      issues: Object.freeze([]),
      releaseAuthorized: false as const,
    });
  } catch {
    return Object.freeze({
      consistent: false,
      issues: Object.freeze(["tool.trajectory.inconsistent"]),
      releaseAuthorized: false as const,
    });
  }
}
