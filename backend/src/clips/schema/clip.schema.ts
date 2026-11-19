import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

/**
 * A user's personal GIF library (B9, docs/plans/BACKEND_PLAN.md — "Personal: clips {ownerId,
 * mediaId, title?, lastUsedAt, usageCount} via MediaService"). Replaces the old `user_gifs`
 * collection, which stored its own dedupe/upload pipeline in parallel to `MediaService` — a
 * clip is just a named pointer to a `MediaAsset` the owner has saved, so upload/dedupe/size
 * limits all come from the one real media pipeline instead of a second copy of it.
 *
 * Deliberately personal-only: there is no `isPublic`/cross-user "trending" concept here (that
 * was the old system's own aggregation over `user_gifs`, dropped alongside `app_settings`'s
 * `trendingGifs` toggle — "what's popular" is Giphy's global tab now, see src/giphy/).
 */
@Schema({ collection: "clips", timestamps: true, versionKey: false })
export class Clip {
  _id: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: "User" })
  ownerId: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: "MediaAsset" })
  mediaId: Types.ObjectId;

  @Prop({ type: String, default: "" })
  title: string;

  @Prop({ type: Date, default: null })
  lastUsedAt: Date | null;

  @Prop({ type: Number, default: 0 })
  usageCount: number;

  createdAt: Date;
  updatedAt: Date;
}

export const ClipSchema = SchemaFactory.createForClass(Clip);
// A re-upload of the same video hashes to the same MediaAsset (MediaService's own dedupe) — this
// stops that from creating a second library entry for the same owner.
ClipSchema.index({ ownerId: 1, mediaId: 1 }, { unique: true });
ClipSchema.index({ ownerId: 1, lastUsedAt: -1, createdAt: -1 });
