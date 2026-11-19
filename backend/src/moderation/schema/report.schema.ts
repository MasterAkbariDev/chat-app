import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

export enum ReportTargetType {
  MESSAGE = "message",
  USER = "user",
  CHANNEL = "channel",
}

export enum ReportStatus {
  OPEN = "open",
  REVIEWING = "reviewing",
  ACTIONED = "actioned",
  DISMISSED = "dismissed",
}

/**
 * report → queue → action (B10, docs/plans/BACKEND_PLAN.md). `targetId` is a plain string, not
 * a typed `ref`, because it points at one of three different collections depending on
 * `targetType` — a single Mongoose `ref` can't be polymorphic like that. The unique index
 * dedupes repeat reports of the same target by the same reporter (the plan's "dedupe per
 * reporter+target") rather than silently accepting an unbounded pile of duplicates.
 */
@Schema({ collection: "reports", timestamps: true, versionKey: false })
export class Report {
  _id: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: "User" })
  reporterId: Types.ObjectId;

  @Prop({ required: true, enum: ReportTargetType })
  targetType: ReportTargetType;

  @Prop({ required: true, type: String })
  targetId: string;

  @Prop({ required: true, type: String })
  reason: string;

  @Prop({ type: String, default: null })
  note: string | null;

  @Prop({ required: true, enum: ReportStatus, default: ReportStatus.OPEN })
  status: ReportStatus;

  @Prop({ type: Types.ObjectId, ref: "AdminUser", default: null })
  handledBy: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  handledAt: Date | null;

  @Prop({ type: String, default: null })
  action: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export const ReportSchema = SchemaFactory.createForClass(Report);
ReportSchema.index(
  { reporterId: 1, targetType: 1, targetId: 1 },
  { unique: true },
);
ReportSchema.index({ status: 1, targetType: 1, createdAt: -1 });
