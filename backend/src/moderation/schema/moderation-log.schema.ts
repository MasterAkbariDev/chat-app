import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

/**
 * Append-only audit trail of every admin action (B10, docs/plans/BACKEND_PLAN.md — "every admin
 * action" is logged). Nothing in this codebase ever updates or deletes a row here — only
 * `ModerationLogService.log()` (a plain insert) writes to this collection.
 */
@Schema({ collection: "moderation_log", timestamps: false, versionKey: false })
export class ModerationLog {
  _id: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: "AdminUser" })
  actorId: Types.ObjectId;

  @Prop({ required: true, type: String })
  action: string;

  @Prop({ required: true, type: String })
  targetType: string;

  @Prop({ required: true, type: String })
  targetId: string;

  @Prop({ type: Object, default: null })
  meta: Record<string, unknown> | null;

  @Prop({ required: true, type: Date, default: Date.now })
  at: Date;
}

export const ModerationLogSchema = SchemaFactory.createForClass(ModerationLog);
ModerationLogSchema.index({ targetType: 1, targetId: 1, at: -1 });
ModerationLogSchema.index({ actorId: 1, at: -1 });
