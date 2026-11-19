/** Text direction from content, the way `dir="auto"` decides it: the first
 * strong character wins (digits, spaces, punctuation and emoji are neutral).
 * Used where an HTML attribute can't do it for us — the Notification API's
 * `dir`, plain-text exports — and to reason about per-line direction. In
 * markup prefer `dir="auto"` (plus `unicode-bidi: plaintext`, see
 * globals.css) so the browser applies the same rule per paragraph. */

// Letters of the right-to-left scripts (bidi classes R/AL). Digits, marks,
// punctuation and emoji aren't letters, so they stay neutral here too.
const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u;
const LETTER = /\p{L}/u;

export type TextDirection = "ltr" | "rtl";

/** Direction of the first strong character, or `null` when there's none
 *  (empty, digits only, emoji only). */
export function firstStrongDirection(text: string | null | undefined): TextDirection | null {
  if (!text) return null;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    return RTL_LETTER.test(ch) ? "rtl" : "ltr";
  }
  return null;
}

/** `firstStrongDirection` with a fallback for text with no strong chars. */
export function textDirection(text: string | null | undefined, fallback: TextDirection = "ltr"): TextDirection {
  return firstStrongDirection(text) ?? fallback;
}

/** Each line's own direction (what `unicode-bidi: plaintext` does per
 *  paragraph); lines with no strong char inherit the previous line's. */
export function lineDirections(text: string, fallback: TextDirection = "ltr"): TextDirection[] {
  let prev = fallback;
  return text.split("\n").map((line) => {
    const d = firstStrongDirection(line) ?? prev;
    prev = d;
    return d;
  });
}
