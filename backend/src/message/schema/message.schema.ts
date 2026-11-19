import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { MessageType } from "src/enum/base.enum";

/** One attachment's server-derived facts (see `Message.attachmentMeta`). The optional fields
 *  are only set for file/music attachments (and `width`/`height` for stickers). */
export interface AttachmentMetaEntry {
  mediaId: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  /** `file` / `audio` media, and `video` (so an album can mix photos and videos). */
  kind?: "file" | "audio" | "video";
  /** Video: server-relative URL of its poster frame. */
  posterUrl?: string | null;
  /** File/music: the name it was sent with (one per attachment in a file group). */
  fileName?: string | null;
  sizeBytes?: number | null;
  mimeType?: string | null;
  /** Audio: track length; from the file itself. */
  durationSec?: number | null;
  /** Audio: from the file's own tags. */
  title?: string | null;
  artist?: string | null;
  /** Server-relative URL (`/uploads/media/...`) of a small JPEG: an image file's thumbnail or a
   *  track's cover art. `width`/`height` are that image's. */
  thumbUrl?: string | null;
}

@Schema({
  collection: "messages",
  timestamps: true,
  versionKey: false,
  toJSON: {
    transform(_doc, ret: Record<string, unknown>) {
      delete ret.isDeleted;
      return ret;
    },
  },
})
export class Message {
  _id: Types.ObjectId;

  @Prop({ required: true, type: String })
  channelId: string;

  @Prop({ required: true, type: Types.ObjectId, ref: "User" })
  senderId: Types.ObjectId;

  /** The client's own id for a text send (`tempId`). A resend with the same id returns this message
   *  instead of storing a second copy (see MessageService.create). Unset on everything else. */
  @Prop({ type: String })
  clientTempId?: string;

  @Prop({
    type: String,
    required: function () {
      return (
        !(this as Message)?.attachments ||
        (this as Message)?.attachments?.length === 0
      );
    },
  })
  content: string;

  /**
   * When this message is a forward, stores a minimal display-only snapshot of the original
   * sender (B5: dropped `userId` — nothing reads it, and the schema previously declared
   * `image` while message.service.ts actually wrote `avatarUrl`, which Mongoose silently
   * stripped since it wasn't a declared path. `avatarUrl` is now the real field.).
   */
  @Prop({
    type: {
      name: { type: String, required: true },
      avatarUrl: { type: String, required: false },
      /** The original sender — only when their "Forwarded messages" privacy allowed a link. */
      userId: { type: String, required: false },
      /** True when they didn't: show the name only, not as a link. */
      hidden: { type: Boolean, required: false },
    },
    _id: false,
    default: null,
  })
  forwardFrom: {
    name: string;
    avatarUrl?: string;
    userId?: string;
    hidden?: boolean;
  } | null;

  @Prop({ enum: MessageType, default: MessageType.TEXT })
  type: MessageType;

  @Prop({ type: [String], default: [] })
  attachments: string[];

  /** Animated emoji drawn inline over unicode fallback spans in `content`
   * (see CustomEmojiEntityDto). `packId`/`relativePath` are resolved
   * server-side when the message is written, never taken from the client. */
  @Prop({
    type: [
      {
        _id: false,
        offset: { type: Number, required: true },
        length: { type: Number, required: true },
        packItemId: { type: String, required: true },
        packId: { type: String, required: true },
        relativePath: { type: String, required: true },
        /** First-frame still, for viewers with animation turned off. */
        stillPath: { type: String, required: false },
      },
    ],
    default: [],
  })
  customEmoji: {
    offset: number;
    length: number;
    packItemId: string;
    packId: string;
    relativePath: string;
    stillPath?: string;
  }[];

  /**
   * Keyed by the exact URL string in `attachments` (not an index-aligned
   * parallel array — safer against any future case where an attachment has
   * no known media row, e.g. a GIF from the generic, non-`MediaService`
   * `/upload` path). Built server-side in `MessageService.create` from the
   * real `MediaAsset` row the client's `attachmentMediaIds` points at —
   * width/height/blurhash always come from that row, never trusted directly
   * from the client. Lets a message attachment show a blurred placeholder
   * and reserve its real aspect ratio before the image itself has loaded.
   */
  @Prop({ type: Object, default: null })
  attachmentMeta: Record<string, AttachmentMetaEntry> | null;

  @Prop({ type: Types.ObjectId, ref: "Message", default: null })
  replyTo: Types.ObjectId | null;

  /**
   * Stored at create time from the replied-to message (B5) so reads never need
   * `.populate("replyTo")` — a page of history no longer pays an extra query, and a reply
   * still renders correctly even if the original is later edited or deleted.
   */
  @Prop({
    type: {
      id: { type: String, required: true },
      senderName: { type: String, required: true },
      snippet: { type: String, required: true },
      // Named `messageType`, not `type` — a nested field literally named "type" collides
      // with Mongoose's own schema-type-detection key and breaks schema construction.
      messageType: { type: String, required: true },
    },
    default: null,
  })
  replySnapshot: {
    id: string;
    senderName: string;
    snippet: string;
    messageType: MessageType;
  } | null;

  @Prop({ type: Boolean, default: false })
  isEdited: boolean;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Boolean, default: false })
  isPinned: boolean;

  @Prop({ type: [String], default: [] })
  mentions: string[];

  /** Voice message duration (B5 — accepted by CreateMessageDto since B0 but never persisted). */
  @Prop({ type: Number, default: null })
  durationSec: number | null;

  /** Voice message waveform samples, for rendering without re-decoding audio. */
  @Prop({ type: [Number], default: null })
  waveform: number[] | null;

  /** File message: the name the sender's client uploaded it with. */
  @Prop({ type: String, default: null })
  originalFilename: string | null;

  @Prop({ type: [Types.ObjectId], default: [] })
  deletedFor: Types.ObjectId[];

  /** Structured payload for system messages (e.g. wallpaper share) */
  @Prop({ type: Object, default: null })
  metadata: Record<string, unknown> | null;

  /**
   * Set together when this message is a sticker/animated-emoji sent from a pack item — resolved
   * + authorized server-side from `CreateMessageDto.packItemId` (`MessageService.create`), same
   * owner-or-subscriber rule as reacting with one (`PacksService.resolveItemForUse`). Lets a
   * received sticker be traced back to its pack, closing the "encountered a pack via a message"
   * gap a plain `attachments` URL can't — otherwise null. Plain string, not `Types.ObjectId` —
   * see docs/DATABASE_AUDIT.md's B4 note on why this codebase avoids that type for id fields.
   */
  @Prop({ type: String, default: null })
  packId: string | null;

  @Prop({ type: String, default: null })
  packItemId: string | null;

  // createdAt/updatedAt come from `timestamps: true` above — the explicit @Prop
  // versions removed in B0 fought the timestamp plugin (same effective behavior,
  // one source of truth). See docs/DATABASE_AUDIT.md.
  createdAt: Date;
  updatedAt: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);
MessageSchema.index({ channelId: 1, createdAt: -1 });
MessageSchema.index({ senderId: 1 });
// Resend dedupe: one stored message per client id, per sender and chat (sparse: most messages have none).
MessageSchema.index(
  { channelId: 1, senderId: 1, clientTempId: 1 },
  { sparse: true },
);
MessageSchema.index({ isDeleted: 1 });
MessageSchema.index({ channelId: 1, isPinned: 1 });
MessageSchema.index({ channelId: 1, mentions: 1, createdAt: 1 });
// B0: additive indexes for history-with-soft-delete and channel system-message
// exclusion / media galleries. See docs/DATABASE_AUDIT.md.
MessageSchema.index({ channelId: 1, isDeleted: 1, createdAt: -1 });
MessageSchema.index({ channelId: 1, type: 1, createdAt: -1 });
// B6: backs GET /v1/channels/:id/messages/search.
MessageSchema.index({ content: "text" });
