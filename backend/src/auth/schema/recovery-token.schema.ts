import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

/**
 * The short, opaque, time-boxed link an admin generates after approving a `RecoveryRequest`
 * (B4 Q1, docs/plans/BACKEND_PLAN.md). Only the SHA-256 hash is ever persisted here — same
 * pattern as `Session.refreshTokenHash` — the raw token is returned exactly once, in the
 * approval response, for the admin to copy and send out of band; it can never be read back
 * from the database afterward.
 */
@Schema({ collection: "recovery_tokens", timestamps: true, versionKey: false })
export class RecoveryToken {
  _id: Types.ObjectId;

  @Prop({ required: true, unique: true })
  tokenHash: string;

  @Prop({ required: true, type: Types.ObjectId, ref: "User" })
  userId: Types.ObjectId;

  @Prop({ required: true, type: Date })
  expiresAt: Date;

  @Prop({ type: Date, default: null })
  usedAt: Date | null;

  /** The request this link was minted for. */
  @Prop({ type: Types.ObjectId, ref: "RecoveryRequest", default: null })
  recoveryRequestId: Types.ObjectId | null;

  /** The admin who approved it. */
  @Prop({ type: Types.ObjectId, ref: "AdminUser", default: null })
  issuedBy: Types.ObjectId | null;

  /** Set by an admin to kill an unused link early. A revoked link is rejected like an expired one. */
  @Prop({ type: Date, default: null })
  revokedAt: Date | null;

  /** When the admin marked the link as sent to the user out of band. */
  @Prop({ type: Date, default: null })
  sentAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export const RecoveryTokenSchema = SchemaFactory.createForClass(RecoveryToken);
RecoveryTokenSchema.index({ userId: 1 });
RecoveryTokenSchema.index({ recoveryRequestId: 1 });
