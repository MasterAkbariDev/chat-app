import { apiFetch } from "./client";
import type { ChatMessage, MessageReactionList, ReactionToggleResult, SeenBy } from "./types";

export interface GetMessagesOptions {
  limit?: number;
  offset?: number;
  afterDate?: string;
  beforeDate?: string;
  /** "newer": the oldest `limit` messages from `afterDate` on (paging forward after a jump).
   *  Default "older": the newest ones (paging back). Pages are oldest-first either way. */
  direction?: "older" | "newer";
}

/**
 * Offset/limit pagination (confirmed against MessageController.findAll —
 * still not cursor-based). Each page comes back oldest-first; "further
 * back" means a larger `offset`.
 */
export function getMessages(channelId: string, options: GetMessagesOptions = {}) {
  return apiFetch<ChatMessage[]>(`/messages/channel/${channelId}`, { query: { ...options } });
}

/** Provide exactly one — a plain unicode emoji, or a sticker/animated-emoji
 * pack item you already have (owned or subscribed; the backend 403s
 * otherwise and bumps its usage count on success). */
export type ReactionInput = { emoji: string } | { packItemId: string };

/**
 * Toggle behavior: calling with the same emoji/packItemId you already
 * reacted with removes it. Returns just the delta (`ReactionToggleResult`),
 * not a full message — patch `reactions` into the already-cached message
 * with it. Also triggers a `reaction_changed` broadcast to every other
 * member, but NOT reliably back to the acting user's own socket — don't
 * rely on the broadcast alone for the initiator, patch from this response
 * too.
 */
export function toggleReaction(messageId: string, reaction: ReactionInput) {
  return apiFetch<ReactionToggleResult>(`/messages/${messageId}/reaction`, { method: "POST", body: reaction });
}

/** Broadcasts `message_updated` to the channel, but (per the pin/unpin
 * precedent) don't rely on it reaching the acting user's own socket —
 * patch from this response too. */
/** `customEmoji` is positional, so an edit always sends the full current
 * set (omitting it clears them server-side). */
export function editMessage(messageId: string, content: string, customEmoji: { offset: number; length: number; packItemId: string }[] = []) {
  return apiFetch<ChatMessage>(`/messages/${messageId}`, { method: "PUT", body: { content, customEmoji } });
}

/** "Delete for everyone" — soft delete (isPinned is also forced false
 * server-side). Returns the updated message doc (unpopulated senderId,
 * `isDeleted` stripped by the schema's toJSON transform — don't expect
 * that field). Also broadcasts `message_deleted` (`{channelId, messageId}`)
 * to the channel; same self-echo caveat as above applies, so callers
 * should remove it from their own cache directly rather than relying
 * solely on the broadcast. */
export function deleteMessage(messageId: string) {
  return apiFetch<ChatMessage>(`/messages/${messageId}`, { method: "DELETE" });
}

/** "Delete for me" — per-user hide, no broadcast (nobody else's view
 * should change). Callers must remove the message from their own cache
 * manually after this resolves. */
export function deleteForMe(messageId: string) {
  return apiFetch<{ success: true }>(`/messages/${messageId}/delete-for-me`, { method: "POST" });
}

/** Only admins/owners can pin/unpin (403 otherwise). Broadcasts
 * `message_updated`, with the same self-echo caveat — patch from the
 * response too. */
export function pinMessage(messageId: string) {
  return apiFetch<ChatMessage>(`/messages/${messageId}/pin`, { method: "POST" });
}

export function unpinMessage(messageId: string) {
  return apiFetch<ChatMessage>(`/messages/${messageId}/pin`, { method: "DELETE" });
}

export function getPinnedMessages(channelId: string) {
  return apiFetch<ChatMessage[]>(`/messages/channel/${channelId}/pinned`);
}

/** Marks everything in the channel up to `lastReadMessageId` as read for
 * the caller, and broadcasts `read:updated` so senders can update their
 * tick indicators live. */
export function markRead(channelId: string, lastReadMessageId: string) {
  return apiFetch<{ success: boolean; channelId: string; lastReadMessageId: string }>(
    `/messages/channel/${channelId}/read`,
    { method: "POST", body: { lastReadMessageId } },
  );
}

/** Author-only, and only meaningful for DMs/groups — channels always come
 * back with an empty `readBy` rather than 403ing. */
export function getSeenBy(messageId: string) {
  return apiFetch<SeenBy>(`/v1/messages/${messageId}/reads`);
}

/** Query keys for the message info sheet. Both live under ["messages", …] so
 * the conversation's `read:updated` / `reaction_changed` handlers refresh them. */
export const messageReadsKey = (messageId: string) => ["messages", "seen-by", messageId, "info"] as const;
export const messageReactionsKey = (messageId: string) => ["messages", "reactions-list", messageId] as const;

/** Who reacted with what, newest first. Any member; channels: admins only (403 otherwise). */
export function getMessageReactions(messageId: string) {
  return apiFetch<MessageReactionList>(`/v1/messages/${messageId}/reactions`);
}

export function getMessage(messageId: string) {
  return apiFetch<ChatMessage>(`/messages/${messageId}`);
}

export interface ChannelSearchResult {
  messageIds: string[];
  total: number;
}

/** Ordered newest-first, ids only — no snippets, so a result list needs a
 * follow-up `getMessage` per row to show anything beyond the id. `q: "@"`
 * (exactly) switches to "messages that mention me" instead of a content
 * match — mirrors the backend's own convention, not reimplemented here. */
export function searchInChannel(channelId: string, q: string, limit = 500) {
  return apiFetch<ChannelSearchResult>(`/messages/channel/${channelId}/search`, { query: { q, limit } });
}

/** `date` is a plain YYYY-MM-DD (no time/zone) — matches the backend's own
 * calendar-day filter exactly. Null when nothing was sent that exact day. */
export function getFirstMessageOfDate(channelId: string, date: string) {
  return apiFetch<{ messageId: string | null }>(`/messages/channel/${channelId}/first-of-date`, { query: { date } });
}

/** "Nearest date going forward with messages" — the fallback for a date
 * that has nothing of its own (a quiet day, or one before the chat even
 * existed yet). Null means nothing exists at or after that date at all —
 * i.e. the picked date is already past the channel's last message. */
export function getFirstMessageFromDate(channelId: string, date: string) {
  return apiFetch<{ messageId: string | null; createdAt: string | null }>(`/messages/channel/${channelId}/first-from-date`, { query: { date } });
}

/** "Jump to date": the first message at or after the *local* start of `date` (YYYY-MM-DD).
 *  A quiet day lands on the next day with messages; a date before the chat existed on its
 *  first message; null means nothing was sent on or after that day. */
export function getFirstMessageFromLocalDay(channelId: string, date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const from = new Date(y, m - 1, d).toISOString();
  return apiFetch<{ messageId: string | null; createdAt: string | null }>(`/messages/channel/${channelId}/first-from-date`, {
    query: { date, from },
  });
}

/** How far everyone else has read (DMs/groups; null for channels or nobody yet): own
 *  messages created at or before `othersReadUpTo` show ✓✓. Kept live from `read:updated`. */
export function getReadState(channelId: string) {
  return apiFetch<{ chatType: string; othersReadUpTo: string | null }>(`/v1/messages/channel/${channelId}/read-state`);
}
export const readStateKey = (channelId: string) => ["messages", "read-state", channelId] as const;

/** Oldest-unread-first (ascending) — everything with a mention of the
 * caller since their own `lastReadMessageId`, already fully mapped
 * (same shape as a normal `ChatMessage`). */
export function getUnreadMentions(channelId: string, limit = 50) {
  return apiFetch<{ count: number; messages: ChatMessage[] }>(`/messages/channel/${channelId}/unread-mentions`, { query: { limit } });
}

/** Same "since last read" window as `getUnreadMentions`, but a much
 * sparser projection server-side (`_id`/`channelId`/`createdAt` only, not a
 * full mapped message) — enough to jump to one, not to render its content. */
export function getUnreadReactions(channelId: string, limit = 50) {
  return apiFetch<{ count: number; messages: { _id: string; createdAt: string }[] }>(`/messages/channel/${channelId}/unread-reactions`, {
    query: { limit },
  });
}
