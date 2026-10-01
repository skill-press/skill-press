import { readFile } from "node:fs/promises";
import { Ajv } from "ajv";

const ajv = new Ajv({ strict: true, allErrors: false });
for (const name of ["skill-press", "eval-suite", "eval-rubric"]) {
  ajv.addSchema(
    JSON.parse(
      await readFile(new URL(`../../schemas/${name}.schema.json`, import.meta.url), "utf8"),
    ),
  );
}
const validate = ajv.compile(
  JSON.parse(
    await readFile(
      new URL("../../schemas/reviewed-text-evidence.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);
const validateEnvelope = ajv.compile(
  JSON.parse(
    await readFile(
      new URL("../../schemas/reviewed-text-envelope.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

/** Shape only. Caller still enforces byte limits, source binding and behavioral policy. */
export function isReviewedTextEvidence(value: unknown): boolean {
  return validate(value);
}

export function isReviewedTextEnvelope(value: unknown): boolean {
  return validateEnvelope(value);
}
