/**
 * Org engineering standards: markdown files with a small frontmatter block, grouped in packs.
 * See specs/002-org-standards-review.md for the format and the API this package will export.
 */

/** Any problem with a standards directory or file. The message starts with the file path (and line). */
export class StandardsError extends Error {
  override name = "StandardsError";
}
