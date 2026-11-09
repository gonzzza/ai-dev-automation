import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { StandardsError } from "./error.js";
import { parseStandard, type Standard } from "./parse.js";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function readEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new StandardsError(`${dir}: standards directory does not exist`);
    throw new StandardsError(`${dir}: cannot read directory: ${errorMessage(error)}`);
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new StandardsError(`${path}: cannot read file: ${errorMessage(error)}`);
  }
}

/**
 * Load the standards in `dir`: one subdirectory per pack, one `.md` file per standard. Reads every
 * pack, or only the named ones. Files outside packs (such as a top-level README.md), non-`.md` files,
 * nested directories and hidden directories (`.git`) are ignored. Throws `StandardsError` if `dir`
 * or a named pack does not exist, on any parse error, and on an id used twice.
 */
export async function loadStandards(dir: string, packs?: string[]): Promise<Standard[]> {
  const available = (await readEntries(dir))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const wanted = packs?.length ? [...new Set(packs)] : available;
  const unknown = wanted.filter((pack) => !available.includes(pack));
  if (unknown.length) {
    throw new StandardsError(
      `${dir}: unknown pack ${unknown.map((p) => JSON.stringify(p)).join(", ")}; available packs: ${available.join(", ") || "(none)"}`,
    );
  }

  const standards: Standard[] = [];
  const seen = new Map<string, string>();
  for (const pack of wanted) {
    const files = (await readEntries(join(dir, pack)))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
    for (const name of files) {
      const path = join(dir, pack, name);
      const standard = parseStandard(path, pack, await readText(path));
      const other = seen.get(standard.id);
      if (other !== undefined) throw new StandardsError(`${path}: duplicate id ${JSON.stringify(standard.id)}, also used in ${other}`);
      seen.set(standard.id, path);
      standards.push(standard);
    }
  }
  return standards;
}
