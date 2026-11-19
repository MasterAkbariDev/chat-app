import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

export enum TicketStatus {
  OPEN = "open",
  PENDING = "pending",
  RESOLVED = "resolved",
}

export class TicketMessage {
  @Prop({ required: true, enum: ["user", "admin"] })
  author: "user" | "admin";

  @Prop({ type: Types.ObjectId, default: null })
  authorId: Types.ObjectId | null;

  @Prop({ required: true, type: String })
  body: string;

  @Prop({ required: true, type: Date, default: Date.now })
  at: Date;
}

/**
 * A support ticket (ADMIN_PANEL_PLAN D2). `open` = waiting for support, `pending` = waiting for
 * the user, `resolved` = closed. A user reply reopens it. Links to a recovery request or a report
 * are optional and only for the admin's context.
 */
@Schema({ collection: "support_tickets", timestamps: true, versionKey: false })
export class SupportTicket {
  _id: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: "User" })
  userId: Types.ObjectId;

  @Prop({ required: true, type: String, maxlength: 120 })
  subject: string;

  @Prop({ required: true, enum: TicketStatus, default: TicketStatus.OPEN })
  status: TicketStatus;

  @Prop({ type: Types.ObjectId, ref: "AdminUser", default: null })
  assignedTo: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: "RecoveryRequest", default: null })
  relatedRecoveryRequestId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: "Report", default: null })
  relatedReportId: Types.ObjectId | null;

  @Prop({ type: [TicketMessage], default: [] })
  messages: TicketMessage[];

  @Prop({ type: Date, default: Date.now })
  lastActivityAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const SupportTicketSchema = SchemaFactory.createForClass(SupportTicket);
SupportTicketSchema.index({ status: 1, lastActivityAt: -1 });
SupportTicketSchema.index({ userId: 1, lastActivityAt: -1 });
SupportTicketSchema.index({ assignedTo: 1, status: 1 });
