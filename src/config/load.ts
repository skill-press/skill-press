import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Lexer, parseAllDocuments } from "yaml";

import type { SkillPressProject } from "./generated.js";
import { type ConfigIssue, ProjectConfigError } from "./errors.js";

export const CONFIG_FILE_NAME = "skillpress.yaml";
export const MAX_CONFIG_BYTES = 64 * 1024;

const MAX_YAML_FLOW_DEPTH = 32;
const MAX_YAML_INDENT = 64;
const MAX_YAML_TOKENS = 8192;

// Module initialization, before the schema read yields, is the scanner's trust boundary.
const applySnapshot = Reflect.apply;
const charCodeAtSnapshot = String.prototype.charCodeAt;

const schemaUrl = new URL("../../schemas/skillpress.schema.json", import.meta.url);
const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile<SkillPressProject>(schema) as ValidateFunction<SkillPressProject>;

function codeUnitAt(value: string, index: number): number {
  return applySnapshot(charCodeAtSnapshot, value, [index]) as number;
}

function exceedsYamlIndentationBudget(text: string): boolean {
  let indentation = 0;
  let scanningIndentation = true;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = codeUnitAt(text, index);
    if (codeUnit === 0x0a) {
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
  return false;
}

function issue(code: string, path: string, message: string): ConfigIssue {
  return { code, path, message };
}

function schemaIssues(errors: readonly ErrorObject[]): ConfigIssue[] {
  return errors.map((error) =>
    issue(
      `config.schema.${error.keyword}`,
      error.instancePath === "" ? "/" : error.instancePath,
      error.message ?? "does not match the project schema",
    ),
  );
}

type FileMetadata = Awaited<ReturnType<typeof lstat>>;

interface InspectedPath {
  readonly path: string;
  readonly metadata: FileMetadata;
}

interface ConfigFileHandle {
  stat(): Promise<FileMetadata>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

type OpenConfigFile = (path: string, flags: number) => Promise<ConfigFileHandle>;

async function inspectPath(path: string): Promise<InspectedPath> {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const components = relative(root, absolutePath).split(sep).filter(Boolean);
  let currentPath = root;
  let metadata: FileMetadata;

  try {
    metadata = await lstat(currentPath);
    for (const component of components) {
      currentPath = join(currentPath, component);
      metadata = await lstat(currentPath);
      if (metadata.isSymbolicLink()) {
        throw new ProjectConfigError(
          "Refusing to follow a symbolic link in the configuration path.",
          [issue("config.symlink", "/", "configuration path must not contain symbolic links")],
        );
      }
    }
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      throw error;
    }
    throw new ProjectConfigError(
      `Unable to inspect SkillPress configuration at ${absolutePath}.`,
      [issue("config.read", "/", "configuration path cannot be inspected")],
      error,
    );
  }

  return { path: absolutePath, metadata };
}

async function resolveConfigPath(path: string): Promise<InspectedPath> {
  const inspected = await inspectPath(path);

  if (inspected.metadata.isDirectory()) {
    const config = await inspectPath(join(inspected.path, CONFIG_FILE_NAME));
    if (!config.metadata.isFile()) {
      throw new ProjectConfigError("SkillPress configuration must be a regular file.", [
        issue("config.file_type", "/", "configuration path is not a regular file"),
      ]);
    }
    return config;
  }

  if (!inspected.metadata.isFile()) {
    throw new ProjectConfigError("SkillPress configuration must be a regular file.", [
      issue("config.file_type", "/", "configuration path is not a regular file"),
    ]);
  }

  return inspected;
}

export function sameFileIdentity(
  expected: Pick<FileMetadata, "dev" | "ino">,
  opened: Pick<FileMetadata, "dev" | "ino">,
): boolean {
  return expected.dev === opened.dev && expected.ino === opened.ino;
}

export async function readConfigText(
  config: InspectedPath,
  openFile: OpenConfigFile = open,
): Promise<string> {
  if (config.metadata.size > MAX_CONFIG_BYTES) {
    throw new ProjectConfigError("SkillPress configuration exceeds the size limit.", [
      issue("config.too_large", "/", `configuration exceeds ${MAX_CONFIG_BYTES} bytes`),
    ]);
  }

  const noFollow = constants.O_NOFOLLOW;
  let handle: ConfigFileHandle;
  try {
    handle = await openFile(config.path, constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new ProjectConfigError(
      `Unable to read SkillPress configuration at ${config.path}.`,
      [issue("config.read", "/", "configuration file cannot be read")],
      error,
    );
  }

  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      throw new ProjectConfigError("SkillPress configuration must be a regular file.", [
        issue("config.file_type", "/", "opened configuration is not a regular file"),
      ]);
    }

    if (!sameFileIdentity(config.metadata, openedMetadata)) {
      throw new ProjectConfigError("SkillPress configuration changed while it was being opened.", [
        issue("config.changed", "/", "configuration file identity changed during loading"),
      ]);
    }

    if (openedMetadata.size > MAX_CONFIG_BYTES) {
      throw new ProjectConfigError("SkillPress configuration exceeds the size limit.", [
        issue("config.too_large", "/", `configuration exceeds ${MAX_CONFIG_BYTES} bytes`),
      ]);
    }

    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }

    if (offset > MAX_CONFIG_BYTES) {
      throw new ProjectConfigError("SkillPress configuration exceeds the size limit.", [
        issue("config.too_large", "/", `configuration exceeds ${MAX_CONFIG_BYTES} bytes`),
      ]);
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch (error) {
      throw new ProjectConfigError(
        "SkillPress configuration must contain valid UTF-8.",
        [issue("config.encoding", "/", "configuration is not valid UTF-8")],
        error,
      );
    }
  } finally {
    await handle.close();
  }
}

function complexityError(message: string): ProjectConfigError {
  return new ProjectConfigError("SkillPress configuration exceeds the YAML complexity budget.", [
    issue("config.complexity", "/", message),
  ]);
}

function assertYamlComplexity(text: string): void {
  if (exceedsYamlIndentationBudget(text)) {
    throw complexityError(`YAML indentation exceeds ${MAX_YAML_INDENT} spaces`);
  }

  let flowDepth = 0;
  let tokenCount = 0;
  for (const token of new Lexer().lex(text)) {
    tokenCount += 1;
    if (tokenCount > MAX_YAML_TOKENS) {
      throw complexityError(`YAML token count exceeds ${MAX_YAML_TOKENS}`);
    }

    if (token === "[" || token === "{") {
      flowDepth += 1;
      if (flowDepth > MAX_YAML_FLOW_DEPTH) {
        throw complexityError(`YAML flow depth exceeds ${MAX_YAML_FLOW_DEPTH}`);
      }
    } else if (token === "]" || token === "}") {
      flowDepth -= 1;
    }
  }
}

function parseConfig(text: string): unknown {
  assertYamlComplexity(text);

  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(text, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new ProjectConfigError(
      "SkillPress configuration is not valid YAML.",
      [issue("config.yaml", "/", "configuration cannot be parsed as YAML")],
      error,
    );
  }

  if (documents.length !== 1) {
    throw new ProjectConfigError("SkillPress configuration must contain one YAML document.", [
      issue("config.yaml_documents", "/", "expected exactly one YAML document"),
    ]);
  }

  const document = documents[0] as (typeof documents)[number];
  if (document.errors.length > 0 || document.warnings.length > 0) {
    const messages = [...document.errors, ...document.warnings].map((error) => error.message);
    throw new ProjectConfigError(
      "SkillPress configuration contains YAML errors.",
      messages.map((message) => issue("config.yaml", "/", message)),
    );
  }

  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new ProjectConfigError(
      "SkillPress configuration uses unsupported YAML aliases.",
      [issue("config.yaml_alias", "/", "YAML aliases are not allowed")],
      error,
    );
  }
}

export async function loadStrictYamlDocument(path: string): Promise<unknown> {
  const inspected = await inspectPath(path);
  if (!inspected.metadata.isFile()) {
    throw new ProjectConfigError("YAML input must be a regular file.", [
      issue("config.file_type", "/", "YAML input path is not a regular file"),
    ]);
  }
  return parseConfig(await readConfigText(inspected));
}

export async function loadProjectConfig(path: string = process.cwd()): Promise<SkillPressProject> {
  const config = await resolveConfigPath(path);
  const value = parseConfig(await readConfigText(config));

  if (!validate(value)) {
    throw new ProjectConfigError(
      "SkillPress configuration does not match schema version 1.",
      schemaIssues(validate.errors as ErrorObject[]),
    );
  }

  return value;
}
