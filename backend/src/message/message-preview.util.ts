import { MessageType } from "src/enum/base.enum";

const PREVIEW_MAX_LENGTH = 120;

/** "12 min" / "1 h 5 min" — same wording the client uses for the service message. */
export function formatCallDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Mirrors the copy in frontend/src/lib/system-message.ts's `describeSystemMessage`.
 * Unlike that open-conversation view, this string is computed once here and shared
 * by every member's chat list (`chat_state.lastMessagePreview`), so it can never say
 * "You" for the viewer's own action — it always names the actor, taken from the
 * `senderName` stashed in the message's `metadata` at creation time (see
 * WallpaperService.applyChat), falling back to "Someone" when that isn't set.
 */
function describeSystemMessagePreview(message: {
  content?: string | null;
  metadata?: Record<string, unknown> | null;
}): string {
  const rawSenderName = message.metadata?.senderName;
  const who =
    typeof rawSenderName === "string" && rawSenderName
      ? rawSenderName
      : "Someone";
  switch (message.content) {
    case "member_joined":
      return `${who} joined the chat`;
    case "members_added": {
      const addedIds = message.metadata?.addedUserIds;
      const count = Array.isArray(addedIds) ? addedIds.length : 0;
      return `${who} added ${count} ${count === 1 ? "member" : "members"}`;
    }
    case "wallpaper_changed":
      return `${who} changed the chat wallpaper`;
    case "voice_chat_started":
      return `${who} started a voice chat`;
    case "voice_chat_ended": {
      const minutes = message.metadata?.durationMinutes;
      return typeof minutes === "number" && minutes > 0
        ? `Voice chat ended · ${formatCallDuration(minutes)}`
        : "Voice chat ended";
    }
    default:
      return message.content ?? "";
  }
}

/** "Artist – Title" from the track's own tags, else its file name, else "Music". */
function musicLabel(message: {
  originalFilename?: string | null;
  attachmentMeta?: Record<
    string,
    { title?: string | null; artist?: string | null } | null | undefined
  > | null;
}): string {
  const meta = Object.values(message.attachmentMeta ?? {})[0];
  const title = meta?.title?.trim();
  if (title) {
    const artist = meta?.artist?.trim();
    return artist ? `${artist} – ${title}` : title;
  }
  return message.originalFilename?.trim() || "Music";
}

function clip(text: string): string {
  return text.length > PREVIEW_MAX_LENGTH
    ? `${text.slice(0, PREVIEW_MAX_LENGTH)}…`
    : text;
}

/**
 * The one-line summary shown in a chat list ("last message"). Shared by the `message.created`
 * emitter (message.service.ts) and the `chat_state` recompute-on-delete path
 * (chat-state.listener.ts) so they can never disagree on what a given message renders as.
 */
export function buildMessagePreview(message: {
  type: MessageType;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
  /** File/music messages: shown instead of the generic label when present. */
  originalFilename?: string | null;
  attachments?: string[] | null;
  attachmentMeta?: Record<
    string,
    { title?: string | null; artist?: string | null } | null | undefined
  > | null;
}): string {
  const count = message.attachments?.length ?? 0;
  const caption = clip((message.content ?? "").replace(/\s+/g, " ").trim());
  // A caption reads better than the generic label (Telegram shows it after the icon).
  const withCaption = (icon: string, label: string) =>
    `${icon} ${caption || label}`;
  switch (message.type) {
    case MessageType.IMAGE:
      return count > 1 ? withCaption("🖼", "Album") : withCaption("📷", "Photo");
    case MessageType.FILE:
      return count > 1
        ? withCaption("📎", `${count} files`)
        : withCaption("📎", message.originalFilename?.trim() || "File");
    case MessageType.AUDIO:
      return count > 1
        ? withCaption("🎵", `${count} songs`)
        : withCaption("🎵", musicLabel(message));
    case MessageType.VOICE:
      return "🎤 Voice message";
    case MessageType.VIDEO:
      return count > 1 ? withCaption("🖼", "Album") : withCaption("🎬", "Video");
    case MessageType.VIDEO_NOTE:
      return "📹 Video message";
    case MessageType.GIF:
      return "GIF";
    case MessageType.STICKER:
      return "Sticker";
    case MessageType.VOICE_CALL:
      return "📞 Call";
    case MessageType.SYSTEM:
      return describeSystemMessagePreview(message);
    case MessageType.TEXT:
    default: {
      const content = (message.content ?? "").trim();
      if (!content) return "";
      return content.length > PREVIEW_MAX_LENGTH
        ? `${content.slice(0, PREVIEW_MAX_LENGTH)}…`
        : content;
    }
  }
}
