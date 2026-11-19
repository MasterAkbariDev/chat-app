/** Escapes a user-supplied string for literal use inside a RegExp, so a
 *  search for "a.b" or "(" can't become a pattern (or a ReDoS). */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
