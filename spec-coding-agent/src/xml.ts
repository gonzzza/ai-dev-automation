/** Escapes text for an XML attribute value or element body in a prompt, so `&lt;` means `<`. */
export const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
