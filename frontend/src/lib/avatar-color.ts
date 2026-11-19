/** Per-person colour identity. No real avatar photos exist for most
 * people/chats yet (the backend's `avatarUrl` is a confirmed dead field —
 * see api/types.ts), so an avatar is an initial over one of eight hues,
 * picked deterministically from an id: the same person always gets the same
 * colour, and that colour follows them — avatar, their name in a group
 * chat, and reply quote bars. The hues themselves are theme-aware CSS
 * variables (`--person-N-bg` / `--person-N-fg` in globals.css), so they're
 * contrast-checked in both light and dark mode. */
export const PERSON_HUE_COUNT = 8;

/** FNV-1a — Mongo ObjectIds share long prefixes (timestamp + machine
 * bytes), and a plain `hash * 31` modulo 8 left people created together on
 * the same hue; FNV's multiply-xor mixes every byte into the low bits. */
export function personHueIndex(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash ^ (hash >>> 16)) >>> 0) % PERSON_HUE_COUNT;
}

export interface PersonColor {
  /** Soft fill — avatar background. */
  bg: string;
  /** Strong ink — avatar initial, sender name, quote bar. */
  fg: string;
}

export function personColor(id: string): PersonColor {
  const i = personHueIndex(id);
  return { bg: `var(--person-${i}-bg)`, fg: `var(--person-${i}-fg)` };
}

/** Back-compat shim for call sites that still pass a single `gradient`
 * string to <Avatar> or paint a background directly — now a flat,
 * theme-aware fill rather than a fixed gradient. Prefer `personColor`. */
export function avatarGradientFor(id: string): string {
  return personColor(id).bg;
}
