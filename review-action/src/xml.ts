/**
 * Escape author-controlled text so it cannot close the prompt's XML-style
 * delimiters and pose as trusted structure (e.g. a line containing "</diff>").
 */
export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
