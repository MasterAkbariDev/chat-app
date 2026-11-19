"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useRouter } from "@/hooks/use-app-router";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ApiError } from "@/lib/api/client";
import { CHANNELS_QUERY_KEY, getChannelsMine, getOrCreateDirect, subscribeToChannel } from "@/lib/api/chats";
import { searchChannels, searchMessages, searchPeople } from "@/lib/api/search";
import { channelDisplayName, type ChannelSearchHit, type ChannelSummary, type MessageSearchHit, type PublicUser } from "@/lib/api/types";
import { resolvePhotoSrc } from "@/lib/photo-src";
import {
  addRecentQuery,
  addRecentResult,
  getRecentSearch,
  getRecentSearchServerSnapshot,
  subscribeRecentSearch,
  type RecentResult,
} from "@/lib/recent-search";

// ---------------------------------------------------------------------------
// Query parsing and matching
// ---------------------------------------------------------------------------

/** The server rejects shorter queries (400). Local chat filtering works from 1. */
export const MIN_GLOBAL_QUERY = 2;
export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_PAGE_SIZE = 20;

export type GlobalScope = "people" | "channels" | "messages";
/** The filter chips above the results. */
export type SearchFilter = "all" | "chats" | GlobalScope;

export interface ParsedQuery {
  /** What the user typed, trimmed. */
  text: string;
  /** Sent to the server: a leading "@" is dropped ("@uid" → "uid"). */
  apiQuery: string;
  /** "@username" — people go first. */
  isHandle: boolean;
  /** Words to match / highlight. */
  terms: string[];
}

export function parseSearchQuery(raw: string): ParsedQuery {
  const text = raw.trim();
  const isHandle = text.startsWith("@");
  const apiQuery = (isHandle ? text.slice(1) : text).trim();
  const terms = apiQuery
    .split(/\s+/)
    .map((t) => t.replace(/^@+/, ""))
    .filter(Boolean);
  return { text, apiQuery, isHandle, terms };
}

/** Arabic and Persian keyboards produce different code points for the same
 * letters (ي/ی, ك/ک). Fold them so "علی" finds "علي". One code unit in, one
 * out — indexes into the original string stay valid for highlighting. */
function foldScript(s: string): string {
  return s.replace(/[يى]/g, "ی").replace(/ك/g, "ک");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type MatchMode = "prefix" | "substring";

/** Where each term matches in `text`, as merged [start, end) ranges on the
 * original string. "prefix" = start of a word ("kar" in "Omid Karimi");
 * "substring" = anywhere (what message search does server-side). */
export function findMatchRanges(text: string, terms: string[], mode: MatchMode = "prefix"): [number, number][] {
  if (!text || terms.length === 0) return [];
  const folded = foldScript(text);
  const ranges: [number, number][] = [];
  for (const term of terms) {
    const t = foldScript(term);
    if (!t) continue;
    const pattern = mode === "prefix" ? `(?<![\\p{L}\\p{N}\\p{M}])${escapeRegExp(t)}` : escapeRegExp(t);
    let re: RegExp;
    try {
      re = new RegExp(pattern, "giu");
    } catch {
      continue;
    }
    for (const m of folded.matchAll(re)) {
      if (m.index === undefined || m[0].length === 0) continue;
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Every term starts a word somewhere in at least one of the fields. */
function matchesAllTerms(fields: string[], terms: string[]): boolean {
  return terms.every((term) => fields.some((f) => findMatchRanges(f, [term]).length > 0));
}

// ---------------------------------------------------------------------------
// Display helpers shared by the search UIs
// ---------------------------------------------------------------------------

/** A photo field (`avatarUrl[0]`, `image[0]`) → the URL to load. Same shared resolver as
 * every avatar (lib/photo-src): legacy and relative `/uploads/...` paths reach the API. */
export function mediaSrc(path?: string | null): string | null {
  return resolvePhotoSrc(path);
}

/** People search only matches *names* of people you already know (contacts,
 * people you share a chat with) — strangers are found by @username only.
 * Shown when a name query finds nobody. */
export const FIND_BY_USERNAME_HINT = "To find someone new, search their exact @username.";

/** A people search came back empty for something that reads like a name
 * (not an "@handle") — the moment to explain the rule above. */
export function wantsUsernameHint(rawQuery: string, peopleFound: number): boolean {
  const q = rawQuery.trim();
  return q.length >= MIN_GLOBAL_QUERY && !q.startsWith("@") && peopleFound === 0;
}

export function personName(u: Pick<PublicUser, "firstName" | "lastName" | "username">): string {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username;
}

export function chatPhoto(c: Pick<ChannelSummary, "type" | "image" | "otherUser">): string | null {
  return mediaSrc(c.type === "private" ? c.otherUser?.avatarUrl?.[0] : c.image?.[0]);
}

export function memberCountLabel(type: string, count: number | undefined): string | null {
  if (count === undefined) return null;
  const noun = type === "channel" ? (count === 1 ? "subscriber" : "subscribers") : count === 1 ? "member" : "members";
  return `${count.toLocaleString()} ${noun}`;
}

export function isSquareChat(type: string): boolean {
  return type === "group" || type === "channel";
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

/** The user's own chats (shared GET /v1/channels/mine cache) whose name,
 * @link or DM username has a word starting with every typed term. Instant —
 * no request — and works from one character. Ranked: name starts with the
 * query, then any word match, then the list's own order (pinned, recent). */
export function useLocalChatMatches(terms: string[]) {
  const query = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: () => getChannelsMine() });
  const key = terms.join(" ");
  const items = useMemo(() => {
    if (terms.length === 0) return [];
    const all = query.data?.items ?? [];
    const first = foldScript(terms[0]).toLocaleLowerCase();
    const scored: { c: ChannelSummary; score: number; i: number }[] = [];
    all.forEach((c, i) => {
      const name = channelDisplayName(c) || "";
      const fields = [name];
      if (c.type === "private" && c.otherUser) fields.push(c.otherUser.username);
      // Private chats' links are internal ids ("private-<id>-<id>"), not handles.
      else if (c.link && c.isPublic) fields.push(c.link);
      if (!matchesAllTerms(fields, terms)) return;
      const lowerName = foldScript(name).toLocaleLowerCase();
      const score = lowerName === key.toLocaleLowerCase() ? 0 : lowerName.startsWith(first) ? 1 : 2;
      scored.push({ c, score, i });
    });
    scored.sort((a, b) => a.score - b.score || a.i - b.i);
    return scored.map((s) => s.c);
    // `terms` is represented by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, key]);
  return { items, all: query.data?.items ?? [], isPending: query.isPending, isError: query.isError, refetch: query.refetch };
}

export interface PagedSearch<T> {
  enabled: boolean;
  items: T[];
  isPending: boolean;
  isError: boolean;
  /** Rate limited (30 searches a minute, shared). */
  isThrottled: boolean;
  /** Showing the previous query's results while the new ones load. */
  isStale: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  retry: () => void;
}

const FETCHERS = {
  people: searchPeople,
  channels: searchChannels,
  messages: searchMessages,
} as const;

type HitOf<S extends GlobalScope> = S extends "people" ? PublicUser : S extends "channels" ? ChannelSearchHit : MessageSearchHit;

/** One server search scope, paged with `offset` ("Show more" → next page).
 * Cached per (scope, query) so the sidebar and the ⌘K palette share it. */
export function usePagedSearch<S extends GlobalScope>(scope: S, apiQuery: string, enabled: boolean, pageSize = SEARCH_PAGE_SIZE): PagedSearch<HitOf<S>> {
  const on = enabled && apiQuery.length >= MIN_GLOBAL_QUERY;
  const q = useInfiniteQuery<HitOf<S>[], Error, InfiniteData<HitOf<S>[], number>, readonly unknown[], number>({
    queryKey: ["search", scope, apiQuery, pageSize],
    queryFn: ({ pageParam }) => (FETCHERS[scope] as (q: string, p: { limit: number; offset: number }) => Promise<HitOf<S>[]>)(apiQuery, { limit: pageSize, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.length < pageSize ? undefined : pages.reduce((n, p) => n + p.length, 0)),
    enabled: on,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const items = useMemo(() => {
    // Pages can overlap if results shift between requests — dedupe by id.
    const seen = new Set<string>();
    const out: HitOf<S>[] = [];
    for (const page of q.data?.pages ?? []) {
      for (const hit of page) {
        const id = (hit as { _id: string })._id;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(hit);
      }
    }
    return out;
  }, [q.data]);
  const { refetch, fetchNextPage } = q;
  return {
    enabled: on,
    items: on ? items : [],
    isPending: on && q.isPending,
    isError: on && q.isError && !q.isFetching,
    isThrottled: on && q.error instanceof ApiError && q.error.status === 429,
    isStale: on && q.isPlaceholderData,
    hasNextPage: on && !!q.hasNextPage,
    isFetchingNextPage: q.isFetchingNextPage,
    fetchNextPage: useCallback(() => void fetchNextPage(), [fetchNextPage]),
    retry: useCallback(() => void refetch(), [refetch]),
  };
}

export interface GlobalSearch {
  parsed: ParsedQuery;
  /** The debounced query the server sections are showing. */
  debounced: ParsedQuery;
  /** Long enough for the server sections. */
  canSearchGlobally: boolean;
  /** Typed, but the debounce hasn't fired yet. */
  isDebouncing: boolean;
  chats: ChannelSummary[];
  chatsPending: boolean;
  people: PagedSearch<PublicUser>;
  channels: PagedSearch<ChannelSearchHit>;
  messages: PagedSearch<MessageSearchHit>;
}

/** Everything a global search UI needs for one query: local chats (instant,
 * from the live query) and the three server scopes (debounced, cached,
 * paged). Only the scopes the filter shows are requested — the server's
 * throttle is 30 a minute across all three. */
export function useGlobalSearch(rawQuery: string, filter: SearchFilter = "all", pageSize = SEARCH_PAGE_SIZE): GlobalSearch {
  const parsed = useMemo(() => parseSearchQuery(rawQuery), [rawQuery]);
  const debouncedText = useDebouncedValue(parsed.text, SEARCH_DEBOUNCE_MS);
  const debounced = useMemo(() => parseSearchQuery(debouncedText), [debouncedText]);
  // Gated on the live value too, so deleting back to one character drops the
  // server sections immediately rather than 300ms later.
  const canSearchGlobally = parsed.apiQuery.length >= MIN_GLOBAL_QUERY && debounced.apiQuery.length >= MIN_GLOBAL_QUERY;
  const wants = (s: GlobalScope) => canSearchGlobally && (filter === "all" || filter === s);

  const local = useLocalChatMatches(filter === "all" || filter === "chats" ? parsed.terms : []);
  const people = usePagedSearch("people", debounced.apiQuery, wants("people"), pageSize);
  const channels = usePagedSearch("channels", debounced.apiQuery, wants("channels"), pageSize);
  const messages = usePagedSearch("messages", debounced.apiQuery, wants("messages"), pageSize);

  // In "All", someone you already have a DM with shows under Chats, and a
  // public chat you're in shows under Chats — don't list them twice.
  const shownChats = useMemo(() => (filter === "all" ? local.items : []), [filter, local.items]);
  const dmUserIds = useMemo(() => new Set(shownChats.map((c) => c.otherUser?._id).filter(Boolean)), [shownChats]);
  const shownChatIds = useMemo(() => new Set(shownChats.map((c) => c.channelId)), [shownChats]);
  const peopleItems = useMemo(() => people.items.filter((u) => !dmUserIds.has(u._id)), [people.items, dmUserIds]);
  const channelItems = useMemo(() => channels.items.filter((c) => !shownChatIds.has(c._id)), [channels.items, shownChatIds]);

  return {
    parsed,
    debounced,
    canSearchGlobally,
    isDebouncing: parsed.text !== debouncedText,
    chats: local.items,
    chatsPending: local.isPending,
    people: { ...people, items: peopleItems },
    channels: { ...channels, items: channelItems },
    messages,
  };
}

export function useRecentSearch() {
  return useSyncExternalStore(subscribeRecentSearch, getRecentSearch, getRecentSearchServerSnapshot);
}

// ---------------------------------------------------------------------------
// Opening results
// ---------------------------------------------------------------------------

function rememberPublic(hit: ChannelSearchHit) {
  addRecentResult({
    key: `chat:${hit._id}`,
    title: hit.name || "Untitled",
    subtitle: [hit.link ? `@${hit.link}` : null, memberCountLabel(hit.type, hit.memberCount)].filter(Boolean).join(" · "),
    colorId: hit._id,
    shape: "square",
    image: mediaSrc(hit.image?.[0]),
    target: { type: "chat", channelId: hit._id },
  });
}

export interface SearchActions {
  openChat: (chat: ChannelSummary) => void;
  openPerson: (user: PublicUser) => void;
  openPublic: (hit: ChannelSearchHit) => void;
  join: (hit: ChannelSearchHit) => void;
  openMessage: (hit: MessageSearchHit) => void;
  openRecent: (recent: RecentResult) => void;
  /** Id of the person/chat currently being opened or joined. */
  pendingId: string | null;
  error: string | null;
}

/** Opening a result navigates, remembers it under "Recent", and records the
 * query that found it. `onNavigate` runs just before navigating (the palette
 * closes itself). */
export function useSearchActions(query: string, onNavigate?: () => void): SearchActions {
  const router = useRouter();
  const queryClient = useQueryClient();

  const go = useCallback(
    (path: string) => {
      addRecentQuery(query);
      onNavigate?.();
      router.push(path);
    },
    [query, onNavigate, router],
  );

  const directMutation = useMutation({
    mutationFn: (userId: string) => getOrCreateDirect(userId),
    onSuccess: async (chat) => {
      await queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
      go(`/app/c/${chat._id}`);
    },
  });

  const joinMutation = useMutation({
    mutationFn: (channelId: string) => subscribeToChannel(channelId),
    onSuccess: async (_res, channelId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ["search", "channels"] }),
      ]);
      go(`/app/c/${channelId}`);
    },
  });

  const openUserId = useCallback(
    (userId: string) => {
      // Already have a DM? Open it without a round trip.
      const mine = queryClient.getQueryData<{ items: ChannelSummary[] }>(CHANNELS_QUERY_KEY)?.items ?? [];
      const dm = mine.find((c) => c.type === "private" && c.otherUser?._id === userId);
      if (dm) go(`/app/c/${dm.channelId}`);
      else directMutation.mutate(userId);
    },
    [queryClient, go, directMutation],
  );

  const openChat = useCallback(
    (chat: ChannelSummary) => {
      const title = channelDisplayName(chat) || "Untitled chat";
      addRecentResult({
        key: `chat:${chat.channelId}`,
        title,
        subtitle: chat.type === "private" && chat.otherUser ? `@${chat.otherUser.username}` : (memberCountLabel(chat.type, chat.memberCount) ?? undefined),
        colorId: chat.channelId,
        shape: isSquareChat(chat.type) ? "square" : "circle",
        image: chatPhoto(chat),
        target: { type: "chat", channelId: chat.channelId },
      });
      go(`/app/c/${chat.channelId}`);
    },
    [go],
  );

  const openPerson = useCallback(
    (user: PublicUser) => {
      addRecentResult({
        key: `person:${user._id}`,
        title: personName(user),
        subtitle: `@${user.username}`,
        colorId: user._id,
        shape: "circle",
        image: mediaSrc(user.avatarUrl?.[0]),
        target: { type: "person", userId: user._id },
      });
      openUserId(user._id);
    },
    [openUserId],
  );

  const openPublic = useCallback(
    (hit: ChannelSearchHit) => {
      rememberPublic(hit);
      // Not a member → the chat page shows a preview with a Join bar.
      go(`/app/c/${hit._id}`);
    },
    [go],
  );

  const join = useCallback(
    (hit: ChannelSearchHit) => {
      rememberPublic(hit);
      joinMutation.mutate(hit._id);
    },
    [joinMutation],
  );

  const openMessage = useCallback(
    (hit: MessageSearchHit) => {
      const chat = hit.chat;
      if (chat) {
        const dm = chat.type === "private";
        addRecentResult({
          key: `chat:${hit.channelId}`,
          title: chat.name || (chat.otherUser ? personName(chat.otherUser) : "Chat"),
          subtitle: dm && chat.otherUser ? `@${chat.otherUser.username}` : undefined,
          colorId: hit.channelId,
          shape: isSquareChat(chat.type) ? "square" : "circle",
          image: mediaSrc(dm ? chat.otherUser?.avatarUrl?.[0] : chat.image?.[0]),
          target: { type: "chat", channelId: hit.channelId },
        });
      }
      go(`/app/c/${hit.channelId}?message=${encodeURIComponent(hit._id)}`);
    },
    [go],
  );

  const openRecent = useCallback(
    (recent: RecentResult) => {
      addRecentResult(recent);
      if (recent.target.type === "chat") {
        onNavigate?.();
        router.push(`/app/c/${recent.target.channelId}`);
      } else {
        openUserId(recent.target.userId);
      }
    },
    [onNavigate, router, openUserId],
  );

  const pendingId = directMutation.isPending ? directMutation.variables : joinMutation.isPending ? joinMutation.variables : null;
  const error = directMutation.isError ? "Couldn't open that chat. Try again." : joinMutation.isError ? "Couldn't join. Try again." : null;

  return { openChat, openPerson, openPublic, join, openMessage, openRecent, pendingId: pendingId ?? null, error };
}
