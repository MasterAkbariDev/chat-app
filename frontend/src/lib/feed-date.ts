/** The date label for a day in the message feed: "Today", "Yesterday", or a locale date
 *  ("Tuesday, September 29", with the year when it isn't this one). Shared by the in-feed
 *  date dividers and the floating date pill that shows while scrolling. */
export function formatDateDivider(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

/** Index of the first rendered row that is still at or below the top edge of the feed
 *  (its bottom is past `viewportTop + slack`), i.e. the message at the top of the viewport.
 *  Rows are given in index order or not — the smallest matching index wins. -1 if none. */
export function topVisibleRowIndex(rows: ReadonlyArray<{ index: number; bottom: number }>, viewportTop: number, slack = 8): number {
  let best = -1;
  for (const r of rows) {
    if (r.bottom > viewportTop + slack && (best < 0 || r.index < best)) best = r.index;
  }
  return best;
}
