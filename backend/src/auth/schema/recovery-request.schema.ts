import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

export enum RecoveryRequestStatus {
  PENDING = "pending",
  APPROVED = "approved",
  DENIED = "denied",
}

/**
 * A user's "I lost access to my account" request (B4 Q1, docs/plans/BACKEND_PLAN.md). Created
 * by `POST /v1/auth/recovery-request` regardless of whether the account actually exists (the
 * endpoint gives an identical response either way — see `AuthService.requestRecovery`), so this
 * collection intentionally may not correspond 1:1 with real accounts. An admin reviews pending
 * rows in the admin panel and approves/denies — approval mints a `RecoveryToken`.
 */
@Schema({
  collection: "recovery_requests",
  timestamps: true,
  versionKey: false,
})
export class RecoveryRequest {
  _id: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: "User" })
  userId: Types.ObjectId;

  @Prop({
    required: true,
    enum: RecoveryRequestStatus,
    default: RecoveryRequestStatus.PENDING,
  })
  status: RecoveryRequestStatus;

  @Prop({ type: Types.ObjectId, ref: "AdminUser", default: null })
  reviewedBy: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  reviewedAt: Date | null;

  /** Where the request came from. Shown to the reviewing admin, never to the user. */
  @Prop({ type: String, default: null })
  ip: string | null;

  /** Why an admin denied it. Shown in the queue's history, never to the user. */
  @Prop({ type: String, default: null })
  denyNote: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export const RecoveryRequestSchema =
  SchemaFactory.createForClass(RecoveryRequest);
RecoveryRequestSchema.index({ status: 1, createdAt: -1 });
RecoveryRequestSchema.index({ userId: 1 });
