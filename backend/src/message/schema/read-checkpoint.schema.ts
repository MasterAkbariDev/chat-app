import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

/** How long per-reader read times are kept — matches Telegram, which only shows "read at"
 *  times for recent messages. Older reads still count as "seen" via the member's read pointer. */
export const READ_CHECKPOINT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * One row each time a member's read position moves past messages it hadn't covered before:
 * "at `readAt`, `userId` had read everything in `channelId` up to `upToCreatedAt`". A member's
 * read time for message M is the earliest `readAt` among their checkpoints with
 * `upToCreatedAt >= M.createdAt`. `chatmembers.lastReadAt` can't answer that — it's the time
 * of their latest read, not of the read that first covered an older message.
 *
 * Expires after 7 days (TTL on `readAt`), so the collection stays small; ids are plain
 * strings like `ChatMembers` (see MessageReaction's doc comment for why).
 */
@Schema({ collection: "read_checkpoints", versionKey: false })
export class ReadCheckpoint {
  _id: Types.ObjectId;

  @Prop({ required: true, type: String })
  channelId: string;

  @Prop({ required: true, type: String })
  userId: string;

  @Prop({ required: true, type: Date })
  upToCreatedAt: Date;

  @Prop({ required: true, type: Date })
  readAt: Date;
}

export const ReadCheckpointSchema =
  SchemaFactory.createForClass(ReadCheckpoint);
ReadCheckpointSchema.index(
  { readAt: 1 },
  { expireAfterSeconds: READ_CHECKPOINT_TTL_SECONDS },
);
ReadCheckpointSchema.index({ channelId: 1, userId: 1, upToCreatedAt: 1 });
