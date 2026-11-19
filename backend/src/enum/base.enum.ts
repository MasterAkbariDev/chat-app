export enum ChatType {
  CHANNEL = "channel",
  GROUP = "group",
  PRIVATE = "private",
  SAVED_MESSAGES = "saved_messages",
}

export enum UserRole {
  OWNER = "owner",
  ADMIN = "admin",
  MEMBER = "member",
}

export enum MessageType {
  TEXT = "text",
  IMAGE = "image",
  FILE = "file",
  /** A music track (Telegram's "audio"): played through the app-wide player, with title/artist/
   *  cover read server-side from the file's own tags (see MediaService.ingestFile). */
  AUDIO = "audio",
  SYSTEM = "system",
  GIF = "gif",
  STICKER = "sticker",
  VOICE = "voice",
  VIDEO = "video",
  /** Round, self-recorded "video message" (Telegram-style), rendered as a
   *  circle — same storage/transcode pipeline as VIDEO, distinct type so
   *  clients can render it differently and previews can say so. */
  VIDEO_NOTE = "video_note",
  VOICE_CALL = "voice_call",
}

export enum UserStatus {
  ONLINE = "online",
  OFFLINE = "offline",
  TYPING = "typing",
  AWAY = "away",
}

/**
 * A `Pack` (src/packs/) is either a sticker pack or an animated-emoji pack — same ownership,
 * subscription, item-CRUD, and keyword-search machinery either way (see src/packs/README or the
 * module's own doc comment). `type` only changes how a client renders/slots the pack's items
 * (sticker tray vs. an animated-emoji tab inside the regular emoji picker) and never changes
 * server-side behavior.
 */
export enum PackType {
  STICKER = "sticker",
  EMOJI = "emoji",
}
