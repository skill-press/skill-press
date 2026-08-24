import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileFromFile } from "json-schema-to-typescript";

const checkOnly = process.argv.includes("--check");
const targets = [
  {
    schema: "schemas/skillpress.schema.json",
    output: "src/config/generated.ts",
  },
  {
    schema: "schemas/capability-brief.schema.json",
    output: "src/create/generated.ts",
  },
  {
    schema: "schemas/eval-suite.schema.json",
    output: "src/eval/generated-suite.ts",
  },
  {
    schema: "schemas/eval-rubric.schema.json",
    output: "src/eval/generated-rubric.ts",
  },
  {
    schema: "schemas/eval-agent-result.schema.json",
    output: "src/eval/generated-agent-result.ts",
  },
  {
    schema: "schemas/eval-evidence.schema.json",
    output: "src/eval/generated-evidence.ts",
  },
  {
    schema: "schemas/improve-report.schema.json",
    output: "src/improve/generated-report.ts",
  },
  {
    schema: "schemas/tessl-review-evidence.schema.json",
    output: "src/tessl/generated-review-evidence.ts",
  },
  {
    schema: "schemas/tessl-eval-evidence.schema.json",
    output: "src/tessl/generated-eval-evidence.ts",
  },
];

let stale = false;
for (const target of targets) {
  const schemaPath = fileURLToPath(new URL(`../${target.schema}`, import.meta.url));
  const outputPath = fileURLToPath(new URL(`../${target.output}`, import.meta.url));
  const generated = await compileFromFile(schemaPath, {
    bannerComment: `/* Generated from ${target.schema}. Do not edit by hand. */`,
    maxItems: 5,
    style: {
      printWidth: 100,
      semi: true,
      singleQuote: false,
      tabWidth: 2,
      trailingComma: "all",
      useTabs: false,
    },
    unreachableDefinitions: true,
  });

  if (checkOnly) {
    const existing = await readFile(outputPath, "utf8").catch(() => undefined);
    if (existing !== generated) {
      process.stderr.write(`Generated types are stale: ${target.output}\n`);
      stale = true;
    }
  } else {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, generated, { encoding: "utf8", mode: 0o644 });
  }
}

if (stale) {
  process.stderr.write("Run 'npm run generate:config-types' to update generated sources.\n");
  process.exitCode = 1;
}
