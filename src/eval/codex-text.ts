import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCapturedCommand } from "../process/capture.js";
import { MAX_CODEX_TRANSCRIPT_BYTES, parseCodexTextResponse } from "./codex-transcript.js";
import type { SkillPressEvaluationRubric } from "./generated-rubric.js";
import type { Scenario } from "./generated-suite.js";
import {
  createTextActorPrompt,
  createTextJudgePrompt,
  parseTextJudgeScores,
} from "./text-evaluation.js";

const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "hooks",
  "multi_agent",
  "multi_agent_v2",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "view_image",
  "code_mode",
  "code_mode_host",
  "memories",
  "goals",
  "skill_search",
  "skill_mcp_dependency_install",
  "workspace_dependencies",
  "remote_plugin",
  "unbounded_connection_retries",
] as const;

/**
 * Operator-reviewed text pilot only, NOT an arbitrary/untrusted skill sandbox.
 * Uses ChatGPT auth on the host, never mounts or copies auth into skill storage.
 * Not exported as an eligible paired-runner backend or exposed by the CLI.
 */
export async function runReviewedCodexText(text: string, signal?: AbortSignal) {
  if (!text.trim() || Buffer.byteLength(text, "utf8") > MAX_CODEX_TRANSCRIPT_BYTES) {
    throw new Error("Codex pilot input must be nonempty and at most 1 MiB.");
  }
  const directory = await mkdtemp(join(tmpdir(), "skillpress-codex-text-"));
  const env = Object.fromEntries(
    ["HOME", "CODEX_HOME", "TMPDIR", "LANG", "TERM"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  try {
    const version = await runCapturedCommand({
      argv: ["codex", "--version"],
      cwd: directory,
      timeoutSeconds: 10,
      env,
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      version.status !== "passed" ||
      version.stdout.toString("utf8").trim() !== "codex-cli 0.160.0"
    ) {
      throw new Error("Codex pilot requires the reviewed CLI version 0.160.0.");
    }
    const result = await runCapturedCommand({
      argv: [
        "codex",
        "exec",
        "--ignore-user-config",
        "--strict-config",
        "--ephemeral",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        ...DISABLED_FEATURES.flatMap((name) => ["--disable", name]),
        "--enable",
        "skip_host_skill_discovery",
        "-c",
        'forced_login_method="chatgpt"',
        "-c",
        'model_reasoning_effort="medium"',
        "-c",
        'approval_policy="never"',
        "-c",
        'web_search="disabled"',
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        "suppress_unstable_features_warning=true",
        "-c",
        "agents.enabled=false",
        "-c",
        "mcp_servers={}",
        "-m",
        "gpt-6.1-sol",
        "-C",
        directory,
        "-",
      ],
      cwd: directory,
      env,
      stdin: text,
      timeoutSeconds: 120,
      maxOutputBytes: MAX_CODEX_TRANSCRIPT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.status !== "passed") {
      // Raw stderr may contain provider details; no retry or alternative auth/provider.
      throw new Error(`Codex pilot stopped: ${result.status}.`);
    }
    const response = parseCodexTextResponse(result.stdout.toString("utf8"), result.exitCode);
    return Object.freeze({
      ...response,
      requestedModel: "gpt-6.1-sol" as const,
      effort: "medium" as const,
      authentication: "forced-chatgpt" as const,
      cliVersion: "0.160.0" as const,
      execution: "reviewed-host-text-pilot" as const,
      inputSha256: createHash("sha256").update(text).digest("hex"),
      outputSha256: createHash("sha256").update(response.text).digest("hex"),
      durationMs: result.durationMs,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * One approved synthetic text experiment, at most four serial model invocations.
 * Caller must validate/review scenario, rubric and skill text and approve usage.
 * No release score: activation and full suite/holdout evaluation are not measured.
 */
export async function runReviewedTextPair(
  scenario: Scenario,
  rubric: SkillPressEvaluationRubric,
  skillText: string,
  signal?: AbortSignal,
) {
  const baselinePrompt = createTextActorPrompt(scenario, null);
  const skillPrompt = createTextActorPrompt(scenario, skillText);
  const leg = async (actorPrompt: string) => {
    const actor = await runReviewedCodexText(actorPrompt, signal);
    const judgePrompt = createTextJudgePrompt(scenario, rubric, actor.text);
    const judge = await runReviewedCodexText(judgePrompt.text, signal);
    const criteria = parseTextJudgeScores(judge.text, rubric);
    return Object.freeze({ actor, judge, criteria });
  };
  const baseline = await leg(baselinePrompt.text);
  const withSkill = await leg(skillPrompt.text);
  return Object.freeze({
    kind: "skillpress.reviewed-text-pair-pilot" as const,
    baseline,
    withSkill,
    modelInvocations: 4,
    releaseEligible: false as const,
  });
}
