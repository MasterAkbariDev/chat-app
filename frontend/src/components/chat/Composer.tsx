"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, CornerUpLeft, File as FileIcon, Image as ImageIcon, MessageSquareOff, Music, Paperclip, Pencil, SendHorizontal, Smile, X } from "lucide-react";
import { Menu, useMenuState } from "@/components/ui/Menu";
import { RecordButton } from "@/components/media/RecordButton";
import { RichMessageInput, type InlineEmoji, type RichMessageInputHandle } from "@/components/chat/RichMessageInput";
import { usePerformance } from "@/contexts/performance-context";
import { VoiceRecorder } from "@/components/media/VoiceRecorder";
import { VideoNoteRecorder } from "@/components/media/VideoNoteRecorder";
import type { RecordingResult } from "@/components/media/use-media-recording";
import { canRecord } from "@/lib/recording";
import { StickerEmojiPicker, type GifPick, type SendItemHandler } from "@/components/packs/StickerEmojiPicker";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { CHANNELS_QUERY_KEY, getParticipants, muteChat, subscribeToChannel, unmuteChat } from "@/lib/api/chats";
import { ApiError } from "@/lib/api/client";
import type { ChannelsPage } from "@/lib/api/types";
import { getSocket } from "@/lib/socket";
import { chatPreviewKey } from "@/hooks/use-chat-meta-events";
import { cn } from "@/lib/cn";
import type { MessageBubbleData } from "@/components/chat/MessageBubble";

// Mirrors the backend's own mention regex exactly (MessageService.resolveMentions —
// `/@([a-zA-Z0-9_]+)/g`) so what the dropdown offers is exactly what will actually
// resolve server-side: letters/digits/underscore only, no dots/hyphens, no
// whitespace-boundary requirement before the `@`.
const MENTION_TRIGGER = /@([a-zA-Z0-9_]*)$/;

/** When you can't post here, the composer becomes a single bar instead:
 *  - `join`: you're previewing a public group/channel you're not in;
 *  - `subscriber`: you're a subscriber of a channel (only admins post) —
 *    the bar toggles notifications, like Telegram;
 *  - `muted-by-admin`: you can't send in this group — an admin muted you, or
 *    (`everyone`) sending is turned off for all members. */
export type ComposerGate =
  | { kind: "join"; chatType: "group" | "channel" }
  | { kind: "subscriber"; muted: boolean }
  | { kind: "muted-by-admin"; everyone?: boolean };

/** What kinds of things you may send here (`myPermissions.member`). */
export interface ComposerAllow {
  /** Photos, videos and files (the paperclip). */
  media: boolean;
  /** Stickers and GIFs (the picker's Stickers tab). */
  stickers: boolean;
  /** Voice and round video messages (the record button). */
  voice: boolean;
}

export interface ComposerProps {
  placeholder: string;
  /** Replaces the composer with a join / mute bar or a notice. */
  gate?: ComposerGate | null;
  /** Needed to fetch this channel's members for @mention autocomplete. */
  channelId: string;
  replyTo?: MessageBubbleData | null;
  onCancelReply?: () => void;
  /** Set while editing one of your own messages — the field is pre-filled
   *  with its text and Send becomes "Save". */
  editing?: MessageBubbleData | null;
  onCancelEdit?: () => void;
  onSubmitEdit?: (text: string, emoji: InlineEmoji[]) => void;
  /** `emoji`: animated emoji placed inline in `text` (offsets into the
   *  trimmed text). */
  onSend: (text: string, emoji: InlineEmoji[]) => void;
  /** A sticker tapped in the picker — sent as its own message immediately.
   *  (Animated emoji go *into* the text instead, like regular emoji.) */
  onSendItem: SendItemHandler;
  /** A GIF picked in the picker's GIFs tab — sent as its own message. */
  onSendGif?: (gif: GifPick) => void;
  /** A photo or video picked via the paperclip button — the caller owns
   *  staging it (quality/resolution choice + preview) and the actual
   *  upload + send. */
  onFileSelected?: (file: File, caption: string) => void;
  /** Several photos/videos picked at once (opens the media editor). Takes precedence over
   *  `onFileSelected`. */
  onMediaSelected?: (files: File[], caption: string) => void;
  /** Documents / music picked from the attach menu's "File" / "Music" — sent as file / music
   *  messages (any number at once). When set, the paperclip opens that menu. */
  onSendFiles?: (files: File[], mode: "file" | "music", caption: string) => void;
  /** True while a previously-picked file is mid-upload — disables the
   *  paperclip button so a second tap can't start a second pick mid-flight. */
  attaching?: boolean;
  /** Fired on every non-empty keystroke — the caller owns the actual
   *  `typing_start`/`typing_stop` socket emission and its debounce, since
   *  that's per-channel state this presentational component doesn't know. */
  onTyping?: () => void;
  sending?: boolean;
  /** Upload + send a recorded voice message. Rejecting keeps the clip in
   *  the recorder with an error, so it can be retried. */
  onSendVoice?: (recording: RecordingResult) => Promise<void>;
  /** Upload + send a round video message. Same contract as onSendVoice. */
  onSendVideoNote?: (recording: RecordingResult) => Promise<void>;
  /** Hides what you aren't allowed to send. Omitted = everything allowed. */
  allow?: ComposerAllow;
  /** Reports whether the attach hint belongs in the header (typing, and attaching is allowed). */
  onAttachHint?: (show: boolean) => void;
  /** Puts text back into the composer (a cancelled attach keeps what was typed). */
  restoreText?: { text: string; id: number } | null;
  /** Hands the header a function that opens the attach options (called on each render). */
  registerAttach?: (open: ((anchor?: HTMLElement | null) => void) | null) => void;
}

function isCoarsePointer() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
}

/** Trims the text and shifts inline-emoji offsets to match. */
function trimWithEmoji(text: string, emoji: InlineEmoji[]): { text: string; emoji: InlineEmoji[] } {
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  return {
    text: trimmed,
    emoji: emoji
      .map((e) => ({ ...e, offset: e.offset - lead }))
      .filter((e) => e.offset >= 0 && e.offset + e.length <= trimmed.length),
  };
}

/** The dock at the bottom of a conversation. With nothing typed, the send
 *  slot becomes a single record button (tap = switch voice/video, hold =
 *  record) — only where the browser can actually record (secure context +
 *  MediaRecorder), so there's never a button that can't work. */
export function Composer({
  placeholder,
  gate,
  channelId,
  replyTo,
  onCancelReply,
  editing,
  onCancelEdit,
  onSubmitEdit,
  onSend,
  onSendItem,
  onSendGif,
  onFileSelected,
  onMediaSelected,
  onSendFiles,
  attaching,
  onTyping,
  sending,
  onSendVoice,
  onSendVideoNote,
  allow,
  onAttachHint,
  registerAttach,
  restoreText,
}: ComposerProps) {
  const canAttach = allow?.media ?? true;
  const canStickers = allow?.stickers ?? true;
  const canVoice = allow?.voice ?? true;
  const { animatedMedia } = usePerformance();
  const [recording, setRecording] = useState<null | "voice" | "video">(null);
  const [recordable] = useState(canRecord);
  const [text, setText] = useState("");
  const [inlineEmoji, setInlineEmoji] = useState<InlineEmoji[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<RichMessageInputHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const musicInputRef = useRef<HTMLInputElement>(null);
  const attachMenu = useMenuState();
  const listboxId = useId();

  // Index (into `text`) of the "@" that opened the current mention query, or
  // -1 when not in one. Recomputed from scratch on every keystroke by
  // re-matching MENTION_TRIGGER against the text up to the caret, rather
  // than tracked incrementally, so it self-corrects if the caret jumps.
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionQuery, setMentionQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const mentionOpen = mentionStart >= 0;

  // Participants double as the mention candidate list — fetched only once a
  // mention is actually being typed, not eagerly on every composer mount.
  const participantsQuery = useQuery({
    queryKey: ["chats", channelId, "participants"],
    queryFn: () => getParticipants(channelId),
    enabled: mentionOpen,
  });
  const candidates = (participantsQuery.data ?? []).filter((p) => p.username.toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0, 8);
  const showMentions = mentionOpen && candidates.length > 0;

  // Entering edit mode pre-fills the field with the message (inline animated
  // emoji included); leaving it (save/cancel) clears it.
  // (Writes into the editor DOM — an external system — so it's an effect;
  // the ref just remembers which message was last loaded.)
  const prefilledIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = editing?.id ?? null;
    if (id === prefilledIdRef.current) return;
    prefilledIdRef.current = id;
    inputRef.current?.setContent(editing ? (editing.text ?? "") : "", editing?.customEmoji ?? []);
  }, [editing]);

  // Focus the field whenever a reply/edit starts, so you can just type.
  useEffect(() => {
    if (replyTo || editing) inputRef.current?.focus();
  }, [replyTo, editing]);

  function detectMention() {
    const before = inputRef.current?.textBeforeCaret() ?? "";
    const match = MENTION_TRIGGER.exec(before);
    if (match) {
      setMentionStart(before.length - match[0].length);
      setMentionQuery(match[1]);
      if (!mentionOpen) setActiveIndex(0);
    } else if (mentionOpen) {
      setMentionStart(-1);
      setMentionQuery("");
    }
  }

  function closeMention() {
    setMentionStart(-1);
    setMentionQuery("");
  }

  function selectMention(username: string) {
    inputRef.current?.replaceBeforeCaret(mentionQuery.length + 1, `@${username} `);
    closeMention();
  }

  function submit() {
    const out = trimWithEmoji(text, inlineEmoji);
    if (!out.text || sending) return;
    if (editing) {
      onSubmitEdit?.(out.text, out.emoji);
    } else {
      onSend(out.text, out.emoji);
      inputRef.current?.setContent("");
    }
    closeMention();
  }

  const sameAsEditing =
    !!editing &&
    text.trim() === (editing.text ?? "").trim() &&
    JSON.stringify(trimWithEmoji(text, inlineEmoji).emoji.map((e) => [e.offset, e.packItemId])) ===
      JSON.stringify((editing.customEmoji ?? []).map((e) => [e.offset, e.packItemId]));
  const canSend = text.trim().length > 0 && !sending && !sameAsEditing;
  // While there's a draft the attach button leaves the row (the input takes its place); the
  // header's ⋯ menu keeps attaching, with a small hint under the button.
  const hasDraft = text.trim().length > 0 || inlineEmoji.length > 0;
  const attachVisible = !editing && canAttach;
  const showAttach = attachVisible && !hasDraft;
  useEffect(() => {
    onAttachHint?.(hasDraft && !editing && canAttach);
  }, [hasDraft, editing, canAttach, onAttachHint]);
  const dockRef = useRef<HTMLDivElement>(null);
  /** Empties the field and returns what it held (the caption for the attachment being picked). */
  function takeDraft(): string {
    const t = text.trim();
    if (t) inputRef.current?.setContent("");
    return t;
  }
  useEffect(() => {
    if (restoreText?.text) inputRef.current?.setContent(restoreText.text);
  }, [restoreText]);
  /** Opens the attach options from `anchor` (the header's ⋯ button) or, by default, from the composer. */
  function openAttach(anchor?: HTMLElement | null) {
    if (!canAttach || editing) return;
    if (onSendFiles) {
      const from = anchor ?? dockRef.current;
      if (from) attachMenu.openFrom(from);
    } else fileInputRef.current?.click();
  }
  useEffect(() => {
    registerAttach?.(openAttach);
  });
  const banner = editing
    ? { icon: Pencil, title: "Edit message", body: editing.text ?? "", onCancel: onCancelEdit, cancelLabel: "Cancel editing" }
    : replyTo
      ? {
          icon: CornerUpLeft,
          title: `Reply to ${replyTo.mine ? "yourself" : (replyTo.senderName ?? "message")}`,
          body: replyTo.text ?? `${replyTo.type} message`,
          onCancel: onCancelReply,
          cancelLabel: "Cancel reply",
        }
      : null;

  if (gate) return <ComposerGateBar gate={gate} channelId={channelId} />;

  return (
    <div className="relative mx-auto flex w-full max-w-[860px] flex-col gap-2">
      {banner ? (
        <div className="fade-in flex items-center gap-3 rounded-[var(--radius-md)] bg-sunken py-2 pe-1.5 ps-3">
          <banner.icon className="size-[18px] shrink-0 text-accent-text" strokeWidth={2} aria-hidden />
          <div className="min-w-0 flex-1 border-s-[3px] border-accent ps-2.5">
            <div className="truncate text-[13.5px] font-bold text-accent-text">{banner.title}</div>
            <div dir="auto" className="truncate text-start text-[13.5px] text-fg-2">
              {banner.body}
            </div>
          </div>
          <button
            type="button"
            aria-label={banner.cancelLabel}
            title={banner.cancelLabel}
            onClick={banner.onCancel}
            className="pressable flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-line hover:text-fg"
          >
            <X className="size-[18px]" strokeWidth={2} />
          </button>
        </div>
      ) : null}

      {recording === "voice" && onSendVoice ? (
        <VoiceRecorder onSend={onSendVoice} onClose={() => setRecording(null)} />
      ) : (
      <div ref={dockRef} className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          multiple={!!onMediaSelected}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            // Reset so picking the exact same file again still fires
            // this handler a second time.
            e.target.value = "";
            if (!files.length) return;
            // What was typed becomes the caption of what's picked (it leaves the composer).
            const caption = takeDraft();
            if (onMediaSelected) onMediaSelected(files, caption);
            else onFileSelected?.(files[0], caption);
          }}
        />
        {onSendFiles ? (
          <>
            <input
              ref={docInputRef}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) onSendFiles(files, "file", takeDraft());
              }}
            />
            <input
              ref={musicInputRef}
              type="file"
              multiple
              accept="audio/*,.mp3,.m4a,.aac,.flac,.ogg,.oga,.opus,.wav"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) onSendFiles(files, "music", takeDraft());
              }}
            />
            {attachMenu.anchor ? (
              <Menu
                anchor={attachMenu.anchor}
                align="start"
                aria-label="Attach"
                onClose={attachMenu.close}
                items={[
                  { key: "media", label: "Photo or video", icon: ImageIcon, disabled: attaching, onSelect: () => fileInputRef.current?.click() },
                  { key: "file", label: "File", icon: FileIcon, onSelect: () => docInputRef.current?.click() },
                  { key: "music", label: "Music", icon: Music, onSelect: () => musicInputRef.current?.click() },
                ]}
              />
            ) : null}
          </>
        ) : null}
        {/* The attach button leaves the row while you type: its track collapses (grid 1fr → 0fr) and
            the input grows into the space, instead of jumping. */}
        {attachVisible ? (
          <div
            aria-hidden={!showAttach || undefined}
            inert={!showAttach || undefined}
            className={cn("grid transition-[grid-template-columns,margin] duration-300 ease-out", showAttach ? "grid-cols-[1fr] me-0" : "-me-2 grid-cols-[0fr]")}
          >
            <div className="min-w-0 overflow-hidden">
            <button
              type="button"
              aria-label={onSendFiles ? "Attach" : "Attach a photo or video"}
              title={onSendFiles ? "Attach a photo, video, file or music" : "Attach a photo or video"}
              aria-haspopup={onSendFiles ? "menu" : undefined}
              aria-expanded={onSendFiles ? attachMenu.open : undefined}
              disabled={attaching && !onSendFiles}
              onClick={(e) => (onSendFiles ? attachMenu.openFrom(e.currentTarget) : fileInputRef.current?.click())}
              tabIndex={showAttach ? undefined : -1}
              className={cn("pressable mb-0.5 flex size-10 shrink-0 items-center justify-center rounded-full text-fg-2 transition-opacity duration-200 hover:bg-sunken hover:text-fg disabled:opacity-40", !showAttach && "pointer-events-none opacity-0")}
            >
              <Paperclip className="size-[21px]" strokeWidth={1.8} />
            </button>
            </div>
          </div>
        ) : null}

        <div className="flex min-h-11 min-w-0 flex-1 items-end rounded-[22px] border border-line bg-sunken transition-colors focus-within:border-accent focus-within:bg-raised hover:border-line-strong">
          <RichMessageInput
            ref={inputRef}
            staticEmoji={animatedMedia === "off"}
            placeholder={editing ? "Edit your message" : placeholder}
            ariaLabel={editing ? "Edit message" : placeholder}
            ariaProps={
              showMentions
                ? {
                    role: "combobox",
                    "aria-expanded": true,
                    "aria-controls": listboxId,
                    "aria-activedescendant": `${listboxId}-${activeIndex % candidates.length}`,
                    "aria-autocomplete": "list",
                  }
                : undefined
            }
            onChange={(value, emoji) => {
              setText(value);
              setInlineEmoji(emoji);
              if (value.trim()) onTyping?.();
            }}
            onCaretChange={detectMention}
            onKeyDown={(e) => {
              if (showMentions) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIndex((i) => (i + 1) % candidates.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  selectMention(candidates[activeIndex % candidates.length].username);
                  return;
                }
              }
              if (e.key === "Escape") {
                if (mentionOpen) closeMention();
                else if (editing) onCancelEdit?.();
                else if (replyTo) onCancelReply?.();
                return;
              }
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                // Desktop: Enter sends, Shift+Enter is a new line. Phones:
                // the on-screen keyboard's return key inserts a new line and
                // the Send button sends, as in every native messenger.
                e.preventDefault();
                if (!e.shiftKey && !isCoarsePointer()) submit();
                else document.execCommand("insertLineBreak");
              }
            }}
          />
          <button
            type="button"
            aria-label={canStickers ? "Emoji and stickers" : "Emoji"}
            title={canStickers ? "Emoji and stickers" : "Emoji"}
            aria-expanded={pickerOpen}
            // Keep the focus in the field: the keyboard stays up while the emoji panel is open.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPickerOpen((v) => !v)}
            className={cn(
              "pressable m-0.5 flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-line hover:text-fg",
              pickerOpen ? "text-accent-text" : "text-muted",
            )}
          >
            <Smile className="size-[21px]" strokeWidth={1.8} />
          </button>
        </div>

        {!text.trim() && inlineEmoji.length === 0 && !editing && recordable && canVoice && (onSendVoice || onSendVideoNote) ? (
          <RecordButton voice={!!onSendVoice} video={!!onSendVideoNote} onStart={(mode) => setRecording(mode)} />
        ) : (
          <button
            type="button"
            aria-label={editing ? "Save changes" : "Send message"}
            title={editing ? "Save changes" : "Send (Enter)"}
            // Keep the field focused: a press on Send must not blur it (that closes the on-screen
            // keyboard), so the keyboard stays up after sending, as in every messenger.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (canSend) submit();
            }}
            aria-disabled={!canSend}
            className={cn(
              "pressable flex size-11 shrink-0 items-center justify-center rounded-full transition-colors",
              canSend ? "bg-accent text-accent-fg hover:bg-accent-hover" : "bg-sunken text-muted",
            )}
          >
            {editing ? <CheckIcon /> : <SendHorizontal className="size-5 rtl:rotate-180" strokeWidth={2} />}
          </button>
        )}
      </div>
      )}

      {recording === "video" && onSendVideoNote ? (
        <VideoNoteRecorder onSend={onSendVideoNote} onClose={() => setRecording(null)} />
      ) : null}

      {pickerOpen ? (
        <div className="absolute bottom-full end-14 z-40 mb-2">
          {/* A press on an emoji must not move focus into the field: that would bring up the keyboard. */}
          <div
            className="relative"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest("button")) e.preventDefault();
            }}
          >
            <StickerEmojiPicker
              // Remount if the right changes while it's open, so a hidden tab can't stay selected.
              key={canStickers ? "with-stickers" : "no-stickers"}
              allowStickers={canStickers}
              // Emoji and animated emoji go into the text and the picker stays
              // open for more; a sticker is sent on its own and closes it.
              onSendEmoji={(char) => inputRef.current?.insertText(char)}
              onInsertAnimated={(pick) => inputRef.current?.insertEmoji(pick)}
              onSendItem={(...args) => {
                onSendItem(...args);
                setPickerOpen(false);
              }}
              onSendGif={
                onSendGif
                  ? (gif) => {
                      onSendGif(gif);
                      setPickerOpen(false);
                    }
                  : undefined
              }
              autoFocus={false}
              onClose={() => setPickerOpen(false)}
            />
          </div>
        </div>
      ) : null}

      {showMentions ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Mention someone"
          className="pop-in absolute bottom-full start-12 z-40 mb-2 flex max-h-[280px] w-[280px] flex-col overflow-y-auto rounded-[var(--radius-md)] border border-line bg-raised p-1.5 shadow-lg"
        >
          {candidates.map((p, i) => {
            const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || p.username;
            const active = i === activeIndex % candidates.length;
            return (
              <div
                key={p.userId}
                id={`${listboxId}-${i}`}
                role="option"
                aria-selected={active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectMention(p.username);
                }}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn("flex cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] px-2.5 py-2", active ? "bg-accent-soft" : "hover:bg-sunken")}
              >
                <Avatar colorId={p.userId} name={name} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold">{name}</div>
                  <div className="truncate text-[12.5px] text-muted">@{p.username}</div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ComposerGateBar({ gate, channelId }: { gate: ComposerGate; channelId: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const joinMutation = useMutation({
    mutationFn: () => subscribeToChannel(channelId),
    onMutate: () => setError(null),
    onSuccess: async () => {
      // Put this socket in the chat's room so new messages arrive live.
      getSocket()?.emit("join_channel", { channelId });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: chatPreviewKey(channelId) }),
      ]);
    },
    onError: (err) => setError(err instanceof ApiError && err.status < 500 ? err.message : "Couldn't join. Check your connection and try again."),
  });

  const muteMutation = useMutation({
    mutationFn: (mute: boolean) => (mute ? muteChat(channelId) : unmuteChat(channelId)),
    onMutate: () => setError(null),
    onSuccess: (_res, mute) => {
      queryClient.setQueryData<ChannelsPage>(CHANNELS_QUERY_KEY, (prev) =>
        prev ? { ...prev, items: prev.items.map((c) => (c.channelId === channelId ? { ...c, isMuted: mute } : c)) } : prev,
      );
      queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
    },
    onError: () => setError("That didn't go through. Check your connection and try again."),
  });

  let body: React.ReactNode;
  if (gate.kind === "join") {
    body = (
      <Button block size="lg" loading={joinMutation.isPending} onClick={() => joinMutation.mutate()}>
        {gate.chatType === "channel" ? "Join channel" : "Join group"}
      </Button>
    );
  } else if (gate.kind === "subscriber") {
    const Icon = gate.muted ? Bell : BellOff;
    body = (
      <Button block size="lg" variant="ghost" loading={muteMutation.isPending} onClick={() => muteMutation.mutate(!gate.muted)}>
        <Icon className="size-[18px]" strokeWidth={2} aria-hidden />
        {gate.muted ? "Unmute" : "Mute"}
      </Button>
    );
  } else {
    body = (
      <p className="flex min-h-11 items-center justify-center gap-2 text-center text-[14px] text-muted">
        <MessageSquareOff className="size-[18px] shrink-0" strokeWidth={1.9} aria-hidden />
        {gate.everyone ? "Sending messages is turned off in this group" : "Admins have muted you in this group"}
      </p>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-2">
      {body}
      {error ? (
        <p role="alert" className="text-center text-[13.5px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
