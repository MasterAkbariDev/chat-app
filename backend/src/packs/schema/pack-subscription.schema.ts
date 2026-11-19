import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

/**
 * "This pack is in this user's own collection" — the fact that was completely missing from the
 * old B9 sticker system (it only had owner-or-public, no per-user save list). A pack's owner is
 * auto-subscribed on creation (`PacksService.create`); everyone else subscribes explicitly via
 * `POST /v1/packs/:id/subscribe` (tapping a shared item/link, or a search result). `order` lets
 * a user reorder their own picker tabs, same idea as `ChatMembers.isPinned` ordering elsewhere.
 */
@Schema({ collection: "pack_subscriptions", timestamps: true })
export class PackSubscription {
  _id: Types.ObjectId;

  @Prop({ required: true, type: String })
  userId: string;

  @Prop({ required: true, type: Types.ObjectId, ref: "Pack" })
  packId: Types.ObjectId;

  @Prop({ default: 0 })
  order: number;

  createdAt: Date;
  updatedAt: Date;
}

export const PackSubscriptionSchema =
  SchemaFactory.createForClass(PackSubscription);
PackSubscriptionSchema.index({ userId: 1, packId: 1 }, { unique: true });
PackSubscriptionSchema.index({ userId: 1, order: 1 });
