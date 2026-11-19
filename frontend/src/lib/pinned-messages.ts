import type { ChatMessage } from "@/lib/api/types";
import { buildMessagePreview } from "@/lib/message-preview";

/** What a pinned message is, for the pinned bar and the pinned list. */
export type PinKind = "text" | "photo" | "video" | "album" | "file" | "music" | "voice" | "video_note" | "gif" | "sticker" | "call" | "system";

export interface PinPreview {
  kind: PinKind;
  /** The media's name in the chat's own words: "Photo", "Video", "Voice message", "File: report.pdf".
   *  Null for plain text, calls and system lines (their text says it all). */
  label: string | null;
  /** The caption (or the text itself), one line, whitespace collapsed. Empty when there's none. */
  text: string;
}

type PreviewInput = Pick<ChatMessage, "type" | "content" | "senderId" | "metadata" | "attachments"> &
  Partial<Pick<ChatMessage, "attachmentMeta" | "originalFilename">>;

const EMOJI_PREFIX = /^\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*\s*/u;

/** A pin as the bar and the pinned list read it: a kind label (for media) and its caption or text. */
export function pinPreview(m: PreviewInput, currentUserId?: string): PinPreview {
  const caption = (m.content ?? "").replace(/\s+/g, " ").trim();
  const count = m.attachments?.length ?? 0;
  switch (m.type) {
    case "image":
      return count > 1 ? { kind: "album", label: "Album", text: caption } : { kind: "photo", label: "Photo", text: caption };
    case "video":
      return count > 1 ? { kind: "album", label: "Album", text: caption } : { kind: "video", label: "Video", text: caption };
    case "file": {
      if (count > 1) return { kind: "file", label: `${count} files`, text: caption };
      const name = m.attachmentMeta ? Object.values(m.attachmentMeta)[0]?.fileName?.trim() : undefined;
      return { kind: "file", label: `File: ${name || m.originalFilename?.trim() || "File"}`, text: caption };
    }
    case "audio": {
      if (count > 1) return { kind: "music", label: `${count} songs`, text: caption };
      const meta = m.attachmentMeta ? Object.values(m.attachmentMeta)[0] : undefined;
      const title = meta?.title?.trim();
      const artist = meta?.artist?.trim();
      const label = title ? (artist ? `${artist} – ${title}` : title) : m.originalFilename?.trim() || "Music";
      return { kind: "music", label, text: caption };
    }
    case "voice":
      return { kind: "voice", label: "Voice message", text: caption };
    case "video_note":
      return { kind: "video_note", label: "Video message", text: caption };
    case "gif":
      return { kind: "gif", label: "GIF", text: caption };
    case "sticker":
      return { kind: "sticker", label: "Sticker", text: caption };
    case "voice_call":
      return { kind: "call", label: null, text: buildMessagePreview(m, currentUserId).replace(EMOJI_PREFIX, "").trim() };
    case "system":
      return { kind: "system", label: null, text: buildMessagePreview(m, currentUserId).replace(EMOJI_PREFIX, "").trim() };
    case "text":
    default:
      return { kind: "text", label: null, text: caption || "Message" };
  }
}

/** One line for the bar: "Photo · caption", or just the text. */
export function pinSnippet(m: PreviewInput, currentUserId?: string): string {
  const { label, text } = pinPreview(m, currentUserId);
  return [label, text].filter(Boolean).join(" · ") || "Message";
}
