import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

/**
 * One sticker or one animated emoji inside a `Pack`. Media is ingested through the ordinary
 * `MediaService.ingestImage` pipeline (already handles animated GIF — magic-byte sniffed, its
 * own size cap, stored unre-encoded — so "moves" needs no new media pipeline; see README's
 * Packs section for why WEBM/Lottie is explicitly out of scope for this pass).
 *
 * `keywords` is the per-item, multi-emoji/word search tagging (Telegram-style — a sticker/emoji
 * tagged 😂😆 is found by typing either). Distinct from `Pack.tags`, which searches for the pack
 * itself, not one item inside it.
 */
@Schema({ collection: "pack_items", timestamps: true })
export class PackItem {
  _id: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: "Pack" })
  packId: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: "MediaAsset" })
  mediaId: Types.ObjectId;

  @Prop({ type: [String], default: [] })
  keywords: string[];

  @Prop({ default: 0 })
  usageCount: number;

  @Prop({ type: Date, default: null })
  lastUsedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export const PackItemSchema = SchemaFactory.createForClass(PackItem);
PackItemSchema.index({ packId: 1, createdAt: 1 });
PackItemSchema.index({ packId: 1, keywords: 1 });
