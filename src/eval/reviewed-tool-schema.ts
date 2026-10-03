import { readFile } from "node:fs/promises";
import { Ajv } from "ajv";

const ajv = new Ajv({ strict: true, allErrors: false });
for (const name of [
  "skill-press",
  "eval-suite",
  "eval-rubric",
  "reviewed-text-evidence",
  "reviewed-text-envelope",
  "reviewed-tool-evidence",
  "reviewed-tool-envelope",
]) {
  ajv.addSchema(
    JSON.parse(
      await readFile(new URL(`../../schemas/${name}.schema.json`, import.meta.url), "utf8"),
    ),
  );
}
const base = "https://raw.githubusercontent.com/skill-press/skill-press/main/schemas/";
const evidence = ajv.compile({ $ref: `${base}reviewed-tool-evidence.schema.json` });
const envelope = ajv.compile({ $ref: `${base}reviewed-tool-envelope.schema.json` });
/** Shape only: byte bounds, source verification and quality recomputation remain required. */
export function isReviewedToolEvidence(value: unknown): boolean {
  return evidence(value);
}
export function isReviewedToolEnvelope(value: unknown): boolean {
  return envelope(value);
}
