"use client";

import { useId, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "@/hooks/use-app-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderCog, MessageCircle, Search, SquarePen, X } from "lucide-react";
import Link from "next/link";
import { ConversationRow, type ConversationRowData } from "@/components/chat/ConversationRow";
import { GlobalSearchResults } from "@/components/chat/GlobalSearchResults";
import { RecentSearches } from "@/components/search/RecentSearches";
import { Chip } from "@/components/ui/Chip";
import { SkeletonList } from "@/components/ui/Skeleton";
import { Button, buttonClasses } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { CHANNELS_QUERY_KEY, getChannelsMine, muteChat, pinChat, reorderPinnedChats, unmuteChat, unpinChat } from "@/lib/api/chats";
import { movePinned, pinToTop, sortChannels } from "@/lib/chat-list";
import { cn } from "@/lib/cn";
import { FOLDERS_QUERY_KEY, getFolders } from "@/lib/api/folders";
import { usePresence } from "@/contexts/presence-context";
import type { SearchFilter } from "@/hooks/use-global-search";
import { channelDisplayName, type ChannelSummary, type ChannelsPage } from "@/lib/api/types";

const SEARCH_FILTERS: { key: SearchFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "chats", label: "Chats" },
  { key: "people", label: "People" },
  { key: "channels", label: "Groups & channels" },
  { key: "messages", label: "Messages" },
];

function formatTimestamp(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  const daysAgo = (now.getTime() - date.getTime()) / 86_400_000;
  if (daysAgo < 6) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function toRowData(channel: ChannelSummary, online: boolean): ConversationRowData {
  return {
    id: channel.channelId,
    title: channelDisplayName(channel) || "Untitled chat",
    kind: channel.type,
    online,
    pinned: channel.isPinned,
    muted: channel.isMuted,
    // Cleared history: the chat keeps its place but shows nothing (Telegram).
    lastMessagePreview: channel.historyCleared ? "" : (channel.lastMessagePreview ?? "No messages yet"),
    lastMessageAt: channel.historyCleared ? "" : formatTimestamp(channel.lastMessageAt),
    lastMessageIso: channel.lastMessageAt,
    hasUnread: channel.unread,
    lastMessageMine: !!channel.lastMessageMine && !channel.historyCleared,
    lastMessageRead: channel.lastMessageRead ?? null,
  };
}

// A separate component per row (not just a function) because presence needs
// a hook (`usePresence`) — there's no batch presence endpoint (see
// presence-context.tsx), so each private-chat row tracks its own other-user
// id independently; group/channel rows just skip it (undefined id is a
// no-op in the hook).
function ChannelRow({
  channel,
  selected,
  onPin,
  onMute,
  onMoveUp,
  onMoveDown,
}: {
  channel: ChannelSummary;
  selected: boolean;
  onPin: () => void;
  onMute: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const presence = usePresence(channel.type === "private" ? channel.otherUser?._id : undefined);
  const online = channel.type === "private" && !!presence?.isOnline;
  return <ConversationRow channel={toRowData(channel, online)} selected={selected} onPin={onPin} onMute={onMute} onMoveUp={onMoveUp} onMoveDown={onMoveDown} />;
}

export function ConversationList() {
  // null = the implicit "All" tab; otherwise a real folder's _id.
  const [selectedFolderId, setFolderId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState<SearchFilter>("all");
  const [query, setQuery] = useState("");
  // Recent searches show while the box is focused and empty.
  const [searchFocused, setSearchFocused] = useState(false);
  // The keyboard-highlighted result (`aria-activedescendant`).
  const [activeOptionId, setActiveOptionId] = useState<string | null>(null);
  const listboxId = `${useId()}-search-results`;
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();

  // Local chats match from the first letter; the server sections wait for
  // two (GlobalSearchResults debounces them itself).
  const searching = query.trim().length > 0;
  const showRecent = searchFocused && !searching;
  const searchPanelOpen = searching || showRecent;

  const selectedId = pathname.startsWith("/app/c/") ? pathname.split("/")[3] : null;

  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  function changeQuery(next: string) {
    setQuery(next);
    setActiveOptionId(null);
  }

  /** ↑/↓ walk every result row (all sections, in order), Enter opens the
   * highlighted one (or the first), Shift+Enter joins a highlighted public
   * group/channel you're not in, Esc clears and then leaves the box. */
  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) changeQuery("");
      else searchRef.current?.blur();
      return;
    }
    if (!searchPanelOpen) return;
    const options = Array.from(document.getElementById(listboxId)?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? []);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (options.length === 0) return;
      const current = options.findIndex((o) => o.id === activeOptionId);
      const next =
        e.key === "ArrowDown"
          ? current < 0 ? 0 : (current + 1) % options.length
          : current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length;
      setActiveOptionId(options[next].id);
      options[next].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && e.shiftKey) {
      const join = options.find((o) => o.id === activeOptionId)?.querySelector<HTMLElement>("[data-search-join]");
      if (!join) return;
      e.preventDefault();
      join.click();
    } else if (e.key === "Enter") {
      const target = options.find((o) => o.id === activeOptionId) ?? (searching ? options[0] : undefined);
      if (!target) return;
      e.preventDefault();
      target.click();
    }
  }

  const { data, isPending, isError, refetch, isRefetching } = useQuery({
    queryKey: CHANNELS_QUERY_KEY,
    queryFn: () => getChannelsMine(),
  });

  const foldersQuery = useQuery({ queryKey: FOLDERS_QUERY_KEY, queryFn: getFolders });
  const folders = useMemo(() => foldersQuery.data ?? [], [foldersQuery.data]);
  // A folder deleted (in Settings, or on another device) while it was the
  // active tab used to leave the list stuck on an empty "No chats in this
  // folder" with no tab highlighted — fall back to All chats instead.
  const folderId = selectedFolderId && foldersQuery.data && !folders.some((f) => f._id === selectedFolderId) ? null : selectedFolderId;

  // A folder's own filter criteria (type/tags/channel include-exclude/
  // unread) can only be evaluated server-side — `ChannelSummary` doesn't
  // carry a chat's tags, for one. So this is a SEPARATE query from the one
  // above: it asks the server which channelIds match, and that id set is
  // used to narrow what's rendered from the primary (always-unfiltered)
  // list — which stays the single source of truth for pin/mute state, so
  // toggling a pin/mute while a folder tab is active still patches the
  // right cache entry (see patchChannel below).
  const folderMembersQuery = useQuery({
    queryKey: ["channels", "folder-members", folderId],
    queryFn: () => getChannelsMine({ folder: folderId! }),
    enabled: !!folderId,
  });

  const patchChannel = (channelId: string, patch: Partial<ChannelSummary>) => {
    queryClient.setQueryData<ChannelsPage>(CHANNELS_QUERY_KEY, (prev) =>
      prev
        ? { ...prev, items: prev.items.map((c) => (c.channelId === channelId ? { ...c, ...patch } : c)) }
        : prev,
    );
  };

  // Optimistic, but rolled back if the request fails — previously a failed
  // pin/mute left the row showing a state the server never saved.
  const pinMutation = useMutation({
    mutationFn: (channel: ChannelSummary) => (channel.isPinned ? unpinChat(channel.channelId) : pinChat(channel.channelId)),
    onMutate: (channel) => {
      // A newly pinned chat goes to the top of the pinned group (the server agrees).
      if (channel.isPinned) patchChannel(channel.channelId, { isPinned: false });
      else queryClient.setQueryData<ChannelsPage>(CHANNELS_QUERY_KEY, (prev) => (prev ? { ...prev, items: pinToTop(prev.items, channel.channelId) } : prev));
    },
    onError: () => queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY, exact: true }),
  });

  // Drag (mouse/pen), the row menu's Move up/down (touch) and Alt+↑/↓ (keyboard) all land
  // here: reorder the cache's pinned rows in place, then save the whole order.
  const reorderMutation = useMutation({
    mutationFn: (order: string[]) => reorderPinnedChats(order),
    onError: () => queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY, exact: true }),
  });
  const [reorderNotice, setReorderNotice] = useState("");
  function movePinnedChat(channelId: string, toIndex: number, refocus = false) {
    const prev = queryClient.getQueryData<ChannelsPage>(CHANNELS_QUERY_KEY);
    if (!prev) return;
    const moved = movePinned(prev.items, channelId, toIndex);
    if (!moved) return;
    queryClient.setQueryData<ChannelsPage>(CHANNELS_QUERY_KEY, { ...prev, items: moved.items });
    reorderMutation.mutate(moved.order);
    const chat = prev.items.find((c) => c.channelId === channelId);
    setReorderNotice(`${chat ? channelDisplayName(chat) || "Chat" : "Chat"} moved to position ${moved.order.indexOf(channelId) + 1} of ${moved.order.length}`);
    // Re-ordering moves the row's DOM node, which can drop keyboard focus.
    if (refocus) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-pinned-row="${channelId}"] a`)?.focus());
  }
  const [drag, setDrag] = useState<{ id: string; over: number | null } | null>(null);

  const muteMutation = useMutation({
    mutationFn: (channel: ChannelSummary) => (channel.isMuted ? unmuteChat(channel.channelId) : muteChat(channel.channelId)),
    onMutate: (channel) => patchChannel(channel.channelId, { isMuted: !channel.isMuted }),
    onError: (_err, channel) => patchChannel(channel.channelId, { isMuted: channel.isMuted }),
  });

  // GET /v1/channels/mine is cursor-paginated (30 per page) and nothing
  // fetched past the first page, so anyone in more chats than that simply
  // couldn't reach the older ones from the list. Further pages are merged
  // into the same shared cache entry (deduped — the server repeats the
  // pinned rows on every page).
  const loadMoreMutation = useMutation({
    mutationFn: (cursor: string) => getChannelsMine({ cursor }),
    onSuccess: (page) => {
      queryClient.setQueryData<ChannelsPage>(CHANNELS_QUERY_KEY, (prev) => {
        if (!prev) return prev;
        const seen = new Set(prev.items.map((c) => c.channelId));
        return { items: [...prev.items, ...page.items.filter((c) => !seen.has(c.channelId))], nextCursor: page.nextCursor };
      });
    },
  });

  const channels = useMemo(() => {
    // Same order the server uses (pinned first, then most recent activity).
    // Re-applied here because the cache is patched in place — a pin toggled
    // from the row menu, or a new message landing in an older chat
    // (NotificationsHost), otherwise left the row where it was until the
    // next full refetch.
    // Pinned keep their own (drag) order, never re-sorted by recency.
    const all = sortChannels(data?.items ?? []);
    if (!folderId) return all;
    const allowedIds = new Set((folderMembersQuery.data?.items ?? []).map((c) => c.channelId));
    return all.filter((c) => allowedIds.has(c.channelId));
  }, [data, folderId, folderMembersQuery.data]);

  const showingFolderLoading = !!folderId && folderMembersQuery.isPending;
  const pinnedChats = channels.filter((c) => c.isPinned);
  const otherChats = channels.filter((c) => !c.isPinned);
  // Reordering edits the one unfiltered order, so it's offered in All chats only.
  const canReorder = !folderId && pinnedChats.length > 1;
  const renderRow = (channel: ChannelSummary) => (
    <ChannelRow
      channel={channel}
      selected={channel.channelId === selectedId}
      onPin={() => pinMutation.mutate(channel)}
      onMute={() => muteMutation.mutate(channel)}
    />
  );

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-panel">
      <div className="safe-top shrink-0">
        <div className="flex h-[var(--header-h)] items-center justify-between gap-2 px-4">
          <h1 className="font-display text-[24px] font-bold tracking-[-0.015em]">Chats</h1>
          <Link href="/app/new" aria-label="New conversation" title="New conversation" className={buttonClasses({ variant: "secondary", size: "sm", className: "rounded-full px-3" })}>
            <SquarePen className="size-[17px]" strokeWidth={2} aria-hidden />
            <span>New</span>
          </Link>
        </div>

        <div className="px-4 pb-3">
          <div className="group/search flex h-10 items-center gap-2 rounded-full border border-line bg-sunken px-3.5 text-muted transition-colors focus-within:border-accent focus-within:bg-raised hover:border-line-strong">
            <Search className="size-[17px] shrink-0" strokeWidth={2} aria-hidden />
            <input
              ref={searchRef}
              type="search"
              role="combobox"
              aria-expanded={searchPanelOpen}
              aria-controls={searchPanelOpen ? listboxId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={searchPanelOpen && activeOptionId ? activeOptionId : undefined}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              onFocus={() => setSearchFocused(true)}
              onBlur={(e) => {
                // Moving focus into the results (e.g. "Clear") keeps them open.
                if (!resultsRef.current?.contains(e.relatedTarget as Node | null)) setSearchFocused(false);
              }}
              placeholder="Search people, groups, messages"
              aria-label="Search chats, people, groups and messages"
              className="h-full w-full min-w-0 bg-transparent text-[14.5px] text-fg outline-none focus-visible:outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  changeQuery("");
                  searchRef.current?.focus();
                }}
                className="pressable -me-1.5 flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-line hover:text-fg"
              >
                <X className="size-4" strokeWidth={2} />
              </button>
            ) : null}
          </div>
        </div>

        {searching || folders.length > 0 ? (
          <div className="flex items-center gap-1 border-b border-line pb-3 ps-4 pe-2">
            <div role="toolbar" aria-label={searching ? "Search in" : "Chat folders"} className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {searching ? (
                SEARCH_FILTERS.map((o) => (
                  <Chip
                    key={o.key}
                    label={o.label}
                    active={searchFilter === o.key}
                    onClick={() => {
                      setSearchFilter(o.key);
                      setActiveOptionId(null);
                    }}
                  />
                ))
              ) : (
                <>
                  <Chip label="All chats" active={folderId === null} onClick={() => setFolderId(null)} />
                  {folders.map((f) => (
                    <Chip key={f._id} label={f.name} active={folderId === f._id} onClick={() => setFolderId(f._id)} />
                  ))}
                </>
              )}
            </div>
            {!searching ? (
              <Link
                href="/app/settings/folders"
                aria-label="Edit chat folders"
                title="Edit chat folders"
                className="pressable flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-fg"
              >
                <FolderCog className="size-[18px]" strokeWidth={1.8} />
              </Link>
            ) : null}
          </div>
        ) : (
          <div className="border-b border-line" />
        )}
      </div>

      <div ref={resultsRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-24 pt-2 lg:pb-3">
        {searching ? (
          <GlobalSearchResults query={query} filter={searchFilter} listboxId={listboxId} activeId={activeOptionId} />
        ) : showRecent ? (
          <RecentSearches
            listboxId={listboxId}
            activeId={activeOptionId}
            onPickQuery={(q) => {
              changeQuery(q);
              searchRef.current?.focus();
            }}
          />
        ) : isPending || showingFolderLoading ? (
          <SkeletonList count={7} />
        ) : isError || (!!folderId && folderMembersQuery.isError) ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <p className="text-[14.5px] text-fg-2">Your chats didn&apos;t load. Check your connection and try again.</p>
            <Button
              size="sm"
              variant="secondary"
              loading={isRefetching || folderMembersQuery.isRefetching}
              onClick={() => (isError ? refetch() : folderMembersQuery.refetch())}
            >
              Try again
            </Button>
          </div>
        ) : channels.length === 0 ? (
          folderId ? (
            <EmptyState icon={FolderCog} title="No chats in this folder" description="Chats that match this folder's rules will show up here." />
          ) : (
            <EmptyState
              icon={MessageCircle}
              title="No conversations yet"
              description="Message someone from your contacts, or start a group."
              action={{ label: "Start a conversation", onClick: () => router.push("/app/new") }}
            />
          )
        ) : (
          <>
          {/* Pinned chats are the top rows of this same list (Telegram): a barely-tinted
              surface, no box, divider or heading. One gap between the groups, as between rows. */}
          <div className="flex flex-col gap-0.5">
            {pinnedChats.length > 0 ? (
              <>
                <ul aria-label="Pinned chats" className="flex flex-col">
                  {pinnedChats.map((channel, index) => (
                    <li
                      key={channel.channelId}
                      data-pinned-row={channel.channelId}
                      draggable={canReorder}
                      onDragStart={(e) => {
                        if (!canReorder) return;
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", channel.channelId);
                        setDrag({ id: channel.channelId, over: null });
                      }}
                      onDragOver={(e) => {
                        if (!drag) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        const r = e.currentTarget.getBoundingClientRect();
                        const over = e.clientY < r.top + r.height / 2 ? index : index + 1;
                        if (drag.over !== over) setDrag({ ...drag, over });
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!drag || drag.over == null) return;
                        const from = pinnedChats.findIndex((c) => c.channelId === drag.id);
                        // `over` is a gap index; removing the dragged row first shifts later gaps up.
                        movePinnedChat(drag.id, drag.over > from ? drag.over - 1 : drag.over);
                        setDrag(null);
                      }}
                      onDragEnd={() => setDrag(null)}
                      onKeyDown={(e) => {
                        if (!canReorder || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                        e.preventDefault();
                        movePinnedChat(channel.channelId, index + (e.key === "ArrowUp" ? -1 : 1), true);
                      }}
                      className={cn(
                        "relative bg-sunken/50 transition-opacity",
                        drag?.id === channel.channelId && "opacity-50",
                        // Drop indicator: a line in the gap the row would land in.
                        drag && drag.over === index && "before:absolute before:inset-x-3 before:-top-px before:h-0.5 before:rounded-full before:bg-accent",
                        drag && drag.over === index + 1 && index === pinnedChats.length - 1 && "after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent",
                      )}
                    >
                      <ChannelRow
                        channel={channel}
                        selected={channel.channelId === selectedId}
                        onPin={() => pinMutation.mutate(channel)}
                        onMute={() => muteMutation.mutate(channel)}
                        onMoveUp={canReorder && index > 0 ? () => movePinnedChat(channel.channelId, index - 1, true) : undefined}
                        onMoveDown={canReorder && index < pinnedChats.length - 1 ? () => movePinnedChat(channel.channelId, index + 1, true) : undefined}
                      />
                    </li>
                  ))}
                </ul>
                {canReorder ? <span className="sr-only">Pinned chats. Drag, or press Alt and the arrow keys, to reorder.</span> : null}
              </>
            ) : null}
            <span role="status" aria-live="polite" className="sr-only">
              {reorderNotice}
            </span>
            <ul className="flex flex-col gap-0.5" aria-label={pinnedChats.length ? "Other chats" : undefined}>
              {otherChats.map((channel) => (
                <li key={channel.channelId}>{renderRow(channel)}</li>
              ))}
              {data?.nextCursor && !folderId ? (
                <li className="flex flex-col items-center gap-2 px-3 py-3">
                  {loadMoreMutation.isError ? (
                    <p role="alert" className="text-[13px] text-danger">
                      Couldn&apos;t load more chats. Try again.
                    </p>
                  ) : null}
                  <Button size="sm" variant="secondary" loading={loadMoreMutation.isPending} onClick={() => loadMoreMutation.mutate(data.nextCursor!)}>
                    Show older chats
                  </Button>
                </li>
              ) : null}
            </ul>
          </div>
          </>
        )}
      </div>
    </div>
  );
}
