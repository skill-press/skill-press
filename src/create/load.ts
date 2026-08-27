import { readFile } from "node:fs/promises";
import { types } from "node:util";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import { ProjectConfigError } from "../config/errors.js";
import { loadStrictYamlDocument } from "../config/load.js";
import {
  classifySemanticTextPlaceholder,
  isGenuineSemanticTextPlaceholderClassification,
} from "../validate/semantic-text-placeholder.js";
import { normalizeComparableText } from "./comparable-text.js";
import { type CapabilityBriefIssue, CapabilityBriefError } from "./errors.js";
import type { ScenarioCase, SkillPressCapabilityBrief } from "./generated.js";

export type ResolvedCapabilityBrief = SkillPressCapabilityBrief & { readonly version: string };

// Module initialization, before the schema read yields, is the semantic trust boundary.
const applySnapshot = Reflect.apply;
const classifyPlaceholderSnapshot = classifySemanticTextPlaceholder;
const genuinePlaceholderSnapshot = isGenuineSemanticTextPlaceholderClassification;
const normalizeComparableTextSnapshot = normalizeComparableText;
const arrayIsArraySnapshot = Array.isArray;
const definePropertySnapshot = Object.defineProperty;
const getOwnPropertyDescriptorSnapshot = Object.getOwnPropertyDescriptor;
const objectEntriesSnapshot = Object.entries;
const setHasSnapshot = Set.prototype.has;
const stringEndsWithSnapshot = String.prototype.endsWith;
const stringIncludesSnapshot = String.prototype.includes;
const stringReplaceAllSnapshot = String.prototype.replaceAll;
const stringStartsWithSnapshot = String.prototype.startsWith;
const isProxySnapshot = types.isProxy;
const ABSENT = Symbol("absent");
const INVALID_FIELD = Symbol("invalid");

const schemaUrl = new URL("../../schemas/capability-brief.schema.json", import.meta.url);
const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile<SkillPressCapabilityBrief>(
  schema,
) as ValidateFunction<SkillPressCapabilityBrief>;

function issue(code: string, path: string, message: string): CapabilityBriefIssue {
  return { code, path, message };
}

function schemaIssues(errors: readonly ErrorObject[]): CapabilityBriefIssue[] {
  return errors.map((error) =>
    issue(
      `brief.schema.${error.keyword}`,
      error.instancePath === "" ? "/" : error.instancePath,
      error.message ?? "does not match the capability brief schema",
    ),
  );
}

function escapePointer(value: string): string {
  const escapedTildes = applySnapshot(stringReplaceAllSnapshot, value, ["~", "~0"]) as string;
  return applySnapshot(stringReplaceAllSnapshot, escapedTildes, ["/", "~1"]) as string;
}

function applyIntrinsic<T>(
  intrinsic: (...args: never[]) => unknown,
  receiver: unknown,
  args: unknown[],
): T {
  return applySnapshot(intrinsic, receiver, args) as T;
}

function appendOwn<T>(values: T[], value: T): void {
  applyIntrinsic(definePropertySnapshot, undefined, [
    values,
    values.length,
    {
      __proto__: null,
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    },
  ]);
}

function isClassificationRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  try {
    return applyIntrinsic<boolean>(isProxySnapshot, undefined, [value]) === false;
  } catch {
    return false;
  }
}

function ownClassificationData(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = applyIntrinsic<PropertyDescriptor | undefined>(
      getOwnPropertyDescriptorSnapshot,
      undefined,
      [value, key],
    );
    if (descriptor === undefined) return ABSENT;
    const data = applyIntrinsic<PropertyDescriptor | undefined>(
      getOwnPropertyDescriptorSnapshot,
      undefined,
      [descriptor, "value"],
    );
    return data === undefined ? INVALID_FIELD : data.value;
  } catch {
    return INVALID_FIELD;
  }
}

type PlaceholderClassification = "safe" | "placeholder" | "failure";

function classifyPlaceholder(value: string): PlaceholderClassification {
  let classification: unknown;
  try {
    classification = applyIntrinsic(classifyPlaceholderSnapshot, undefined, [value]);
    if (applyIntrinsic(genuinePlaceholderSnapshot, undefined, [classification]) !== true) {
      return "failure";
    }
  } catch {
    return "failure";
  }
  if (!isClassificationRecord(classification)) return "failure";
  const ok = ownClassificationData(classification, "ok");
  const reason = ownClassificationData(classification, "reason");
  if (ok === true && reason === ABSENT) return "safe";
  return ok === false && reason === "placeholder" ? "placeholder" : "failure";
}

const NON_PROSE_EXACT_PATHS = new Set([
  "/name",
  "/namespace",
  "/version",
  "/repository",
  "/author/github",
  "/license/id",
  "/risk",
  "/execution/sandbox",
  "/execution/network",
]);

function isNonProsePath(path: string): boolean {
  return (
    (applySnapshot(setHasSnapshot, NON_PROSE_EXACT_PATHS, [path]) as boolean) ||
    ((applySnapshot(stringStartsWithSnapshot, path, ["/capability/inputs/"]) as boolean) &&
      (applySnapshot(stringEndsWithSnapshot, path, ["/name"]) as boolean)) ||
    ((applySnapshot(stringStartsWithSnapshot, path, ["/capability/outputs/"]) as boolean) &&
      (applySnapshot(stringEndsWithSnapshot, path, ["/name"]) as boolean)) ||
    ((applySnapshot(stringStartsWithSnapshot, path, ["/tests/commands/"]) as boolean) &&
      ((applySnapshot(stringIncludesSnapshot, path, ["/argv/"]) as boolean) ||
        (applySnapshot(stringEndsWithSnapshot, path, ["/cwd"]) as boolean))) ||
    ((applySnapshot(stringStartsWithSnapshot, path, ["/scenarios/"]) as boolean) &&
      (applySnapshot(stringEndsWithSnapshot, path, ["/id"]) as boolean))
  );
}

interface SemanticTextEntry {
  readonly value: string;
  readonly path: string;
}

function collectSemanticTextEntries(
  value: unknown,
  path: string,
  entries: SemanticTextEntry[],
): void {
  if (typeof value === "string") {
    if (!isNonProsePath(path)) entries[entries.length] = { value, path: path === "" ? "/" : path };
    return;
  }
  if (applyIntrinsic<boolean>(arrayIsArraySnapshot, undefined, [value])) {
    const array = value as readonly unknown[];
    for (let index = 0; index < array.length; index += 1) {
      collectSemanticTextEntries(array[index], `${path}/${index}`, entries);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const objectEntries = applyIntrinsic<readonly (readonly [string, unknown])[]>(
      objectEntriesSnapshot,
      undefined,
      [value],
    );
    for (let index = 0; index < objectEntries.length; index += 1) {
      const entry = objectEntries[index] as readonly [string, unknown];
      collectSemanticTextEntries(entry[1], `${path}/${escapePointer(entry[0])}`, entries);
    }
  }
}

function semanticTextEntries(value: unknown): readonly SemanticTextEntry[] {
  const entries: SemanticTextEntry[] = [];
  collectSemanticTextEntries(value, "", entries);
  return entries;
}

function placeholderIssues(entries: readonly SemanticTextEntry[]): CapabilityBriefIssue[] {
  const staged: CapabilityBriefIssue[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as SemanticTextEntry;
    const classification = classifyPlaceholder(entry.value);
    if (classification === "placeholder") {
      appendOwn(staged, issue("brief.placeholder", entry.path, "value is a placeholder"));
    } else if (classification === "failure") {
      return [
        issue(
          "brief.placeholder_analysis",
          entry.path,
          "value could not be analyzed safely for placeholders",
        ),
      ];
    }
  }
  return staged;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function invalidUnicodeIssues(value: unknown, path = ""): CapabilityBriefIssue[] {
  if (typeof value === "string") {
    return hasUnpairedSurrogate(value)
      ? [
          issue(
            "brief.invalid_unicode",
            path === "" ? "/" : path,
            "string contains an unpaired UTF-16 surrogate",
          ),
        ]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => invalidUnicodeIssues(entry, `${path}/${index}`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      invalidUnicodeIssues(entry, `${path}/${escapePointer(key)}`),
    );
  }
  return [];
}

interface ScenarioGroup {
  readonly path: string;
  readonly scenarios: readonly ScenarioCase[];
  readonly requiresForbiddenBehavior: boolean;
}

function scenarioGroups(brief: SkillPressCapabilityBrief): readonly ScenarioGroup[] {
  return [
    {
      path: "/scenarios/training/positive",
      scenarios: brief.scenarios.training.positive,
      requiresForbiddenBehavior: false,
    },
    {
      path: "/scenarios/training/nearMiss",
      scenarios: brief.scenarios.training.nearMiss,
      requiresForbiddenBehavior: true,
    },
    {
      path: "/scenarios/training/failure",
      scenarios: brief.scenarios.training.failure,
      requiresForbiddenBehavior: false,
    },
    {
      path: "/scenarios/training/adversarial",
      scenarios: brief.scenarios.training.adversarial,
      requiresForbiddenBehavior: true,
    },
    {
      path: "/scenarios/holdout/positive",
      scenarios: brief.scenarios.holdout.positive,
      requiresForbiddenBehavior: false,
    },
    {
      path: "/scenarios/holdout/nearMiss",
      scenarios: brief.scenarios.holdout.nearMiss,
      requiresForbiddenBehavior: true,
    },
  ];
}

function uniquenessIssues(brief: SkillPressCapabilityBrief): CapabilityBriefIssue[] {
  const issues: CapabilityBriefIssue[] = [];
  const ids = new Map<string, string>();
  const prompts = new Map<string, string>();
  const activationConditions = new Map(
    brief.capability.useWhen.map(
      (value, index) =>
        [normalizeComparableTextSnapshot(value), `/capability/useWhen/${index}`] as const,
    ),
  );

  brief.capability.doNotUseWhen.forEach((value, index) => {
    const activePath = activationConditions.get(normalizeComparableTextSnapshot(value));
    if (activePath !== undefined) {
      issues.push(
        issue(
          "brief.activation_contradiction",
          `/capability/doNotUseWhen/${index}`,
          `condition also appears at ${activePath}`,
        ),
      );
    }
  });

  for (const group of scenarioGroups(brief)) {
    group.scenarios.forEach((scenario, index) => {
      const path = `${group.path}/${index}`;
      const previousId = ids.get(scenario.id);
      if (previousId !== undefined) {
        issues.push(
          issue(
            "brief.scenario_id_duplicate",
            `${path}/id`,
            `scenario id also appears at ${previousId}`,
          ),
        );
      } else {
        ids.set(scenario.id, `${path}/id`);
      }

      const promptKey = normalizeComparableTextSnapshot(scenario.prompt);
      const previousPrompt = prompts.get(promptKey);
      if (previousPrompt !== undefined) {
        issues.push(
          issue(
            "brief.scenario_prompt_duplicate",
            `${path}/prompt`,
            `scenario prompt also appears at ${previousPrompt}`,
          ),
        );
      } else {
        prompts.set(promptKey, `${path}/prompt`);
      }

      if (group.requiresForbiddenBehavior && scenario.forbiddenBehavior === undefined) {
        issues.push(
          issue(
            "brief.forbidden_behavior_required",
            `${path}/forbiddenBehavior`,
            "near-miss and adversarial scenarios require forbidden behavior",
          ),
        );
      }

      if (scenario.forbiddenBehavior !== undefined) {
        const expected = new Set(scenario.expectedBehavior.map(normalizeComparableTextSnapshot));
        scenario.forbiddenBehavior.forEach((behavior, behaviorIndex) => {
          if (expected.has(normalizeComparableTextSnapshot(behavior))) {
            issues.push(
              issue(
                "brief.behavior_contradiction",
                `${path}/forbiddenBehavior/${behaviorIndex}`,
                "behavior is both expected and forbidden in the same scenario",
              ),
            );
          }
        });
      }
    });
  }

  for (const [path, names] of [
    ["/capability/inputs", brief.capability.inputs.map((entry) => entry.name)],
    ["/capability/outputs", brief.capability.outputs.map((entry) => entry.name)],
  ] as const) {
    const seen = new Set<string>();
    names.forEach((name, index) => {
      if (seen.has(name)) {
        issues.push(issue("brief.name_duplicate", `${path}/${index}/name`, "name must be unique"));
      }
      seen.add(name);
    });
  }

  return issues;
}

function remapSourceError(error: ProjectConfigError): CapabilityBriefError {
  return new CapabilityBriefError(
    "Unable to load the SkillPress capability brief.",
    error.issues.map((entry) =>
      issue(
        entry.code.replace(/^config\./u, "brief.source."),
        entry.path,
        entry.message.replaceAll("configuration", "capability brief"),
      ),
    ),
    error,
  );
}

export async function loadCapabilityBrief(path: string): Promise<ResolvedCapabilityBrief> {
  let value: unknown;
  try {
    value = await loadStrictYamlDocument(path);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      throw remapSourceError(error);
    }
    throw error;
  }

  if (!validate(value)) {
    throw new CapabilityBriefError(
      "Capability brief does not match schema version 2.",
      schemaIssues(validate.errors as ErrorObject[]),
    );
  }

  // Finish traversal and normalization before the first classifier callback can run.
  // Diagnostics are assembled below in the historical public order.
  const invalidUnicode = invalidUnicodeIssues(value);
  const semanticText = semanticTextEntries(value);
  const uniqueness = uniquenessIssues(value);
  const semanticIssues: CapabilityBriefIssue[] = [];
  const semanticError = new CapabilityBriefError(
    "Capability brief is incomplete or ambiguous.",
    semanticIssues,
  );
  const resolved: ResolvedCapabilityBrief = { ...value, version: value.version ?? "0.1.0" };
  applyIntrinsic(definePropertySnapshot, undefined, [
    resolved,
    "then",
    {
      __proto__: null,
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false,
    },
  ]);
  const placeholders = placeholderIssues(semanticText);
  for (let index = 0; index < invalidUnicode.length; index += 1) {
    appendOwn(semanticIssues, invalidUnicode[index] as CapabilityBriefIssue);
  }
  for (let index = 0; index < placeholders.length; index += 1) {
    appendOwn(semanticIssues, placeholders[index] as CapabilityBriefIssue);
  }
  for (let index = 0; index < uniqueness.length; index += 1) {
    appendOwn(semanticIssues, uniqueness[index] as CapabilityBriefIssue);
  }
  if (semanticIssues.length > 0) {
    throw semanticError;
  }

  return resolved;
}
