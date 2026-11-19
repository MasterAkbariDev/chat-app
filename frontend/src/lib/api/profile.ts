import { apiFetch } from "./client";
import type { ChatMessage } from "./types";

/** The shared-media browser's tabs that come from messages, in Telegram's order. */
export type SharedKind = "media" | "files" | "music" | "voice" | "links" | "gifs";
export const SHARED_KINDS: SharedKind[] = ["media", "files", "music", "voice", "links", "gifs"];

/** One page of a tab: item refs in order (an album's photos are separate items), the
 *  messages they come from, and the cursor for the next (older) page. */
export interface SharedItemsPage {
  items: { messageId: string; index: number }[];
  messages: ChatMessage[];
  nextCursor: string | null;
}

/** GET /messages/channel/:id/shared/items — newest first, paged by item. Media = photos and
 *  videos; music = tracks and audio files; voice = voice and round video messages. */
export function getSharedItems(channelId: string, kind: SharedKind, cursor?: string, limit = 60) {
  return apiFetch<SharedItemsPage>(`/messages/channel/${channelId}/shared/items`, { query: { kind, cursor, limit } });
}

/** Items per tab (an album of 3 photos counts 3). */
export function getSharedCounts(channelId: string) {
  return apiFetch<Record<SharedKind, number>>(`/messages/channel/${channelId}/shared/counts`);
}

export const sharedCountsKey = (channelId: string) => ["messages", "shared", channelId, "counts"] as const;
export const sharedListKey = (channelId: string, kind: SharedKind) => ["messages", "shared", channelId, kind] as const;

/** Hides every message so far from you only (moves your `hiddenAt` to now);
 * the chat stays in your list and the other person keeps everything. */
export function clearHistory(channelId: string) {
  return apiFetch<{ success: boolean }>(`/chats/${channelId}/clear-history`, { method: "POST" });
}

export interface CommonGroup {
  _id: string;
  name: string;
  image: string[];
  type: "group";
  isPublic?: boolean;
  link?: string | null;
  memberCount: number;
}

/** Groups you and `userId` are both in (not channels or DMs), by name. */
export function getCommonGroups(userId: string) {
  return apiFetch<CommonGroup[]>(`/chats/common/${userId}`);
}
