import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

/**
 * One row per (message, user, emoji-or-packItem). Replaces the old `message.reactions` Map (B5,
 * docs/plans/BACKEND_PLAN.md) — a toggle is now a single delete-or-insert on this collection
 * instead of a read-modify-write of the whole message document, and a page of messages gets
 * its reaction counts from one batched `$group` instead of shipping every reactor's userId.
 *
 * A reaction is either a plain unicode emoji (`emoji` set, `packItemId` null) or a sticker/
 * animated-emoji pack item (`packItemId` set, `emoji` null) — never both, enforced in
 * `MessageService.toggleReaction`, not at the schema level. `packItemRelativePath` is
 * deliberately denormalized here (copied once from the pack item at reaction time) rather than
 * resolved via a `$lookup` on every read: the batched `$group` this collection exists to make
 * cheap runs across a whole page of messages at once, and a per-row join back to `pack_items` +
 * `media_assets` on every read would defeat that. It also means a reaction keeps showing the
 * media it showed when it was added even if the underlying pack item is later edited — treated
 * as correct, not a staleness bug, matching how a sent sticker *message* already behaves (its
 * `attachments` URL is fixed at send time too).
 *
 * `channelId`/`messageId`/`userId`/`packItemId`/`packId` are plain strings, matching the
 * convention already used by `ChatMembers` — see docs/DATABASE_AUDIT.md and the B4 session-store
 * bug it caused (`@Prop({type: Types.ObjectId})` resolves to a Mixed-typed path in this
 * codebase's Mongoose/NestJS versions, so string queries never auto-cast). Storing as string
 * sidesteps it.
 */
@Schema({
  collection: "message_reactions",
  timestamps: true,
  versionKey: false,
})
export class MessageReaction {
  _id: Types.ObjectId;

  @Prop({ required: true, type: String })
  messageId: string;

  @Prop({ required: true, type: String })
  channelId: string;

  /** Null for a pack-item reaction — see class doc comment. */
  @Prop({ type: String, default: null })
  emoji: string | null;

  /** Null for a plain-emoji reaction — see class doc comment. */
  @Prop({ type: String, default: null })
  packItemId: string | null;

  /** Denormalized alongside `packItemId`, null otherwise — see class doc comment. */
  @Prop({ type: String, default: null })
  packItemRelativePath: string | null;

  /** Denormalized alongside `packItemId` (its parent pack) — lets a client offer "open this
   *  pack" from a reaction without a lookup; null otherwise. */
  @Prop({ type: String, default: null })
  packId: string | null;

  @Prop({ required: true, type: String })
  userId: string;

  createdAt: Date;
  updatedAt: Date;
}

export const MessageReactionSchema =
  SchemaFactory.createForClass(MessageReaction);
MessageReactionSchema.index(
  { messageId: 1, userId: 1, emoji: 1, packItemId: 1 },
  { unique: true },
);
MessageReactionSchema.index({ messageId: 1 });
MessageReactionSchema.index({ channelId: 1, createdAt: 1 });
