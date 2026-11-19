import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

/**
 * Maps a Giphy GIF/sticker id to the `MediaAsset` it was mirrored into on first use (B9,
 * docs/plans/BACKEND_PLAN.md — "a Giphy asset must be saved to our server too so next time it
 * works without Giphy"). Once a row exists here, every later send of that same Giphy id is
 * served entirely from our own storage — no Giphy call, and it keeps working even if Giphy
 * becomes unreachable or shuts down (as Tenor did in 2026).
 *
 * `giphyId`/`mediaAssetId` reference stays a string / real ObjectId respectively — this
 * collection is looked up by `{giphyId, kind}` (a Giphy-side identifier, never cast from a
 * user-supplied Mongo id), so the B4 Mixed-type-cast pitfall doesn't apply here.
 */
@Schema({ collection: "giphy_media", timestamps: true, versionKey: false })
export class GiphyMedia {
  _id: Types.ObjectId;

  @Prop({ required: true, type: String })
  giphyId: string;

  @Prop({ required: true, enum: ["gif", "sticker"] })
  kind: "gif" | "sticker";

  @Prop({ required: true, type: Types.ObjectId, ref: "MediaAsset" })
  mediaAssetId: Types.ObjectId;

  @Prop({ type: String, default: "" })
  title: string;

  @Prop({ type: Number, default: 0 })
  usageCount: number;

  @Prop({ type: Date, default: Date.now })
  lastUsedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const GiphyMediaSchema = SchemaFactory.createForClass(GiphyMedia);
GiphyMediaSchema.index({ giphyId: 1, kind: 1 }, { unique: true });
