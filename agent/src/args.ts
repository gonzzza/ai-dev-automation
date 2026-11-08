/**
 * Parses a CLI limit. Turn and budget caps are guardrails, so anything that isn't a finite
 * positive number (NaN would silently disable the cap downstream) is an error.
 */
export function parseLimit(flag: string, raw: string, { integer = false } = {}): number {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${flag} must be a positive ${integer ? "integer" : "number"}, got "${raw}".`);
  }
  return value;
}
