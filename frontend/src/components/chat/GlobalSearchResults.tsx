"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, RotateCw, SearchX } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { Highlight } from "@/components/search/Highlight";
import { RowText, SearchGroup, SearchOption, optionDomId } from "@/components/search/SearchList";
import { useAuth } from "@/contexts/auth-context";
import {
  FIND_BY_USERNAME_HINT,
  chatPhoto,
  isSquareChat,
  mediaSrc,
  memberCountLabel,
  personName,
  useGlobalSearch,
  useSearchActions,
  wantsUsernameHint,
  type PagedSearch,
  type SearchActions,
  type SearchFilter,
} from "@/hooks/use-global-search";
import { channelDisplayName, type ChannelSearchHit, type ChannelSummary, type MessageSearchHit, type PublicUser } from "@/lib/api/types";

/** How many rows a section shows in "All" before "Show more". */
const PREVIEW_COUNT = 4;

type SectionKey = "chats" | "people" | "channels" | "messages";

const SECTION_TITLE: Record<SectionKey, string> = {
  chats: "Chats",
  people: "People",
  channels: "Public groups & channels",
  messages: "Messages",
};

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Telegram-style global search, shown in place of the chat list: your own
 * chats (instant, local), then people, public groups & channels, and
 * messages from the server (debounced, cached, paged with "Show more").
 * The search input lives in ConversationList and drives this listbox via
 * `aria-activedescendant` (`activeId`). */
export function GlobalSearchResults({
  query,
  filter,
  listboxId,
  activeId,
}: {
  /** The live (un-debounced) text in the search box. */
  query: string;
  filter: SearchFilter;
  listboxId: string;
  activeId: string | null;
}) {
  const search = useGlobalSearch(query, filter);
  const actions = useSearchActions(search.parsed.text);
  const { user: me } = useAuth();
  const terms = search.parsed.terms;
  const serverTerms = search.debounced.terms;

  // Which sections are expanded — reset whenever the query changes.
  const [expandedState, setExpandedState] = useState<{ q: string; keys: Set<SectionKey> }>({ q: "", keys: new Set() });
  const expanded = expandedState.q === search.debounced.apiQuery ? expandedState.keys : new Set<SectionKey>();
  const single = filter !== "all";
  const isOpen = (k: SectionKey) => single || expanded.has(k);
  const toggle = (k: SectionKey) =>
    setExpandedState(() => {
      const keys = new Set(expanded);
      if (keys.has(k)) keys.delete(k);
      else keys.add(k);
      return { q: search.debounced.apiQuery, keys };
    });

  const id = (key: string) => optionDomId(listboxId, key);
  const opt = (key: string) => ({ id: id(key), active: activeId === id(key) });

  const wantsChats = filter === "all" || filter === "chats";
  const order: SectionKey[] = search.parsed.isHandle ? ["people", "chats", "channels", "messages"] : ["chats", "people", "channels", "messages"];
  const visible = order.filter((k) => (k === "chats" ? wantsChats : filter === "all" || filter === k));

  const paged: Record<Exclude<SectionKey, "chats">, PagedSearch<unknown>> = {
    people: search.people,
    channels: search.channels,
    messages: search.messages,
  };

  const tooShort = !search.canSearchGlobally;
  const anyPending = visible.some((k) => (k === "chats" ? search.chatsPending : paged[k].isPending)) || (search.isDebouncing && !tooShort);
  const anyError = visible.some((k) => k !== "chats" && paged[k].isError);
  const counts = visible.map((k) => (k === "chats" ? search.chats.length : paged[k].items.length));
  const total = counts.reduce((a, b) => a + b, 0);
  const moreAvailable = visible.some((k) => k !== "chats" && paged[k].hasNextPage);

  const status = anyPending
    ? "Searching"
    : total === 0
      ? `No results for “${search.parsed.text}”`
      : `${total}${moreAvailable ? "+" : ""} ${total === 1 ? "result" : "results"}`;

  function renderSection(k: SectionKey) {
    if (k === "chats") {
      if (search.chatsPending) return <SectionSkeleton key={k} title={SECTION_TITLE[k]} />;
      const items = search.chats;
      if (items.length === 0) return null;
      const shown = isOpen(k) ? items : items.slice(0, PREVIEW_COUNT);
      return (
        <SearchGroup key={k} id={`${listboxId}-h-${k}`} title={SECTION_TITLE[k]} count={items.length}>
          {shown.map((c) => (
            <ChatOption key={c.channelId} {...opt(`chat-${c.channelId}`)} chat={c} terms={terms} onSelect={() => actions.openChat(c)} />
          ))}
          {!single && items.length > PREVIEW_COUNT ? (
            <MoreOption {...opt(`more-${k}`)} open={isOpen(k)} hiddenCount={items.length - PREVIEW_COUNT} onSelect={() => toggle(k)} />
          ) : null}
        </SearchGroup>
      );
    }

    const page = paged[k];
    if (!page.enabled) return null;
    if (page.isPending) return <SectionSkeleton key={k} title={SECTION_TITLE[k]} square={k === "channels"} />;
    if (page.isError) {
      return (
        <SearchGroup key={k} id={`${listboxId}-h-${k}`} title={SECTION_TITLE[k]}>
          <p className="px-3 pb-1 text-[13.5px] text-danger">
            {page.isThrottled ? "Too many searches in a row. Wait a moment, then try again." : `${SECTION_TITLE[k]} didn't load. Check your connection.`}
          </p>
          <SearchOption {...opt(`retry-${k}`)} onSelect={page.retry} className="min-h-11 text-[14px] font-semibold text-accent-text">
            <RotateCw className="size-4 shrink-0" strokeWidth={2} aria-hidden />
            Try again
          </SearchOption>
        </SearchGroup>
      );
    }
    if (page.items.length === 0) return null;

    const open = isOpen(k);
    const shownCount = open ? page.items.length : PREVIEW_COUNT;
    const rows =
      k === "people"
        ? search.people.items.slice(0, shownCount).map((u) => (
            <PersonOption key={u._id} {...opt(`person-${u._id}`)} user={u} terms={serverTerms} pending={actions.pendingId === u._id} onSelect={() => actions.openPerson(u)} />
          ))
        : k === "channels"
          ? search.channels.items.slice(0, shownCount).map((c) => (
              <PublicChatOption key={c._id} {...opt(`public-${c._id}`)} hit={c} terms={serverTerms} actions={actions} />
            ))
          : search.messages.items.slice(0, shownCount).map((m) => (
              <MessageOption key={m._id} {...opt(`message-${m._id}`)} hit={m} terms={serverTerms} myId={me?._id} onSelect={() => actions.openMessage(m)} />
            ));

    const hidden = page.items.length - PREVIEW_COUNT;
    return (
      <SearchGroup key={k} id={`${listboxId}-h-${k}`} title={SECTION_TITLE[k]} count={`${page.items.length}${page.hasNextPage ? "+" : ""}`}>
        <div className={page.isStale ? "opacity-60 transition-opacity" : undefined}>{rows}</div>
        {!open && (hidden > 0 || page.hasNextPage) ? (
          <MoreOption {...opt(`more-${k}`)} open={false} hiddenCount={hidden > 0 ? hidden : undefined} onSelect={() => toggle(k)} />
        ) : open && page.hasNextPage ? (
          <SearchOption {...opt(`load-${k}`)} disabled={page.isFetchingNextPage} onSelect={page.fetchNextPage} className="min-h-11 justify-center text-[14px] font-semibold text-accent-text">
            {page.isFetchingNextPage ? <Spinner label="Loading more" className="size-4 text-accent-text" /> : <ChevronDown className="size-4" strokeWidth={2} aria-hidden />}
            {page.isFetchingNextPage ? "Loading more" : "Load more"}
          </SearchOption>
        ) : open && !single && page.items.length > PREVIEW_COUNT ? (
          <MoreOption {...opt(`more-${k}`)} open onSelect={() => toggle(k)} />
        ) : null}
      </SearchGroup>
    );
  }

  const sections = visible.map(renderSection).filter(Boolean);
  const showEmpty = !anyPending && !anyError && total === 0;
  // Names only match people you already know — say how to reach a stranger.
  const peopleHint =
    (filter === "all" || filter === "people") &&
    !tooShort &&
    !anyPending &&
    !search.people.isError &&
    wantsUsernameHint(search.parsed.text, search.people.items.length);

  return (
    <div>
      <div role="status" aria-live="polite" className="sr-only">
        {status}
      </div>

      {actions.error ? (
        <p role="alert" className="mx-3 mb-1 mt-2 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
          {actions.error}
        </p>
      ) : null}

      <div id={listboxId} role="listbox" aria-label="Search results" onMouseDown={(e) => e.preventDefault()}>
        {sections}
      </div>

      {showEmpty ? (
        <div className="fade-in flex flex-col items-center px-6 py-10 text-center">
          <SearchX className="mb-2 size-6 text-muted" strokeWidth={1.8} aria-hidden />
          <p dir="auto" className="text-[15px] font-semibold text-fg">
            No results for “{search.parsed.text}”
          </p>
          <p className="mt-1 text-[13.5px] text-muted">
            {tooShort && filter !== "chats"
              ? "Type at least 2 letters to search people, groups and messages."
              : peopleHint
                ? FIND_BY_USERNAME_HINT
                : filter === "all"
                ? "Check the spelling, or try a shorter word."
                : "Check the spelling, or search everything with “All”."}
          </p>
        </div>
      ) : peopleHint ? (
        <p className="px-3 py-3 text-center text-[13px] text-muted">{FIND_BY_USERNAME_HINT}</p>
      ) : tooShort && filter === "all" && total > 0 ? (
        <p className="px-3 py-3 text-center text-[13px] text-muted">Type one more letter to search people, groups and messages.</p>
      ) : null}
    </div>
  );
}

function SectionSkeleton({ title, square }: { title: string; square?: boolean }) {
  return (
    <div aria-hidden className="pb-1">
      <div className="px-3 pb-1 pt-3 text-[13px] font-semibold text-muted">{title}</div>
      <SkeletonRow className={square ? "[&>*:first-child]:rounded-[30%]" : undefined} />
      <SkeletonRow className={square ? "[&>*:first-child]:rounded-[30%]" : undefined} />
    </div>
  );
}

function MoreOption({ id, active, open, hiddenCount, onSelect }: { id: string; active: boolean; open: boolean; hiddenCount?: number; onSelect: () => void }) {
  return (
    <SearchOption id={id} active={active} onSelect={onSelect} className="min-h-11 justify-center text-[14px] font-semibold text-accent-text">
      {open ? <ChevronUp className="size-4" strokeWidth={2} aria-hidden /> : <ChevronDown className="size-4" strokeWidth={2} aria-hidden />}
      {open ? "Show less" : hiddenCount ? `Show ${hiddenCount} more` : "Show more"}
    </SearchOption>
  );
}

type OptionBase = { id: string; active: boolean };

function ChatOption({ id, active, chat, terms, onSelect }: OptionBase & { chat: ChannelSummary; terms: string[]; onSelect: () => void }) {
  const title = channelDisplayName(chat) || "Untitled chat";
  const square = isSquareChat(chat.type);
  const meta =
    chat.type === "private"
      ? chat.otherUser
        ? `@${chat.otherUser.username}`
        : ""
      : [chat.isPublic && chat.link ? `@${chat.link}` : null, memberCountLabel(chat.type, chat.memberCount)].filter(Boolean).join(" · ");
  // Only DM usernames and public @links take part in matching.
  const metaTerms = chat.type === "private" || chat.isPublic ? terms : [];
  return (
    <SearchOption id={id} active={active} onSelect={onSelect}>
      <Avatar colorId={chat.channelId} name={title} src={chatPhoto(chat)} size={44} shape={square ? "square" : "circle"} />
      <RowText title={<Highlight text={title} terms={terms} />} subtitle={meta ? <Highlight text={meta} terms={metaTerms} /> : null} />
    </SearchOption>
  );
}

function PersonOption({ id, active, user, terms, pending, onSelect }: OptionBase & { user: PublicUser; terms: string[]; pending: boolean; onSelect: () => void }) {
  const name = personName(user);
  return (
    <SearchOption id={id} active={active} disabled={pending} onSelect={onSelect}>
      <Avatar colorId={user._id} name={name} src={mediaSrc(user.avatarUrl?.[0])} size={44} />
      <RowText title={<Highlight text={name} terms={terms} />} subtitle={<Highlight text={`@${user.username}`} terms={terms} />} />
      {pending ? <Spinner label="Opening chat" className="size-4" /> : null}
    </SearchOption>
  );
}

/** Shift+Enter in the search box joins the active row (ConversationList
 *  clicks the `[data-search-join]` button inside it). */
export const SEARCH_JOIN_SHORTCUT = "Shift+Enter";

function PublicChatOption({ id, active, hit, terms, actions }: OptionBase & { hit: ChannelSearchHit; terms: string[]; actions: SearchActions }) {
  const name = hit.name || "Untitled";
  const pending = actions.pendingId === hit._id;
  const meta = [hit.link ? `@${hit.link}` : null, memberCountLabel(hit.type, hit.memberCount)].filter(Boolean).join(" · ");
  const kind = hit.type === "channel" ? "channel" : "group";
  return (
    <SearchOption
      id={id}
      active={active}
      onSelect={() => actions.openPublic(hit)}
      // The row is an option the search box points at (it never gets focus),
      // so the join shortcut is part of its name: Enter opens, Shift+Enter joins.
      label={`${name}, ${kind}${meta ? `, ${meta}` : ""}${hit.isMember ? ", joined" : `. Press ${SEARCH_JOIN_SHORTCUT} to join`}`}
    >
      <Avatar colorId={hit._id} name={name} src={mediaSrc(hit.image?.[0])} size={44} shape="square" />
      <RowText title={<Highlight text={name} terms={terms} />} subtitle={<Highlight text={meta} terms={terms} />} />
      {hit.isMember ? null : (
        <>
          {active ? (
            <span aria-hidden className="hidden shrink-0 items-center gap-1 text-[12px] text-muted pointer-fine:inline-flex">
              <kbd className="rounded-[6px] border border-line bg-raised px-1.5 py-0.5 font-sans text-[11.5px] font-semibold text-fg-2">Shift</kbd>
              <span>+</span>
              <kbd className="rounded-[6px] border border-line bg-raised px-1.5 py-0.5 font-sans text-[11.5px] font-semibold text-fg-2">Enter</kbd>
            </span>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            // Inside a listbox option, which the search box drives with
            // aria-activedescendant: keyboard users join with Shift+Enter
            // instead of tabbing here.
            tabIndex={-1}
            data-search-join=""
            aria-keyshortcuts={SEARCH_JOIN_SHORTCUT}
            loading={pending}
            aria-label={`Join ${name}`}
            className="h-10 shrink-0 rounded-full px-4"
            onClick={(e) => {
              e.stopPropagation();
              actions.join(hit);
            }}
          >
            Join
          </Button>
        </>
      )}
    </SearchOption>
  );
}

function MessageOption({ id, active, hit, terms, myId, onSelect }: OptionBase & { hit: MessageSearchHit; terms: string[]; myId?: string; onSelect: () => void }) {
  const chat = hit.chat;
  const dm = chat?.type === "private";
  const chatName = chat?.name || (chat?.otherUser ? personName(chat.otherUser) : "Chat");
  const photo = mediaSrc(dm ? chat?.otherUser?.avatarUrl?.[0] : chat?.image?.[0]);
  const sender = chat?.type === "group" && hit.senderName ? (hit.senderId && hit.senderId === myId ? "You" : hit.senderName) : null;
  return (
    <SearchOption id={id} active={active} onSelect={onSelect} className="items-start py-2.5">
      <Avatar colorId={hit.channelId} name={chatName} src={photo} size={44} shape={chat && isSquareChat(chat.type) ? "square" : "circle"} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span dir="auto" className="min-w-0 flex-1 truncate text-start text-[15px] font-semibold text-fg">
            {chatName}
          </span>
          <time dateTime={hit.createdAt} className="tabular shrink-0 text-[12.5px] text-muted">
            {formatWhen(hit.createdAt)}
          </time>
        </span>
        <span dir="auto" className="line-clamp-2 text-start text-[13.5px] leading-snug text-fg-2">
          {sender ? <span className="font-semibold text-fg">{sender}: </span> : null}
          <Highlight text={hit.snippet} terms={terms} mode="substring" />
        </span>
      </span>
    </SearchOption>
  );
}
