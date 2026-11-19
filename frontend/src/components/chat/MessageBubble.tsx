"use client";

import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  AlertCircle,
  BookmarkCheck,
  BookmarkPlus,
  Check,
  CheckCheck,
  Clock3,
  Copy,
  CornerUpLeft,
  Flag,
  MoreHorizontal,
  Pencil,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Pin,
  PinOff,
  SmilePlus,
  Sticker,
  TextSelect,
  ListChecks,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { useDragX } from "@/hooks/use-drag-x";
import { useSaveGif } from "@/hooks/use-save-gif";
import { Avatar } from "@/components/ui/Avatar";
import { DeleteMessagesDialog } from "@/components/chat/DeleteMessagesDialog";
import { Menu, useMenuState, type MenuItem } from "@/components/ui/Menu";
import { ReactionChip, SelectTextBar, consumeMenuDismissClick, copyText, useTouchLongPress } from "@/components/chat/message-touch";
import { cn } from "@/lib/cn";
import { personColor } from "@/lib/avatar-color";
import { describeCallLog, parseCallLog } from "@/lib/call-log";
import { resolveMediaUrl, videoPosterUrl } from "@/lib/media-url";
import { StickerEmojiPicker } from "@/components/packs/StickerEmojiPicker";
import { PackPreviewSheet } from "@/components/packs/PackPreviewSheet";
import { PackImage } from "@/components/packs/PackImage";
import { ReportDialog } from "@/components/chat/ReportDialog";
import { MessageInfoMenuRow, MessageInfoSheet, type MessageInfoChatKind } from "@/components/chat/MessageInfoSheet";
import { VoicePlayer } from "@/components/media/VoicePlayer";
import { VideoNotePlayer } from "@/components/media/VideoNotePlayer";
import { VideoPlayer } from "@/components/media/VideoPlayer";
import { BubbleGifVideo, BubbleImage, BubbleSticker, MediaPlaceholder, bubbleMediaWidth } from "@/components/media/BubbleMedia";
import { FileMessage } from "@/components/media/FileMessage";
import { MediaAlbum } from "@/components/media/MediaAlbum";
import { MusicMessage } from "@/components/media/MusicMessage";
import { MediaViewer, mediaItemsFrom, useMediaViewer } from "@/components/media/MediaViewer";
import { displayAspect, resolveAttachmentUrl } from "@/lib/media-src";
import type { PlaybackTrack } from "@/lib/playback";
import type { AttachmentMeta, MessageType } from "@/lib/api/types";

const REPLY_THRESHOLD = 56;
const QUICK_REACTIONS = ["❤️", "😂", "👍", "😮", "😢"];

/** Exactly one of `emoji`/`packItemId` is set on a reaction — mirrors
 *  MessageReaction (lib/api/types.ts). Same shape both as an input (what to
 *  toggle) and as a stored reaction row's identity. */
export type ReactionInput = { emoji: string } | { packItemId: string };

export interface MessageBubbleReaction {
  emoji: string | null;
  packItemId: string | null;
  /** Only set alongside `packItemId` — resolve with resolveMediaUrl(). */
  relativePath: string | null;
  /** The pack a sticker/animated-emoji reaction came from (long-press opens it). */
  packId?: string | null;
  count: number;
  reactedByMe: boolean;
}

/** Where this message sits in a run of consecutive messages from the same
 * sender — drives the connected corner radii, spacing, and whether the
 * sender's name/avatar are shown. */
export type GroupPosition = "single" | "first" | "middle" | "last";

export interface MessageBubbleData {
  id: string;
  type: MessageType;
  mine: boolean;
  senderName?: string;
  /** Channels with signatures on: the author's name, shown next to the time (never a link). */
  signature?: string | null;
  /** Only set alongside `senderName` (never for `mine`) — lets the name
   *  link to that sender's profile view, and picks their person colour. */
  senderId?: string;
  /** The sender's profile photo (`avatarUrl[0]` of a populated sender), shown
   *  next to their last message in a run in groups. Falls back to initials. */
  senderAvatarUrl?: string | null;
  text?: string;
  /** `messageId`: the quoted message — tapping the quote jumps to it. */
  replyTo?: { senderName: string; snippet: string; messageId?: string | null } | null;
  /** Absolute URLs, as served by the backend's /uploads static route. */
  attachments?: string[];
  /** Keyed by the exact URL in `attachments` — see lib/api/types.ts's
   *  `ChatMessage.attachmentMeta` for where this comes from. Not every
   *  attachment has an entry (e.g. a GIF, or one sent before this existed). */
  attachmentMeta?: Record<string, AttachmentMeta> | null;
  /** Set together when this is a sticker/animated-emoji message sent from a pack item — lets the
   *  sticker be tapped to open/add its pack, even for a received one you don't have yet. */
  packId?: string | null;
  packItemId?: string | null;
  reactions?: MessageBubbleReaction[];
  /** Animated emoji drawn inline over unicode fallback spans in `text`. */
  customEmoji?: { offset: number; length: number; packItemId: string; packId?: string; relativePath: string; stillPath?: string }[] | null;
  /** Voice / video messages: recorded length in seconds. */
  durationSec?: number | null;
  /** Voice messages: 0–1 level samples for the waveform. */
  waveform?: number[] | null;
  /** File / music messages: the name it was sent with. */
  originalFilename?: string | null;
  createdAt: string;
  /** Full timestamp for the hover tooltip / <time dateTime>. */
  createdAtIso?: string;
  read?: boolean;
  isEdited?: boolean;
  isPinned?: boolean;
  /** Whether *this viewer* is allowed to pin/unpin — private: either person;
   *  group/channel: the "Pin messages" right (`myPermissions.member.pinMessages`). */
  canPin?: boolean;
  /** Whether *this viewer* can delete for everyone — the sender, or someone
   *  with the "Delete messages" admin right. Deleting "for me" is always allowed. */
  canDeleteForEveryone?: boolean;
  /** Someone else's post this viewer may still edit (a channel admin with
   *  "Edit others' posts"). Your own text messages are always editable. */
  canEditOthers?: boolean;
  /** System messages only — a tappable follow-up action rendered under the
   *  pill (e.g. "Use this wallpaper" on a wallpaper_changed message, shown
   *  only to a viewer who isn't the one who triggered it). */
  systemAction?: { label: string; pending: boolean; done: boolean; onClick: () => void };
  /** In-chat search jumped here — a brief highlight, not a persisted state. */
  highlighted?: boolean;
  /** Optimistic-send state — only ever set on `mine` messages, while the
   *  real `_id` doesn't exist yet (`id` is a client-generated `tempId`). */
  sendStatus?: "pending" | "failed";
}

export interface MessageBubbleProps {
  message: MessageBubbleData;
  /** Multi-select: while on, a tap toggles this message and its menu, long press and swipe are off. */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (messageId: string) => void;
  onStartSelect?: (messageId: string) => void;
  /** Leaves multi-select (a hold on a selected message starts text selection instead). */
  onClearSelect?: () => void;
  /** This message is in text-selection mode; `onTextSelect` starts it (its id) or ends it (null). */
  textSelecting?: boolean;
  onTextSelect?: (messageId: string | null) => void;
  /** The delete checkbox's label when the message can go for everyone (a direct chat names them). */
  everyoneLabel?: string;
  groupPosition?: GroupPosition;
  /** Group/channel chats: show sender names + avatars for other people. */
  showSender?: boolean;
  onReply?: (message: MessageBubbleData) => void;
  onToggleReaction?: (message: MessageBubbleData, reaction: ReactionInput) => void;
  /** Opens the composer in edit mode for this message. */
  onStartEdit?: (message: MessageBubbleData) => void;
  onDelete?: (message: MessageBubbleData, mode: "me" | "everyone") => void;
  onTogglePin?: (message: MessageBubbleData) => void;
  /** Only relevant when `message.sendStatus === "failed"`. */
  onRetrySend?: (messageId: string) => void;
  onDismissFailedSend?: (messageId: string) => void;
  /** The viewer's saved quick-reaction emoji (Settings → Quick reaction) —
   *  double-clicking the bubble toggles a reaction with it, and it leads
   *  the hover bar / long-press strip. */
  quickReactionEmoji?: string;
  /** Set when the quick reaction is an animated emoji: double-click reacts
   *  with this pack item instead (`quickReactionEmoji` is then its fallback). */
  quickReactionItem?: { packItemId: string; relativePath: string; thumbPath: string; stillPath: string } | null;
  /** Drives the menu's "Seen by N" / "Read at …" / reactions row (MessageInfoSheet). */
  chatKind?: MessageInfoChatKind;
  /** Channel admins may see who reacted to posts. */
  isChatAdmin?: boolean;
  /** Tapping the quoted reply preview: scroll to (loading if needed) and flash the original. */
  onJumpToMessage?: (messageId: string, fromMessageId: string) => void;
}

function fileNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(url.split("/").pop() ?? url);
  } catch {
    return url;
  }
}

function reactionKey(r: Pick<MessageBubbleReaction, "emoji" | "packItemId">): string {
  return r.emoji ?? r.packItemId ?? "";
}

function reactionInputOf(r: Pick<MessageBubbleReaction, "emoji" | "packItemId">): ReactionInput {
  return r.packItemId ? { packItemId: r.packItemId } : { emoji: r.emoji! };
}

// Mirrors the backend's own mention regex exactly (MessageService.resolveMentions
// — `/@([a-zA-Z0-9_]+)/g`): letters/digits/underscore only, no dots/hyphens, no
// whitespace-boundary requirement before the `@`. Highlighting anything this
// regex wouldn't also match server-side would be misleading — it'd look like
// a real mention that never actually notified anyone.
const MENTION_PATTERN = /@([a-zA-Z0-9_]+)/g;
const URL_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

/** Message text with `@mentions` highlighted, bare URLs made into links, and
 *  inline animated emoji drawn over their unicode fallback spans. Doesn't
 *  verify a mention is an actual member; the backend already silently drops
 *  non-member mentions server-side. */
function RichText({
  text,
  mine,
  emoji,
  onOpenPack,
}: {
  text: string;
  mine: boolean;
  emoji?: MessageBubbleData["customEmoji"];
  /** Tapping an inline animated emoji opens its pack. */
  onOpenPack?: (packId: string) => void;
}) {
  const parts: React.ReactNode[] = [];
  let key = 0;
  const plain = (chunkText: string) => {
    for (const chunk of chunkText.split(URL_PATTERN)) {
      if (!chunk) continue;
      if (/^https?:\/\//.test(chunk)) {
        parts.push(
          <a
            key={key++}
            href={chunk}
            target="_blank"
            rel="noreferrer noopener"
            className={cn("break-all underline underline-offset-2", mine ? "decoration-[var(--own-meta)]" : "text-accent-text")}
          >
            {chunk}
          </a>,
        );
        continue;
      }
      let lastIndex = 0;
      // `matchAll` manages its own iteration state internally — safe on a
      // module-level regex during render, unlike a manual `.exec()` loop.
      for (const match of chunk.matchAll(MENTION_PATTERN)) {
        if (match.index > lastIndex) parts.push(chunk.slice(lastIndex, match.index));
        parts.push(
          <span key={key++} className={cn("font-semibold", mine ? "underline decoration-[var(--own-meta)] underline-offset-2" : "text-accent-text")}>
            {match[0]}
          </span>,
        );
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < chunk.length) parts.push(chunk.slice(lastIndex));
    }
  };
  let pos = 0;
  for (const e of [...(emoji ?? [])].sort((a, b) => a.offset - b.offset)) {
    if (e.offset < pos || e.offset + e.length > text.length) continue;
    plain(text.slice(pos, e.offset));
    const fallback = text.slice(e.offset, e.offset + e.length);
    const img = <PackImage thumbPath={e.relativePath} stillPath={e.stillPath} alt={fallback} title={fallback} className="mx-px inline-block size-[1.3em] object-contain align-[-0.28em]" />;
    const packId = e.packId;
    parts.push(
      packId && onOpenPack ? (
        <button key={key++} type="button" onClick={() => onOpenPack(packId)} aria-label={`${fallback} — open its pack`} className="inline align-baseline">
          {img}
        </button>
      ) : (
        <span key={key++}>{img}</span>
      ),
    );
    pos = e.offset + e.length;
  }
  plain(text.slice(pos));
  return <>{parts}</>;
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u;

/** How many emoji a text message is made of, if it's *only* emoji (inline
 *  animated ones included) — 0 otherwise. Drives the big, bubble-less
 *  rendering for 1–3 emoji, as in Telegram. */
function emojiOnlyCount(text: string | undefined, emoji: MessageBubbleData["customEmoji"]): number {
  if (!text) return 0;
  let rest = "";
  let pos = 0;
  for (const e of [...(emoji ?? [])].sort((a, b) => a.offset - b.offset)) {
    rest += text.slice(pos, e.offset);
    pos = e.offset + e.length;
  }
  rest += text.slice(pos);
  const trimmed = rest.replace(/\s+/g, "");
  if (trimmed && !EMOJI_ONLY.test(trimmed)) return 0;
  if (/[0-9#*]/.test(trimmed)) return 0; // keycap digits are Emoji_Component too
  const unicode = trimmed ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)).length : 0;
  return unicode + (emoji?.length ?? 0);
}

/** `content` for a `voice_call` message is JSON (`{callLog, kind,
 * durationMinutes?}`, see calls.service.ts's `finalizeCall`), not plain
 * text — `toBubbleData` still puts it in `.text` unchanged since only this
 * one message type needs it parsed. `mine` is always "the caller" for this
 * message type (the backend posts it under the initiator's senderId). */
function CallLogContent({ message }: { message: MessageBubbleData }) {
  const log = parseCallLog(message.text ?? "");
  const label = log ? describeCallLog(log, message.mine) : "Call";
  const missedLike = log?.kind === "missed" || log?.kind === "declined";
  const Icon = missedLike ? PhoneMissed : message.mine ? PhoneOutgoing : PhoneIncoming;
  return (
    <div className="flex items-center gap-3 py-0.5 pe-1">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full",
          message.mine ? "bg-white/15" : missedLike ? "bg-danger-soft text-danger" : "bg-sunken text-fg-2",
        )}
      >
        <Icon className="size-[18px]" strokeWidth={2} aria-hidden />
      </span>
      <span className="text-[15px] font-semibold">{label}</span>
    </div>
  );
}

/** Renders an existing reaction's glyph — a small pack-item thumbnail when
 *  it's a sticker/animated-emoji reaction, otherwise the plain emoji char. */
function ReactionGlyph({ r }: { r: Pick<MessageBubbleReaction, "emoji" | "relativePath"> }) {
  if (r.relativePath) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- remote, backend-hosted, size unknown ahead of time
      <img src={resolveMediaUrl(r.relativePath)} alt="" className="size-4 object-contain" />
    );
  }
  return <span className="text-[15px] leading-none">{r.emoji}</span>;
}

/** The quoted message above a reply. Tappable (Telegram): jumps to the original. */
function ReplyQuote({
  reply,
  onJump,
  className,
  children,
}: {
  reply: { senderName: string; snippet: string };
  onJump?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  if (!onJump) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onJump();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      aria-label={`Go to the message from ${reply.senderName} that this replies to`}
      // A soft tint in the quote's own colour (works on own/other bubbles and stickers alike),
      // instead of a brightness filter that muddied the bubble colour.
      className={cn(
        "relative block min-w-0 cursor-pointer text-start outline-none",
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:bg-current after:opacity-0 after:transition-opacity after:duration-[var(--dur-fast)]",
        "hover:after:opacity-[0.07] active:after:opacity-[0.12] focus-visible:ring-2 focus-visible:ring-accent/60",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Status meta: time · edited · delivery tick. Rendered inside the bubble. */
/** `onSurface`: rendered on a neutral pill outside any bubble (stickers,
 *  video messages) — must not use the own-bubble's pale meta colour there. */
function Meta({ message, overlay, onSurface }: { message: MessageBubbleData; overlay?: boolean; onSurface?: boolean }) {
  const mine = message.mine && !onSurface;
  return (
    <span
      className={cn(
        "tabular inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11.5px] leading-none",
        overlay ? "rounded-full bg-black/50 px-1.5 py-[3px] text-[11px] text-white backdrop-blur-[2px]" : mine ? "text-own-meta" : "text-muted",
      )}
    >
      {message.isPinned ? <Pin className="size-3 rotate-45" strokeWidth={2.2} aria-label="Pinned" /> : null}
      {message.isEdited ? <span>edited</span> : null}
      {message.signature ? <span className="max-w-[12rem] truncate">{message.signature}</span> : null}
      <time dateTime={message.createdAtIso} title={message.createdAtIso ? new Date(message.createdAtIso).toLocaleString() : undefined}>
        {message.createdAt}
      </time>
      {message.mine ? (
        message.sendStatus === "pending" ? (
          <Clock3 className="size-3.5" strokeWidth={2} aria-label="Sending" />
        ) : message.sendStatus === "failed" ? (
          <AlertCircle className="size-3.5 text-danger" strokeWidth={2.2} aria-label="Not sent" />
        ) : message.read ? (
          <CheckCheck className={cn("size-4", overlay ? "" : onSurface ? "text-accent-text" : "text-own-fg")} strokeWidth={2.2} aria-label="Seen" />
        ) : (
          <Check className="size-4" strokeWidth={2.2} aria-label="Sent" />
        )
      ) : null}
    </span>
  );
}

/** The time/ticks at the end of a text (or caption), on their own line under the text, at the
 *  bubble's end (right in LTR, left in RTL). Never beside the last line: that read as messy. */
function MetaFloat({ message }: { message: MessageBubbleData }) {
  return (
    <span className="mt-1 flex w-full justify-end leading-none" style={{ unicodeBidi: "isolate" }}>
      <Meta message={message} />
    </span>
  );
}

/** A single video in a bubble. Its frame takes the video's own shape once the size is
 *  known (portrait stays portrait, narrower; landscape stays wide) — no 16:9 crop. */
function BubbleVideoBox({
  url,
  meta,
  durationSec,
  label,
  onOpen,
}: {
  url: string;
  meta?: AttachmentMeta | null;
  durationSec?: number | null;
  label: string;
  onOpen: () => void;
}) {
  const [live, setLive] = useState<number | null>(null);
  // Before the video itself loads (it's fetched only on screen), its poster frame already
  // has the video's shape — use that; the video's own size corrects it once it arrives.
  useEffect(() => {
    const p = videoPosterUrl(url);
    if (!p) return;
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth && img.naturalHeight) setLive(img.naturalWidth / img.naturalHeight);
    };
    img.src = p;
  }, [url]);
  const known = displayAspect(meta?.width, meta?.height, live ?? 16 / 9);
  const aspect = Math.min(1.9, Math.max(0.5625, live ?? known));
  // The frame fills its media column (which is at least the picture's own width), so the bubble
  // is exactly as wide as the video.
  const minWidth = bubbleMediaWidth(aspect);
  return (
    <div
      className="relative overflow-hidden bg-black"
      style={{ width: "100%", minWidth, aspectRatio: String(aspect), maxHeight: 380 }}
      data-media-box=""
    >
      <MediaPlaceholder blurhash={meta?.blurhash} />
      <VideoPlayer
        src={url}
        poster={videoPosterUrl(url)}
        durationSec={durationSec}
        label={label}
        onExpand={onOpen}
        onVideoSize={(w, h) => setLive(w / h)}
        fit="cover"
        className="absolute inset-0 size-full bg-transparent"
      />
    </div>
  );
}

/** How long a single click waits for a second one (a double tap) before it opens the action menu. */
const DOUBLE_TAP_WAIT_MS = 300;

function MessageBubbleImpl({
  message,
  selectMode = false,
  selected = false,
  onToggleSelect,
  onStartSelect,
  onClearSelect,
  textSelecting = false,
  onTextSelect,
  everyoneLabel = "Also delete for everyone",
  groupPosition = "single",
  showSender = false,
  onReply,
  onToggleReaction,
  onStartEdit,
  onDelete,
  onTogglePin,
  onRetrySend,
  onDismissFailedSend,
  quickReactionEmoji,
  quickReactionItem,
  chatKind,
  isChatAdmin,
  onJumpToMessage,
}: MessageBubbleProps) {
  const mine = message.mine;
  const menu = useMenuState();
  const [picker, setPicker] = useState<{ x: number; y: number; placement: "up" | "down" } | null>(null);
  const [packPreviewId, setPackPreviewId] = useState<string | null>(null);
  /** "Select text" mode: the bubble's text is selectable, with a Copy/Done bar. */
  // Text-selection mode is owned by the conversation (the bar lives there too), so it survives this row
  // being unmounted by the list while scrolling. Only Cancel, Back or Escape end it.
  const selecting = textSelecting;
  const textRef = useRef<HTMLSpanElement>(null);
  const mediaViewer = useMediaViewer();
  // Only used when no MediaViewerProvider is mounted above (then just this message's media).
  const [localViewerIndex, setLocalViewerIndex] = useState<number | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [infoTab, setInfoTab] = useState<"seen" | "reactions" | null>(null);
  /** Set when the info sheet was opened from a reaction chip: list only that reaction. */
  const [infoReaction, setInfoReaction] = useState<string | undefined>(undefined);
  const openReactionInfo = (key: string) => {
    setInfoReaction(key);
    setInfoTab("reactions");
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reactButtonRef = useRef<HTMLButtonElement>(null);
  // Where the row was pressed, so a drag doesn't count as a click on it (see onRowClick).
  const rowDown = useRef<{ x: number; y: number } | null>(null);
  const lastQuickReact = useRef(0);
  const menuTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (menuTimer.current) window.clearTimeout(menuTimer.current);
  }, []);
  // A press-and-hold selects the message. On a message that's already selected it starts text
  // selection of that message instead (and leaves multi-select).
  const longPress = useTouchLongPress(() => {
    if (selectMode && selected) {
      onClearSelect?.();
      startSelecting();
      return;
    }
    if (onStartSelect && !selectMode) onStartSelect(message.id);
  }, !selecting && !!onStartSelect);
  /** A tap on a sticker / animated emoji opens its pack — unless that press was a long-press. */
  const openPack = (packId: string) => {
    if (longPress.firedRef.current) return;
    setPackPreviewId(packId);
  };
  const gifSave = useSaveGif(message);
  const repliedId = message.replyTo?.messageId;
  const jumpToReplied =
    repliedId && onJumpToMessage && !message.sendStatus
      ? () => {
          if (longPress.firedRef.current) return;
          onJumpToMessage(repliedId, message.id);
        }
      : undefined;

  // Swipe-to-reply — touch only, so a mouse drag still selects text.
  const dir = mine ? -1 : 1;
  const { dragging, delta, handlers: dragHandlers } = useDragX({
    onEnd: (d) => {
      if (d * dir > REPLY_THRESHOLD && !message.sendStatus && !selectMode) onReply?.(message);
    },
  });
  const touchOnly = <E extends React.PointerEvent>(fn: (e: E) => void) => (e: E) => {
    if (e.pointerType === "touch") fn(e);
  };

  if (message.type === "system") {
    return (
      <div id={`message-${message.id}`} className="flex flex-col items-center gap-2 px-6 py-2 text-center">
        <div className={cn("max-w-[420px] rounded-full bg-sunken px-3.5 py-1.5 text-[13px] leading-snug text-fg-2", message.highlighted && "flash-highlight")}>
          {message.text}
        </div>
        {message.systemAction ? (
          <button
            type="button"
            onClick={message.systemAction.onClick}
            disabled={message.systemAction.pending || message.systemAction.done}
            className="pressable inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[13px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-60"
          >
            {message.systemAction.done ? <Check className="size-4" strokeWidth={2.4} aria-hidden /> : null}
            {message.systemAction.done ? "Applied" : message.systemAction.pending ? "Applying…" : message.systemAction.label}
          </button>
        ) : null}
      </div>
    );
  }

  // A pending/failed message's `id` is a client-generated `tempId`, not a
  // real one the backend recognizes yet — every server-backed action
  // (edit/delete/pin/react/report) would just 404/400 against it.
  const isOptimistic = !!message.sendStatus;
  const canEdit = (mine || !!message.canEditOthers) && message.type === "text" && !!onStartEdit && !isOptimistic;
  const canReact = !!onToggleReaction && !isOptimistic;
  const hasActions = !selectMode && !isOptimistic && !!(onReply || onDelete || onTogglePin || onToggleReaction);
  const longPressOn = !selecting && !!onStartSelect;
  // A failed send has its own menu (Try again / Delete); other pending sends have none yet.
  const failed = message.sendStatus === "failed";
  const menuAvailable = failed || (!isOptimistic && !!(onReply || onDelete || onTogglePin || onToggleReaction));
  const isFirst = groupPosition === "single" || groupPosition === "first";
  const isLast = groupPosition === "single" || groupPosition === "last";
  const senderLabel = mine ? "You" : (message.senderName ?? "Someone");
  const color = message.senderId ? personColor(message.senderId) : null;

  function ownMediaItems() {
    return mediaItemsFrom([
      {
        _id: message.id,
        type: message.type,
        attachments: message.attachments ?? [],
        attachmentMeta: message.attachmentMeta,
        createdAt: message.createdAtIso ?? "",
        durationSec: message.durationSec ?? null,
        // The bubble's text is the caption for media (blank captions are already empty).
        content: message.text ?? "",
        senderLabel,
      },
    ]);
  }

  /** Opens the in-app viewer (never a new tab) at this message's `i`th attachment. */
  /** Voice and video messages play through the app-wide player (now-playing bar). */
  function playbackTrack(kind: "voice" | "video_note", url: string): PlaybackTrack | undefined {
    if (message.sendStatus) return undefined;
    return {
      id: message.id,
      kind,
      src: resolveAttachmentUrl(url),
      durationSec: message.durationSec,
      senderName: senderLabel,
      createdAt: message.createdAtIso,
      channelId: mediaViewer?.channelId(),
    };
  }

  function openMedia(i: number) {
    if (mediaViewer) mediaViewer.open(message.id, i, ownMediaItems());
    else setLocalViewerIndex(i);
  }

  function quickReact() {
    if (isOptimistic) return;
    // A double tap can fire the event twice; one reaction per gesture.
    const now = Date.now();
    if (now - lastQuickReact.current < 600) return;
    lastQuickReact.current = now;
    if (quickReactionItem) onToggleReaction?.(message, { packItemId: quickReactionItem.packItemId });
    else if (quickReactionEmoji) onToggleReaction?.(message, { emoji: quickReactionEmoji });
  }

  function startSelecting() {
    onTextSelect?.(message.id);
    // Select the whole text so the native handles appear; drag them to adjust.
    requestAnimationFrame(() => {
      const el = textRef.current;
      const sel = window.getSelection();
      if (!el || !sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      // The selection bar sits at the top of the screen — keep the message clear of it.
      if (el.getBoundingClientRect().top < 72) el.scrollIntoView({ block: "center" });
    });
  }

  function stopSelecting() {
    const sel = window.getSelection();
    if (sel && textRef.current && sel.anchorNode && textRef.current.contains(sel.anchorNode)) sel.removeAllRanges();
    onTextSelect?.(null);
  }

  function openPicker(from: HTMLElement | null) {
    const rect = from?.getBoundingClientRect();
    if (!rect) return;
    // The picker is ~380px tall; open downward when there isn't room above.
    setPicker({ x: rect.right, y: rect.top < 420 ? rect.bottom : rect.top, placement: rect.top < 420 ? "down" : "up" });
  }

  const reactionStrip = canReact ? (
    <div className="flex items-center gap-0.5 border-b border-line px-2 pb-1.5 pt-0.5">
      {quickReactionItem ? (
        <button
          type="button"
          role="menuitem"
          aria-label="React with your animated quick reaction"
          onClick={() => {
            menu.close();
            onToggleReaction?.(message, { packItemId: quickReactionItem.packItemId });
          }}
          className="pressable flex size-10 items-center justify-center rounded-full hover:bg-sunken"
        >
          <PackImage thumbPath={quickReactionItem.thumbPath || quickReactionItem.relativePath} stillPath={quickReactionItem.stillPath || undefined} alt="" className="size-7 object-contain" />
        </button>
      ) : null}
      {Array.from(new Set([quickReactionItem ? null : quickReactionEmoji, ...QUICK_REACTIONS].filter(Boolean) as string[]))
        .slice(0, quickReactionItem ? 4 : 5)
        .map((emoji) => (
          <button
            key={emoji}
            type="button"
            role="menuitem"
            aria-label={`React with ${emoji}`}
            onClick={() => {
              menu.close();
              onToggleReaction?.(message, { emoji });
            }}
            className="pressable flex size-10 items-center justify-center rounded-full text-[22px] hover:bg-sunken"
          >
            {emoji}
          </button>
        ))}
      <button
        type="button"
        role="menuitem"
        aria-label="More reactions"
        onClick={() => {
          const anchor = menu.anchor;
          menu.close();
          if (anchor && "point" in anchor) setPicker({ x: Math.max(anchor.point.x, 348), y: anchor.point.y, placement: anchor.point.y < 420 ? "down" : "up" });
          else openPicker(reactButtonRef.current);
        }}
        className="pressable flex size-10 items-center justify-center rounded-full text-fg-2 hover:bg-sunken"
      >
        <SmilePlus className="size-5" strokeWidth={1.8} />
      </button>
    </div>
  ) : null;

  const infoTarget = { id: message.id, mine, reactions: message.reactions ?? [] };
  const infoRow =
    !isOptimistic && menu.anchor ? (
      <MessageInfoMenuRow
        target={infoTarget}
        chatKind={chatKind}
        isAdmin={isChatAdmin}
        onOpen={(tab) => {
          menu.close();
          setInfoTab(tab);
        }}
      />
    ) : null;
  const menuHeader =
    reactionStrip || infoRow ? (
      <>
        {reactionStrip}
        {infoRow}
      </>
    ) : null;

  const menuItems: MenuItem[] = failed
    ? [
        { key: "retry", label: "Try again", icon: RotateCcw, onSelect: () => onRetrySend?.(message.id) },
        { key: "delete-failed", label: "Delete", icon: Trash2, danger: true, onSelect: () => onDismissFailedSend?.(message.id) },
      ]
    : [
    ...(onReply ? [{ key: "reply", label: "Reply", icon: CornerUpLeft, onSelect: () => onReply(message) }] : []),
    ...(message.text && message.type === "text"
      ? [
          { key: "copy", label: "Copy text", icon: Copy, onSelect: () => void copyText(message.text ?? "") },
          { key: "select", label: "Select text", icon: TextSelect, onSelect: startSelecting },
        ]
      : []),
    ...(message.packId ? [{ key: "pack", label: "View pack", icon: Sticker, onSelect: () => setPackPreviewId(message.packId!) }] : []),
    ...(canEdit ? [{ key: "edit", label: "Edit", icon: Pencil, onSelect: () => onStartEdit?.(message) }] : []),
    ...(message.canPin !== undefined && onTogglePin
      ? [
          {
            key: "pin",
            label: message.isPinned ? "Unpin" : "Pin",
            icon: message.isPinned ? PinOff : Pin,
            disabled: !message.canPin,
            onSelect: () => onTogglePin(message),
          },
        ]
      : []),
    ...(gifSave.canSave
      ? [
          {
            key: "save-gif",
            label: gifSave.saved ? "Saved to your GIFs" : "Save GIF",
            icon: gifSave.saved ? BookmarkCheck : BookmarkPlus,
            disabled: gifSave.saved || gifSave.saving,
            onSelect: gifSave.save,
          },
        ]
      : []),
    ...(!mine ? [{ key: "report", label: "Report", icon: Flag, onSelect: () => setReportOpen(true) }] : []),
    { key: "sep", separator: true as const },
    ...(onStartSelect ? [{ key: "select", label: "Select", icon: ListChecks, onSelect: () => onStartSelect(message.id) }] : []),
    ...(onDelete ? [{ key: "delete", label: "Delete", icon: Trash2, danger: true, onSelect: () => setConfirmDelete(true) }] : []),
  ];

  // Connected corners: the sender-side corners shrink where this bubble
  // touches its neighbour in the same run, so a run reads as one voice.
  const radius = mine
    ? cn("rounded-[var(--radius-bubble)] rounded-ee-[6px]", !isFirst && "rounded-se-[6px]")
    : cn("rounded-[var(--radius-bubble)] rounded-es-[6px]", !isFirst && "rounded-ss-[6px]");

  const swipe = dragging ? Math.max(0, Math.min(REPLY_THRESHOLD + 16, delta * dir)) : 0;
  const swipeProgress = Math.min(1, swipe / REPLY_THRESHOLD);

  const isMediaOnly = (message.type === "image" || message.type === "gif" || message.type === "video") && !message.text;
  // Bare media: no caption, no quoted reply, not a multi-item album's text row.
  const bareMedia = isMediaOnly && !message.replyTo;
  // Media with a caption: the media fills the bubble edge to edge, with a thin inset (Telegram).
  const captionedMedia = (message.type === "image" || message.type === "gif" || message.type === "video") && !!message.text && !message.replyTo;
  const isSticker = message.type === "sticker";

  // The media column is only as wide as its media: a lone photo takes its own shape (a portrait
  // one is narrower), an album the 300px mosaic. A video sizes its own frame (BubbleVideoBox),
  // so the column just follows it. The bubble is max(media, caption), never wider than its media.
  const albumMedia = (message.attachments?.length ?? 0) > 1 && message.type !== "gif";
  const loneUrl = message.attachments?.[0];
  const loneMeta = loneUrl ? message.attachmentMeta?.[loneUrl] : null;
  const loneGifVideo = message.type === "gif" && !!loneUrl && /\.(mp4|webm)(\?|$)/i.test(loneUrl);
  const mediaMinWidth = albumMedia
    ? bubbleMediaWidth(1)
    : message.type === "video"
      ? undefined
      : bubbleMediaWidth(displayAspect(loneMeta?.width, loneMeta?.height, loneGifVideo ? 1 : 4 / 3));
  // Corners: a bare photo keeps the bubble's 14px; under a caption the media's top corners sit
  // 3px inside the bubble's (and go square where the bubble's corner is the 6px run-connector);
  // its bottom is square because the caption continues below.
  const inset = "calc(var(--radius-bubble) - 3px)";
  const mediaCorners: React.CSSProperties = bareMedia
    ? { borderRadius: 14 }
    : captionedMedia
      ? {
          borderStartStartRadius: !mine && !isFirst ? 3 : inset,
          borderStartEndRadius: mine && !isFirst ? 3 : inset,
          borderEndStartRadius: 0,
          borderEndEndRadius: 0,
        }
      : { borderRadius: inset };

  let body: React.ReactNode;
  const jumbo = message.type === "text" && !message.replyTo && !message.sendStatus ? emojiOnlyCount(message.text, message.customEmoji) : 0;

  if (jumbo >= 1 && jumbo <= 3) {
    const size = jumbo === 1 ? 88 : 64;
    const text = message.text ?? "";
    const nodes: React.ReactNode[] = [];
    let pos = 0;
    let k = 0;
    for (const e of [...(message.customEmoji ?? [])].sort((a, b) => a.offset - b.offset)) {
      if (e.offset > pos) nodes.push(<span key={k++}>{text.slice(pos, e.offset).trim()}</span>);
      const fallback = text.slice(e.offset, e.offset + e.length);
      const img = <PackImage thumbPath={e.relativePath} stillPath={e.stillPath} alt={fallback} title={fallback} style={{ width: size, height: size }} className="object-contain" />;
      const packId = e.packId;
      nodes.push(
        packId ? (
          <button key={k++} type="button" onClick={() => openPack(packId)} aria-label={`${fallback} — open its pack`} className="pressable rounded-[var(--radius-sm)]">
            {img}
          </button>
        ) : (
          <span key={k++}>{img}</span>
        ),
      );
      pos = e.offset + e.length;
    }
    if (pos < text.length) nodes.push(<span key={k++}>{text.slice(pos).trim()}</span>);
    body = (
      <div className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")} onDoubleClick={undefined}>
        {showSender && !mine && isFirst && message.senderName ? (
          <span className="px-1 text-[13px] font-bold" style={{ color: color?.fg }}>
            <bdi>{message.senderName}</bdi>
          </span>
        ) : null}
        <div
          className={cn("flex items-center gap-1 leading-none", message.highlighted && "jump-pulse-plain")}
          style={{ fontSize: size * 0.78 }}
        >
          {nodes}
        </div>
        <span className="rounded-full border border-line bg-raised px-2 py-1 shadow-sm">
          <Meta message={message} onSurface />
        </span>
      </div>
    );
  } else if (message.type === "video_note") {
    const url = message.attachments?.[0];
    body = (
      <div className={cn("flex flex-col gap-1.5", mine ? "items-end" : "items-start")}>
        {message.replyTo ? (
          <ReplyQuote
            reply={message.replyTo}
            onJump={jumpToReplied}
            className="max-w-[240px] rounded-[10px] border-s-[3px] border-accent bg-raised px-2.5 py-1.5 text-[13px] leading-snug shadow-sm"
          >
            <div className="truncate font-bold text-accent-text">
              <bdi>{message.replyTo.senderName}</bdi>
            </div>
            <div dir="auto" className="line-clamp-1 text-start text-fg-2">{message.replyTo.snippet || "Attachment"}</div>
          </ReplyQuote>
        ) : null}
        {showSender && !mine && isFirst && message.senderName ? (
          <span className="px-1 text-[13px] font-bold" style={{ color: color?.fg }}>
            <bdi>{message.senderName}</bdi>
          </span>
        ) : null}
        {url ? (
          <VideoNotePlayer
            src={resolveAttachmentUrl(url)}
            durationSec={message.durationSec}
            size={typeof window !== "undefined" && window.innerWidth < 480 ? 200 : 240}
            label={`Video message from ${senderLabel}`}
            track={playbackTrack("video_note", url)}
            className={cn(message.highlighted && "jump-pulse-plain")}
          />
        ) : null}
        <span className="rounded-full border border-line bg-raised px-2 py-1 shadow-sm">
          <Meta message={message} onSurface />
        </span>
      </div>
    );
  } else if (isSticker) {
    const url = message.attachments?.[0];
    const img = url ? (
      <BubbleSticker url={url} meta={message.attachmentMeta?.[url]} />
    ) : null;
    body = (
      <div className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
        {img && message.packId ? (
          // A sticker sent from a pack item is tappable to open that pack —
          // the "encountered a pack via a message" discovery path.
          <button type="button" onClick={() => openPack(message.packId!)} aria-label="Sticker — open its pack" className="pressable rounded-[var(--radius-md)]">
            {img}
          </button>
        ) : (
          img
        )}
        <span className="rounded-full border border-line bg-raised px-2 py-1 shadow-sm">
          <Meta message={message} onSurface />
        </span>
      </div>
    );
  } else {
    body = (
      <div
        className={cn(
          "relative min-w-0 overflow-hidden text-[15px] leading-[1.45]",
          // Bare media keeps even corners (no speech-bubble tail) and sits apart from the next item.
          bareMedia ? "mb-2.5 rounded-[14px]" : radius,
          // A photo/GIF/video with no caption is drawn bare (Telegram): no bubble colour,
          // border or padding — the media itself is the message, with the time on it.
          bareMedia
            ? "bg-transparent"
            : mine
              ? "bg-own text-own-fg"
              : cn("bg-other text-fg", !captionedMedia && "border border-line"),
          bareMedia ? "p-0" : captionedMedia ? "p-[3px]" : isMediaOnly ? "p-1" : "px-3 py-[7px]",
          // Jumped-to message (reply tap, pin, search): a short pulse + a tint that fades
          // inside the bubble — no ring, no full-row background (Telegram-style).
          message.highlighted && "jump-pulse",
        )}
      >
        {showSender && !mine && isFirst && message.senderName && !isMediaOnly ? (
          message.senderId ? (
            // inline-block: only the name itself opens the profile, not the whole top line.
            <Link href={`/app/user/${message.senderId}`} className="mb-0.5 inline-block max-w-full truncate align-top text-[13.5px] font-bold hover:underline" style={{ color: color?.fg }}>
              <bdi>{message.senderName}</bdi>
            </Link>
          ) : (
            <div className="mb-0.5 truncate text-[13.5px] font-bold text-accent-text">
              <bdi>{message.senderName}</bdi>
            </div>
          )
        ) : null}

        {message.replyTo ? (
          <ReplyQuote
            reply={message.replyTo}
            onJump={jumpToReplied}
            className={cn(
              "mb-1.5 mt-0.5 rounded-[8px] border-s-[3px] px-2.5 py-1.5 text-[13.5px] leading-snug",
              mine ? "border-own-meta bg-white/12" : "border-accent bg-sunken",
              isMediaOnly ? "m-1 w-[calc(100%-0.5rem)]" : "w-full",
            )}
          >
            <div className={cn("truncate font-bold", mine ? "text-own-fg" : "text-accent-text")}>
              <bdi>{message.replyTo.senderName}</bdi>
            </div>
            <div dir="auto" className={cn("line-clamp-2 text-start", mine ? "text-own-meta" : "text-fg-2")}>{message.replyTo.snippet || "Attachment"}</div>
          </ReplyQuote>
        ) : null}

        {message.type === "voice" ? (
          <div className="flex w-[min(280px,62vw)] flex-col gap-1 py-1">
            {message.attachments?.[0] ? (
              <VoicePlayer
                src={resolveAttachmentUrl(message.attachments[0])}
                durationSec={message.durationSec}
                waveform={message.waveform}
                tone={mine ? "own" : "other"}
                label={`Voice message from ${senderLabel}`}
                track={playbackTrack("voice", message.attachments[0])}
                resolveNext={mediaViewer?.nextVoice}
              />
            ) : null}
            <div className="flex justify-end">
              <Meta message={message} />
            </div>
          </div>
        ) : message.type === "voice_call" ? (
          <div className="flex items-end gap-3 py-1">
            <CallLogContent message={message} />
            <Meta message={message} />
          </div>
        ) : message.type === "file" || message.type === "audio" ? (
          <div className="flex flex-col gap-0.5 pb-0.5 pt-1">
            {/* One row per file (Telegram stacks a file group in one bubble); a pending
             *  `pending:<i>` placeholder is a row still uploading (lib/file-transfers). */}
            <div className="flex flex-col gap-2">
              {(message.attachments?.length ? message.attachments : [undefined]).map((att, i) => {
                if (att?.startsWith("cancelled:")) return null;
                const url = att && !att.startsWith("pending:") ? att : undefined;
                const meta = url ? message.attachmentMeta?.[url] : null;
                const name = meta?.fileName ?? (i === 0 ? message.originalFilename : null);
                const uploadKey = att?.startsWith("pending:") ? `${message.id}#${i}` : undefined;
                return message.type === "audio" ? (
                  <MusicMessage
                    key={i}
                    id={message.id}
                    trackIndex={i}
                    uploadKey={uploadKey}
                    url={url}
                    meta={meta}
                    originalFilename={name}
                    durationSec={i === 0 ? message.durationSec : null}
                    own={mine}
                    senderLabel={senderLabel}
                    createdAt={message.createdAtIso}
                    channelId={mediaViewer?.channelId()}
                  />
                ) : (
                  <FileMessage
                    key={i}
                    id={message.id}
                    uploadKey={uploadKey}
                    url={url}
                    meta={meta}
                    originalFilename={name ?? (url ? fileNameFromUrl(url) : message.text)}
                    own={mine}
                  />
                );
              })}
            </div>
            {message.text ? (
              <div className="bidi-text flow-root whitespace-pre-wrap break-words px-0.5 pt-1 [overflow-wrap:anywhere]">
                <span ref={textRef} data-text-target={message.id}>
                  <RichText text={message.text} mine={mine} />
                </span>
                <MetaFloat message={message} />
              </div>
            ) : (
              <div className="flex justify-end">
                <Meta message={message} />
              </div>
            )}
          </div>
        ) : message.type === "image" || message.type === "gif" || message.type === "video" ? (
          <div className="flex flex-col">
            <div
              className={cn("relative grid max-w-full gap-[3px] overflow-hidden", "grid-cols-1")}
              style={{ width: "100%", minWidth: mediaMinWidth, ...mediaCorners }}
            >
              {(message.attachments?.length ?? 0) > 1 && message.type !== "gif" ? (
                // Several photos and/or videos: one Telegram-style mosaic.
                <MediaAlbum type={message.type} attachments={message.attachments ?? []} meta={message.attachmentMeta} senderLabel={senderLabel} onOpen={openMedia} />
              ) : message.type === "video" ? (
                message.attachments?.[0] ? (
                  <BubbleVideoBox
                    url={resolveAttachmentUrl(message.attachments[0])}
                    meta={message.attachmentMeta?.[message.attachments[0]]}
                    durationSec={message.durationSec}
                    label={`Video from ${senderLabel}`}
                    onOpen={() => openMedia(0)}
                  />
                ) : null
              ) : (
                (message.attachments ?? []).map((url, i) => {
                  const meta = message.attachmentMeta?.[url];
                  const multi = (message.attachments?.length ?? 0) > 1;
                  const n = message.attachments?.length ?? 1;
                  const label = message.type === "gif" ? `Open GIF from ${senderLabel}` : `Open photo ${multi ? `${i + 1} of ${n} ` : ""}from ${senderLabel}`;
                  // A GIF keeps its original file (variants would drop the animation); one
                  // sent as a short video loops like a GIF.
                  return message.type === "gif" && /\.(mp4|webm)(\?|$)/i.test(url) ? (
                    <BubbleGifVideo key={i} url={url} meta={meta} label={label} onOpen={() => openMedia(i)} />
                  ) : (
                    <BubbleImage key={i} url={url} meta={meta} grid={multi} label={label} animated={message.type === "gif"} onOpen={() => openMedia(i)} />
                  );
                })
              )}
              {!message.text ? (
                // Time sits on the media, bottom-right, as a small pill (Telegram).
                <span className="pointer-events-none absolute bottom-1.5 end-1.5 z-[3]">
                  <Meta message={message} overlay />
                </span>
              ) : null}
            </div>
            {message.text ? (
              <div className="bidi-text flow-root whitespace-pre-wrap break-words px-2 pb-1 pt-1.5 [overflow-wrap:anywhere]">
                <span ref={textRef} data-text-target={message.id}>
                  <RichText text={message.text} mine={mine} />
                </span>
                <MetaFloat message={message} />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="bidi-text flow-root whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            <span ref={textRef} data-text-target={message.id}>{message.text ? <RichText text={message.text} mine={mine} emoji={message.customEmoji} onOpenPack={openPack} /> : null}</span>
            <MetaFloat message={message} />
          </div>
        )}
      </div>
    );
  }

  const hoverBar = hasActions ? (
    <div
      className={cn(
        "flex shrink-0 items-center gap-0.5 self-center rounded-full bg-raised p-1 shadow-[0_2px_12px_rgba(0,0,0,0.18)] ring-1 ring-line/60",
        "transition-[opacity,transform] duration-[var(--dur-fast)] ease-out motion-reduce:transition-none",
        "pointer-events-none translate-y-0.5 scale-95 opacity-0 group-hover/msg:pointer-events-auto group-hover/msg:translate-y-0 group-hover/msg:scale-100 group-hover/msg:opacity-100 group-focus-within/msg:pointer-events-auto group-focus-within/msg:translate-y-0 group-focus-within/msg:scale-100 group-focus-within/msg:opacity-100",
        (menu.open || picker) && "pointer-events-auto translate-y-0 scale-100 opacity-100",
        "max-lg:hidden",
      )}
    >
      {canReact ? (
        <button
          ref={reactButtonRef}
          type="button"
          aria-label="Add reaction"
          title="Add reaction"
          onClick={(e) => openPicker(e.currentTarget)}
          className="pressable flex size-8 items-center justify-center rounded-full text-fg-2 transition-colors duration-[var(--dur-fast)] hover:bg-accent-soft hover:text-accent-text focus-visible:bg-accent-soft focus-visible:text-accent-text"
        >
          <SmilePlus className="size-[18px]" strokeWidth={1.8} />
        </button>
      ) : null}
      {onReply ? (
        <button
          type="button"
          aria-label="Reply"
          title="Reply"
          onClick={() => onReply(message)}
          className="pressable flex size-8 items-center justify-center rounded-full text-fg-2 transition-colors duration-[var(--dur-fast)] hover:bg-accent-soft hover:text-accent-text focus-visible:bg-accent-soft focus-visible:text-accent-text"
        >
          <CornerUpLeft className="size-[18px]" strokeWidth={1.8} />
        </button>
      ) : null}
      {gifSave.canSave ? (
        <button
          type="button"
          aria-label={gifSave.saved ? "Saved to your GIFs" : "Save GIF"}
          title={gifSave.saved ? "Saved to your GIFs" : "Save GIF"}
          aria-pressed={gifSave.saved}
          disabled={gifSave.saving}
          onClick={gifSave.save}
          className={cn(
            "pressable flex size-8 items-center justify-center rounded-full transition-colors duration-[var(--dur-fast)] hover:bg-accent-soft disabled:opacity-60",
            gifSave.saved ? "text-accent-text" : "text-fg-2 hover:text-accent-text",
          )}
        >
          {gifSave.saved ? <BookmarkCheck className="size-[18px]" strokeWidth={1.8} /> : <BookmarkPlus className="size-[18px]" strokeWidth={1.8} />}
        </button>
      ) : null}
      <button
        type="button"
        aria-label="More actions"
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={(e) => menu.openFrom(e.currentTarget)}
        className="pressable flex size-8 items-center justify-center rounded-full text-fg-2 transition-colors duration-[var(--dur-fast)] hover:bg-accent-soft hover:text-accent-text focus-visible:bg-accent-soft focus-visible:text-accent-text"
      >
        <MoreHorizontal className="size-[18px]" strokeWidth={1.8} />
      </button>
    </div>
  ) : null;

  const reactions = message.reactions?.length ? (
    <div className={cn("relative z-[1] -mt-1.5 flex flex-wrap gap-1", mine ? "justify-end pe-2" : "ps-2")}>
      {message.reactions.map((r) =>
        canReact ? (
          <ReactionChip
            key={reactionKey(r)}
            onToggle={() => onToggleReaction?.(message, reactionInputOf(r))}
            onHold={() => openReactionInfo(reactionKey(r))}
            aria-pressed={r.reactedByMe}
            aria-label={`${r.emoji ?? "Sticker"} reaction, ${r.count}${r.reactedByMe ? ", including you" : ""}`}
            className={cn(
              "pressable flex h-7 items-center gap-1 rounded-full border px-2 shadow-sm",
              r.reactedByMe ? "border-accent bg-accent-soft text-accent-text" : "border-line bg-raised text-fg-2 hover:border-line-strong",
            )}
          >
            <ReactionGlyph r={r} />
            <span className="tabular text-[12.5px] font-semibold">{r.count}</span>
          </ReactionChip>
        ) : (
          <span key={reactionKey(r)} className="flex h-7 items-center gap-1 rounded-full border border-line bg-raised px-2 text-fg-2 shadow-sm">
            <ReactionGlyph r={r} />
            <span className="tabular text-[12.5px] font-semibold">{r.count}</span>
          </span>
        ),
      )}
    </div>
  ) : null;

  // A click on the message's row (the bubble or the space beside it) opens the dropdown beside the
  // bubble. A drag, a press-and-hold, a button/link/media press, or a click inside a menu doesn't.
  function onRowClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target.closest("[role=menu]")) return;
    // Selection mode: the whole row toggles the message (except its own menu button).
    if (selectMode) {
      // The click that ends a press-and-hold: the hold already selected the message.
      if (longPress.firedRef.current) return;
      if (target.closest("[data-no-select]")) return;
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect?.(message.id);
      return;
    }
    // This click only dismissed another overlay (a menu or the emoji panel): it doesn't open one here.
    if (consumeMenuDismissClick()) return;
    if ((isOptimistic && !failed) || longPress.firedRef.current) return;
    if (target.closest("button,a,video,audio,input,textarea,[data-no-gesture]")) return;
    if (e.detail > 1) {
      // The second click of a double tap: one quick reaction, and the menu the first click was about to open is dropped.
      if (menuTimer.current) window.clearTimeout(menuTimer.current);
      menuTimer.current = null;
      quickReact();
      return;
    }
    if (!menuAvailable) return;
    const down = rowDown.current;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
    // Wait out the double-tap window first, so a double tap never opens the menu.
    const bubble = e.currentTarget.querySelector<HTMLElement>('[role="article"]') ?? e.currentTarget;
    if (menuTimer.current) window.clearTimeout(menuTimer.current);
    menuTimer.current = window.setTimeout(() => {
      menuTimer.current = null;
      menu.openFrom(bubble);
    }, DOUBLE_TAP_WAIT_MS);
  }

  return (
    <div
      id={`message-${message.id}`}
      onPointerDown={(e) => {
        rowDown.current = { x: e.clientX, y: e.clientY };
        if (longPressOn) longPress.handlers.onPointerDown(e);
      }}
      onPointerMove={(e) => {
        if (longPressOn) longPress.handlers.onPointerMove(e);
      }}
      onPointerUp={() => {
        if (longPressOn) longPress.handlers.onPointerUp();
      }}
      onPointerCancel={() => {
        if (longPressOn) longPress.handlers.onPointerCancel();
      }}
      onClick={onRowClick}
      className={cn(
        "group/msg flex w-full select-none items-end gap-2",
        mine ? "justify-end" : "justify-start",
        isFirst ? "pt-2" : "pt-0.5",
        message.reactions?.length ? "pb-1" : "",
      )}
    >
      {showSender && !mine ? (
        <div className="w-8 shrink-0 self-end">
          {isLast && message.senderId ? (
            <Link href={`/app/user/${message.senderId}`} aria-label={`${message.senderName}'s profile`} tabIndex={-1} className="block rounded-full">
              <Avatar colorId={message.senderId} name={message.senderName} src={message.senderAvatarUrl} size={32} />
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className={cn("flex min-w-0 max-w-[min(78%,560px)] items-center gap-2", mine ? "flex-row-reverse" : "flex-row")}>
        {selectMode ? (
          <span
            aria-hidden
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
              selected ? "border-accent bg-accent text-accent-fg" : "border-line-strong",
            )}
          >
            {selected ? <Check className="size-3" strokeWidth={3} /> : null}
          </span>
        ) : null}
        <div
          role="article"
          aria-label={`${senderLabel}, ${message.createdAt}${message.isEdited ? ", edited" : ""}${message.isPinned ? ", pinned" : ""}${selectMode ? (selected ? ", selected" : ", not selected") : ""}`}
          // Selection mode: a tap anywhere on the message toggles it (children don't get the click).
          className={cn(
            "relative flex min-w-0 flex-col",
            // The message with an open menu is marked (see the row's click handler).
            selected && "brightness-90 transition-[filter] duration-150",
            selecting ? "select-text" : "select-none",
          )}
          onContextMenu={
            hasActions && !selecting
              ? (e) => {
                  // A press-and-hold selects instead; this is the browser's own long-press
                  // contextmenu right behind it, so it's swallowed.
                  if (longPress.firedRef.current) {
                    e.preventDefault();
                    return;
                  }
                  if ((e.target as HTMLElement).closest("a,video,audio")) return;
                  e.preventDefault();
                  menu.openAt(e.clientX, e.clientY);
                }
              : undefined
          }
          onPointerDown={(e) => {
            touchOnly(dragHandlers.onPointerDown)(e);
          }}
          onPointerMove={(e) => {
            touchOnly(dragHandlers.onPointerMove)(e);
          }}
          onPointerUp={(e) => {
            touchOnly(dragHandlers.onPointerUp)(e);
          }}
          onPointerCancel={(e) => {
            touchOnly(dragHandlers.onPointerCancel)(e);
          }}
          style={{
            transform: swipe ? `translateX(${dir * swipe}px)` : undefined,
            transition: dragging ? "none" : "transform 220ms var(--ease-out)",
            touchAction: "pan-y",
            WebkitTouchCallout: selecting ? "default" : "none",
            WebkitUserSelect: selecting ? "text" : undefined,
          }}
        >
          {swipe > 0 ? (
            <span
              aria-hidden
              className="absolute top-1/2 flex size-8 items-center justify-center rounded-full bg-accent text-accent-fg"
              style={{ [mine ? "right" : "left"]: "100%", marginInline: 8, opacity: swipeProgress, transform: `translateY(-50%) scale(${0.6 + swipeProgress * 0.4})` }}
            >
              <CornerUpLeft className="size-4" strokeWidth={2.2} />
            </span>
          ) : null}
          {body}
          {reactions}
          {/* Retry and Delete live in the message's action menu (tap the message). */}
          {message.sendStatus === "failed" ? (
            <div role="status" aria-label="Not sent" className={cn("mt-1 flex items-center gap-1 text-[12.5px]", mine ? "justify-end" : "")}>
              <AlertCircle className="size-3.5 shrink-0 text-danger" strokeWidth={2.2} aria-hidden />
              <span className="font-medium text-danger">Not sent · tap to retry or delete</span>
            </div>
          ) : null}
        </div>
        {hoverBar}
      </div>

      {gifSave.toast}
      {menu.anchor ? (
        <Menu anchor={menu.anchor} items={menuItems} onClose={menu.close} header={menuHeader} aria-label="Message actions" align={mine ? "end" : "start"} />
      ) : null}

      {picker && canReact && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed z-[95]"
              style={{
                left: Math.min(Math.max(picker.x, 348), window.innerWidth - 8),
                top: picker.y,
              }}
            >
              <div className="relative">
                <StickerEmojiPicker
                  placement={picker.placement}
                  onSendEmoji={(char) => {
                    onToggleReaction?.(message, { emoji: char });
                    setPicker(null);
                  }}
                  onSendItem={(_packId, itemId) => {
                    onToggleReaction?.(message, { packItemId: itemId });
                    setPicker(null);
                  }}
                  onClose={() => setPicker(null)}
                />
              </div>
            </div>,
            document.body,
          )
        : null}

      {localViewerIndex !== null ? <MediaViewer items={ownMediaItems()} startIndex={localViewerIndex} onClose={() => setLocalViewerIndex(null)} /> : null}
      {packPreviewId ? <PackPreviewSheet packId={packPreviewId} onClose={() => setPackPreviewId(null)} /> : null}
      {infoTab ? (
        <MessageInfoSheet
          target={infoTarget}
          chatKind={chatKind}
          initialTab={infoTab}
          initialReaction={infoTab === "reactions" ? infoReaction : undefined}
          onClose={() => {
            setInfoTab(null);
            setInfoReaction(undefined);
          }}
        />
      ) : null}
      {reportOpen ? <ReportDialog targetType="message" targetId={message.id} targetLabel="this message" onClose={() => setReportOpen(false)} /> : null}
      {confirmDelete ? (
        <DeleteMessagesDialog
          count={1}
          canEveryone={!!message.canDeleteForEveryone}
          everyoneLabel={everyoneLabel}
          onClose={() => setConfirmDelete(false)}
          onConfirm={(forEveryone) => {
            setConfirmDelete(false);
            onDelete?.(message, forEveryone ? "everyone" : "me");
          }}
        />
      ) : null}
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);
