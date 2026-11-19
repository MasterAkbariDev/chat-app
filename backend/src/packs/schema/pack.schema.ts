import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { PackType } from "src/enum/base.enum";

/**
 * A sticker pack or an animated-emoji pack (`type` — same shape either way, see
 * `src/enum/base.enum.ts`'s `PackType` doc comment). Replaces the old B9 `sticker_packs`
 * collection — the old system had no "add this pack to my collection" concept at all (only
 * owner-or-public access); this generalizes it Telegram-style: `isPublic` now controls
 * *discoverability* (search), not *access* — a private pack is still fully viewable/addable by
 * anyone holding its `slug` (an unguessable-enough, but not cryptographically secret, invite
 * link), same shape as Telegram's own "private sticker set, shareable by link" behavior.
 *
 * Owning a pack and having it in your own collection are separate facts (see
 * `PackSubscription`) — `PacksService.create` auto-subscribes the owner so "my packs" is always
 * just "my subscriptions," never a union of two different queries.
 */
@Schema({ collection: "packs", timestamps: true })
export class Pack {
  _id: Types.ObjectId;

  @Prop({ required: true, enum: PackType })
  type: PackType;

  @Prop({ required: true, trim: true, maxlength: 64 })
  name: string;

  @Prop({ type: String, default: null, maxlength: 300 })
  description: string | null;

  @Prop({ required: true, type: Types.ObjectId, ref: "User" })
  ownerId: Types.ObjectId;

  /** Pack-level search tags (free text) — distinct from a `PackItem`'s own `keywords`. */
  @Prop({ type: [String], default: [] })
  tags: string[];

  /** Discoverability only — see class doc comment. Never gates `findOne`/`findBySlug`. */
  @Prop({ default: false })
  isPublic: boolean;

  /**
   * Unique, URL-safe invite slug — resolves via `GET /v1/packs/by-slug/:slug`. Auto-derived from
   * `name` at creation (deduped with a short random suffix on collision), immutable afterward so
   * a previously shared link never breaks.
   */
  @Prop({ required: true, unique: true })
  slug: string;

  @Prop({ default: 0 })
  itemCount: number;

  @Prop({ default: 0 })
  totalUsageCount: number;

  @Prop({ default: false })
  isDeleted: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const PackSchema = SchemaFactory.createForClass(Pack);
PackSchema.index({ ownerId: 1, isDeleted: 1 });
PackSchema.index({ type: 1, isPublic: 1, isDeleted: 1, totalUsageCount: -1 });
