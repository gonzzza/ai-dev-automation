#!/usr/bin/env node
// Validates every spec in specs/ with the same parser the agent uses, so a bad spec fails in CI
// (and in the /write-spec skill) instead of at the start of an agent run.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkSpecs } from "./spec.js";

const SPECS_DIR = fileURLToPath(new URL("../../specs/", import.meta.url));

async function main(): Promise<void> {
  const names = (await readdir(SPECS_DIR)).filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md").sort();
  const files = await Promise.all(
    names.map(async (name) => ({ path: `specs/${name}`, body: await readFile(`${SPECS_DIR}${name}`, "utf8") })),
  );
  const errors = checkSpecs(files);
  for (const error of errors) console.error(`✗ ${error}`);
  if (errors.length) {
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${files.length} spec(s) valid`);
}

await main();
