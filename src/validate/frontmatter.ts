import {
  type Document,
  isAlias,
  isMap,
  isScalar,
  Lexer,
  LineCounter,
  type Node,
  parseDocument,
  type Pair,
  visit,
  type YAMLMap,
  type YAMLParseError,
} from "yaml";

import type { DiagnosticCollector } from "./diagnostics.js";
import { frontmatterTextIssue } from "./frontmatter-text.js";
import { parseSkillDocumentEnvelope } from "./skill-source.js";
import type {
  DiagnosticLocation,
  ParsedAgentSkillFrontmatter,
  ParsedFrontmatterField,
  ParsedFrontmatterValue,
} from "./types.js";

const MAX_YAML_FLOW_DEPTH = 32;
const MAX_YAML_INDENT = 64;
const MAX_YAML_TOKENS = 8192;
const MAX_YAML_NODES = 4096;

// Module initialization is the trust boundary for the indentation scanner.
const applySnapshot = Reflect.apply;
const charCodeAtSnapshot = String.prototype.charCodeAt;

const ALLOWED_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

function codeUnitAt(value: string, index: number): number {
  return applySnapshot(charCodeAtSnapshot, value, [index]) as number;
}

function exceedsComplexity(yaml: string): boolean {
  let indentation = 0;
  let scanningIndentation = true;
  for (let index = 0; index < yaml.length; index += 1) {
    const codeUnit = codeUnitAt(yaml, index);
    if (codeUnit === 0x0a || codeUnit === 0x0d) {
      if (codeUnit === 0x0d && codeUnitAt(yaml, index + 1) === 0x0a) index += 1;
      indentation = 0;
      scanningIndentation = true;
    } else if (scanningIndentation) {
      if (codeUnit !== 0x20) scanningIndentation = false;
      else {
        indentation += 1;
        if (indentation > MAX_YAML_INDENT) return true;
      }
    }
  }
  let tokens = 0;
  let flowDepth = 0;
  try {
    for (const token of new Lexer().lex(yaml)) {
      tokens += 1;
      if (tokens > MAX_YAML_TOKENS) return true;
      if (token === "[" || token === "{") {
        flowDepth += 1;
        if (flowDepth > MAX_YAML_FLOW_DEPTH) return true;
      } else if (token === "]" || token === "}") flowDepth -= 1;
    }
  } catch {
    return true;
  }
  return false;
}

function location(node: Node | Pair | null | undefined, counter: LineCounter): DiagnosticLocation {
  const offset =
    node !== null && node !== undefined && "range" in node ? node.range?.[0] : undefined;
  if (offset === undefined) return { line: 2, column: 1 };
  const position = counter.linePos(offset);
  return { line: position.line + 1, column: position.col };
}

function addSyntaxErrors(
  errors: readonly YAMLParseError[],
  diagnostics: DiagnosticCollector,
  counter: LineCounter,
): void {
  for (const error of errors) {
    if (error.code === "DUPLICATE_KEY" || error.code === "NON_STRING_KEY") continue;
    const offset = error.pos[0];
    const at = offset === undefined ? undefined : counter.linePos(offset);
    diagnostics.add(
      "skill.frontmatter.yaml",
      "error",
      "agent-skills",
      "frontmatter is not valid strict YAML",
      { line: (at?.line ?? 1) + 1, column: at?.col ?? 1 },
    );
  }
}

function inspectTree(
  contents: Node | null,
  diagnostics: DiagnosticCollector,
  counter: LineCounter,
): boolean {
  let rejected = false;
  let nodes = 0;
  visit(contents, {
    Node(_key, node) {
      nodes += 1;
      const at = location(node, counter);
      if (nodes > MAX_YAML_NODES) {
        rejected = true;
        return visit.BREAK;
      }
      const restrictions = [
        [isAlias(node), "skill.frontmatter.alias", "YAML aliases are not allowed"],
        [
          "anchor" in node && node.anchor !== undefined,
          "skill.frontmatter.anchor",
          "YAML anchors are not allowed",
        ],
        [node.tag !== undefined, "skill.frontmatter.tag", "explicit YAML tags are not allowed"],
      ] as const;
      for (const [matches, code, message] of restrictions) {
        if (matches) {
          rejected = true;
          diagnostics.add(code, "error", "agent-skills", message, at);
        }
      }
      if (isMap(node)) addDuplicateKeys(node, diagnostics, counter, () => (rejected = true));
      if (isScalar(node) && typeof node.value === "string") {
        const issue = frontmatterTextIssue(node.value);
        if (issue === "invalid_unicode") {
          rejected = true;
          diagnostics.add(
            "skill.frontmatter.invalid_unicode",
            "error",
            "skillpress",
            "frontmatter strings must contain valid paired Unicode scalar values",
            at,
          );
        } else if (issue === "control_character") {
          rejected = true;
          diagnostics.add(
            "skill.frontmatter.control_character",
            "error",
            "skillpress",
            "frontmatter strings contain a forbidden control or noncharacter code point",
            at,
          );
        }
      }
      return undefined;
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.type === "PLAIN" && pair.key.value === "<<") {
        rejected = true;
        diagnostics.add(
          "skill.frontmatter.merge_key",
          "error",
          "agent-skills",
          "YAML merge keys are not allowed",
          location(pair.key, counter),
        );
      }
    },
  });
  if (nodes > MAX_YAML_NODES) {
    diagnostics.add(
      "skill.frontmatter.complexity",
      "error",
      "skillpress",
      `YAML node count exceeds ${MAX_YAML_NODES}`,
      { line: 2, column: 1 },
    );
  }
  return rejected;
}

function addDuplicateKeys(
  map: YAMLMap,
  diagnostics: DiagnosticCollector,
  counter: LineCounter,
  reject: () => void,
): void {
  const keys = new Set<string>();
  for (const pair of map.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
    if (keys.has(pair.key.value)) {
      reject();
      diagnostics.add(
        "skill.frontmatter.duplicate_key",
        "error",
        "agent-skills",
        "YAML mapping keys must be unique",
        location(pair.key, counter),
      );
    }
    keys.add(pair.key.value);
  }
}

function value(node: Node | null): ParsedFrontmatterValue {
  if (isScalar(node) && typeof node.value === "string")
    return { kind: "string", value: node.value };
  if (!isMap(node)) return { kind: "other" };
  return {
    kind: "map",
    entries: node.items.map((pair) => ({
      key: isScalar(pair.key) && typeof pair.key.value === "string" ? pair.key.value : undefined,
      value:
        isScalar(pair.value) && typeof pair.value.value === "string" ? pair.value.value : undefined,
    })),
  };
}

function fields(
  contents: YAMLMap,
  diagnostics: DiagnosticCollector,
  counter: LineCounter,
): ReadonlyMap<string, ParsedFrontmatterField> {
  const result = new Map<string, ParsedFrontmatterField>();
  for (const pair of contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      diagnostics.add(
        "skill.frontmatter.yaml",
        "error",
        "agent-skills",
        "frontmatter mapping keys must be strings",
        location(isScalar(pair.key) ? pair.key : undefined, counter),
      );
      continue;
    }
    if (!ALLOWED_FIELDS.has(pair.key.value)) {
      diagnostics.add(
        "skill.frontmatter.unknown_field",
        "error",
        "agent-skills",
        "frontmatter contains an unknown field",
        location(pair.key, counter),
      );
      continue;
    }
    result.set(pair.key.value, {
      value: value(pair.value as Node | null),
      location: location(pair.key, counter),
    });
  }
  return result;
}

export function parseAgentSkillFrontmatter(
  text: string,
  diagnostics: DiagnosticCollector,
): ParsedAgentSkillFrontmatter | undefined {
  const parts = parseSkillDocumentEnvelope(text, diagnostics);
  if (parts === undefined) return undefined;
  if (exceedsComplexity(parts.yaml)) {
    diagnostics.add(
      "skill.frontmatter.complexity",
      "error",
      "skillpress",
      "YAML frontmatter exceeds the parser complexity budget",
      { line: 2, column: 1 },
    );
    return undefined;
  }
  const counter = new LineCounter();
  let document: Document;
  try {
    document = parseDocument(parts.yaml, {
      keepSourceTokens: true,
      lineCounter: counter,
      logLevel: "error",
      merge: false,
      prettyErrors: false,
      resolveKnownTags: false,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: "1.2",
    });
  } catch {
    diagnostics.add(
      "skill.frontmatter.yaml",
      "error",
      "agent-skills",
      "frontmatter is not valid strict YAML",
      { line: 2, column: 1 },
    );
    return undefined;
  }
  const syntax = [...document.errors, ...document.warnings];
  addSyntaxErrors(syntax, diagnostics, counter);
  const rejected = inspectTree(document.contents, diagnostics, counter);
  if (!isMap(document.contents)) {
    diagnostics.add(
      "skill.frontmatter.mapping",
      "error",
      "agent-skills",
      "frontmatter must be a YAML mapping",
      { line: 2, column: 1 },
    );
    return undefined;
  }
  const blocking = syntax.some(
    (error) => error.code !== "NON_STRING_KEY" && error.code !== "DUPLICATE_KEY",
  );
  if (blocking || rejected) return undefined;
  return {
    fields: fields(document.contents, diagnostics, counter),
    body: parts.body,
    bodyStartLine: parts.bodyStartLine,
    bodyStartOffset: parts.bodyStartOffset,
  };
}
