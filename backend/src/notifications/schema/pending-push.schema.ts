import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

export type PendingPushDocument = HydratedDocument<PendingPush>;

/**
 * A message push that FCM couldn't take while it was down (or refused for now). Kept until it
 * goes out, a token dies, or it's older than 2 days (`expiresAt`, removed by TTL).
 */
@Schema({
  collection: "pending_pushes",
  timestamps: { createdAt: true, updatedAt: false },
})
export class PendingPush {
  @Prop({ required: true, type: String })
  token: string;

  @Prop({ required: true, type: String })
  userId: string;

  @Prop({ required: true, type: Object })
  notification: { title: string; body: string };

  @Prop({ required: true, type: Object })
  data: Record<string, string>;

  @Prop({ type: Object, default: null })
  web: { tag?: string; link?: string } | null;

  @Prop({ type: Number, default: 0 })
  attempts: number;

  @Prop({ required: true, type: Date })
  nextAttemptAt: Date;

  @Prop({ required: true, type: Date })
  expiresAt: Date;

  createdAt: Date;
}

export const PendingPushSchema = SchemaFactory.createForClass(PendingPush);
PendingPushSchema.index({ nextAttemptAt: 1 });
PendingPushSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
