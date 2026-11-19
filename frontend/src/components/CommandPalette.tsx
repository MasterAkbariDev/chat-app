"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "@/hooks/use-app-router";
import { CornerDownLeft, Palette, Search, Settings, SquarePen, SwatchBook, Users, type LucideIcon } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Dialog } from "@/components/ui/Dialog";
import { Spinner } from "@/components/ui/Spinner";
import { Highlight } from "@/components/search/Highlight";
import {
  FIND_BY_USERNAME_HINT,
  chatPhoto,
  isSquareChat,
  mediaSrc,
  memberCountLabel,
  personName,
  useGlobalSearch,
  useLocalChatMatches,
  useSearchActions,
  wantsUsernameHint,
  type MatchMode,
} from "@/hooks/use-global-search";
import { useTheme } from "@/contexts/theme-context";
import { THEME_KEYS, THEMES } from "@/lib/themes";
import { channelDisplayName } from "@/lib/api/types";
import { cn } from "@/lib/cn";

const RECENT_COUNT = 5;
const MATCH_COUNT = 6;
/** Server results per section — the full lists live in the chat list's search. */
const GLOBAL_COUNT = 3;

const GROUPS = ["Chats", "People", "Groups & channels", "Messages", "Actions"] as const;
type Group = (typeof GROUPS)[number];

type Command = {
  id: string;
  group: Group;
  label: string;
  /** Second line (e.g. @username or a message snippet). */
  detail?: string;
  detailMode?: MatchMode;
  hint?: string;
  run: () => void;
} & ({ kind: "chat"; colorId: string; square: boolean; src: string | null } | { kind: "action"; icon: LucideIcon });

function isMacLike() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!open) return null;
  return <PaletteDialog onClose={() => setOpen(false)} />;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [query, setQuery] = useState("");
  // Same data hooks (and cache) as the chat list's global search.
  const search = useGlobalSearch(query);
  const { all: allChats } = useLocalChatMatches([]);
  const actions = useSearchActions(query, onClose);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-list`;
  const mac = isMacLike();

  const commands = useMemo<Command[]>(() => {
    function go(path: string) {
      onClose();
      router.push(path);
    }
    function cycleTheme() {
      const idx = THEME_KEYS.indexOf(theme);
      setTheme(THEME_KEYS[(idx + 1) % THEME_KEYS.length]);
    }
    const q = query.trim().toLowerCase();
    const chats = (q ? search.chats.slice(0, MATCH_COUNT) : allChats.slice(0, RECENT_COUNT)).map(
      (c): Command => ({
        id: `chat-${c.channelId}`,
        group: "Chats",
        kind: "chat",
        colorId: c.channelId,
        square: isSquareChat(c.type),
        src: chatPhoto(c),
        label: channelDisplayName(c) || "Untitled chat",
        run: () => (q ? actions.openChat(c) : go(`/app/c/${c.channelId}`)),
      }),
    );
    const people = search.people.items.slice(0, GLOBAL_COUNT).map(
      (u): Command => ({
        id: `person-${u._id}`,
        group: "People",
        kind: "chat",
        colorId: u._id,
        square: false,
        src: mediaSrc(u.avatarUrl?.[0]),
        label: personName(u),
        detail: `@${u.username}`,
        run: () => actions.openPerson(u),
      }),
    );
    const publicChats = search.channels.items.slice(0, GLOBAL_COUNT).map(
      (c): Command => ({
        id: `public-${c._id}`,
        group: "Groups & channels",
        kind: "chat",
        colorId: c._id,
        square: true,
        src: mediaSrc(c.image?.[0]),
        label: c.name || "Untitled",
        detail: [c.link ? `@${c.link}` : null, memberCountLabel(c.type, c.memberCount)].filter(Boolean).join(" · "),
        hint: c.isMember ? undefined : "Preview",
        run: () => actions.openPublic(c),
      }),
    );
    const messages = search.messages.items.slice(0, GLOBAL_COUNT).map(
      (m): Command => ({
        id: `message-${m._id}`,
        group: "Messages",
        kind: "chat",
        colorId: m.channelId,
        square: !!m.chat && isSquareChat(m.chat.type),
        src: mediaSrc(m.chat?.type === "private" ? m.chat.otherUser?.avatarUrl?.[0] : m.chat?.image?.[0]),
        label: m.chat?.name || (m.chat?.otherUser ? personName(m.chat.otherUser) : "Chat"),
        detail: m.snippet,
        detailMode: "substring",
        run: () => actions.openMessage(m),
      }),
    );
    const paletteActions: Command[] = [
      { id: "new", group: "Actions", kind: "action", icon: SquarePen, label: "Start a new conversation", run: () => go("/app/new") },
      { id: "contacts", group: "Actions", kind: "action", icon: Users, label: "Open contacts", run: () => go("/app/contacts") },
      { id: "settings", group: "Actions", kind: "action", icon: Settings, label: "Open settings", run: () => go("/app/settings") },
      { id: "appearance", group: "Actions", kind: "action", icon: Palette, label: "Appearance settings", run: () => go("/app/settings/appearance") },
      {
        id: "theme",
        group: "Actions",
        kind: "action",
        icon: SwatchBook,
        label: "Switch theme",
        hint: `Now: ${THEMES[theme].label}`,
        run: cycleTheme,
      },
    ];
    const shownActions = paletteActions.filter((a) => !q || a.label.toLowerCase().includes(q));
    // "@username" — people first.
    return search.parsed.isHandle
      ? [...people, ...chats, ...publicChats, ...messages, ...shownActions]
      : [...chats, ...people, ...publicChats, ...messages, ...shownActions];
  }, [allChats, search, actions, query, theme, setTheme, router, onClose]);

  const clampedIndex = commands.length === 0 ? -1 : Math.min(activeIndex, commands.length - 1);
  const active = clampedIndex >= 0 ? commands[clampedIndex] : null;
  const optionId = (cmd: Command) => `${baseId}-${cmd.id}`;

  useEffect(() => {
    if (!active) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (commands.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((clampedIndex + 1) % commands.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((clampedIndex - 1 + commands.length) % commands.length);
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault();
      setActiveIndex(commands.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      active?.run();
    }
  }

  const groupOrder: readonly Group[] = search.parsed.isHandle ? ["People", "Chats", "Groups & channels", "Messages", "Actions"] : GROUPS;
  const groups = groupOrder.map((g) => ({ group: g, items: commands.filter((c) => c.group === g) })).filter((g) => g.items.length > 0);
  const globalLoading =
    search.canSearchGlobally && (search.isDebouncing || search.people.isPending || search.channels.isPending || search.messages.isPending);
  const globalError = search.people.isError || search.channels.isError || search.messages.isError;
  const peopleHint = search.canSearchGlobally && !globalLoading && !globalError && wantsUsernameHint(query, search.people.items.length);
  const terms = search.parsed.terms;

  return (
    <Dialog
      onClose={onClose}
      size="md"
      hideClose
      aria-label="Command palette"
      className="sm:mt-[10vh] sm:max-h-[70vh] sm:self-start"
      bodyClassName="flex flex-col p-0"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 transition-colors focus-within:border-accent">
        <Search className="size-5 shrink-0 text-muted" strokeWidth={1.8} aria-hidden />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(active) : undefined}
          aria-label="Search chats, people, messages and actions"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onInputKeyDown}
          placeholder="Jump to a chat, person or action"
          // The global :focus-visible ring would box the bare input inside
          // the dialog; the row's accent hairline shows focus instead.
          style={{ outline: "none" }}
          className="h-14 min-w-0 flex-1 bg-transparent text-[16px] text-fg outline-none placeholder:text-muted focus-visible:outline-none"
        />
        <kbd className="hidden shrink-0 rounded-[var(--radius-xs)] border border-line bg-sunken px-1.5 py-0.5 font-sans text-[12px] text-muted sm:inline">Esc</kbd>
      </div>

      <div ref={listRef} id={listboxId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups.length === 0 && !globalLoading ? (
          <div className="px-3 py-8 text-center text-[14px] text-muted">
            Nothing matches &ldquo;{query.trim()}&rdquo;. Try a chat name, a person or &ldquo;settings&rdquo;.
            {peopleHint ? <span className="mt-1 block text-[13px]">{FIND_BY_USERNAME_HINT}</span> : null}
          </div>
        ) : (
          groups.map(({ group, items }) => (
            <div key={group} role="group" aria-labelledby={`${baseId}-g-${group}`} className="pb-1">
              <div id={`${baseId}-g-${group}`} role="presentation" className="px-3 pb-1 pt-2.5 text-[12.5px] font-semibold text-muted">
                {group === "Chats" && !query.trim() ? "Recent chats" : group}
              </div>
              {items.map((cmd) => {
                const selected = cmd.id === active?.id;
                return (
                  <div
                    key={cmd.id}
                    id={optionId(cmd)}
                    role="option"
                    aria-selected={selected}
                    onPointerMove={() => {
                      const idx = commands.indexOf(cmd);
                      if (idx !== clampedIndex) setActiveIndex(idx);
                    }}
                    onClick={() => cmd.run()}
                    className={cn(
                      "flex min-h-12 cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-start",
                      selected ? "bg-accent-soft" : "hover:bg-sunken",
                    )}
                  >
                    {cmd.kind === "chat" ? (
                      <Avatar colorId={cmd.colorId} name={cmd.label} src={cmd.src} size={32} shape={cmd.square ? "square" : "circle"} />
                    ) : (
                      <span
                        className={cn(
                          "flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)]",
                          selected ? "bg-raised text-accent-text" : "bg-sunken text-fg-2",
                        )}
                      >
                        <cmd.icon className="size-[18px]" strokeWidth={1.8} aria-hidden />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span
                        dir={cmd.kind === "chat" ? "auto" : undefined}
                        className={cn("block truncate text-start text-[15px]", selected ? "font-semibold text-accent-text" : "font-medium text-fg")}
                      >
                        {cmd.kind === "chat" && cmd.group !== "Messages" ? <Highlight text={cmd.label} terms={terms} /> : cmd.label}
                      </span>
                      {cmd.detail ? (
                        <span dir="auto" className="block truncate text-start text-[13px] text-muted">
                          <Highlight text={cmd.detail} terms={terms} mode={cmd.detailMode} />
                        </span>
                      ) : null}
                    </span>
                    {cmd.hint ? <span className="shrink-0 text-[13px] text-muted">{cmd.hint}</span> : null}
                    {selected ? <CornerDownLeft className="size-4 shrink-0 text-accent-text rtl:-scale-x-100" strokeWidth={1.8} aria-hidden /> : null}
                  </div>
                );
              })}
            </div>
          ))
        )}
        {globalLoading ? (
          <div className="flex items-center gap-2 px-3 py-2.5 text-[13px] text-muted" aria-hidden>
            <Spinner label="Searching" className="size-4" />
            Searching people, groups and messages
          </div>
        ) : peopleHint && groups.length > 0 ? (
          <p className="px-3 py-2.5 text-[13px] text-muted">{FIND_BY_USERNAME_HINT}</p>
        ) : globalError ? (
          <p className="px-3 py-2.5 text-[13px] text-danger">Some results didn&apos;t load. Keep typing or try again in a moment.</p>
        ) : null}
        {actions.error ? (
          <p role="alert" className="px-3 py-2.5 text-[13px] text-danger">
            {actions.error}
          </p>
        ) : null}
      </div>

      <div className="hidden shrink-0 items-center gap-4 border-t border-line px-4 py-2.5 text-[12.5px] text-muted sm:flex">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>Enter</Kbd> to open
        </span>
        <span className="ms-auto flex items-center gap-1.5">
          <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>K</Kbd> opens this anywhere
        </span>
      </div>
    </Dialog>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-[var(--radius-xs)] border border-line bg-sunken px-1.5 font-sans text-[12px] font-medium text-fg-2">
      {children}
    </kbd>
  );
}
