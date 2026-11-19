import type { ChatMessage } from "./api/types";

/** The backend posts a handful of raw content codes for `type: "system"`
 * messages (`member_joined`, `members_added`, `wallpaper_changed` — see
 * chat.service.ts / wallpaper.service.ts) and relies on the client to turn
 * them into real text; rendering `message.content` directly would show the
 * literal code. `who` is "You" for the acting user's own system messages,
 * their display name otherwise — the backend always sets `senderId` to
 * whoever performed the action, even for messages with no visible sender
 * label elsewhere. */
export function describeSystemMessage(message: Pick<ChatMessage, "content" | "metadata">, who: string): string {
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
      return typeof minutes === "number" && minutes > 0 ? `Voice chat ended · ${formatCallMinutes(minutes)}` : "Voice chat ended";
    }
    default:
      return message.content;
  }
}

/** "12 min" / "1 h 5 min" — matches the backend's chat-list preview wording. */
export function formatCallMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Only `wallpaper_changed` carries this shape today (see
 * `WallpaperService.applyChat`'s system-message `metadata`). */
export function wallpaperChangeMetadata(message: Pick<ChatMessage, "content" | "metadata">): { wallpaperId: string } | null {
  if (message.content !== "wallpaper_changed") return null;
  const wallpaperId = message.metadata?.wallpaperId;
  return typeof wallpaperId === "string" ? { wallpaperId } : null;
}
