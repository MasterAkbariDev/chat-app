import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

export enum WallpaperType {
  IMAGE = "image",
  VIDEO = "video",
}

export enum WallpaperFitMode {
  COVER = "cover",
  CONTAIN = "contain",
  STRETCH = "stretch",
}

@Schema({
  collection: "wallpapers",
  timestamps: true,
  versionKey: false,
})
export class Wallpaper {
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "User", required: true, index: true })
  ownerId: Types.ObjectId;

  /** Set when wallpaper is scoped to a private or group chat share */
  @Prop({ type: String, default: null, index: true })
  channelId: string | null;

  @Prop({ enum: WallpaperType, required: true })
  type: WallpaperType;

  @Prop({ required: true })
  mediaUrl: string;

  @Prop({ type: String, default: null })
  thumbnailUrl: string | null;

  @Prop({ type: Number, default: 0, min: 0, max: 20 })
  blur: number;

  @Prop({ type: Number, default: 0, min: 0, max: 100 })
  dim: number;

  @Prop({ type: Number, default: 100, min: 50, max: 150 })
  brightness: number;

  @Prop({
    enum: WallpaperFitMode,
    default: WallpaperFitMode.COVER,
  })
  fitMode: WallpaperFitMode;

  @Prop({ type: Boolean, default: false })
  parallax: boolean;

  /** Video clip duration in seconds (max 5) */
  @Prop({ type: Number, default: null })
  duration: number | null;

  @Prop({ type: Number, default: 0 })
  videoStartSec: number;

  @Prop({ type: String, default: null })
  originalFilename: string | null;

  /**
   * The `MediaAsset` this wallpaper's media was ingested into (B9, docs/plans/BACKEND_PLAN.md —
   * "media via MediaService"). Null for a wallpaper whose `mediaUrl` predates this or was set
   * directly rather than through the upload endpoints. Used only for reference-count bookkeeping
   * (`WallpaperGcService`) — never resolved back into a URL (the client already has `mediaUrl`).
   */
  @Prop({ type: Types.ObjectId, ref: "MediaAsset", default: null })
  mediaId: Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

export const WallpaperSchema = SchemaFactory.createForClass(Wallpaper);
WallpaperSchema.index({ ownerId: 1, createdAt: -1 });
// B9: "one wallpaper doc per scope" — upserted in place by (ownerId, channelId) instead of a new
// doc per apply. `channelId: null` (the global-wallpaper scope) still participates correctly: a
// unique index treats `null` as a value like any other, so at most one global-scope doc per owner.
WallpaperSchema.index({ ownerId: 1, channelId: 1 }, { unique: true });
