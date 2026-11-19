"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Lock, MessageCircleHeart, Unlock, X } from "lucide-react";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { Button } from "@/components/ui/Button";
import { ChatSearchBar } from "@/components/chat/ChatSearchBar";
import { MessageBubble, type GroupPosition, type MessageBubbleData } from "@/components/chat/MessageBubble";
import { Composer, type ComposerAllow, type ComposerGate } from "@/components/chat/Composer";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { MessageListSkeleton } from "@/components/chat/MessageListSkeleton";
import { useRouter } from "@/hooks/use-app-router";
import { chatManagementKey, chatPreviewKey } from "@/hooks/use-chat-meta-events";
import { useChatPermissions } from "@/hooks/use-chat-permissions";
import { memberCountLabel } from "@/lib/chat-labels";
import { useAuth } from "@/contexts/auth-context";
import { usePresence } from "@/contexts/presence-context";
import { useCall } from "@/contexts/call-context";
import { useRealtimeEvent } from "@/hooks/use-realtime-event";
import { CHANNELS_QUERY_KEY, getChannelsMine, getChatPreview, getMembersForManagement } from "@/lib/api/chats";
import {
  deleteForMe,
  deleteMessage,
  editMessage,
  getFirstMessageFromLocalDay,
  getMessage,
  getMessages,
  getPinnedMessages,
  getReadState,
  getUnreadMentions,
  getUnreadReactions,
  markRead,
  pinMessage,
  readStateKey,
  searchInChannel,
  toggleReaction,
  unpinMessage,
} from "@/lib/api/messages";
import { channelDisplayName, senderId, senderName, type ChannelsPage, type ChatMessage, type ChatPreview } from "@/lib/api/types";
import { acceptSharedWallpaper, getEffectiveWallpaper, wallpaperEffectiveKey } from "@/lib/api/wallpaper";
import { ApiError } from "@/lib/api/client";
import { uploadVoice } from "@/lib/api/media";
import { uploadVideoNote } from "@/lib/api/files";
import { useFileSending } from "@/components/media/use-file-sending";
import type { RecordingResult } from "@/components/media/use-media-recording";
import { extensionForMime } from "@/lib/recording";
import type { CreateMessageInput } from "@/lib/socket";
import type { InlineEmoji } from "@/components/chat/RichMessageInput";
import { MediaEditor } from "@/components/media/editor/MediaEditor";
import { DeleteMessagesDialog } from "@/components/chat/DeleteMessagesDialog";
import { SelectionBar } from "@/components/chat/SelectionBar";
import { SelectTextBar, copyText } from "@/components/chat/message-touch";
import { BLOCKED_QUERY_KEY, getBlockedUserIds, hasBlockedMe, unblockUser } from "@/lib/api/users";
import { clearChatNotifications } from "@/lib/notification-clear";
import { FileSendDialog } from "@/components/media/FileSendDialog";
import { MediaSendProgress } from "@/components/media/editor/MediaSendProgress";
import { useMediaSendQueue } from "@/components/media/editor/use-media-send-queue";
import type { MediaEditorResult } from "@/components/media/editor/types";
import { getSocket } from "@/lib/socket";
import { cn } from "@/lib/cn";
import { resolveMediaUrl } from "@/lib/media-url";
import { describeSystemMessage, wallpaperChangeMetadata } from "@/lib/system-message";
import { buildMessagePreview } from "@/lib/message-preview";
import { smoothScroll } from "@/lib/performance";
import { isNearJump, settleOnTarget, targetDelta, type JumpAlign } from "@/lib/jump-scroll";
import { ChatWallpaper } from "@/components/chat/ChatWallpaper";
import { MediaViewerProvider } from "@/components/media/MediaViewer";
import { NowPlayingBar } from "@/components/media/NowPlayingBar";
import { GroupCallBar } from "@/components/calls/GroupCallBar";
import { registerJumpHandler } from "@/lib/playback";
import { PinnedBar } from "@/components/chat/PinnedBar";
import { formatDateDivider, topVisibleRowIndex } from "@/lib/feed-date";
import { presenceStatus } from "@/lib/last-seen";
import { getUserProfile } from "@/lib/api/contacts";

import { messagesKey, messagesQueryOptions } from "@/lib/messages-query";
export { messagesKey };
const pinnedKey = (channelId: string) => ["messages", "pinned", channelId] as const;
/** Size of each window loaded around a jump target (either side), and of forward pages. */
const JUMP_WINDOW = 30;
const FORWARD_PAGE = 50;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Media and files carry an optional caption; a blank one (a space left by an old client)
 *  is no caption at all, so the message is drawn bare. */
const CAPTIONED_TYPES = new Set(["image", "video", "gif", "video_note", "file", "audio", "sticker"]);
/** A text send with no acknowledgement after this long on a live connection shows as not sent. */
const SEND_ACK_MS = 15_000;

function captionOrText(msg: ChatMessage): string {
  if (CAPTIONED_TYPES.has(msg.type) && !msg.content?.trim()) return "";
  return msg.content;
}

function toBubbleData(
  msg: ChatMessage,
  currentUserId: string,
  rights: { pin: boolean; deleteOthers: boolean; editOthers: boolean },
  /** ✓✓ for own messages: someone else has read up to (or past) this one. */
  readByOthers: boolean,
  systemAction: MessageBubbleData["systemAction"],
  highlighted: boolean,
  sendStatus: "pending" | "failed" | undefined,
): MessageBubbleData {
  const mine = senderId(msg.senderId) === currentUserId;

  return {
    id: msg._id,
    type: msg.type,
    mine,
    senderName: mine ? undefined : senderName(msg.senderId),
    signature: msg.signature ?? null,
    senderId: mine ? undefined : senderId(msg.senderId),
    senderAvatarUrl: mine || typeof msg.senderId !== "object" ? undefined : msg.senderId.avatarUrl?.[0],
    text: msg.type === "system" ? describeSystemMessage(msg, mine ? "You" : senderName(msg.senderId)) : captionOrText(msg),
    systemAction,
    highlighted,
    sendStatus,
    replyTo: msg.replySnapshot
      ? { senderName: msg.replySnapshot.senderName, snippet: msg.replySnapshot.snippet, messageId: msg.replySnapshot.messageId ?? msg.replyTo ?? null }
      : null,
    attachments: msg.attachments,
    attachmentMeta: msg.attachmentMeta,
    packId: msg.packId,
    packItemId: msg.packItemId,
    reactions: msg.reactions.length
      ? msg.reactions.map((r) => ({ emoji: r.emoji, packItemId: r.packItemId, packId: r.packId, relativePath: r.relativePath, count: r.count, reactedByMe: r.me }))
      : undefined,
    createdAt: formatTime(msg.createdAt),
    createdAtIso: msg.createdAt,
    durationSec: msg.durationSec,
    waveform: msg.waveform,
    originalFilename: msg.originalFilename,
    customEmoji: msg.customEmoji ?? null,
    read: mine ? readByOthers : undefined,
    isEdited: msg.isEdited,
    isPinned: msg.isPinned,
    canPin: rights.pin ? true : undefined,
    canDeleteForEveryone: mine || rights.deleteOthers,
    canEditOthers: !mine && rights.editOthers,
  };
}

const GROUP_WINDOW_MS = 5 * 60_000;

/** Consecutive messages from the same sender, on the same day, within a few
 * minutes of each other read as one "run" — shared corners, one name, one
 * avatar. System messages always stand alone. */
function continuesRun(a: ChatMessage | undefined, b: ChatMessage | undefined): boolean {
  if (!a || !b || a.type === "system" || b.type === "system") return false;
  if (senderId(a.senderId) !== senderId(b.senderId)) return false;
  const ta = new Date(a.createdAt);
  const tb = new Date(b.createdAt);
  return ta.toDateString() === tb.toDateString() && Math.abs(tb.getTime() - ta.getTime()) < GROUP_WINDOW_MS;
}

function groupPositionOf(prev: ChatMessage | undefined, m: ChatMessage, next: ChatMessage | undefined): GroupPosition {
  const joinsPrev = continuesRun(prev, m);
  const joinsNext = continuesRun(m, next);
  if (joinsPrev && joinsNext) return "middle";
  if (joinsPrev) return "last";
  if (joinsNext) return "first";
  return "single";
}

/** A conversation route. Chats you're in open normally; a public group or
 * channel you're not in opens read-only with a Join bar (Telegram-style);
 * a private one you're not in explains how to get in.
 * `focusMessageId` (`?message=<id>`) scrolls to and highlights a message. */
export function ConversationView({ channelId, focusMessageId }: { channelId: string; focusMessageId?: string }) {
  const channelsQuery = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: () => getChannelsMine() });
  const inList = !!channelsQuery.data?.items.some((c) => c.channelId === channelId);
  // Also covers a chat you *are* in that just isn't on the first page of
  // your (paginated) chat list — the preview says `isMember` then.
  const previewQuery = useQuery({
    queryKey: chatPreviewKey(channelId),
    queryFn: () => getChatPreview(channelId),
    enabled: channelsQuery.isSuccess && !inList,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });

  if (inList) return <ConversationPane channelId={channelId} focusMessageId={focusMessageId} />;
  if (channelsQuery.isPending || (channelsQuery.isSuccess && previewQuery.isPending)) return <ConversationLoading />;
  if (previewQuery.data) return <ConversationPane channelId={channelId} focusMessageId={focusMessageId} preview={previewQuery.data} />;

  const notAllowed = previewQuery.error instanceof ApiError && previewQuery.error.status < 500;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-canvas">
      {notAllowed ? (
        <EmptyState
          icon={Lock}
          title="This chat is private"
          description="Ask someone in it for an invite link."
        />
      ) : (
        <EmptyState
          icon={MessageCircleHeart}
          title="Couldn't open this chat"
          description="Check your connection, then try again."
          action={{ label: "Try again", onClick: () => (channelsQuery.isError ? channelsQuery.refetch() : previewQuery.refetch()) }}
        />
      )}
    </div>
  );
}

function ConversationLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas" aria-busy="true">
      <div className="safe-top flex h-[var(--header-h)] shrink-0 items-center gap-3 border-b border-line bg-panel px-4 lg:px-6">
        <Skeleton className="size-10 rounded-[var(--radius-sm)]" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-3 lg:px-6">
        <MessageListSkeleton />
      </div>
      <div className="safe-bottom shrink-0 border-t border-line bg-panel px-3 py-2.5 lg:px-6">
        <Skeleton className="mx-auto h-11 w-full max-w-[860px] rounded-full" />
      </div>
    </div>
  );
}

function ConversationPane({
  channelId,
  focusMessageId,
  preview,
}: {
  channelId: string;
  focusMessageId?: string;
  /** Set when this chat isn't in your chat list: either a public chat
   *  you're previewing, or (`isMember`) one past the list's first page. */
  preview?: ChatPreview;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const { startCall } = useCall();
  const queryClient = useQueryClient();
  const [replyTo, setReplyTo] = useState<MessageBubbleData | null>(null);
  // Multi-select: the chosen message ids, for the chat they were picked in (null = not selecting).
  const [selection, setSelection] = useState<{ channelId: string; ids: Set<string> } | null>(null);
  const selectedIds = selection?.channelId === channelId ? selection.ids : null;
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  // Opening a chat clears its shown notifications (they're read now).
  useEffect(() => {
    void clearChatNotifications(channelId);
  }, [channelId]);
  // Banned from this direct chat: the conversation stays, and its composer gives way to a line of text.
  const [bannedChatId, setBannedChatId] = useState<string | null>(null);
  const bannedHere = bannedChatId === channelId;
  useRealtimeEvent(
    "chat_banned",
    useCallback((payload: { channelId: string }) => {
      if (payload.channelId === channelId) setBannedChatId(payload.channelId);
    }, [channelId]),
  );
  // Text-selection mode: the message being selected from (its bar is rendered here, see below).
  const [textSelectId, setTextSelectId] = useState<string | null>(null);
  // Where the bar sits: the selected message's text, found in the list (it may be scrolled out).
  const textSelectTarget = useMemo(
    () => ({
      get current() {
        return textSelectId ? document.querySelector<HTMLElement>(`[data-text-target="${textSelectId}"]`) : null;
      },
    }),
    [textSelectId],
  );
  const [editingMessage, setEditingMessage] = useState<MessageBubbleData | null>(null);
  // Optimistic text sends: keyed by the message's real `_id` once it exists,
  // or by the client-generated `tempId` while still in flight — a bubble
  // renders immediately on send, `send_message`'s own ack (or the matching
  // `new_message` broadcast, whichever arrives first — both carry the same
  // `tempId`) reconciles it into a real message, and a socket error/timeout
  // leaves it visibly "Failed to send" with retry/dismiss rather than
  // silently vanishing.
  const [sendStatuses, setSendStatuses] = useState<Map<string, "pending" | "failed">>(new Map());
  // Text sends not yet acknowledged, by client id (see sendTextMessage).
  const outboxRef = useRef(new Map<string, { channelId: string; text: string; replyToId?: string; emoji: InlineEmoji[] }>());
  // Picked photos/videos open the media editor (components/media/editor) first — crop, draw,
  // text, adjust, trim, quality, caption — then upload in order through `mediaQueue`, whose
  // progress rows sit above the composer. `uploadError` is a small dismissible line.
  const [editorFiles, setEditorFiles] = useState<File[] | null>(null);
  // Files / music from the attach menu: a "Send N files" sheet with a caption first.
  const [fileDraft, setFileDraft] = useState<{ files: File[]; mode: "file" | "music"; caption: string } | null>(null);
  // The composer's text when files were picked becomes their caption; if the picker is cancelled
  // it goes back into the composer.
  const [captionDraft, setCaptionDraft] = useState("");
  const [composerRestore, setComposerRestore] = useState<{ text: string; id: number } | null>(null);
  const captionSent = useRef(false);
  function endCaptionDraft() {
    if (!captionSent.current && captionDraft) setComposerRestore((r) => ({ text: captionDraft, id: (r?.id ?? 0) + 1 }));
    captionSent.current = false;
    setCaptionDraft("");
  }
  const [uploadError, setUploadError] = useState<string | null>(null);
  // File / music messages (attach menu → File, Music): optimistic bubbles with upload rings.
  const sendFiles = useFileSending({
    channelId,
    userId: user?._id,
    replyToId: replyTo?.id,
    onReplyUsed: () => setReplyTo(null),
    setSendStatuses,
    onError: setUploadError,
  });
  const mediaQueue = useMediaSendQueue({ channelId, replyToId: replyTo?.id, onReplyUsed: () => setReplyTo(null) });
  // Keyed by userId so a group chat can show more than one typer at once.
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const isTypingRef = useRef(false);
  const typingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const channelsQuery = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: () => getChannelsMine() });
  // Same key/fn as the chat list's hover/press prefetch (ConversationRow).
  const messagesQuery = useQuery(messagesQueryOptions(channelId));
  const pinnedQuery = useQuery({ queryKey: pinnedKey(channelId), queryFn: () => getPinnedMessages(channelId) });

  // Real "load older on scroll" pagination — `findAll`'s own DESC-sort-then-
  // reverse design only supports asking for "the N messages immediately
  // before X" (via `beforeDate`), not a forward/adjacent page, so this only
  // ever extends backward; getting back to "now" from a scrolled-up
  // position is still the "Jump to latest" pill, not incremental forward
  // paging.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pendingScrollAdjustRef = useRef<number | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);

  // Message-list virtualization: only the messages actually in (or near) the
  // viewport get a real DOM node — height varies a lot per bubble (a plain
  // text line vs. an image grid vs. reactions), so `estimateSize` is a rough
  // guess and `measureElement` (a ResizeObserver under the hood) corrects
  // each row's real height after it first paints. jump-to-message
  // (search/date-jump/unread chips, below) used to rely on every loaded
  // message being a real DOM node it could `document.getElementById` and
  // `scrollIntoView` — now uses the virtualizer's own index-based
  // `scrollToIndex`, which forces an off-screen target to mount instead.
  const rowVirtualizer = useVirtualizer({
    count: messagesQuery.data?.length ?? 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 64,
    overscan: 12,
    getItemKey: (index) => messagesQuery.data?.[index]?._id ?? index,
  });

  const loadOlderMutation = useMutation({
    mutationFn: () => {
      const oldest = messagesQuery.data?.[0];
      if (!oldest) return Promise.resolve([] as ChatMessage[]);
      return getMessages(channelId, { limit: 50, beforeDate: oldest.createdAt });
    },
    onMutate: () => {
      pendingScrollAdjustRef.current = scrollContainerRef.current?.scrollHeight ?? null;
    },
    onSuccess: (older) => {
      if (older.length < 50) setHasMoreOlder(false);
      if (older.length === 0) return;
      queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) => {
        const existingIds = new Set((prev ?? []).map((m) => m._id));
        const fresh = older.filter((m) => !existingIds.has(m._id));
        return [...fresh, ...(prev ?? [])];
      });
    },
  });

  // Runs after the prepended messages have actually painted — restores the
  // exact same content under the viewport rather than leaving the user
  // looking at whatever now-shifted messages happen to occupy the old
  // scroll offset (the classic "content jump" bug for prepend-above lists).
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    const prevHeight = pendingScrollAdjustRef.current;
    if (el && prevHeight != null) {
      el.scrollTop += el.scrollHeight - prevHeight;
      pendingScrollAdjustRef.current = null;
    }
  }, [messagesQuery.data]);

  // "Stick to bottom": while the reader is at (or near) the newest message,
  // new arrivals keep the view pinned there; once they scroll up to read
  // history, new arrivals are counted on the jump-to-latest button instead
  // of yanking the view away from what they're reading.
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [newWhileAway, setNewWhileAway] = useState(0);

  // The feed getting shorter — an on-screen keyboard opening (the shell
  // shrinks to sit above it, see useVisualViewport), the composer growing, a
  // banner appearing — keeps the newest message in view if it was in view.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      if (h < lastHeight && atBottomRef.current) el.scrollTop = el.scrollHeight;
      lastHeight = h;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Telegram's pinned bar follows the reading position: it shows the newest pin at or
  // above the bottom of the viewport (scroll up past pin #3 and it shows #3). Read off
  // the few mounted rows once per frame — no fetches; state only changes when the pin does.
  const [pinFollowId, setPinFollowId] = useState<string | null>(null);
  const pinFollowFrameRef = useRef<number | null>(null);
  // Only the reader's own scrolling moves the bar — not a jump's programmatic scroll
  // (which would undo the tap-to-step-back cycling).
  const userScrollAtRef = useRef(0);
  const markUserScroll = () => {
    userScrollAtRef.current = Date.now();
  };
  function followPinnedOnScroll() {
    if (pinFollowFrameRef.current != null || Date.now() - userScrollAtRef.current > 1000) return;
    pinFollowFrameRef.current = requestAnimationFrame(() => {
      pinFollowFrameRef.current = null;
      const el = scrollContainerRef.current;
      const pins = queryClient.getQueryData<ChatMessage[]>(pinnedKey(channelId));
      const list = queryClient.getQueryData<ChatMessage[]>(messagesKey(channelId));
      if (!el || !pins?.length || !list?.length) return;
      const bottom = el.getBoundingClientRect().bottom;
      let lastVisible = -1;
      el.querySelectorAll<HTMLElement>("[data-index]").forEach((row) => {
        const i = Number(row.dataset.index);
        if (i > lastVisible && row.getBoundingClientRect().top < bottom - 8) lastVisible = i;
      });
      const at = list[lastVisible]?.createdAt;
      if (!at) return;
      const atMs = Date.parse(at);
      let best: ChatMessage | null = null;
      let oldest: ChatMessage | null = null;
      for (const p of pins) {
        const t = Date.parse(p.createdAt);
        if (t <= atMs && (!best || t > Date.parse(best.createdAt))) best = p;
        if (!oldest || t < Date.parse(oldest.createdAt)) oldest = p;
      }
      // Above every pin: the oldest one is the nearest.
      const id = (best ?? oldest)?._id ?? null;
      setPinFollowId((prev) => (prev === id ? prev : id));
    });
  }
  useEffect(
    () => () => {
      if (pinFollowFrameRef.current != null) cancelAnimationFrame(pinFollowFrameRef.current);
    },
    [],
  );

  // Telegram's floating date: while the feed scrolls, a small pill shows the date of the
  // message at the top of the viewport; it fades ~1s after scrolling stops. Read from the
  // mounted rows once per frame (no fetches); the label state only changes when the day does.
  const [floatDate, setFloatDate] = useState<{ day: string; label: string } | null>(null);
  const [floatShown, setFloatShown] = useState(false);
  const floatFrameRef = useRef<number | null>(null);
  const floatHideTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (floatFrameRef.current != null) cancelAnimationFrame(floatFrameRef.current);
      if (floatHideTimerRef.current != null) window.clearTimeout(floatHideTimerRef.current);
    },
    [],
  );
  function showFloatingDate() {
    setFloatShown(true);
    if (floatHideTimerRef.current != null) window.clearTimeout(floatHideTimerRef.current);
    floatHideTimerRef.current = window.setTimeout(() => setFloatShown(false), 1000);
    if (floatFrameRef.current != null) return;
    floatFrameRef.current = requestAnimationFrame(() => {
      floatFrameRef.current = null;
      const el = scrollContainerRef.current;
      const list = queryClient.getQueryData<ChatMessage[]>(messagesKey(channelId));
      if (!el || !list?.length) return;
      const rows: { index: number; bottom: number }[] = [];
      el.querySelectorAll<HTMLElement>("[data-index]").forEach((row) => {
        rows.push({ index: Number(row.dataset.index), bottom: row.getBoundingClientRect().bottom });
      });
      const top = topVisibleRowIndex(rows, el.getBoundingClientRect().top);
      const m = top >= 0 ? list[top] : undefined;
      if (!m) return;
      const day = new Date(m.createdAt).toDateString();
      setFloatDate((prev) => (prev?.day === day ? prev : { day, label: formatDateDivider(m.createdAt) }));
    });
  }

  function handleMessagesScroll() {
    const el = scrollContainerRef.current;
    // A jump is placing its target: these scrolls are ours, not the reader's.
    if (!el || settlingRef.current) return;
    showFloatingDate();
    followPinnedOnScroll();
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom !== atBottomRef.current) {
      atBottomRef.current = nearBottom;
      setAtBottom(nearBottom);
    }
    if (nearBottom && newWhileAway && !jumped) setNewWhileAway(0);
    if (jumped && hasMoreNewer && !loadNewerMutation.isPending && el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
      loadNewerMutation.mutate();
    }
    if (loadOlderMutation.isPending || !hasMoreOlder) return;
    if (el.scrollTop < 200) loadOlderMutation.mutate();
  }

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const count = queryClient.getQueryData<ChatMessage[]>(messagesKey(channelId))?.length ?? 0;
      if (count === 0) return;
      rowVirtualizer.scrollToIndex(count - 1, { align: "end", behavior });
      // Rows are measured after they first paint, so the virtualizer's own
      // estimate can land a little short — settle on the real bottom once
      // layout has caught up.
      requestAnimationFrame(() => {
        const el = scrollContainerRef.current;
        if (el && behavior === "auto") el.scrollTop = el.scrollHeight;
      });
    },
    // rowVirtualizer is internally stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channelId, queryClient],
  );

  // In-chat search: the backend's own search returns ordered ids only, no
  // snippets — "jump to a match" means replacing the feed's cached window
  // with a fresh one ending at that message (via the same findAll route,
  // beforeDate'd just past it). `jumped` tracks whether the feed is
  // currently showing that historical window rather than the live tail —
  // scrolling up further from there now also loads real older history via
  // the same `loadOlderMutation` above, same as it does from the live tail.
  const [searchOpen, setSearchOpen] = useState(false);
  // Attach moved to the header while typing: the composer opens its attach options through this.
  const attachTrigger = useRef<((anchor?: HTMLElement | null) => void) | null>(null);
  const [attachHint, setAttachHint] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [jumped, setJumped] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  // The search endpoint is throttled (30/min per channel) — debounce so a
  // typed-out query doesn't fire once per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchQuery(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const searchResultsQuery = useQuery({
    queryKey: ["messages", "search", channelId, debouncedSearchQuery],
    queryFn: () => searchInChannel(channelId, debouncedSearchQuery),
    enabled: searchOpen && debouncedSearchQuery.trim().length > 0,
  });
  const searchTotal = searchResultsQuery.data?.total ?? 0;
  const searchMessageIds = searchResultsQuery.data?.messageIds ?? [];

  // A request to bring a message into view — separate from the flash (`highlightedMessageId`),
  // which only starts once the target has settled. The nonce makes re-tapping the same
  // reply scroll again.
  const [scrollRequest, setScrollRequest] = useState<{ id: string; align: JumpAlign; instant: boolean; nonce: number } | null>(null);
  // While a far target is being placed the feed is hidden (one cut, no visible
  // scroll → rows load → scroll again), and paging on scroll is paused.
  const [settling, setSettling] = useState(false);
  const settlingRef = useRef(false);
  const focusMessage = useCallback((id: string, align: JumpAlign = "center", instant = false) => {
    setScrollRequest((prev) => ({ id, align, instant, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  // A jumped window has more messages after it (paged forward on scroll, see loadNewer).
  const [hasMoreNewer, setHasMoreNewer] = useState(false);
  const jumpedRef = useRef(false);
  jumpedRef.current = jumped;
  // Telegram's "back to the reply": tapping a reply's quote remembers the reply, and the
  // jump-down button returns there first before going to the newest message.
  const [returnStack, setReturnStack] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(t);
  }, [notice]);

  // Load a window *around* a message that isn't in the loaded feed — some history before
  // it and some after, so you can keep reading forward from it (more loads on scroll) —
  // then scroll to and flash it.
  const jumpMutation = useMutation({
    mutationFn: async ({ messageId, createdAt }: { messageId: string; align?: "center" | "start"; createdAt?: string | null }) => {
      const at = createdAt ?? (await getMessage(messageId)).createdAt;
      const [before, after] = await Promise.all([
        getMessages(channelId, { limit: JUMP_WINDOW, beforeDate: at }),
        getMessages(channelId, { limit: JUMP_WINDOW, afterDate: at, direction: "newer" }),
      ]);
      const seen = new Set<string>();
      const window = [...before, ...after].filter((m) => (seen.has(m._id) ? false : (seen.add(m._id), true)));
      if (!window.some((m) => m._id === messageId)) throw new ApiError(404, "Message not found", null);
      return { messageId, window, moreOlder: before.length >= JUMP_WINDOW, moreNewer: after.length >= JUMP_WINDOW };
    },
    onSuccess: ({ messageId, window, moreOlder, moreNewer }, { align }) => {
      // The window reaches the newest message: it *is* the live feed again.
      setJumped(moreNewer);
      jumpedRef.current = moreNewer;
      setHasMoreNewer(moreNewer);
      setHasMoreOlder(moreOlder);
      // Don't let "follow new arrivals" read the swapped tail as a new message.
      const last = window[window.length - 1];
      if (last) lastSeenTailRef.current = `${channelId}:${last._id}`;
      atBottomRef.current = false;
      queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), window);
      // Same commit as the new window: it's placed on the target before it first paints.
      focusMessage(messageId, align, true);
    },
    onError: (err) => {
      settlingRef.current = false;
      setSettling(false);
      setNotice(err instanceof ApiError && err.status === 404 ? "This message was deleted" : "Couldn't open that message. Try again.");
    },
  });

  /** Scroll to a message and flash it — in place when it's loaded, otherwise via a window
   *  loaded around it. Search, pins, replies, dates, unread chips and the player use this. */
  const jumpTo = (messageId: string, align: "center" | "start" = "center", createdAt?: string | null) => {
    const loaded = queryClient.getQueryData<ChatMessage[]>(messagesKey(channelId))?.some((m) => m._id === messageId);
    if (loaded) focusMessage(messageId, align);
    else jumpMutation.mutate({ messageId, align, createdAt });
  };

  // Forward paging inside a jumped window, until it meets the live feed.
  const loadNewerMutation = useMutation({
    mutationFn: () => {
      const list = queryClient.getQueryData<ChatMessage[]>(messagesKey(channelId)) ?? [];
      const newest = [...list].reverse().find((m) => !m._id.startsWith("temp-"));
      if (!newest) return Promise.resolve([] as ChatMessage[]);
      return getMessages(channelId, { limit: FORWARD_PAGE, afterDate: newest.createdAt, direction: "newer" });
    },
    onSuccess: (newer) => {
      const reachedLive = newer.length < FORWARD_PAGE;
      const prev = queryClient.getQueryData<ChatMessage[]>(messagesKey(channelId)) ?? [];
      const existing = new Set(prev.map((m) => m._id));
      const fresh = newer.filter((m) => !existing.has(m._id));
      if (fresh.length) {
        const last = fresh[fresh.length - 1];
        lastSeenTailRef.current = `${channelId}:${last._id}`;
        queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), [...prev, ...fresh]);
      }
      if (reachedLive) {
        setHasMoreNewer(false);
        setJumped(false);
        jumpedRef.current = false;
      }
    },
  });

  // The now-playing bar's "show message" for a voice/video message in this chat.
  const jumpToMessageRef = useRef<(id: string) => void>(() => {});
  useLayoutEffect(() => {
    jumpToMessageRef.current = (id) => jumpTo(id);
  });
  useEffect(() => registerJumpHandler(channelId, (id) => jumpToMessageRef.current(id)), [channelId]);

  // Fires whenever the current match changes (opening search on the first
  // result, or stepping with the up/down buttons) — not on every keystroke,
  // since `searchIndex` only changes on navigation.
  useEffect(() => {
    const id = searchMessageIds[searchIndex];
    if (id) jumpTo(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMessageIds[searchIndex]]);

  // Brings `scrollRequest` into view, then flashes it. A target that's mounted and near
  // gets one short scroll; anything else (far, or a freshly loaded window) is placed
  // instantly with the feed hidden and revealed once it has stopped moving. Layout effect:
  // a jump's new window and its request commit together, so the feed is hidden before the
  // window ever paints at the old scroll offset.
  useLayoutEffect(() => {
    const req = scrollRequest;
    const container = scrollContainerRef.current;
    if (!req || !container) {
      // Cleared (another chat opened): never leave paging paused.
      if (!req) settlingRef.current = false;
      return;
    }
    const list = queryClient.getQueryData<ChatMessage[]>(messagesKey(channelId)) ?? [];
    const idx = list.findIndex((m) => m._id === req.id);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const flash = () => {
      setHighlightedMessageId(req.id);
      timers.push(setTimeout(() => setHighlightedMessageId((cur) => (cur === req.id ? null : cur)), 2000));
    };
    const finishSettling = () => {
      settlingRef.current = false;
      setSettling(false);
    };
    if (idx < 0) {
      finishSettling();
      return;
    }
    const getTarget = () => {
      const bubble = document.getElementById(`message-${req.id}`);
      return req.align === "start" ? (bubble?.closest<HTMLElement>("[data-index]") ?? bubble) : bubble;
    };
    const mounted = getTarget();
    const c = container.getBoundingClientRect();
    const delta = mounted ? targetDelta(c, mounted.getBoundingClientRect(), req.align) : null;
    if (!req.instant && !settlingRef.current && delta !== null && isNearJump(delta, c.height)) {
      if (Math.abs(delta) > 2) {
        container.scrollTo({ top: container.scrollTop + delta, behavior: smoothScroll() });
        timers.push(setTimeout(flash, 260));
      } else flash();
      return () => timers.forEach(clearTimeout);
    }
    settlingRef.current = true;
    setSettling(true);
    atBottomRef.current = false;
    const cancel = settleOnTarget({
      container,
      getTarget,
      scrollToIndex: () => rowVirtualizer.scrollToIndex(idx, { align: req.align }),
      align: req.align,
      onSettled: () => {
        setSettling(false);
        flash();
        // Our own trailing scroll events land before the next frame — keep ignoring them, so
        // a target near the top doesn't instantly page older history in and shift it. Paging
        // resumes with the reader's next scroll.
        timers.push(
          setTimeout(() => {
            settlingRef.current = false;
            const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
            atBottomRef.current = nearBottom;
            setAtBottom(nearBottom);
          }, 50),
        );
      },
    });
    return () => {
      cancel();
      timers.forEach(clearTimeout);
    };
    // rowVirtualizer's identity is stable across renders (internally memoized); the list is
    // read fresh from the cache — only a new request should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest]);

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchIndex(0);
  }

  function returnToLatest() {
    setJumped(false);
    jumpedRef.current = false;
    setHasMoreNewer(false);
    setHasMoreOlder(true);
    setHighlightedMessageId(null);
    setNewWhileAway(0);
    setReturnStack([]);
    queryClient.invalidateQueries({ queryKey: messagesKey(channelId) }).then(() => scrollToBottom());
  }

  function jumpToLatest() {
    // Back to the reply you jumped from first (Telegram), then to the newest message.
    if (returnStack.length) {
      const back = returnStack[returnStack.length - 1];
      setReturnStack((s) => s.slice(0, -1));
      jumpTo(back);
      return;
    }
    if (jumped) returnToLatest();
    else {
      setNewWhileAway(0);
      scrollToBottom(smoothScroll());
    }
  }

  function handleJumpToReplied(messageId: string, fromMessageId: string) {
    setReturnStack((s) => [...s.filter((id) => id !== fromMessageId), fromMessageId].slice(-20));
    jumpTo(messageId);
  }

  // "Jump to date": the first message on or after the start of that day *in the
  // reader's time zone* (a quiet day lands on the next day with messages, a date
  // before the chat existed on its first message), shown at the top like Telegram.
  // Nothing on or after it → back to the newest messages.
  const [dateJumpPending, setDateJumpPending] = useState(false);
  async function handleJumpToDate(date: string) {
    setDateJumpPending(true);
    try {
      const first = await getFirstMessageFromLocalDay(channelId, date);
      if (first.messageId) jumpTo(first.messageId, "start", first.createdAt);
      else {
        setNotice("No messages from that day on");
        if (jumped) returnToLatest();
        else scrollToBottom(smoothScroll());
      }
    } catch {
      setNotice("Couldn't jump to that date. Try again.");
    } finally {
      setDateJumpPending(false);
    }
  }
  const isPreviewOnly = !!preview && !preview.isMember;
  const wallpaperQuery = useQuery({
    queryKey: wallpaperEffectiveKey(channelId),
    queryFn: () => getEffectiveWallpaper(channelId),
    enabled: !isPreviewOnly,
  });
  const wallpaper = wallpaperQuery.data ?? null;

  // Local-only "already accepted this visit" tracking — the message itself
  // carries no accepted flag from the backend (accepting just points the
  // accepter's own chatWallpaperId at the shared doc), so this just keeps
  // the button from re-firing after a successful tap, not a persisted state.
  const [acceptedWallpaperMsgIds, setAcceptedWallpaperMsgIds] = useState<Set<string>>(new Set());
  const acceptWallpaperMutation = useMutation({
    mutationFn: ({ wallpaperId }: { wallpaperId: string; messageId: string }) => acceptSharedWallpaper(wallpaperId, channelId),
    onSuccess: (_wp, { messageId }) => {
      setAcceptedWallpaperMsgIds((prev) => new Set(prev).add(messageId));
      queryClient.invalidateQueries({ queryKey: wallpaperEffectiveKey(channelId) });
    },
  });

  const channel = channelsQuery.data?.items.find((c) => c.channelId === channelId);
  // A direct chat you've blocked the other person in: like Telegram, the composer gives way to an Unblock button.
  const otherUserId = channel?.type === "private" ? channel.otherUser?._id : undefined;
  const blockedQuery = useQuery({ queryKey: BLOCKED_QUERY_KEY, queryFn: getBlockedUserIds, enabled: !!otherUserId });
  const iBlockedThem = !!otherUserId && (blockedQuery.data ?? []).includes(otherUserId);
  // They've blocked you: their side of the chat says so instead of offering a composer.
  const blockedMeQuery = useQuery({
    queryKey: ["users", "blocked-me", otherUserId],
    queryFn: () => hasBlockedMe(otherUserId!),
    enabled: !!otherUserId && !iBlockedThem,
  });
  const blockedByThem = !iBlockedThem && !!blockedMeQuery.data?.blocked;
  const unblockMutation = useMutation({
    mutationFn: () => unblockUser(otherUserId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BLOCKED_QUERY_KEY }),
  });
  const chatType = channel?.type ?? preview?.type;
  const myRole = channel?.myRole ?? preview?.myRole ?? null;
  // Pin / delete-for-everyone / edit-others mirror the backend's rules: either
  // person in a direct chat; in a group/channel, my own rights there.
  const myPermissions = useChatPermissions(channelId);
  const messageRights = {
    pin: !isPreviewOnly && (chatType === "private" || !!myPermissions?.member.pinMessages),
    deleteOthers: !isPreviewOnly && (chatType === "private" || !!myPermissions?.admin.deleteMessages),
    editOthers: !isPreviewOnly && chatType === "channel" && !!myPermissions?.admin.editMessages,
  };

  // A group member an admin has muted can't send (the server rejects it).
  // The channels list doesn't carry that flag, so it's read from your own
  // row of the members list; `user_muted` (use-chat-meta-events) keeps it live.
  const mutedCheckQuery = useQuery({
    queryKey: chatManagementKey(channelId),
    queryFn: () => getMembersForManagement(channelId),
    enabled: !isPreviewOnly && chatType === "group" && !!myRole && myRole !== "owner",
  });
  const myMemberRow = user ? mutedCheckQuery.data?.find((m) => m.userId === user._id) : undefined;
  const mutedByAdmin = !!myMemberRow?.mutedByAdmin || myMemberRow?.permissions?.sendMessages === false;
  const composerGate: ComposerGate | null = isPreviewOnly
    ? { kind: "join", chatType: chatType === "channel" ? "channel" : "group" }
    : chatType === "channel" && (myRole === "member" || myPermissions?.canPost === false)
      ? { kind: "subscriber", muted: channel?.isMuted ?? false }
      : chatType === "group" && (mutedByAdmin || myPermissions?.member.sendMessages === false)
        ? { kind: "muted-by-admin", everyone: !mutedByAdmin }
        : null;
  // What the composer offers (the server enforces the same rules).
  const composerAllow: ComposerAllow | undefined =
    (chatType === "group" || chatType === "channel") && myPermissions
      ? { media: !!myPermissions?.member.sendMedia, stickers: !!myPermissions?.member.sendStickers, voice: !!myPermissions?.member.sendVoice }
      : undefined;

  // "Catch me up" snapshot, fetched once per unread chat-open — not live,
  // and not re-fetched after jumping, since it represents what was new
  // *when the chat was opened*, same framing as most chat apps' "jump to
  // next unread mention" affordance. Gated on `channel.unread` (already
  // free from ChannelSummary, see F2) so an already-read chat costs zero
  // extra requests.
  const unreadMentionsQuery = useQuery({
    queryKey: ["messages", "unread-mentions", channelId],
    queryFn: () => getUnreadMentions(channelId),
    enabled: !!channel?.unread,
  });
  const unreadReactionsQuery = useQuery({
    queryKey: ["messages", "unread-reactions", channelId],
    queryFn: () => getUnreadReactions(channelId),
    enabled: !!channel?.unread,
  });
  const unreadMentionsCount = unreadMentionsQuery.data?.count ?? 0;
  const unreadReactionsCount = unreadReactionsQuery.data?.count ?? 0;

  // Read ticks (Telegram): every own message at or before the furthest point anyone
  // else has read shows ✓✓ — one number per chat (`othersReadUpTo`), kept live by
  // `read:updated` (below), instead of a per-message lookup. Channels show no read
  // state (a single ✓ on your own posts); Saved Messages is always read.
  const readStateQuery = useQuery({
    queryKey: readStateKey(channelId),
    queryFn: () => getReadState(channelId),
    enabled: !isPreviewOnly && !!chatType && chatType !== "channel" && chatType !== "saved_messages",
  });
  const othersReadUpToMs = readStateQuery.data?.othersReadUpTo ? Date.parse(readStateQuery.data.othersReadUpTo) : null;
  const isReadByOthers = (m: ChatMessage) =>
    chatType === "saved_messages" || (chatType !== "channel" && othersReadUpToMs != null && Date.parse(m.createdAt) <= othersReadUpToMs);

  // "New messages" divider: where this reader's unread run started *when
  // the chat was opened* — captured once per channel before markRead (below)
  // moves the read pointer, so the divider doesn't vanish the moment it's
  // shown. Also where the initial scroll lands, instead of the very bottom.
  const [unreadAnchor, setUnreadAnchor] = useState<{ channelId: string; messageId: string | null } | null>(null);
  if ((channel || preview) && messagesQuery.data && user && unreadAnchor?.channelId !== channelId) {
    let messageId: string | null = null;
    if (channel?.unread) {
      const list = messagesQuery.data;
      const readIdx = channel.lastReadMessageId ? list.findIndex((m) => m._id === channel.lastReadMessageId) : -1;
      const from = readIdx >= 0 ? readIdx + 1 : 0;
      messageId = list.slice(from).find((m) => senderId(m.senderId) !== user._id && m.type !== "system")?._id ?? null;
    }
    setUnreadAnchor({ channelId, messageId });
  }
  const unreadDividerId = unreadAnchor?.channelId === channelId ? unreadAnchor.messageId : null;

  // Initial position on opening a chat: the first unread message if there
  // is one, otherwise the newest message — never the top of history.
  const initialScrollRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const data = messagesQuery.data;
    if (!data?.length || jumped || initialScrollRef.current === channelId || unreadAnchor?.channelId !== channelId) return;
    initialScrollRef.current = channelId;
    atBottomRef.current = true;
    const focusIdx = focusMessageId ? data.findIndex((m) => m._id === focusMessageId) : -1;
    const idx = unreadAnchor.messageId ? data.findIndex((m) => m._id === unreadAnchor.messageId) : -1;
    if (focusIdx >= 0) {
      // A `?message=` link: open on that message (highlighted below).
      atBottomRef.current = false;
      rowVirtualizer.scrollToIndex(focusIdx, { align: "center" });
    } else if (idx > 0) {
      rowVirtualizer.scrollToIndex(Math.max(0, idx - 1), { align: "start" });
    } else {
      scrollToBottom();
    }
    // rowVirtualizer is internally stable; only these inputs should retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesQuery.data, channelId, unreadAnchor, jumped, scrollToBottom, focusMessageId]);

  // `?message=<id>` (e.g. from search or a shared link): highlight it if
  // it's in the loaded page, otherwise load the window that ends at it.
  // The param is then dropped so the same link works again later.
  const focusHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusMessageId || !messagesQuery.data) return;
    const key = `${channelId}:${focusMessageId}`;
    if (focusHandledRef.current === key) return;
    focusHandledRef.current = key;
    if (messagesQuery.data.some((m) => m._id === focusMessageId)) focusMessage(focusMessageId, "center", true);
    else {
      // Opening straight onto an older message: keep the latest page hidden while its
      // window loads, so it never flashes before the jump.
      settlingRef.current = true;
      setSettling(true);
      jumpMutation.mutate({ messageId: focusMessageId });
    }
    router.replace(`/app/c/${channelId}`, { scroll: false });
    // jumpMutation/router are stable enough; only a new target should retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, focusMessageId, messagesQuery.data]);

  // Follow new arrivals when the reader is at the bottom (or it's their own
  // message); otherwise count them on the jump-to-latest button.
  const lastSeenTailRef = useRef<string | null>(null);
  useEffect(() => {
    const data = messagesQuery.data;
    if (!data?.length) return;
    const last = data[data.length - 1];
    const tail = `${channelId}:${last._id}`;
    const prevTail = lastSeenTailRef.current;
    lastSeenTailRef.current = tail;
    if (!prevTail || !prevTail.startsWith(`${channelId}:`) || prevTail === tail || jumped) return;
    const mine = senderId(last.senderId) === user?._id;
    if (mine || atBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom(smoothScroll()));
    } else {
      // A new message arrived while the reader was scrolled up.
      setNewWhileAway((n) => n + 1);
    }
  }, [messagesQuery.data, channelId, jumped, user, scrollToBottom]);

  // Tell the backend we've seen up through the newest message, so its
  // author's read tick (and everyone's unread badge) reflects it. Only
  // fires once per (channel, newest message) pair.
  const lastMarkedRef = useRef<{ channelId: string; messageId: string } | null>(null);
  useEffect(() => {
    // Same reasoning as myLastMessageId above — a jumped-to historical
    // window's last element isn't the channel's actual newest message, so
    // marking read against it would move the read pointer backward.
    // Not a member yet (previewing) — there's no read pointer to move.
    if (jumped || isPreviewOnly) return;
    const messages = messagesQuery.data;
    if (!messages || messages.length === 0) return;
    // The newest *real* message — an optimistic send still has a client
    // `temp-…` id the server can't look up (marking read with it failed).
    const last = [...messages].reverse().find((m) => !m._id.startsWith("temp-"));
    if (!last) return;
    if (lastMarkedRef.current?.channelId === channelId && lastMarkedRef.current.messageId === last._id) return;
    lastMarkedRef.current = { channelId, messageId: last._id };
    markRead(channelId, last._id)
      .then(() => {
        // Otherwise the chat list's own `unread` dot for this row only
        // clears on its next full refetch (remount, tab revisit, staleTime
        // elapsing) even though the server already knows it's read.
        queryClient.setQueryData<ChannelsPage>(CHANNELS_QUERY_KEY, (prev) =>
          prev
            ? {
                ...prev,
                items: prev.items.map((c) => (c.channelId === channelId ? { ...c, unread: false, lastReadMessageId: last._id } : c)),
              }
            : prev,
        );
      })
      .catch(() => {});
  }, [channelId, messagesQuery.data, queryClient, jumped, isPreviewOnly]);

  // Reset typing state on channel switch — this component is reused across
  // channelId changes (route param, not a remount), so stale typers from
  // the previous chat would otherwise linger. Done during render (React's
  // documented pattern for "adjust state when a prop changes"), not inside
  // an effect body, so it lands before paint instead of causing an extra
  // commit.
  const [typingChannelId, setTypingChannelId] = useState(channelId);
  if (typingChannelId !== channelId) {
    setTypingChannelId(channelId);
    setTypingUsers(new Map());
    // Same reasoning — an open search / jumped-to-history state from the
    // previous chat has no meaning in this one.
    setSearchOpen(false);
    setSearchQuery("");
    setDebouncedSearchQuery("");
    setSearchIndex(0);
    setJumped(false);
    setHighlightedMessageId(null);
    setScrollRequest(null);
    setSettling(false);
    setHasMoreOlder(true);
    setHasMoreNewer(false);
    setReturnStack([]);
    setNotice(null);
    setPinFollowId(null);
    setEditingMessage(null);
    setReplyTo(null);
    setAtBottom(true);
    setNewWhileAway(0);
  }

  // Stops our own in-flight typing_start for whichever channel we're
  // leaving, rather than letting it ride out the server's 5s auto-timeout
  // there — this part genuinely needs an effect (cleanup on unmount/change).
  useEffect(() => {
    return () => {
      if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
      if (isTypingRef.current) {
        isTypingRef.current = false;
        getSocket()?.emit("typing_stop", { channelId });
      }
    };
  }, [channelId]);

  // The server auto-joins every socket to `channel:{id}` rooms for chats
  // you're already a member of on connect, so no explicit join is needed
  // here — just listen for events scoped to this channel.
  useRealtimeEvent(
    "new_message",
    useCallback(
      (payload) => {
        if (payload.channelId !== channelId) return;
        // NotificationsHost keeps the chat list's preview current for every
        // *other* chat; the open one is patched here so its row doesn't go
        // stale while you're reading it.
        queryClient.setQueryData<ChannelsPage>(CHANNELS_QUERY_KEY, (prev) =>
          prev
            ? {
                ...prev,
                items: prev.items.map((c) =>
                  c.channelId === channelId
                    ? {
                        ...c,
                        lastMessagePreview: buildMessagePreview(payload.message, user?._id),
                        lastMessageAt: payload.message.createdAt,
                        historyCleared: false,
                        // A new message is never read yet by the other side.
                        lastMessageMine: senderId(payload.message.senderId) === user?._id,
                        lastMessageRead: false,
                      }
                    : c,
                ),
              }
            : prev,
        );
        queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) => {
          const list = prev ?? [];
          // Drop the optimistic placeholder this broadcast is the real
          // counterpart of (see handleSend/sendTextMessage) — same `tempId`
          // reconciliation the ack itself does, kept here too since this
          // broadcast is usually what actually reaches the sender first.
          const withoutTemp = payload.tempId ? list.filter((m) => m._id !== payload.tempId) : list;
          if (withoutTemp.some((m) => m._id === payload.message._id)) return withoutTemp;
          // Reading an older stretch (a jump) that doesn't reach the newest
          // message yet: appending would leave a gap — count it on the
          // jump-down button instead; forward paging picks it up.
          if (jumpedRef.current) return withoutTemp;
          return [...withoutTemp, payload.message];
        });
        if (jumpedRef.current) setNewWhileAway((n) => n + 1);
        if (payload.tempId) {
          setSendStatuses((prev) => {
            if (!prev.has(payload.tempId!)) return prev;
            const next = new Map(prev);
            next.delete(payload.tempId!);
            return next;
          });
        }
      },
      [channelId, queryClient, user],
    ),
  );

  useRealtimeEvent(
    "message_deleted",
    useCallback(
      (payload) => {
        if (payload.channelId !== channelId) return;
        queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) =>
          (prev ?? []).filter((m) => m._id !== payload.messageId),
        );
      },
      [channelId, queryClient],
    ),
  );

  // Covers edits and pin/unpin — both still broadcast the full updated
  // message. Reactions are a separate, smaller `reaction_changed` event
  // (below), not routed through this one anymore (B5).
  useRealtimeEvent(
    "message_updated",
    useCallback(
      (payload) => {
        if (payload.channelId !== channelId) return;
        queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) =>
          (prev ?? []).map((m) => (m._id === payload.message._id ? payload.message : m)),
        );
        // Cheap enough to just refetch the (usually tiny) pinned list on any
        // update rather than trying to detect which updates actually changed
        // isPinned.
        queryClient.invalidateQueries({ queryKey: pinnedKey(channelId) });
      },
      [channelId, queryClient],
    ),
  );

  // Reaction delta (B5) — no full message in the payload, so the toggle has
  // to be replayed locally against the cached reactions array. Keyed by
  // `emoji ?? packItemId` since exactly one is set on any given reaction.
  useRealtimeEvent(
    "reaction_changed",
    useCallback(
      (payload) => {
        if (payload.channelId !== channelId || !user) return;
        const isMe = payload.userId === user._id;
        const key = payload.emoji ?? payload.packItemId;
        queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) =>
          (prev ?? []).map((m) => {
            if (m._id !== payload.messageId) return m;
            const reactions = m.reactions.slice();
            const idx = reactions.findIndex((r) => (r.emoji ?? r.packItemId) === key);
            if (payload.action === "added") {
              if (idx >= 0) reactions[idx] = { ...reactions[idx], count: reactions[idx].count + 1, me: reactions[idx].me || isMe };
              else
                reactions.push({
                  emoji: payload.emoji,
                  packItemId: payload.packItemId,
                  relativePath: payload.relativePath,
                  packId: payload.packId,
                  count: 1,
                  me: isMe,
                });
            } else if (idx >= 0) {
              const nextCount = reactions[idx].count - 1;
              if (nextCount <= 0) reactions.splice(idx, 1);
              else reactions[idx] = { ...reactions[idx], count: nextCount, me: isMe ? false : reactions[idx].me };
            }
            return { ...m, reactions };
          }),
        );
      },
      [channelId, queryClient, user],
    ),
  );

  // Server-scoped to `channel:{id}` rooms and excludes the sender's own
  // socket already, so no `payload.userId === user._id` guard is needed
  // here. `uploading` folds into the same event (attaching media) — shown
  // with the same "is typing…" treatment rather than a separate copy, since
  // the distinction isn't worth a second UI state for how rarely it differs.
  useRealtimeEvent(
    "user_typing",
    useCallback(
      (payload) => {
        if (payload.channelId !== channelId) return;
        setTypingUsers((prev) => {
          const next = new Map(prev);
          if (payload.isTyping || payload.uploading) next.set(payload.userId, payload.username);
          else next.delete(payload.userId);
          return next;
        });
      },
      [channelId],
    ),
  );

  // Lets the author's read tick update live when the other side reads.
  useRealtimeEvent(
    "read:updated",
    useCallback(
      (payload) => {
        if (payload.channelId !== channelId) return;
        // Someone else read further: every own message up to there turns ✓✓.
        if (payload.userId !== user?._id) {
          const upTo = payload.upToCreatedAt;
          if (upTo) {
            queryClient.setQueryData<{ chatType: string; othersReadUpTo: string | null }>(readStateKey(channelId), (prev) =>
              prev && (!prev.othersReadUpTo || Date.parse(upTo) > Date.parse(prev.othersReadUpTo)) ? { ...prev, othersReadUpTo: upTo } : prev,
            );
          } else {
            queryClient.invalidateQueries({ queryKey: readStateKey(channelId) });
          }
        }
        // An open message info sheet ("Seen by") refetches.
        queryClient.invalidateQueries({ queryKey: ["messages", "seen-by"] });
      },
      [channelId, queryClient, user],
    ),
  );

  // Patch the cache from the mutation's own response rather than relying
  // solely on the `message_updated` broadcast reaching back to the acting
  // user's own socket. Empirically, that broadcast does NOT reliably reach
  // the initiator for pin/unpin (confirmed: the DB updates correctly, a
  // second connected client sees it immediately, but the acting user's own
  // browser doesn't update until it refetches) — an asymmetry in the same
  // family as the reactions "first reactor is sender" quirk. The broadcast
  // is still what updates *other* connected clients; this just stops this
  // client depending on getting its own echo back.
  function patchMessage(updated: ChatMessage) {
    queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) =>
      (prev ?? []).map((m) => (m._id === updated._id ? updated : m)),
    );
    queryClient.invalidateQueries({ queryKey: pinnedKey(channelId) });
  }

  function handleToggleReaction(message: MessageBubbleData, reaction: { emoji: string } | { packItemId: string }) {
    const key = "emoji" in reaction ? reaction.emoji : reaction.packItemId;
    const previousReactions = messagesQuery.data?.find((m) => m._id === message.id)?.reactions ?? [];
    const wasMine = previousReactions.find((r) => (r.emoji ?? r.packItemId) === key)?.me ?? false;

    // Optimistic local toggle, predicting the exact same add/remove math the
    // `reaction_changed` replay (below) applies for everyone else's toggles
    // — a sticker/pack-item reaction just added won't have its thumbnail
    // (`relativePath`) until the real response lands, since that's not
    // known client-side ahead of time; a plain emoji has no such gap.
    queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) =>
      (prev ?? []).map((m) => {
        if (m._id !== message.id) return m;
        const reactions = m.reactions.slice();
        const idx = reactions.findIndex((r) => (r.emoji ?? r.packItemId) === key);
        if (!wasMine) {
          if (idx >= 0) reactions[idx] = { ...reactions[idx], count: reactions[idx].count + 1, me: true };
          else
            reactions.push({
              emoji: "emoji" in reaction ? reaction.emoji : null,
              packItemId: "packItemId" in reaction ? reaction.packItemId : null,
              relativePath: null,
              packId: null,
              count: 1,
              me: true,
            });
        } else if (idx >= 0) {
          const nextCount = reactions[idx].count - 1;
          if (nextCount <= 0) reactions.splice(idx, 1);
          else reactions[idx] = { ...reactions[idx], count: nextCount, me: false };
        }
        return { ...m, reactions };
      }),
    );

    // The HTTP response carries the full authoritative `reactions` array for
    // this message — patch it straight in rather than waiting on (or
    // replaying) the `reaction_changed` broadcast for our own toggle.
    toggleReaction(message.id, reaction)
      .then((result) => {
        queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) =>
          (prev ?? []).map((m) => (m._id === result.messageId ? { ...m, reactions: result.reactions } : m)),
        );
      })
      .catch(() => {
        queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) =>
          (prev ?? []).map((m) => (m._id === message.id ? { ...m, reactions: previousReactions } : m)),
        );
      });
  }

  function handleEdit(message: MessageBubbleData, content: string, emoji: InlineEmoji[] = []) {
    const previous = messagesQuery.data?.find((m) => m._id === message.id);
    if (!previous) return;
    queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) =>
      (prev ?? []).map((m) => (m._id === message.id ? { ...m, content, customEmoji: emoji, isEdited: true } : m)),
    );
    editMessage(
      message.id,
      content,
      emoji.map(({ offset, length, packItemId }) => ({ offset, length, packItemId })),
    )
      .then(patchMessage)
      .catch(() => {
        queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) =>
          (prev ?? []).map((m) => (m._id === message.id ? previous : m)),
        );
      });
  }

  function handleTogglePin(message: MessageBubbleData) {
    const previous = messagesQuery.data?.find((m) => m._id === message.id);
    if (!previous) return;
    queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) =>
      (prev ?? []).map((m) => (m._id === message.id ? { ...m, isPinned: !message.isPinned } : m)),
    );
    const call = message.isPinned ? unpinMessage(message.id) : pinMessage(message.id);
    call
      .then(patchMessage)
      .catch(() => {
        queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) =>
          (prev ?? []).map((m) => (m._id === message.id ? previous : m)),
        );
      });
  }

  // Pinned bar / pinned list: unpin one or several (the list's "Unpin all").
  async function unpinMany(ids: string[]) {
    const results = await Promise.allSettled(ids.map((id) => unpinMessage(id)));
    for (const r of results) {
      if (r.status === "fulfilled") {
        const updated = r.value;
        queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) =>
          (prev ?? []).map((m) => (m._id === updated._id ? { ...m, isPinned: false } : m)),
        );
      }
    }
    await queryClient.invalidateQueries({ queryKey: pinnedKey(channelId) });
    if (results.some((r) => r.status === "rejected")) setNotice("Couldn't unpin some messages. Try again.");
  }

  function handleDelete(message: MessageBubbleData, mode: "me" | "everyone") {
    const data = messagesQuery.data ?? [];
    const index = data.findIndex((m) => m._id === message.id);
    const previous = data[index];
    if (!previous) return;

    // Optimistic removal either way — for "everyone" this also sidesteps
    // the same self-echo unreliability documented for `message_updated`
    // (the acting user's own socket isn't guaranteed the broadcast back);
    // going optimistic means this view never depended on it in the first
    // place. Rolled back to its exact original position, not just appended
    // back at the end, if the request actually fails.
    queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) => (prev ?? []).filter((m) => m._id !== message.id));

    const call = mode === "everyone" ? deleteMessage(message.id) : deleteForMe(message.id);
    // The server recomputes the chat list preview before answering (for me: my own last
    // visible message), and our own socket isn't guaranteed the broadcast — refetch it.
    call.then(() => queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY, exact: true })).catch(() => {});
    call.catch(() => {
      queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) => {
        const list = prev ?? [];
        if (list.some((m) => m._id === previous._id)) return list;
        const next = list.slice();
        next.splice(Math.min(index, next.length), 0, previous);
        return next;
      });
    });
  }

  function setSelected(update: (prev: Set<string>) => Set<string>) {
    setSelection((prev) => {
      const base = prev?.channelId === channelId ? prev.ids : new Set<string>();
      const ids = update(base);
      return ids.size ? { channelId, ids } : null;
    });
  }
  function toggleSelected(id: string) {
    setSelected((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const selectedMessages = (messagesQuery.data ?? []).filter((m) => selectedIds?.has(m._id));
  const selectedCopyable = selectedMessages.some((m) => !!captionOrText(m).trim());
  const selectedDeletable = selectedMessages.length > 0 && selectedMessages.every((m) => !m._id.startsWith("temp-"));
  // Same rule as toBubbleData's canDeleteForEveryone: your own messages, or any when you may delete others'.
  const canDeleteForEveryoneHere = (m: ChatMessage) => (senderId(m.senderId) === user?._id || messageRights.deleteOthers) && !m._id.startsWith("temp-");
  function copySelected() {
    const text = selectedMessages.map((m) => captionOrText(m).trim()).filter(Boolean).join("\n");
    setSelection(null);
    if (!text) return;
    void copyText(text).then((ok) => setNotice(ok ? "Copied" : "Couldn't copy. Select the text and copy it."));
  }
  /** Deletes each selected message the same way a single delete does; "for everyone" only where
   *  the server allows it for that message. */
  function deleteSelected(forEveryone: boolean) {
    for (const m of selectedMessages) {
      handleDelete({ id: m._id } as MessageBubbleData, forEveryone && canDeleteForEveryoneHere(m) ? "everyone" : "me");
    }
    setSelection(null);
  }

  // The server force-clears a stale `isTyping` after 5s of its own
  // (chat.gateway.ts's per-channel timer) if we never send typing_stop, but
  // that's a safety net, not something to rely on — 2.5s of local idle is
  // what actually clears it promptly for the people watching.
  function stopTyping() {
    if (typingStopTimerRef.current) {
      clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = null;
    }
    if (isTypingRef.current) {
      isTypingRef.current = false;
      getSocket()?.emit("typing_stop", { channelId });
    }
  }

  function handleTyping() {
    const socket = getSocket();
    if (!socket) return;
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      socket.emit("typing_start", { channelId });
    }
    if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = setTimeout(stopTyping, 2500);
  }

  // Fires the real socket send for a given (tempId, content) pair — shared
  // between a fresh send and a retry of a failed one, so retry doesn't need
  // its own copy of the ack-handling logic.
  function sendTextMessage(tempId: string, text: string, replyToId?: string, emoji: InlineEmoji[] = []) {
    const socket = getSocket();
    if (!user) return;
    setSendStatuses((prev) => new Map(prev).set(tempId, "pending"));
    // The outbox keeps every send until the server acknowledges it. Offline, it waits there, and
    // the connect listener below sends it again once we're back; the server answers a repeat with
    // the message it already stored, so nothing is delivered twice.
    outboxRef.current.set(tempId, { channelId, text, replyToId, emoji });
    if (!socket?.connected) return;
    const customEmoji = emoji.length ? emoji.map(({ offset, length, packItemId }) => ({ offset, length, packItemId })) : undefined;
    // No ack in time on a live connection: show it as not sent (retry is safe, see above).
    const timer = window.setTimeout(() => {
      if (outboxRef.current.has(tempId)) setSendStatuses((prev) => new Map(prev).set(tempId, "failed"));
    }, SEND_ACK_MS);
    socket.emit("send_message", { channelId, content: text, type: "text", replyTo: replyToId, tempId, customEmoji }, (ack) => {
      window.clearTimeout(timer);
      outboxRef.current.delete(tempId);
      if ("error" in ack) {
        setSendStatuses((prev) => new Map(prev).set(tempId, "failed"));
        // Muted by an admin since this screen loaded — refresh, which swaps
        // the composer for the "Admins have muted you" notice.
        if (typeof ack.error === "string" && /muted/i.test(ack.error)) {
          queryClient.invalidateQueries({ queryKey: chatManagementKey(channelId) });
        }
        return;
      }
      // The matching `new_message` broadcast (below) usually reconciles this
      // first, but doing it here too covers the rare case where the ack
      // beats the broadcast back, or this socket somehow misses its own
      // broadcast — either way, ending up here twice is harmless (both
      // paths dedupe by the real message's `_id`).
      queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) => {
        const withoutTemp = (prev ?? []).filter((m) => m._id !== tempId);
        if (withoutTemp.some((m) => m._id === ack.message._id)) return withoutTemp;
        return [...withoutTemp, ack.message];
      });
      setSendStatuses((prev) => {
        if (!prev.has(tempId)) return prev;
        const next = new Map(prev);
        next.delete(tempId);
        return next;
      });
    });
  }

  // Sends the outbox again for this chat: on every (re)connect, and when the chat opens.
  const flushOutboxRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    flushOutboxRef.current = () => {
      for (const [tempId, entry] of outboxRef.current) {
        if (entry.channelId === channelId) sendTextMessage(tempId, entry.text, entry.replyToId, entry.emoji);
      }
    };
  });
  useEffect(() => {
    const socket = getSocket();
    const onConnect = () => flushOutboxRef.current();
    socket?.on("connect", onConnect);
    flushOutboxRef.current();
    return () => {
      socket?.off("connect", onConnect);
    };
  }, [channelId]);

  function handleSend(text: string, emoji: InlineEmoji[] = []) {
    if (!user) return;
    stopTyping();
    // Sending from an older stretch goes back to the newest messages (Telegram).
    if (jumped) returnToLatest();
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimisticMessage: ChatMessage = {
      _id: tempId,
      channelId,
      senderId: user._id,
      content: text,
      type: "text",
      attachments: [],
      replyTo: replyTo?.id ?? null,
      replySnapshot: replyTo
        ? { messageId: replyTo.id, senderName: replyTo.mine ? "You" : (replyTo.senderName ?? ""), snippet: replyTo.text ?? "", type: replyTo.type }
        : null,
      isEdited: false,
      isPinned: false,
      mentions: [],
      durationSec: null,
      waveform: null,
      originalFilename: null,
      deletedFor: [],
      forwardFrom: null,
      metadata: null,
      packId: null,
      packItemId: null,
      customEmoji: emoji,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reactions: [],
    };
    queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) => [...(prev ?? []), optimisticMessage]);
    sendTextMessage(tempId, text, replyTo?.id, emoji);
    setReplyTo(null);
  }

  function retrySend(messageId: string) {
    const message = messagesQuery.data?.find((m) => m._id === messageId);
    if (!message) return;
    sendTextMessage(messageId, message.content, message.replyTo ?? undefined, message.customEmoji ?? []);
  }

  function dismissFailedSend(messageId: string) {
    queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) => (prev ?? []).filter((m) => m._id !== messageId));
    setSendStatuses((prev) => {
      if (!prev.has(messageId)) return prev;
      const next = new Map(prev);
      next.delete(messageId);
      return next;
    });
  }

  // A sticker or animated-emoji item tapped in the picker — sent as its own
  // message immediately (no bubble, per MessageBubble's "sticker" type
  // rendering), gated to items already in the sender's own collection (the
  // picker only ever offers those). `packItemId` lets the server resolve +
  // authorize the item and persist `packId` alongside it — same rule as
  // reacting with one, and it bumps the item's usage count server-side, so
  // there's no separate client-initiated "record usage" call to make anymore.
  function handleSendItem(_packId: string, itemId: string, relativePath: string) {
    const socket = getSocket();
    if (!socket || !user) return;
    socket.emit("send_message", {
      channelId,
      content: "",
      type: "sticker",
      attachments: [resolveMediaUrl(relativePath)],
      packItemId: itemId,
    });
  }

  // A GIF from the picker's GIFs tab (your saved library or Giphy) — sent as
  // its own message; a saved one carries its mediaId so the server can attach
  // its real size/blurhash.
  function handleSendGif(gif: { url: string; mediaId?: string }) {
    const socket = getSocket();
    if (!socket || !user) return;
    socket.emit("send_message", {
      channelId,
      content: "",
      type: "gif",
      attachments: [gif.url],
      ...(gif.mediaId ? { attachmentMediaIds: [gif.mediaId] } : {}),
      ...(replyTo ? { replyTo: replyTo.id } : {}),
    });
    setReplyTo(null);
  }

  // Real photo/video attachments: the editor prepares them (the file at the chosen quality,
  // or video edits for the server's ffmpeg pass), the queue uploads them via lib/api/media.ts
  // (MediaService sniffs/dedupes/blurhashes) and sends each with its `mediaId`. "Send as
  // file" items go through the file/music path instead.
  function handleFileSelected(file: File, caption = "") {
    setUploadError(null);
    setCaptionDraft(caption);
    setEditorFiles([file]);
  }

  function handleEditorDone(result: MediaEditorResult) {
    const files = result.items.filter((i) => i.kind === "file").map((i) => i.file);
    const media = result.items.filter((i) => i.kind !== "file");
    // The caption goes with the media album, else with the files ("Send as file").
    if (media.length) mediaQueue.send({ items: media, caption: result.caption });
    if (files.length) sendFiles(files, "file", media.length ? "" : result.caption);
    setEditorFiles(null);
    captionSent.current = true;
    setCaptionDraft("");
  }

  // Voice and round video messages: upload the recorded clip, then send it
  // over the socket and wait for the ack, so a failure (upload or send)
  // rejects back into the recorder — which keeps the clip and offers a
  // retry — instead of silently losing a recording. `uploading_start/stop`
  // lets the other side see "uploading…" while it's in flight.
  function emitWithAck(dto: CreateMessageInput): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = getSocket();
      if (!socket?.connected) {
        reject(new Error("You're offline. Reconnect and try again."));
        return;
      }
      const timer = setTimeout(() => reject(new Error("Sending took too long. Try again.")), 20_000);
      socket.emit("send_message", dto, (ack) => {
        clearTimeout(timer);
        if ("error" in ack) reject(new Error(typeof ack.error === "string" ? ack.error : "The message didn't send. Try again."));
        else resolve();
      });
    });
  }

  async function sendRecording(kind: "voice" | "video_note", recording: RecordingResult) {
    if (!user) return;
    const socket = getSocket();
    socket?.emit("uploading_start", { channelId });
    try {
      const ext = extensionForMime(recording.mimeType);
      const replyToId = replyTo?.id;
      if (kind === "voice") {
        const uploaded = await uploadVoice(recording.blob, `voice-message.${ext}`).catch((err) => {
          throw new Error(err instanceof ApiError ? err.message : "The voice message didn't upload. Try again.");
        });
        await emitWithAck({
          channelId,
          content: "",
          type: "voice",
          attachments: [uploaded.url],
          durationSec: recording.durationSec,
          waveform: recording.waveform,
          replyTo: replyToId,
        });
      } else {
        const uploaded = await uploadVideoNote(recording.blob, `video-message.${ext}`).catch((err) => {
          throw new Error(err instanceof ApiError ? err.message : "The video message didn't upload. Try again.");
        });
        await emitWithAck({
          channelId,
          content: "",
          type: "video_note",
          attachments: [uploaded.url],
          attachmentMediaIds: [uploaded.mediaId],
          durationSec: uploaded.durationSec ? Math.round(uploaded.durationSec) : recording.durationSec,
          replyTo: replyToId,
        });
      }
      if (replyToId) setReplyTo(null);
    } finally {
      socket?.emit("uploading_stop", { channelId });
    }
  }

  // Only meaningful for a private DM — undefined for group/channel skips
  // the fetch entirely (usePresence no-ops on a falsy id) rather than
  // tracking presence for something with no single "other side".
  const otherUserPresence = usePresence(channel?.type === "private" ? channel.otherUser?._id : undefined);
  // Their "Calls" privacy: the profile view says whether you may call them (cached, shared with the profile page).
  const dmPeerId = channel?.type === "private" ? channel.otherUser?._id : undefined;
  const dmPeerProfile = useQuery({
    queryKey: ["users", "profile", dmPeerId],
    queryFn: () => getUserProfile(dmPeerId!),
    enabled: !!dmPeerId,
    staleTime: 60_000,
  });

  if (!user) return null;

  const title = channel ? channelDisplayName(channel) : (preview?.name ?? "");
  const pinned = pinnedQuery.data ?? [];
  const isGroupChat = chatType === "group" || chatType === "channel";

  const typingNames = Array.from(typingUsers.values());
  const typingText =
    typingNames.length === 0
      ? null
      : isGroupChat
        ? typingNames.length === 1
          ? `${typingNames[0]} is typing`
          : typingNames.length === 2
            ? `${typingNames[0]} and ${typingNames[1]} are typing`
            : `${typingNames.length} people are typing`
        : "typing";

  const presenceDot: "online" | "offline" | "none" =
    channel?.type !== "private" ? "none" : otherUserPresence?.isOnline ? "online" : otherUserPresence ? "offline" : "none";

  const subtitle =
    typingText ??
    (channel
      ? channel.type === "private"
        ? otherUserPresence?.isOnline
          ? "Online"
          : (presenceStatus(otherUserPresence)?.text ?? "")
        : channel.type === "saved_messages"
          ? "Only you can see this"
          : channel.memberCount != null
            ? memberCountLabel(channel.type, channel.memberCount)
            : ""
      : preview
        ? memberCountLabel(preview.type, preview.memberCount)
        : "");

  const messages = messagesQuery.data ?? [];
  const showJumpButton = jumped || !atBottom;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      {searchOpen ? (
        <ChatSearchBar
          query={searchQuery}
          onQueryChange={(q) => {
            setSearchQuery(q);
            setSearchIndex(0);
          }}
          onClose={closeSearch}
          total={searchTotal}
          currentIndex={searchIndex}
          onOlder={() => setSearchIndex((i) => Math.min(i + 1, Math.max(searchMessageIds.length - 1, 0)))}
          onNewer={() => setSearchIndex((i) => Math.max(i - 1, 0))}
          isPending={searchResultsQuery.isFetching}
        />
      ) : (
        <ChatHeader
          channel={{
            id: channelId,
            title: title || "Loading…",
            kind: chatType,
            presence: presenceDot,
            ...(channel ? {} : { avatarSrc: preview?.image?.[0] ?? null }),
          }}
          subtitle={subtitle}
          typing={!!typingText}
          onOpenSearch={() => setSearchOpen(true)}
          onPickDate={handleJumpToDate}
          onStartCall={channel && channel.type !== "saved_messages" && composerGate?.kind !== "subscriber" ? () => startCall(channelId, title, channel.type === "private") : undefined}
          callBlockedReason={dmPeerProfile.data?.canCall === false ? `${title} doesn't accept calls from you` : undefined}
          onAttach={(anchor) => attachTrigger.current?.(anchor)}
          showAttachHint={attachHint}
        />
      )}

      {/* Voice/video message playing (app-wide player): Telegram-style strip under the header. */}
      <NowPlayingBar />

      {/* Group/channel voice chat running: Telegram's "Voice chat · n participants · Join" bar. */}
      {channel && (channel.type === "group" || channel.type === "channel") && !searchOpen ? <GroupCallBar channelId={channelId} title={title} /> : null}

      {pinned.length > 0 && !searchOpen ? (
        <PinnedBar pins={pinned} currentUserId={user._id} canUnpin={messageRights.pin} onJump={(id) => jumpTo(id, "center", pinned.find((p) => p._id === id)?.createdAt)} onUnpin={unpinMany} followId={pinFollowId} />
      ) : null}

      {(unreadMentionsCount > 0 || unreadReactionsCount > 0) && !searchOpen ? (
        // A "catch me up" snapshot from when this chat was opened (see the
        // queries above).
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-4 py-2 lg:px-6">
          {unreadMentionsCount > 0 ? (
            <button
              type="button"
              onClick={() => jumpTo(unreadMentionsQuery.data!.messages[0]._id, "center", unreadMentionsQuery.data!.messages[0].createdAt)}
              className="pressable inline-flex h-8 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-[13px] font-semibold text-accent-text hover:brightness-95"
            >
              @ {unreadMentionsCount} mention{unreadMentionsCount === 1 ? "" : "s"}
            </button>
          ) : null}
          {unreadReactionsCount > 0 ? (
            <button
              type="button"
              onClick={() => jumpTo(unreadReactionsQuery.data!.messages[0]._id)}
              className="pressable inline-flex h-8 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-[13px] font-semibold text-accent-text hover:brightness-95"
            >
              {unreadReactionsCount} new reaction{unreadReactionsCount === 1 ? "" : "s"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {wallpaper ? <ChatWallpaper wallpaper={wallpaper} /> : null}

        <div
          ref={scrollContainerRef}
          onScroll={handleMessagesScroll}
          onWheel={markUserScroll}
          onTouchMove={markUserScroll}
          onKeyDown={markUserScroll}
          onPointerDown={markUserScroll}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={title ? `Messages with ${title}` : "Messages"}
          aria-busy={settling || undefined}
          className={cn(
            "absolute inset-0 overflow-y-auto overscroll-contain px-3 transition-opacity duration-[var(--dur-fast)] lg:px-6",
            settling && "opacity-0 transition-none",
          )}
        >
          {/* Bottom-anchored: a short conversation sits just above the
           * composer, like every messenger, instead of at the top. */}
          <div className="flex min-h-full flex-col justify-end">
          {loadOlderMutation.isPending || (jumpMutation.isPending && messages.length === 0) ? (
            <div className="flex justify-center py-3" role="status" aria-label="Loading older messages">
              <span className="size-5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
            </div>
          ) : !hasMoreOlder && messages.length > 0 && !jumped ? (
            <div className="flex justify-center pb-2 pt-6">
              <span className="rounded-full bg-sunken/90 px-3 py-1 text-[12.5px] font-medium text-muted">Start of the conversation</span>
            </div>
          ) : null}

          {messagesQuery.isPending ? (
            <MessageListSkeleton />
          ) : messagesQuery.isError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <p className="text-[14.5px] text-fg-2">Messages didn&apos;t load. Check your connection and try again.</p>
              <Button size="sm" variant="secondary" onClick={() => messagesQuery.refetch()} loading={messagesQuery.isRefetching}>
                Try again
              </Button>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="flex size-14 items-center justify-center rounded-full bg-accent-soft text-accent-text">
                <MessageCircleHeart className="size-6" strokeWidth={1.8} aria-hidden />
              </div>
              <p className="text-[16px] font-semibold">No messages yet</p>
              <p className="max-w-[280px] text-[14px] text-muted">
                {composerGate
                  ? chatType === "channel"
                    ? "Nothing has been posted in this channel yet."
                    : "Nothing has been said in this group yet."
                  : `Say hello to ${title || "them"} — your first message starts the conversation.`}
              </p>
            </div>
          ) : (
            // Photos/videos open in the in-app viewer, paging through this chat's loaded media.
            <MediaViewerProvider messages={messages} currentUserId={user._id}>
            <div className="relative mx-auto w-full max-w-[860px]" style={{ height: rowVirtualizer.getTotalSize() }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const i = virtualRow.index;
                const m = messages[i];
                if (!m) return null;
                const prev = messages[i - 1];
                const next = messages[i + 1];
                const showDateDivider = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
                const showUnreadDivider = m._id === unreadDividerId;
                const wpMeta = senderId(m.senderId) !== user._id ? wallpaperChangeMetadata(m) : null;
                const systemAction: MessageBubbleData["systemAction"] = wpMeta
                  ? {
                      label: "Use this wallpaper",
                      pending: acceptWallpaperMutation.isPending && acceptWallpaperMutation.variables?.messageId === m._id,
                      done: acceptedWallpaperMsgIds.has(m._id),
                      onClick: () => acceptWallpaperMutation.mutate({ wallpaperId: wpMeta.wallpaperId, messageId: m._id }),
                    }
                  : undefined;
                return (
                  <div
                    key={virtualRow.key}
                    data-index={i}
                    ref={rowVirtualizer.measureElement}
                    className={cn("absolute inset-x-0 top-0", i === messages.length - 1 && "pb-4")}
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {showDateDivider ? (
                      <div className="flex justify-center pb-1 pt-4">
                        <span className="rounded-full border border-line bg-panel px-3 py-1 text-[12.5px] font-semibold text-fg-2 shadow-sm">
                          {formatDateDivider(m.createdAt)}
                        </span>
                      </div>
                    ) : null}
                    {showUnreadDivider ? (
                      <div className="flex items-center gap-3 py-3" role="separator" aria-label="New messages">
                        <span className="h-px flex-1 bg-accent/40" />
                        <span className="text-[12.5px] font-bold text-accent-text">New messages</span>
                        <span className="h-px flex-1 bg-accent/40" />
                      </div>
                    ) : null}
                    <MessageBubble
                      message={toBubbleData(
                        m,
                        user._id,
                        messageRights,
                        isReadByOthers(m),
                        systemAction,
                        m._id === highlightedMessageId,
                        sendStatuses.get(m._id),
                      )}
                      groupPosition={showDateDivider || showUnreadDivider ? (continuesRun(m, next) ? "first" : "single") : groupPositionOf(prev, m, next)}
                      showSender={chatType === "group"}
                      // Previewing (not a member): read-only. A channel
                      // subscriber can react but not reply (they can't post).
                      onReply={
                        composerGate
                          ? undefined
                          : (msg) => {
                              setEditingMessage(null);
                              setReplyTo(msg);
                            }
                      }
                      onToggleReaction={isPreviewOnly ? undefined : handleToggleReaction}
                      onStartEdit={(msg) => {
                        setReplyTo(null);
                        setEditingMessage(msg);
                      }}
                      onDelete={isPreviewOnly ? undefined : handleDelete}
                      selectMode={!!selectedIds}
                      selected={selectedIds?.has(m._id) ?? false}
                      onClearSelect={() => setSelection(null)}
                      textSelecting={textSelectId === m._id}
                      onTextSelect={(id) => setTextSelectId(id)}
                      onToggleSelect={toggleSelected}
                      onStartSelect={(id) => setSelected(() => new Set([id]))}
                      everyoneLabel={chatType === "private" ? `Also delete for ${title}` : "Also delete for everyone"}
                      onTogglePin={isPreviewOnly ? undefined : handleTogglePin}
                      onRetrySend={retrySend}
                      onDismissFailedSend={dismissFailedSend}
                      quickReactionEmoji={user.quickReaction}
                      quickReactionItem={user.quickReactionItem}
                      chatKind={chatType}
                      isChatAdmin={myRole === "owner" || myRole === "admin"}
                      onJumpToMessage={handleJumpToReplied}
                    />
                  </div>
                );
              })}
            </div>
            </MediaViewerProvider>
          )}
          {loadNewerMutation.isPending ? (
            <div className="flex justify-center py-3" role="status" aria-label="Loading newer messages">
              <span className="size-5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
            </div>
          ) : null}
          </div>
        </div>

        {/* Floating date (see showFloatingDate): decorative, never takes a tap, never moves the layout. */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center transition-opacity duration-[var(--dur-base)] ease-out motion-reduce:transition-none",
            floatShown && floatDate ? "opacity-100" : "opacity-0",
          )}
        >
          <span dir="auto" className="rounded-full border border-line bg-raised/95 px-3 py-1 text-[12.5px] font-semibold text-fg-2 shadow-sm">
            {floatDate?.label ?? ""}
          </span>
        </div>

        {jumpMutation.isPending || dateJumpPending || settling ? (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center" role="status" aria-label="Loading messages">
            <span className="flex size-9 items-center justify-center rounded-full border border-line bg-raised shadow-md">
              <span className="size-4 animate-spin rounded-full border-2 border-muted border-t-transparent" />
            </span>
          </div>
        ) : null}
        {notice ? (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4">
            <span role="status" className="fade-in rounded-full bg-fg/85 px-3.5 py-1.5 text-[13.5px] font-medium text-canvas shadow-md">
              {notice}
            </span>
          </div>
        ) : null}

        {(showJumpButton || returnStack.length > 0) && messages.length > 0 ? (
          <button
            type="button"
            onClick={jumpToLatest}
            aria-label={
              returnStack.length ? "Back to the reply" : newWhileAway ? `Jump to latest, ${newWhileAway} new` : "Jump to latest"
            }
            title={returnStack.length ? "Back to the reply" : "Jump to latest"}
            className="pop-in pressable absolute bottom-4 end-4 z-10 flex size-11 items-center justify-center rounded-full border border-line bg-raised text-fg-2 shadow-md hover:text-fg lg:end-6"
          >
            <ArrowDown className="size-5" strokeWidth={2} />
            {newWhileAway ? (
              <span className="tabular absolute -top-1.5 end-0 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[11.5px] font-bold text-accent-fg">
                {newWhileAway > 99 ? "99+" : newWhileAway}
              </span>
            ) : null}
          </button>
        ) : null}
      </div>

      <div className="relative z-10 shrink-0 border-t border-line bg-panel px-3 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2.5 lg:px-6 lg:pb-3 lg:pt-3">
        {uploadError ? (
          <div role="alert" className="fade-in mx-auto mb-2 flex max-w-[860px] items-center gap-3 rounded-[var(--radius-sm)] bg-danger-soft px-3.5 py-2 text-[13.5px] text-danger">
            <span className="min-w-0 flex-1">{uploadError}</span>
            <button type="button" onClick={() => setUploadError(null)} aria-label="Dismiss" className="pressable flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-danger/10">
              <X className="size-4" strokeWidth={2} />
            </button>
          </div>
        ) : null}
        <MediaSendProgress jobs={mediaQueue.jobs} onCancel={mediaQueue.cancel} onRetry={mediaQueue.retry} />
        {editorFiles ? (
          <MediaEditor
            key={editorFiles.map((f) => f.name).join("|")}
            files={editorFiles}
            initialCaption={captionDraft}
            onClose={() => {
              setEditorFiles(null);
              endCaptionDraft();
            }}
            onDone={handleEditorDone}
          />
        ) : null}
        {fileDraft ? (
          <FileSendDialog
            files={fileDraft.files}
            mode={fileDraft.mode}
            initialCaption={fileDraft.caption}
            onClose={() => {
              setFileDraft(null);
              endCaptionDraft();
            }}
            onSend={(files, mode, caption) => {
              captionSent.current = true;
              sendFiles(files, mode, caption);
            }}
          />
        ) : null}
        {iBlockedThem ? (
          <button
            type="button"
            onClick={() => unblockMutation.mutate()}
            disabled={unblockMutation.isPending}
            aria-busy={unblockMutation.isPending || undefined}
            className="pressable flex h-12 w-full items-center justify-center gap-2 rounded-full bg-accent text-[15px] font-semibold text-accent-fg shadow-md hover:bg-accent-hover disabled:opacity-70"
          >
            <Unlock className="size-[18px]" strokeWidth={2.1} aria-hidden />
            {unblockMutation.isPending ? "Unblocking…" : `Unblock ${title}`}
          </button>
        ) : blockedByThem ? (
          <p className="rounded-[22px] border border-line bg-sunken px-4 py-3 text-center text-[14px] text-muted">You can&apos;t message this person.</p>
        ) : bannedHere ? (
          <p className="rounded-[22px] border border-line bg-sunken px-4 py-3 text-center text-[14px] text-muted">You can&apos;t send messages in this chat anymore.</p>
        ) : selectedIds ? (
          <SelectionBar
            count={selectedIds.size}
            canCopy={selectedCopyable}
            canDelete={selectedDeletable}
            onCopy={copySelected}
            onDelete={() => setBatchDeleteOpen(true)}
            onCancel={() => setSelection(null)}
          />
        ) : (
        <Composer
          onAttachHint={setAttachHint}
          registerAttach={(open) => {
            attachTrigger.current = open;
          }}
          // Keyed by chat: this view is reused across chats (route param, not
          // a remount), and without a fresh Composer a half-typed draft — or
          // a voice/video recording in progress — carried over into the next
          // chat, where pressing send would deliver it to the wrong people.
          key={channelId}
          gate={composerGate}
          placeholder={title ? `Message ${title}` : "Write a message"}
          channelId={channelId}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          editing={editingMessage}
          onCancelEdit={() => setEditingMessage(null)}
          onSubmitEdit={(text, emoji) => {
            if (editingMessage) handleEdit(editingMessage, text, emoji);
            setEditingMessage(null);
          }}
          onSend={handleSend}
          onSendItem={handleSendItem}
          onSendGif={handleSendGif}
          onFileSelected={handleFileSelected}
          onMediaSelected={(files, caption) => {
            setUploadError(null);
            setCaptionDraft(caption);
            setEditorFiles(files);
          }}
          onSendFiles={(files, mode, caption) => setFileDraft({ files, mode, caption })}
          restoreText={composerRestore}
          attaching={!!editorFiles}
          onTyping={handleTyping}
          onSendVoice={(r) => sendRecording("voice", r)}
          onSendVideoNote={(r) => sendRecording("video_note", r)}
          allow={composerAllow}
        />
        )}
        {textSelectId ? (
          <SelectTextBar
            target={textSelectTarget}
            text={captionOrText(messagesQuery.data?.find((m) => m._id === textSelectId) ?? ({} as ChatMessage))}
            onDone={() => {
              window.getSelection()?.removeAllRanges();
              setTextSelectId(null);
            }}
          />
        ) : null}
        {batchDeleteOpen ? (
          <DeleteMessagesDialog
            count={selectedIds?.size ?? 0}
            canEveryone={selectedMessages.length > 0 && selectedMessages.every(canDeleteForEveryoneHere)}
            everyoneLabel={chatType === "private" ? `Also delete for ${title}` : "Also delete for everyone"}
            onClose={() => setBatchDeleteOpen(false)}
            onConfirm={(forEveryone) => {
              setBatchDeleteOpen(false);
              deleteSelected(forEveryone);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
