"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, MessagesSquare, Search, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { getChannelsMine } from "@/lib/api/chats";
import { cn } from "@/lib/cn";
import { channelDisplayName, type ChannelSummary, type ChatKind } from "@/lib/api/types";

/** Loops `GET /v1/channels/mine`'s cursor pagination to build the full list
 * client-side — the chat-list's own cache only ever holds the first page,
 * and a folder picker needs every chat the user is in, not just the first
 * 30. Capped at 500 as a sanity bound, not a real limit anyone should hit. */
async function fetchAllChannels(): Promise<ChannelSummary[]> {
  const items: ChannelSummary[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await getChannelsMine({ cursor });
    items.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return items;
}

const KIND_LABEL: Record<ChatKind, string> = {
  private: "Private chat",
  group: "Group",
  channel: "Channel",
  saved_messages: "Saved messages",
};

export interface ChannelPickerDialogProps {
  title: string;
  /** Already-selected ids, pre-checked when the dialog opens. */
  initialSelectedIds: string[];
  onClose: () => void;
  onConfirm: (ids: string[]) => void;
}

// Modeled on AddMembersDialog's search-and-multi-select shape, but backed by
// the user's own joined chats (getChannelsMine) instead of a people search —
// these are pre-existing chats to pin in/out of a folder, not new contacts.
export function ChannelPickerDialog({ title, initialSelectedIds, onClose, onConfirm }: ChannelPickerDialogProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelectedIds));

  const channelsQuery = useQuery({ queryKey: ["channels", "mine", "all"], queryFn: fetchAllChannels });
  const channels = useMemo(() => channelsQuery.data ?? [], [channelsQuery.data]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter((c) => channelDisplayName(c).toLowerCase().includes(q));
  }, [channels, query]);

  const selectedChannels = channels.filter((c) => selected.has(c.channelId));

  function toggle(channelId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  }

  return (
    <Dialog
      onClose={onClose}
      title={title}
      className="h-[85dvh] sm:h-[min(640px,85dvh)]"
      bodyClassName="flex flex-col gap-3 p-0"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(Array.from(selected))}>
            {selected.size === 0 ? "Save selection" : `Save ${selected.size} ${selected.size === 1 ? "chat" : "chats"}`}
          </Button>
        </>
      }
    >
      <div className="sticky top-0 z-10 flex flex-col gap-3 border-b border-line bg-raised px-5 pb-3 pt-1">
        <div className="relative">
          <Search className="pointer-events-none absolute inset-y-0 start-3.5 my-auto size-[18px] text-muted" strokeWidth={1.8} aria-hidden />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your chats"
            aria-label="Search your chats"
            autoComplete="off"
            className="ps-10"
            autoFocus
          />
        </div>

        {selectedChannels.length > 0 ? (
          <div className="flex max-h-[76px] flex-wrap gap-1.5 overflow-y-auto" aria-label="Selected chats">
            {selectedChannels.map((c) => {
              const name = channelDisplayName(c);
              return (
                <button
                  key={c.channelId}
                  type="button"
                  onClick={() => toggle(c.channelId)}
                  aria-label={`Remove ${name}`}
                  className="pressable inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-accent-soft pe-2.5 ps-1 text-[13px] font-semibold text-accent-text hover:brightness-[0.97]"
                >
                  <Avatar colorId={c.channelId} name={name} size={24} shape={c.type === "group" || c.type === "channel" ? "square" : "circle"} />
                  <span className="truncate">{name}</span>
                  <X className="size-3.5 shrink-0" strokeWidth={2} aria-hidden />
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="px-2 pb-2">
        {channelsQuery.isPending ? (
          <div role="status" aria-label="Loading your chats" className="flex flex-col">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2.5" aria-hidden>
                <Skeleton className="size-11 shrink-0 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-3 w-2/5" />
                  <Skeleton className="h-2.5 w-1/4" />
                </div>
              </div>
            ))}
          </div>
        ) : channelsQuery.isError ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <p className="text-[14px] text-danger">Couldn&apos;t load your chats.</p>
            <Button size="sm" variant="secondary" onClick={() => channelsQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-muted">
            <MessagesSquare className="size-6" strokeWidth={1.8} aria-hidden />
            <p className="text-[14px]">{query.trim() ? `No chats match “${query.trim()}”.` : "You're not in any chats yet."}</p>
          </div>
        ) : (
          <ul className="flex flex-col">
            {results.map((c) => {
              const isSelected = selected.has(c.channelId);
              const name = channelDisplayName(c);
              return (
                <li key={c.channelId}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    onClick={() => toggle(c.channelId)}
                    className={cn(
                      "focus-inset flex min-h-[60px] w-full items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-start transition-colors duration-[var(--dur-fast)]",
                      isSelected ? "bg-accent-soft/60 hover:bg-accent-soft" : "hover:bg-sunken",
                    )}
                  >
                    <Avatar colorId={c.channelId} name={name} size={44} shape={c.type === "group" || c.type === "channel" ? "square" : "circle"} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-fg">{name}</span>
                      <span className="block truncate text-[13px] text-muted">{KIND_LABEL[c.type] ?? c.type}</span>
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-[7px] border-2 transition-colors duration-[var(--dur-fast)]",
                        isSelected ? "border-accent bg-accent text-accent-fg" : "border-line-strong",
                      )}
                    >
                      {isSelected ? <Check className="size-3.5" strokeWidth={3} /> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
