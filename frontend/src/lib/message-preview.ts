import type { ChatMessage } from "@/lib/api/types";
import { senderId, senderName } from "@/lib/api/types";
import { describeSystemMessage } from "@/lib/system-message";
import { describeCallLog, parseCallLog } from "@/lib/call-log";

const PREVIEW_MAX_LENGTH = 120;

/** Mirrors the backend's own `buildMessagePreview` (message-preview.util.ts)
 * for every non-system case, so a client-side preview patched into the chat
 * list ahead of a refetch (see NotificationsHost) never disagrees with what
 * the server's own `chat_state.lastMessagePreview` would eventually show.
 * System messages are the one deliberate difference: the backend only ever
 * computes one shared string for every member, so it can't say "You" — here
 * we know the viewer (`currentUserId`), so we reuse the same
 * `describeSystemMessage` copy the open conversation view uses
 * (system-message.ts) with a viewer-relative "who". */
export function buildMessagePreview(
  message: Pick<ChatMessage, "type" | "content" | "senderId" | "metadata"> & Partial<Pick<ChatMessage, "originalFilename" | "attachmentMeta" | "attachments">>,
  currentUserId?: string,
): string {
  const count = message.attachments?.length ?? 0;
  const rawCaption = (message.content ?? "").replace(/\s+/g, " ").trim();
  const caption = rawCaption.length > PREVIEW_MAX_LENGTH ? `${rawCaption.slice(0, PREVIEW_MAX_LENGTH)}…` : rawCaption;
  // A caption reads better than the generic label (Telegram shows it after the icon).
  const withCaption = (icon: string, label: string) => `${icon} ${caption || label}`;
  switch (message.type) {
    case "image":
      return count > 1 ? withCaption("🖼", "Album") : withCaption("📷", "Photo");
    case "file":
      return count > 1 ? withCaption("📎", `${count} files`) : withCaption("📎", message.originalFilename?.trim() || "File");
    case "audio": {
      if (count > 1) return withCaption("🎵", `${count} songs`);
      const meta = Object.values(message.attachmentMeta ?? {})[0];
      const title = meta?.title?.trim();
      const artist = meta?.artist?.trim();
      return withCaption("🎵", title ? (artist ? `${artist} – ${title}` : title) : message.originalFilename?.trim() || "Music");
    }
    case "voice":
      return "🎤 Voice message";
    case "video":
      return count > 1 ? withCaption("🖼", "Album") : withCaption("🎬", "Video");
    case "video_note":
      return "📹 Video message";
    case "gif":
      return "GIF";
    case "sticker":
      return "Sticker";
    case "voice_call": {
      const log = parseCallLog(message.content);
      if (!log) return "📞 Call";
      const mine = currentUserId != null && senderId(message.senderId) === currentUserId;
      return `📞 ${describeCallLog(log, mine)}`;
    }
    case "system": {
      const mine = currentUserId != null && senderId(message.senderId) === currentUserId;
      // The `new_message` socket payload for a system message isn't always populated the
      // way a REST fetch is (e.g. WallpaperService.applyChat broadcasts the raw created
      // doc, `senderId` still a bare ObjectId string) — fall back to the `senderName` the
      // backend stashed in `metadata` for exactly this case rather than showing "Unknown".
      const metadataSenderName = message.metadata?.senderName;
      const who = mine
        ? "You"
        : typeof metadataSenderName === "string" && metadataSenderName
          ? metadataSenderName
          : senderName(message.senderId);
      return describeSystemMessage(message, who);
    }
    case "text":
    default: {
      const content = (message.content ?? "").trim();
      if (!content) return "";
      return content.length > PREVIEW_MAX_LENGTH ? `${content.slice(0, PREVIEW_MAX_LENGTH)}…` : content;
    }
  }
}
