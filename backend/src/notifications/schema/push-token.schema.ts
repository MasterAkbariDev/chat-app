import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

/**
 * B7 (docs/plans/BACKEND_PLAN.md) — one row per registered device. `userId` is a plain string,
 * matching the convention already used by `ChatMembers`/`Contact`/etc. (see the B4 session-store
 * bug it exists to avoid). Android/Flutter only — this app doesn't build APNs, so `platform` has
 * one value today; the field stays open in case that ever changes.
 */
@Schema({ collection: "push_tokens", timestamps: true, versionKey: false })
export class PushToken {
  _id: Types.ObjectId;

  @Prop({ required: true, type: String })
  userId: string;

  @Prop({ required: true, enum: ["android"] })
  platform: "android";

  @Prop({ required: true, type: String, unique: true })
  token: string;

  @Prop({ type: String, default: null })
  ua: string | null;

  @Prop({ type: Date, default: Date.now })
  lastSeenAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const PushTokenSchema = SchemaFactory.createForClass(PushToken);
PushTokenSchema.index({ userId: 1 });
