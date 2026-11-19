import type { ChannelSummary, ChannelsPage } from "@/lib/api/types";

/** `message_deleted`'s payload. The backend adds the recomputed chat-list summary
 *  (`lastMessageAt`/`lastMessagePreview`) once `chat_state` has been updated. */
export interface MessageDeletedPayload {
  channelId: string;
  messageId: string;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
}

/**
 * Patches the chat list after a delete-for-everyone. Returns the same page (no re-render)
 * when nothing visible changed: the payload has no summary, the chat isn't in the list, or
 * the deleted message wasn't its last one. Your own delete-for-me override is reconciled by
 * the refetch the caller schedules when this returns a new page.
 */
export function applyMessageDeleted(page: ChannelsPage | undefined, payload: MessageDeletedPayload): ChannelsPage | undefined {
  if (!page || !("lastMessageAt" in payload)) return page;
  const nextAt = payload.lastMessageAt ?? null;
  let changed = false;
  const items = page.items.map((c) => {
    if (c.channelId !== payload.channelId) return c;
    if ((c.lastMessageAt ?? null) === nextAt && (c.lastMessagePreview ?? null) === (payload.lastMessagePreview ?? null)) return c;
    changed = true;
    return {
      ...c,
      lastMessageAt: nextAt,
      lastMessagePreview: payload.lastMessagePreview ?? null,
      // Nothing left at all: nothing to be unread either.
      unread: nextAt ? c.unread : false,
    };
  });
  return changed ? { ...page, items } : page;
}

const time = (c: ChannelSummary) => (c.lastMessageAt ? Date.parse(c.lastMessageAt) || 0 : 0);

/**
 * The list's display order: pinned first in the order they're kept (the server's pin order,
 * or a local reorder), then everything else by most recent activity. Stable, so pinned
 * chats never reshuffle by recency.
 */
export function sortChannels(items: readonly ChannelSummary[]): ChannelSummary[] {
  const pinned = items.filter((c) => c.isPinned);
  const rest = items.filter((c) => !c.isPinned).sort((a, b) => time(b) - time(a));
  return [...pinned, ...rest];
}

/** Moves `channelId` among the pinned chats to `toIndex` (0 = top). Unpinned rows keep their
 *  places in the array. Returns the new pinned id order, or null when nothing moved. */
export function movePinned(items: readonly ChannelSummary[], channelId: string, toIndex: number): { items: ChannelSummary[]; order: string[] } | null {
  const pinned = items.filter((c) => c.isPinned);
  const from = pinned.findIndex((c) => c.channelId === channelId);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(pinned.length - 1, toIndex));
  if (to === from) return null;
  const reordered = pinned.slice();
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  let i = 0;
  const next = items.map((c) => (c.isPinned ? reordered[i++] : c));
  return { items: next, order: reordered.map((c) => c.channelId) };
}

/** A just-pinned chat goes to the top of the pinned group (the server does the same). */
export function pinToTop(items: readonly ChannelSummary[], channelId: string): ChannelSummary[] {
  const target = items.find((c) => c.channelId === channelId);
  if (!target) return items.slice();
  return [{ ...target, isPinned: true }, ...items.filter((c) => c.channelId !== channelId)];
}
