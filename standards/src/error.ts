/** Any problem with a standards directory or file. The message starts with the file path (and line). */
export class StandardsError extends Error {
  override name = "StandardsError";
}
