/** Telegram-style read time: "today at 14:05", "yesterday at 9:12 AM",
 * "Oct 3 at 14:05", "Oct 3, 2025 at 14:05". Local time; the hour format
 * (12/24h) follows the viewer's locale. */
export function formatReadTime(value: string | Date, now: Date = new Date()): string {
  const d = new Date(value);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  const date = d.toLocaleDateString(
    undefined,
    d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" },
  );
  return `${date} at ${time}`;
}
