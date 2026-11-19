"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, ChevronRight, Eye, Heart } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Dialog } from "@/components/ui/Dialog";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { SkeletonList } from "@/components/ui/Skeleton";
import { useRealtimeEvent } from "@/hooks/use-realtime-event";
import { getMessageReactions, getSeenBy, messageReactionsKey, messageReadsKey } from "@/lib/api/messages";
import type { ChatKind, MessageReactionList, PublicUser, SeenBy } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { resolveMediaUrl } from "@/lib/media-url";
import { formatReadTime } from "@/lib/read-time";

export type MessageInfoChatKind = ChatKind;

/** Minimal slice of a bubble's data the info row/sheet needs. */
export interface MessageInfoTarget {
  id: string;
  mine: boolean;
  reactions: { emoji: string | null; packItemId: string | null; relativePath: string | null; count: number }[];
}

type Reactor = MessageReactionList["reactions"][number];

function nameOf(u: PublicUser): string {
  return [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.username || "Someone";
}

function reactionKeyOf(r: { emoji: string | null; packItemId: string | null }): string {
  return r.emoji ?? r.packItemId ?? "";
}

/** A reaction's glyph: the pack image (animated as uploaded) or the emoji. */
function Glyph({ r, size = 20 }: { r: { emoji: string | null; relativePath: string | null }; size?: number }) {
  if (r.relativePath) {
    // eslint-disable-next-line @next/next/no-img-element -- backend-hosted pack media, size unknown ahead of time
    return <img src={resolveMediaUrl(r.relativePath)} alt="" className="shrink-0 object-contain" style={{ width: size, height: size }} />;
  }
  return (
    <span className="shrink-0 leading-none" style={{ fontSize: size * 0.9 }}>
      {r.emoji}
    </span>
  );
}

function MiniAvatars({ users }: { users: PublicUser[] }) {
  if (!users.length) return null;
  return (
    <span className="flex shrink-0 -space-x-1.5 rtl:space-x-reverse" aria-hidden>
      {users.slice(0, 3).map((u) => (
        <Avatar key={u._id} colorId={u._id} name={nameOf(u)} src={u.avatarUrl?.[0]} size={22} className="rounded-full ring-2 ring-raised" />
      ))}
    </span>
  );
}

function canListReactions(kind: MessageInfoChatKind | undefined, target: MessageInfoTarget, isAdmin: boolean) {
  return kind !== "channel" || target.mine || isAdmin;
}

/**
 * The "Seen by N" / "Read today at 14:05" / "N reactions" row at the top of a
 * message's action menu (Telegram's context-menu info row). Renders nothing
 * when there's nothing to show. Read data is author-only and never shown in
 * channels; reactions are listed for everyone (channels: admins only).
 */
export function MessageInfoMenuRow({
  target,
  chatKind,
  isAdmin = false,
  onOpen,
}: {
  target: MessageInfoTarget;
  chatKind?: MessageInfoChatKind;
  /** Channel admins may see who reacted. */
  isAdmin?: boolean;
  /** Opens the info sheet (the caller closes the menu first). */
  onOpen: (tab: "seen" | "reactions") => void;
}) {
  const reactionTotal = target.reactions.reduce((n, r) => n + r.count, 0);
  const wantsReads = target.mine && (chatKind === "group" || chatKind === "private");
  const wantsReactions = reactionTotal > 0 && canListReactions(chatKind, target, isAdmin);

  const reads = useQuery({
    queryKey: messageReadsKey(target.id),
    queryFn: () => getSeenBy(target.id),
    enabled: wantsReads,
    staleTime: 5_000,
  });
  const reactors = useQuery({
    queryKey: messageReactionsKey(target.id),
    queryFn: () => getMessageReactions(target.id),
    enabled: wantsReactions && !wantsReads,
    staleTime: 5_000,
  });

  if (!wantsReads && !wantsReactions) return null;

  const rowClass =
    "focus-inset flex min-h-11 w-full items-center gap-2.5 border-b border-line px-3.5 py-2 text-start text-[14px] font-medium text-fg outline-none";

  // Private chat: just the read time, like Telegram ("Read today at 14:05").
  if (wantsReads && chatKind === "private") {
    const r = reads.data?.readers[0];
    const label = reads.isPending
      ? "Checking…"
      : r
        ? r.readAt
          ? `Read ${formatReadTime(r.readAt)}`
          : "Read"
        : "Not read yet";
    const content = (
      <>
        <CheckCheck className={cn("size-[18px] shrink-0", r ? "text-accent-text" : "text-muted")} strokeWidth={1.9} aria-hidden />
        <span className="min-w-0 flex-1 truncate tabular">{label}</span>
        {wantsReactions ? (
          <>
            <span className="flex shrink-0 items-center gap-1 text-[13px] text-fg-2">
              <Heart className="size-3.5" strokeWidth={2} aria-hidden />
              <span className="tabular">{reactionTotal}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted rtl:rotate-180" aria-hidden />
          </>
        ) : null}
      </>
    );
    return wantsReactions ? (
      <button type="button" role="menuitem" onClick={() => onOpen("reactions")} className={cn(rowClass, "hover:bg-sunken focus-visible:bg-sunken")}>
        {content}
      </button>
    ) : (
      <p role="none" className={cn(rowClass, "text-fg-2")}>
        {content}
      </p>
    );
  }

  // Group (author): "Seen by N" with up to three faces, plus a reaction count.
  if (wantsReads) {
    const data = reads.data;
    const total = data?.total ?? 0;
    const label = reads.isPending ? "Checking…" : total === 0 ? "Not seen yet" : `Seen by ${total}`;
    const interactive = total > 0 || wantsReactions;
    const content = (
      <>
        <Eye className="size-[18px] shrink-0 text-fg-2" strokeWidth={1.8} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {wantsReactions ? (
          <span className="flex shrink-0 items-center gap-1 text-[13px] text-fg-2">
            <Heart className="size-3.5" strokeWidth={2} aria-hidden />
            <span className="tabular">{reactionTotal}</span>
          </span>
        ) : null}
        <MiniAvatars users={(data?.readers ?? []).map((r) => r.user)} />
        {interactive ? <ChevronRight className="size-4 shrink-0 text-muted rtl:rotate-180" aria-hidden /> : null}
      </>
    );
    return interactive ? (
      <button
        type="button"
        role="menuitem"
        onClick={() => onOpen(total > 0 ? "seen" : "reactions")}
        className={cn(rowClass, "hover:bg-sunken focus-visible:bg-sunken")}
      >
        {content}
      </button>
    ) : (
      <p role="none" className={cn(rowClass, "text-fg-2")}>
        {content}
      </p>
    );
  }

  // Someone else's message (or a channel post): who reacted.
  return (
    <button type="button" role="menuitem" onClick={() => onOpen("reactions")} className={cn(rowClass, "hover:bg-sunken focus-visible:bg-sunken")}>
      <Heart className="size-[18px] shrink-0 text-fg-2" strokeWidth={1.8} aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {reactionTotal} {reactionTotal === 1 ? "reaction" : "reactions"}
      </span>
      <MiniAvatars users={[...new Map((reactors.data?.reactions ?? []).map((r) => [r.user._id, r.user])).values()]} />
      <ChevronRight className="size-4 shrink-0 text-muted rtl:rotate-180" aria-hidden />
    </button>
  );
}

function PersonRow({ user, subtitle, trailing }: { user: PublicUser; subtitle?: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <li className="flex min-h-14 items-center gap-3 py-1.5">
      <Avatar colorId={user._id} name={nameOf(user)} src={user.avatarUrl?.[0]} size={40} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-fg">{nameOf(user)}</div>
        {subtitle ? <div className="flex items-center gap-1 truncate text-[13px] text-muted">{subtitle}</div> : null}
      </div>
      {trailing}
    </li>
  );
}

function SeenList({ data, reactionsByUser }: { data: SeenBy; reactionsByUser: Map<string, Reactor[]> }) {
  if (data.hidden) {
    return (
      <p className="py-6 text-center text-[14px] text-muted">
        Seen by {data.total}. This group is too large to show who read each message.
      </p>
    );
  }
  if (!data.readers.length) {
    return <p className="py-8 text-center text-[14px] text-muted">Nobody has read this yet.</p>;
  }
  return (
    <>
      <ul aria-label="Seen by">
        {data.readers.map((r) => (
          <PersonRow
            key={r.user._id}
            user={r.user}
            subtitle={
              <>
                <CheckCheck className="size-3.5 shrink-0 text-accent-text" strokeWidth={2} aria-hidden />
                <span className="tabular">{r.readAt ? formatReadTime(r.readAt) : "Seen"}</span>
              </>
            }
            trailing={
              reactionsByUser.get(r.user._id)?.length ? (
                <span className="flex shrink-0 items-center gap-1">
                  {reactionsByUser.get(r.user._id)!.slice(0, 3).map((x) => (
                    <Glyph key={reactionKeyOf(x)} r={x} size={22} />
                  ))}
                </span>
              ) : null
            }
          />
        ))}
      </ul>
      {!data.kept || data.readers.some((r) => !r.readAt) ? (
        <p className="pb-1 pt-3 text-[12.5px] text-muted">Read times are kept for 7 days.</p>
      ) : null}
    </>
  );
}

function ReactionsList({ data, initialFilter }: { data: MessageReactionList; initialFilter?: string }) {
  const [filter, setFilter] = useState<string>(initialFilter ?? "all");
  const groups = useMemo(() => {
    const m = new Map<string, { r: Reactor; count: number }>();
    for (const r of data.reactions) {
      const k = reactionKeyOf(r);
      const g = m.get(k);
      if (g) g.count++;
      else m.set(k, { r, count: 1 });
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [data.reactions]);
  const active = filter !== "all" && !groups.some(([k]) => k === filter) ? "all" : filter;
  const rows = active === "all" ? data.reactions : data.reactions.filter((r) => reactionKeyOf(r) === active);

  if (!data.reactions.length) return <p className="py-8 text-center text-[14px] text-muted">No reactions yet.</p>;

  const chip = (key: string, label: React.ReactNode, count: number, aria: string) => (
    <button
      key={key}
      type="button"
      aria-pressed={active === key}
      aria-label={aria}
      onClick={() => setFilter(key)}
      className={cn(
        "pressable inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold",
        active === key ? "border-transparent bg-accent-soft text-accent-text" : "border-line text-fg-2 hover:border-line-strong hover:text-fg",
      )}
    >
      {label}
      <span className="tabular">{count}</span>
    </button>
  );

  return (
    <>
      <div className="-mx-5 flex gap-1.5 overflow-x-auto px-5 pb-2" role="group" aria-label="Filter reactions">
        {chip("all", "All", data.total, `All reactions, ${data.total}`)}
        {groups.map(([k, g]) => chip(k, <Glyph r={g.r} size={18} />, g.count, `${g.r.emoji ?? "Animated emoji"}, ${g.count}`))}
      </div>
      <ul aria-label="Reactions">
        {rows.map((r) => (
          <PersonRow
            key={`${r.user._id}:${reactionKeyOf(r)}`}
            user={r.user}
            subtitle={<span className="tabular">{formatReadTime(r.reactedAt)}</span>}
            trailing={<Glyph r={r} size={26} />}
          />
        ))}
      </ul>
    </>
  );
}

/**
 * Telegram-style message info: who read it (with when) and who reacted.
 *  - group, own message: "Seen" and "Reactions" tabs
 *  - private, own message: the read time, then reactions
 *  - anyone else / channels: reactions only
 */
export function MessageInfoSheet({
  target,
  chatKind,
  initialTab = "seen",
  initialReaction,
  onClose,
}: {
  target: MessageInfoTarget;
  chatKind?: MessageInfoChatKind;
  initialTab?: "seen" | "reactions";
  /** Open the Reactions list filtered to this reaction (emoji or packItemId). */
  initialReaction?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const wantsReads = target.mine && (chatKind === "group" || chatKind === "private");
  const reads = useQuery({ queryKey: messageReadsKey(target.id), queryFn: () => getSeenBy(target.id), enabled: wantsReads });
  const reactions = useQuery({ queryKey: messageReactionsKey(target.id), queryFn: () => getMessageReactions(target.id) });

  // Live: someone reacts while the sheet is open. (Reads refresh through the
  // conversation's `read:updated` handler, which invalidates every
  // ["messages", "seen-by", …] key.)
  useRealtimeEvent("reaction_changed", (p) => {
    if (p.messageId === target.id) void queryClient.invalidateQueries({ queryKey: messageReactionsKey(target.id) });
  });

  const reactionsByUser = useMemo(() => {
    const m = new Map<string, Reactor[]>();
    for (const r of reactions.data?.reactions ?? []) m.set(r.user._id, [...(m.get(r.user._id) ?? []), r]);
    return m;
  }, [reactions.data]);

  const showTabs = wantsReads && chatKind === "group";
  const [tab, setTab] = useState<"seen" | "reactions">(showTabs ? initialTab : "reactions");
  const reactionCount = reactions.data?.total ?? target.reactions.reduce((n, r) => n + r.count, 0);
  const privateReader = chatKind === "private" ? reads.data?.readers[0] : undefined;

  return (
    <Dialog onClose={onClose} title={wantsReads ? "Message info" : "Reactions"} size="sm" bodyClassName="pt-1">
      {showTabs ? (
        <SegmentedTabs
          aria-label="Show"
          className="mb-2"
          value={tab}
          onChange={setTab}
          options={[
            { key: "seen", label: reads.data ? `Seen ${reads.data.total}` : "Seen" },
            { key: "reactions", label: reactionCount ? `Reactions ${reactionCount}` : "Reactions" },
          ]}
        />
      ) : null}
      {wantsReads && chatKind === "private" ? (
        <p className="mb-2 flex items-center gap-2 rounded-[var(--radius-sm)] bg-sunken px-3 py-2.5 text-[14px] text-fg-2">
          <CheckCheck className={cn("size-4 shrink-0", privateReader ? "text-accent-text" : "text-muted")} strokeWidth={2} aria-hidden />
          <span className="tabular">
            {reads.isPending ? "Checking…" : privateReader ? (privateReader.readAt ? `Read ${formatReadTime(privateReader.readAt)}` : "Read") : "Not read yet"}
          </span>
        </p>
      ) : null}
      <div aria-live="polite">
        {tab === "seen" && showTabs ? (
          reads.data ? (
            <SeenList data={reads.data} reactionsByUser={reactionsByUser} />
          ) : reads.isError ? (
            <p className="py-8 text-center text-[14px] text-muted">Couldn&apos;t load who read this.</p>
          ) : (
            <SkeletonList count={3} />
          )
        ) : reactions.data ? (
          <ReactionsList data={reactions.data} initialFilter={initialReaction} />
        ) : reactions.isError ? (
          <p className="py-8 text-center text-[14px] text-muted">Couldn&apos;t load reactions.</p>
        ) : (
          <SkeletonList count={3} />
        )}
      </div>
    </Dialog>
  );
}
