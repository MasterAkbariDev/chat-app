"use client";

import Link from "next/link";
import { useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@/hooks/use-app-router";
import { ArrowDown, ArrowUp, BellOff, Check, CheckCheck, Info, MoreHorizontal, Pin, PinOff, Bell } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Menu, useLongPress, useMenuState, type MenuItem } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import { CHANNELS_QUERY_KEY, getChannelsMine } from "@/lib/api/chats";
import { messagesQueryOptions } from "@/lib/messages-query";
import { useChatHasVoiceChat, VoiceChatBadge } from "@/components/calls/GroupCallBar";
import type { ChannelSummary, ChannelsPage } from "@/lib/api/types";

/** The photo to show for a chat: the group/channel's own image, or the
 *  other person's profile photo for a DM. */
export function chatPhotoOf(c: Pick<ChannelSummary, "image" | "otherUser" | "type">): string | null {
  if (c.type === "private") return c.otherUser?.avatarUrl?.[0] ?? null;
  return c.image?.[0] ?? null;
}

/** Reads a chat's photo straight from the shared GET /v1/channels/mine cache
 *  (never fetches on its own — `enabled: false` only subscribes), so a row or
 *  header updates live when the list refetches after a photo change. */
export function useChatPhoto(channelId: string): string | null {
  const { data } = useQuery({
    queryKey: CHANNELS_QUERY_KEY,
    queryFn: () => getChannelsMine(),
    enabled: false,
    select: (page: ChannelsPage) => {
      const c = page.items.find((item) => item.channelId === channelId);
      return c ? chatPhotoOf(c) : null;
    },
  });
  return data ?? null;
}

/** The other person's looping profile video in a DM, from the same cache as `useChatPhoto`. */
export function useChatAvatarVideo(channelId: string): string | null {
  const { data } = useQuery({
    queryKey: CHANNELS_QUERY_KEY,
    queryFn: () => getChannelsMine(),
    enabled: false,
    select: (page: ChannelsPage) => {
      const c = page.items.find((item) => item.channelId === channelId);
      return c?.type === "private" ? (c.otherUser?.avatarVideoUrl ?? null) : null;
    },
  });
  return data ?? null;
}

export interface ConversationRowData {
  id: string;
  title: string;
  kind: "private" | "group" | "channel" | "saved_messages";
  online: boolean;
  pinned: boolean;
  muted: boolean;
  lastMessagePreview: string;
  lastMessageAt: string;
  /** Machine-readable timestamp for <time dateTime>. */
  lastMessageIso?: string | null;
  unreadCount?: number;
  unreadMention?: boolean;
  /** Set when the backend only knows "has unread", not a count (no
   * unread-count endpoint exists per row) — renders as a plain dot rather
   * than a number, so it never implies precision this data doesn't have. */
  hasUnread?: boolean;
  /** The last message is yours: a read tick (sent, or read by your partner in a direct chat). */
  lastMessageMine?: boolean;
  lastMessageRead?: boolean | null;
  /** Photo URL (group/channel image, or the other person's photo for a DM).
   *  When omitted it's looked up from the channels cache by `id`. */
  avatarSrc?: string | null;
}

export interface ConversationRowProps {
  channel: ConversationRowData;
  selected?: boolean;
  onPin?: () => void;
  onMute?: () => void;
  /** Pinned chats: move within the pinned group (menu items; touch and keyboard
   *  equivalents of drag-to-reorder). Omitted at either end. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

/** One chat in the list. The whole row is a real link (keyboard, middle-
 * click and "open in new tab" all work); per-chat actions live in a menu
 * reachable three ways — the ⋯ button (hover/focus), right-click, or a
 * long-press on touch — rather than a swipe gesture that had no keyboard
 * or mouse equivalent. */
export function ConversationRow({ channel, selected, onPin, onMute, onMoveUp, onMoveDown }: ConversationRowProps) {
  const router = useRouter();
  const menu = useMenuState();
  const longPress = useLongPress((x, y) => menu.openAt(x, y));
  const unread = !!(channel.unreadCount || channel.hasUnread);
  // Any unread indicator (count, @, or dot) — the pin glyph only shows when there is none.
  const badge = !!(channel.unreadCount || channel.unreadMention || channel.hasUnread);
  const isGroup = channel.kind === "group" || channel.kind === "channel";
  const cachedPhoto = useChatPhoto(channel.id);
  const photo = channel.avatarSrc !== undefined ? channel.avatarSrc : cachedPhoto;
  const prefetch = usePrefetchMessages(channel.id);
  const voiceChat = useChatHasVoiceChat(channel.id);

  const items: MenuItem[] = [
    { key: "pin", label: channel.pinned ? "Unpin" : "Pin to top", icon: channel.pinned ? PinOff : Pin, onSelect: () => onPin?.() },
    ...(onMoveUp ? [{ key: "move-up", label: "Move up", icon: ArrowUp, onSelect: onMoveUp }] : []),
    ...(onMoveDown ? [{ key: "move-down", label: "Move down", icon: ArrowDown, onSelect: onMoveDown }] : []),
    { key: "mute", label: channel.muted ? "Unmute" : "Mute notifications", icon: channel.muted ? Bell : BellOff, onSelect: () => onMute?.() },
    { key: "sep", separator: true },
    { key: "info", label: "View info", icon: Info, onSelect: () => router.push(`/app/c/${channel.id}/info`) },
  ];

  const status = [voiceChat && "voice chat live", channel.pinned && "pinned", channel.muted && "muted", unread && "unread"].filter(Boolean).join(", ");

  return (
    <div className="group relative">
      <Link
        href={`/app/c/${channel.id}`}
        aria-current={selected ? "page" : undefined}
        // A reorderable (pinned) row is dragged by its list item, not as a link.
        draggable={onMoveUp || onMoveDown ? false : undefined}
        aria-label={`${channel.title}${status ? ` (${status})` : ""}. ${channel.lastMessagePreview}. ${channel.lastMessageAt}`}
        onContextMenu={(e) => {
          e.preventDefault();
          menu.openAt(e.clientX, e.clientY);
        }}
        onClick={(e) => {
          if (longPress.firedRef.current) e.preventDefault();
        }}
        {...longPress.handlers}
        onPointerDown={(e) => {
          prefetch.now();
          longPress.handlers.onPointerDown(e);
        }}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") prefetch.soon();
        }}
        onPointerLeave={prefetch.cancel}
        onFocus={prefetch.soon}
        onBlur={prefetch.cancel}
        className={cn(
          "focus-inset flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 transition-colors duration-[var(--dur-fast)] [-webkit-touch-callout:none]",
          selected ? "bg-accent-soft" : "hover:bg-sunken",
        )}
      >
        <span className="relative shrink-0">
          <Avatar colorId={channel.id} name={channel.title} src={photo} size={48} shape={isGroup ? "square" : "circle"} presence={channel.online ? "online" : "none"} />
          {voiceChat ? <VoiceChatBadge /> : null}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {/* dir="auto": names/previews are user text, often Persian — an
                RTL string in the LTR row otherwise mis-orders its punctuation,
                and truncation clipped the *start* of the text, not its end. */}
            <span dir="auto" className={cn("min-w-0 flex-1 truncate text-start text-[15px] text-fg", unread ? "font-bold" : "font-semibold")}>
              {channel.title}
            </span>
            {/* Only hidden where the ⋯ button exists (lg+) and is shown in
                its place; below lg there's no button, and a keyboard-
                focused row used to just lose its timestamp. The pin sits
                after the time (Telegram) and yields to any unread badge. */}
            <span className="flex shrink-0 items-center gap-1 transition-opacity lg:group-focus-within:opacity-0 lg:group-hover:opacity-0">
              <time
                dateTime={channel.lastMessageIso ?? undefined}
                className={cn("tabular text-[12.5px]", unread && !channel.muted ? "font-semibold text-accent-text" : "text-muted")}
              >
                {channel.lastMessageAt}
              </time>
              {channel.pinned && !badge ? <Pin className="size-[13px] rotate-45 text-muted" strokeWidth={2} aria-hidden /> : null}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            {channel.lastMessageMine && channel.lastMessageAt ? <ReadTick read={!!channel.lastMessageRead} /> : null}
            <span dir="auto" className={cn("min-w-0 flex-1 truncate text-start text-[14px]", unread ? "text-fg-2" : "text-muted")}>
              {channel.lastMessagePreview}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-muted">
              {channel.muted ? <BellOff className="size-[15px]" strokeWidth={1.8} aria-hidden /> : null}
              {channel.unreadCount ? (
                <span className={cn("tabular flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[12px] font-bold", channel.muted ? "bg-line-strong text-fg" : "bg-accent text-accent-fg")}>
                  {channel.unreadCount}
                </span>
              ) : channel.unreadMention ? (
                <span className="flex size-5 items-center justify-center rounded-full bg-accent text-[12px] font-bold text-accent-fg">@</span>
              ) : channel.hasUnread ? (
                <span className={cn("size-2.5 rounded-full", channel.muted ? "bg-line-strong" : "bg-accent")} aria-hidden />
              ) : null}
            </span>
          </div>
        </div>
      </Link>

      <button
        type="button"
        aria-label={`More actions for ${channel.title}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={(e) => menu.openFrom(e.currentTarget)}
        className={cn(
          "pressable absolute end-2.5 top-2.5 hidden size-8 items-center justify-center rounded-full bg-raised text-fg-2 shadow-sm lg:flex",
          // Also revealed while the row's link has focus — the timestamp
          // hides on focus-within, so keyboard users otherwise saw a blank
          // corner with no hint the actions button is the next Tab stop.
          "opacity-0 hover:text-fg focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100",
          menu.open && "opacity-100",
        )}
      >
        <MoreHorizontal className="size-[18px]" strokeWidth={2} />
      </button>

      {menu.anchor ? <Menu anchor={menu.anchor} items={items} onClose={menu.close} aria-label={`Actions for ${channel.title}`} /> : null}
    </div>
  );
}

/** Warms a chat's first page of messages before it's opened: right away on
 * press (the click lands ~100–300 ms later), or after a short hover / focus
 * dwell so sweeping the pointer down the list doesn't fire a request per row.
 * `prefetchQuery` is a no-op while the cache is still fresh (staleTime), and
 * uses the conversation's own key/fn, so the page it lands is the one it
 * would have fetched. */
function usePrefetchMessages(channelId: string) {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancel() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }
  function now() {
    cancel();
    void queryClient.prefetchQuery(messagesQueryOptions(channelId));
  }
  function soon() {
    cancel();
    timer.current = setTimeout(now, 150);
  }
  return { now, soon, cancel };
}

/** Your last message's state: one tick when sent, two when your partner has read it (direct chats). */
function ReadTick({ read }: { read: boolean }) {
  const Icon = read ? CheckCheck : Check;
  return <Icon className={cn("size-[16px] shrink-0", read ? "text-accent-text" : "text-muted")} strokeWidth={2.2} role="img" aria-label={read ? "Read" : "Sent"} />;
}
