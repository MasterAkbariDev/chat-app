import type { LastSeenBucket } from "./api/types";

/** Telegram's approximations, shown when someone's last-seen privacy hides the
 * exact time from you (or you hide yours from them — it works both ways). */
export const LAST_SEEN_BUCKET_TEXT: Record<LastSeenBucket, string> = {
  recently: "last seen recently",
  within_week: "last seen within a week",
  within_month: "last seen within a month",
  long_ago: "last seen a long time ago",
};

export function formatLastSeen(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "last seen just now";
  if (minutes < 60) return `last seen ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export interface PresenceLike {
  isOnline: boolean;
  lastSeen: string | null;
  lastSeenBucket?: LastSeenBucket;
}

/** The status line under a person's name: "online", "last seen 5m ago",
 * "last seen recently"… or null when nothing is known yet. */
export function presenceStatus(p: PresenceLike | undefined | null): { text: string; online: boolean } | null {
  if (!p) return null;
  if (p.isOnline) return { text: "online", online: true };
  if (p.lastSeen) return { text: formatLastSeen(p.lastSeen), online: false };
  if (p.lastSeenBucket) return { text: LAST_SEEN_BUCKET_TEXT[p.lastSeenBucket], online: false };
  return { text: "offline", online: false };
}
