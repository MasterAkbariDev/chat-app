import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

/**
 * B6 (docs/plans/BACKEND_PLAN.md) — the address book. `ownerId`/`userId` are plain strings,
 * matching the convention used by `ChatMembers`/`MessageReaction`: `@Prop({type: Types.ObjectId})`
 * resolves to a Mongoose `Mixed`-typed path in this project's Mongoose/NestJS versions (see the
 * B4 session-store bug it caused), so a plain string never auto-casts against it. Storing as
 * string sidesteps that entirely.
 */
@Schema({ collection: "contacts", timestamps: true, versionKey: false })
export class Contact {
  _id: Types.ObjectId;

  @Prop({ required: true, type: String })
  ownerId: string;

  @Prop({ required: true, type: String })
  userId: string;

  @Prop({ type: String, default: null })
  customName: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export const ContactSchema = SchemaFactory.createForClass(Contact);
ContactSchema.index({ ownerId: 1, userId: 1 }, { unique: true });
ContactSchema.index({ ownerId: 1 });
