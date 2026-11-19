/** Telegram-style album mosaics: 2–10 photos/videos arranged in rows (or a tall first item with
 *  a column beside it) so every cell keeps roughly its own shape and the album fills the bubble
 *  width exactly. Pure maths — the bubble turns it into flex boxes. */

export type AlbumLayout =
  /** Rows top to bottom; each row's cells share its height, widths ∝ their aspect. */
  | { kind: "rows"; rows: { items: number[]; aspects: number[] }[]; aspect: number }
  /** Item 0 tall on the start side, the rest stacked in one column beside it. */
  | { kind: "column"; first: number; rest: number[]; firstShare: number; aspect: number };

const MIN_AR = 0.6;
const MAX_AR = 2.2;

export function clampAspect(ar: number | null | undefined): number {
  if (!ar || !Number.isFinite(ar) || ar <= 0) return 1;
  return Math.min(MAX_AR, Math.max(MIN_AR, ar));
}

/** Row sizes for n items (n ≥ 2): pairs and triples, triples later so the top stays big. */
export function rowSizes(n: number, aspects: number[]): number[] {
  if (n === 2) {
    // Two wide pictures read better stacked.
    return aspects.every((a) => a > 1.3) ? [1, 1] : [2];
  }
  if (n === 3) return aspects[0] > 1.2 ? [1, 2] : [3];
  if (n === 4) return aspects[0] > 1.2 ? [1, 3] : [2, 2];
  const rows: number[] = [];
  let left = n;
  // Start with a pair when it divides awkwardly (5 → 2+3, 7 → 2+2+3, 8 → 2+3+3).
  while (left > 0) {
    if (left === 4) {
      rows.push(2, 2);
      break;
    }
    if (left <= 3) {
      rows.push(left);
      break;
    }
    if (left % 3 === 0) rows.push(3);
    else rows.push(2);
    left -= rows[rows.length - 1];
  }
  return rows;
}

/** The mosaic for `ratios` (width / height of each item, null = unknown). */
export function albumLayout(ratios: (number | null | undefined)[]): AlbumLayout {
  const ar = ratios.map(clampAspect);
  const n = ar.length;
  if (n <= 1) return { kind: "rows", rows: [{ items: [0], aspects: [ar[0] ?? 1] }], aspect: ar[0] ?? 1 };

  // A portrait first item with 2–3 others: tall cell + a column (Telegram's 3/4 layouts).
  if ((n === 3 || n === 4) && ar[0] < 0.85) {
    const rest = ar.slice(1);
    // Column width when its items are stacked to the same total height (1): w = 1 / Σ(1/ar).
    const colW = 1 / rest.reduce((s, a) => s + 1 / a, 0);
    const total = ar[0] + colW;
    return {
      kind: "column",
      first: 0,
      rest: rest.map((_, i) => i + 1),
      firstShare: ar[0] / total,
      aspect: Math.min(MAX_AR, Math.max(0.75, total)),
    };
  }

  const sizes = rowSizes(n, ar);
  const rows: { items: number[]; aspects: number[] }[] = [];
  let i = 0;
  for (const size of sizes) {
    const items = Array.from({ length: size }, (_, k) => i + k);
    rows.push({ items, aspects: items.map((k) => ar[k]) });
    i += size;
  }
  // Each row's height is 1 / Σaspects (for width 1); the album's aspect is 1 / Σ heights.
  const height = rows.reduce((s, r) => s + 1 / r.aspects.reduce((a, b) => a + b, 0), 0);
  return { kind: "rows", rows, aspect: Math.min(MAX_AR, Math.max(0.6, 1 / height)) };
}

/** Whether one attachment of an image/video message is a video: its meta says so (mixed
 *  albums), the whole message is a video, or (meta missing) the URL is a video file. */
/** Whether one album item is a video. A mixed album can carry photos under a video
 *  message (and the reverse), so each item's own file decides: its recorded kind, then its
 *  extension; the message type is only a last resort. */
export function attachmentIsVideo(type: string, url: string, meta?: { kind?: string | null } | null): boolean {
  if (meta?.kind === "video" || meta?.kind === "image") return meta.kind === "video";
  if (type === "gif") return false;
  if (/\.(mp4|m4v|mov|webm)(\?|$)/i.test(url)) return true;
  if (/\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(url)) return false;
  return type === "video";
}
