import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDerivedAge } from "./unicode-age-table.mjs";
import {
  parseDefaultIgnorable,
  verifyAssignedDefaultIgnorable,
} from "./unicode-default-ignorable-table.mjs";
import { compressCaseFolding, verifyCaseFolding } from "./unicode-fold-table.mjs";
import { parsePunctuationAndSymbol } from "./unicode-general-category-table.mjs";
import { parseCaseFolding, readPinnedUnicodeInputs } from "./unicode-source-parse.mjs";
import { renderGeneratedSource } from "./unicode-table-render.mjs";

const GENERATED_PATH = "src/validate/generated-unicode.ts";

async function generate(checkOnly) {
  const {
    caseFoldingLines,
    derivedAgeLines,
    derivedCorePropertiesLines,
    derivedGeneralCategoryLines,
  } = await readPinnedUnicodeInputs();
  const selectedCaseFolding = parseCaseFolding(caseFoldingLines);
  const assignedRanges = parseDerivedAge(derivedAgeLines);
  const defaultIgnorableRanges = parseDefaultIgnorable(derivedCorePropertiesLines);
  const punctuationAndSymbolRanges = parsePunctuationAndSymbol(derivedGeneralCategoryLines);
  verifyAssignedDefaultIgnorable(defaultIgnorableRanges, assignedRanges);
  const compressed = compressCaseFolding(selectedCaseFolding);
  verifyCaseFolding(selectedCaseFolding, compressed);
  const generated = renderGeneratedSource(
    assignedRanges,
    defaultIgnorableRanges,
    punctuationAndSymbolRanges,
    compressed,
  );
  const outputPath = fileURLToPath(new URL(`../${GENERATED_PATH}`, import.meta.url));

  if (checkOnly) {
    const existing = await readFile(outputPath, "utf8").catch(() => undefined);
    if (existing !== generated) {
      process.stderr.write(`Generated Unicode tables are stale: ${GENERATED_PATH}\n`);
      process.stderr.write("Run 'npm run generate:unicode' to update generated sources.\n");
      process.exitCode = 1;
    }
    return;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated, { encoding: "utf8", mode: 0o644 });
}

const argumentsList = process.argv.slice(2);
if (argumentsList.length > 1 || (argumentsList.length === 1 && argumentsList[0] !== "--check")) {
  process.stderr.write("Usage: node scripts/generate-unicode-tables.mjs [--check]\n");
  process.exitCode = 1;
} else {
  await generate(argumentsList[0] === "--check");
}
