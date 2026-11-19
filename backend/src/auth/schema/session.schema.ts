import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

/**
 * One row per issued refresh token (rotated on every use). `familyId` links every token
 * descended from the same login — reusing an already-rotated token revokes the whole family
 * (docs/plans/BACKEND_PLAN.md B4: "reuse detection revokes the family").
 */
@Schema({ collection: "sessions", timestamps: true, versionKey: false })
export class Session {
  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, unique: true })
  refreshTokenHash: string;

  @Prop({ required: true })
  familyId: string;

  @Prop({ type: String, default: null })
  device: string | null;

  @Prop({ type: String, default: null })
  ip: string | null;

  @Prop({ type: Date, default: Date.now })
  lastUsedAt: Date;

  @Prop({ type: Date, default: null })
  revokedAt: Date | null;

  // Written by `timestamps: true`; declared so typed reads can use it.
  createdAt: Date;
  updatedAt: Date;
}

export const SessionSchema = SchemaFactory.createForClass(Session);
SessionSchema.index({ userId: 1, revokedAt: 1 });
SessionSchema.index({ familyId: 1 });
