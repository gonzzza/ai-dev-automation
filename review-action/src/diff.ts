import { matchesGlob } from "node:path";

/** The subset of GitHub's "list pull request files" response we use. */
export interface ChangedFile {
  filename: string;
  status: string;
  patch?: string;
}

export interface AnnotatedFile {
  path: string;
  /** Patch rewritten with new-side line numbers, so the model can cite real lines. */
  annotated: string;
  /** New-side line numbers GitHub accepts an inline comment on. */
  commentableLines: Set<number>;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export const DEFAULT_EXCLUDE = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/*.min.js",
  "**/*.map",
  "**/*.snap",
  "**/dist/**",
];

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Annotate a unified-diff patch with new-file line numbers:
 *
 *   @@ -10,3 +10,4 @@
 *      10   unchanged
 *         - removed
 *      11 + added
 */
export function annotatePatch(patch: string): Omit<AnnotatedFile, "path"> {
  const out: string[] = [];
  const commentableLines = new Set<number>();
  let newLine = 0;

  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      newLine = Number(header[1]);
      // Keep only "@@ -a,b +c,d @@". Git appends a section heading copied from the
      // file, which is author-controlled text without a line-number prefix.
      out.push(header[0]);
      continue;
    }
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") {
      commentableLines.add(newLine);
      out.push(`${String(newLine).padStart(5)} + ${text}`);
      newLine++;
    } else if (marker === "-") {
      out.push(`${" ".repeat(5)} - ${text}`);
    } else if (marker === " ") {
      commentableLines.add(newLine);
      out.push(`${String(newLine).padStart(5)}   ${text}`);
      newLine++;
    }
    // "\ No newline at end of file" and empty trailing lines carry no code.
  }

  return { annotated: out.join("\n"), commentableLines };
}

export interface SelectOptions {
  exclude: string[];
  /** Budget for the annotated diff sent to the model, in characters. */
  maxChars: number;
}

/** Decide which files go to the model. Every file left out is reported with a reason. */
export function selectFiles(
  files: ChangedFile[],
  { exclude, maxChars }: SelectOptions,
): { included: AnnotatedFile[]; skipped: SkippedFile[] } {
  const included: AnnotatedFile[] = [];
  const skipped: SkippedFile[] = [];
  let used = 0;

  for (const file of files) {
    const path = file.filename;
    if (exclude.some((pattern) => matchesGlob(path, pattern))) {
      skipped.push({ path, reason: "excluded by pattern" });
    } else if (file.status === "removed") {
      skipped.push({ path, reason: "file deleted" });
    } else if (!file.patch) {
      skipped.push({ path, reason: "no text diff (binary, rename only, or too large for the GitHub API)" });
    } else {
      const annotatedFile = { path, ...annotatePatch(file.patch) };
      if (used + annotatedFile.annotated.length > maxChars) {
        skipped.push({ path, reason: "diff size budget exceeded (raise `max-diff-chars` to include it)" });
      } else {
        used += annotatedFile.annotated.length;
        included.push(annotatedFile);
      }
    }
  }

  return { included, skipped };
}
