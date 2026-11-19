/**
 * Strips C0 control characters and DEL from message content before it's persisted (B5,
 * docs/plans/BACKEND_PLAN.md). Tab (9), newline (10) and carriage-return (13) are the only
 * "formatting" this app allows and are kept; everything else in that range has no legitimate
 * use in a chat message and can carry terminal-escape or other injection payloads.
 *
 * Built from character codes rather than a regex literal with embedded \u00XX escapes, which
 * are easy to mangle in transit (editors/terminals rendering them as the literal control byte).
 */
function isStrippedControlChar(code: number): boolean {
  if (code === 9 || code === 10 || code === 13) return false;
  if (code === 127) return true;
  return code <= 31;
}

export function sanitizeMessageContent(content: string): string {
  let result = "";
  for (const ch of content) {
    if (!isStrippedControlChar(ch.charCodeAt(0))) {
      result += ch;
    }
  }
  return result.trim();
}
