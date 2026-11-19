import { apiFetch } from "./client";
import type { ChannelSearchHit, MessageSearchHit, PublicUser } from "./types";

// GET /v1/search — every typed word must match the start of a word
// (partial: "kar" finds "Karimi"), case-insensitive, ranked exact → prefix.
// `limit` is clamped to [1,50] (default 20); `offset` pages ("Show more").
// 90/min throttle, shared across scopes — debounce the input.

type Page = { limit?: number; offset?: number };

/** Names only match people you already know (your contacts and people you
 *  share a chat with); strangers only by @username — 4+ characters match as a
 *  prefix, shorter must be exact — and only if their privacy allows. Never
 *  yourself, never anyone blocked either way, never by email/phone. */
export function searchPeople(q: string, { limit = 20, offset = 0 }: Page = {}) {
  return apiFetch<PublicUser[]>("/v1/search", { query: { scope: "people", q, limit, offset } });
}

/** Public groups/channels only (by name or @link); private ones are invite-only. */
export function searchChannels(q: string, { limit = 20, offset = 0 }: Page = {}) {
  return apiFetch<ChannelSearchHit[]>("/v1/search", { query: { scope: "channels", q, limit, offset } });
}

/** Your own chats only (not ones you left, nothing from before you cleared a
 *  chat), substring match, newest first. */
export function searchMessages(q: string, { limit = 20, offset = 0 }: Page = {}) {
  return apiFetch<MessageSearchHit[]>("/v1/search", { query: { scope: "messages", q, limit, offset } });
}
