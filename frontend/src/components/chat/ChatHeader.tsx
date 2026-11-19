"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@/hooks/use-app-router";
import { ArrowLeft, CalendarSearch, ImageIcon, Info, MoreVertical, Paperclip, Phone, Search } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { useChatAvatarVideo, useChatPhoto } from "@/components/chat/ConversationRow";
import { LoopVideo } from "@/components/media/LoopVideo";
import { DatePicker } from "@/components/ui/DatePicker";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, useMenuState, type MenuItem } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import { getFirstMessageFromDate } from "@/lib/api/messages";
import { formatYmd, todayYmd, toYmd } from "@/lib/calendar";

export interface ChatHeaderData {
  id: string;
  title: string;
  kind?: "private" | "group" | "channel" | "saved_messages";
  /** Only meaningful for a private DM — omit for group/channel. */
  presence?: "online" | "offline" | "none";
  /** Photo URL; when omitted it's read from the channels cache by `id`. */
  avatarSrc?: string | null;
}

export function ChatHeader({
  channel,
  subtitle,
  typing,
  onOpenSearch,
  onPickDate,
  onStartCall,
  callBlockedReason,
  onAttach,
  showAttachHint,
}: {
  channel: ChatHeaderData;
  subtitle: string;
  /** Subtitle is a live "… is typing" line — rendered in accent with dots. */
  typing?: boolean;
  onOpenSearch?: () => void;
  /** Jump to the first message on/after this date (`YYYY-MM-DD`). */
  onPickDate?: (date: string) => void;
  onStartCall?: () => void;
  /** Set when you may not call them (their "Calls" privacy): the button stays
   *  visible but inert, with this as its tooltip — like Telegram. */
  callBlockedReason?: string;
  /** Opens the composer's attach options (the ⋯ menu's Attach item). */
  onAttach?: (anchor: HTMLElement | null) => void;
  /** Shows a small paperclip under the ⋯ button while you're typing (attach moved here). */
  showAttachHint?: boolean;
}) {
  const router = useRouter();
  const menu = useMenuState();
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  // The picker opens from a menu item that's gone by the time it closes, so
  // Dialog can't hand focus back to it — return it to the ⋯ button instead.
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  function closeDatePicker() {
    setDatePickerOpen(false);
    requestAnimationFrame(() => moreButtonRef.current?.focus({ preventScroll: true }));
  }
  // The chat's first message (the earliest message on/after the epoch), so the
  // picker can dim the days before it. One small indexed lookup, only once
  // the picker is opened; the date is local, like the picker's.
  const firstMessageQuery = useQuery({
    queryKey: ["messages", "first-date", channel.id],
    queryFn: () => getFirstMessageFromDate(channel.id, "1970-01-01"),
    enabled: datePickerOpen,
    staleTime: 10 * 60_000,
  });
  const firstMessageAt = firstMessageQuery.data?.createdAt;
  const firstMessageDay = firstMessageAt ? formatYmd(toYmd(new Date(firstMessageAt))) : null;
  const infoHref = `/app/c/${channel.id}/info`;
  const isGroup = channel.kind === "group" || channel.kind === "channel";
  const cachedPhoto = useChatPhoto(channel.id);
  const photo = channel.avatarSrc !== undefined ? channel.avatarSrc : cachedPhoto;
  // A DM partner whose main photo is a video: loop it (LoopVideo pauses it off
  // screen and falls back to the still in Lite mode / Reduce motion / "off").
  const video = useChatAvatarVideo(channel.id);

  const overflow: MenuItem[] = [
    ...(onAttach ? [{ key: "attach", label: "Attach photo, video or file", icon: Paperclip, onSelect: () => onAttach(moreButtonRef.current) }] : []),
    { key: "date", label: "Jump to date", icon: CalendarSearch, onSelect: () => setDatePickerOpen(true) },
    {
      key: "info",
      label: channel.kind === "channel" ? "Channel info" : channel.kind === "group" ? "Group info" : channel.kind === "saved_messages" ? "Chat info" : "Contact info",
      icon: Info,
      onSelect: () => router.push(infoHref),
    },
    // Same rule as Chat info's Wallpaper action: DMs and groups, not channels.
    ...(channel.kind === "private" || channel.kind === "group"
      ? [{ key: "wallpaper", label: "Change wallpaper", icon: ImageIcon, onSelect: () => router.push(`/app/settings/wallpaper?chat=${channel.id}`) }]
      : []),
  ];

  return (
    <header className="safe-top relative z-20 shrink-0 border-b border-line bg-panel">
      <div className="flex h-[var(--header-h)] items-center gap-1 px-2 lg:px-4">
        <Link
          href="/app"
          aria-label="Back to chats"
          title="Back to chats"
          className="pressable flex size-10 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-sunken hover:text-fg lg:hidden"
        >
          <ArrowLeft className="size-[22px] rtl:rotate-180" strokeWidth={2} />
        </Link>

        <Link
          href={infoHref}
          aria-label={`${channel.title}, ${subtitle || "view info"}`}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-md)] px-1.5 py-1 transition-colors hover:bg-sunken"
        >
          <Avatar
            colorId={channel.id}
            name={channel.title}
            src={photo}
            size={40}
            shape={isGroup ? "square" : "circle"}
            presence={channel.presence}
            media={video && !isGroup ? <LoopVideo src={video} poster={photo} /> : undefined}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[16px] font-bold leading-tight text-fg">
              <bdi>{channel.title}</bdi>
            </div>
            <div aria-live="polite" className={cn("flex h-[18px] items-center gap-1 truncate text-[13px]", typing ? "font-medium text-accent-text" : channel.presence === "online" ? "text-success" : "text-muted")}>
              {typing ? <TypingDots /> : null}
              <span className="truncate">{subtitle}</span>
            </div>
          </div>
        </Link>

        <div className="flex shrink-0 items-center gap-0.5">
          {onStartCall ? (
            <IconButton
              aria-label={callBlockedReason ?? "Start a call"}
              aria-disabled={callBlockedReason ? true : undefined}
              className={callBlockedReason ? "cursor-not-allowed opacity-40 hover:bg-transparent" : undefined}
              onClick={callBlockedReason ? undefined : onStartCall}
            >
              <Phone strokeWidth={1.8} />
            </IconButton>
          ) : null}
          <IconButton aria-label="Search in this chat" onClick={onOpenSearch}>
            <Search strokeWidth={1.8} />
          </IconButton>
          <div className="relative">
            {/* A press on ⋯ keeps the focus where it is: the keyboard stays up and the menu doesn't fight it. */}
            <IconButton
              ref={moreButtonRef}
              aria-label="More options"
              aria-haspopup="menu"
              aria-expanded={menu.open}
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => menu.openFrom(e.currentTarget)}
            >
              <MoreVertical strokeWidth={1.8} />
            </IconButton>
            {/* A small hint under ⋯ that attaching is here now (while the composer has text). */}
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute -bottom-0.5 left-1/2 flex size-4 -translate-x-1/2 items-center justify-center rounded-full bg-accent text-accent-fg shadow-sm transition-[opacity,transform] duration-200 ease-out",
                showAttachHint ? "scale-100 opacity-100" : "scale-75 opacity-0",
              )}
            >
              <Paperclip className="size-2.5" strokeWidth={2.4} />
            </span>
          </div>
        </div>
      </div>
      {menu.anchor ? <Menu anchor={menu.anchor} items={overflow} onClose={menu.close} aria-label="Chat options" /> : null}
      {datePickerOpen ? (
        <DatePicker
          title="Jump to date"
          // A local calendar date — `toISOString()` is UTC, which east of UTC
          // (e.g. Tehran, +3:30) is still yesterday for the first hours of
          // the day, so `max` would forbid jumping to today.
          max={todayYmd()}
          dimBefore={firstMessageDay}
          onClose={closeDatePicker}
          onSelect={(date) => {
            closeDatePicker();
            onPickDate?.(date);
          }}
        />
      ) : null}
    </header>
  );
}

export function TypingDots() {
  return (
    <span className="inline-flex shrink-0 items-center gap-[3px]" aria-hidden>
      <span className="typing-dot size-1 rounded-full bg-current" />
      <span className="typing-dot size-1 rounded-full bg-current [animation-delay:150ms]" />
      <span className="typing-dot size-1 rounded-full bg-current [animation-delay:300ms]" />
    </span>
  );
}
