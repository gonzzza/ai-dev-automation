#!/usr/bin/env node
// Validates every spec in specs/ with the same parser the agent uses, so a bad spec fails in CI
// (and in the /write-spec skill) instead of at the start of an agent run.
import { fileURLToPath } from "node:url";
import { checkSpecs, readSpecFiles } from "./spec.js";

const SPECS_DIR = fileURLToPath(new URL("../../specs/", import.meta.url));

async function main(): Promise<void> {
  const files = await readSpecFiles(SPECS_DIR);
  const errors = checkSpecs(files);
  for (const error of errors) console.error(`✗ ${error}`);
  if (errors.length) {
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${files.length} spec(s) valid`);
}

await main();
