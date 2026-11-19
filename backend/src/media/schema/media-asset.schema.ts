import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

/** `file`: any document kept byte-for-byte (sent as a Telegram-style file message);
 *  `audio`: a music track kept byte-for-byte, with its tags + cover art extracted. */
export type MediaAssetKind = "image" | "video" | "file" | "audio";
export type MediaAssetTier = "hot" | "cold";

/**
 * One row per distinct file (by content hash), regardless of how many messages/profiles/chats
 * reference it — `refCount` tracks that, so a future orphan sweep (B11) can tell what's safe to
 * archive. See docs/plans/BACKEND_PLAN.md B2 "MediaService".
 */
@Schema({ collection: "media_assets", timestamps: true, versionKey: false })
export class MediaAsset {
  _id: Types.ObjectId;

  @Prop({ required: true, unique: true })
  hash: string;

  @Prop({ required: true, enum: ["image", "video", "file", "audio"] })
  kind: MediaAssetKind;

  @Prop({ required: true })
  mimeType: string;

  @Prop({ required: true })
  sizeBytes: number;

  @Prop({ type: Number, default: null })
  width: number | null;

  @Prop({ type: Number, default: null })
  height: number | null;

  /** Compact placeholder for progressive image loading — null until an image variant exists. */
  @Prop({ type: String, default: null })
  blurhash: string | null;

  @Prop({ type: Number, default: null })
  durationSec: number | null;

  /** Audio only — from the file's own tags (ID3/MP4/Vorbis), never from the client. */
  @Prop({ type: String, default: null })
  title: string | null;

  @Prop({ type: String, default: null })
  artist: string | null;

  /**
   * Relative paths (never absolute — no host baked in), resolved against wherever the storage
   * backend serves from (today: `/uploads`; S3+CDN in B11 with no call-site change).
   */
  @Prop({
    type: {
      original: String,
      web: String,
      thumb: String,
      poster: String,
      packThumb: String,
      packStill: String,
    },
    required: true,
  })
  variants: {
    original: string;
    web?: string;
    thumb?: string;
    poster?: string;
    /** Pack items only: 160px WebP, animation kept — what pickers, inline
     *  emoji and reaction pills load instead of the (often 512px) original. */
    packThumb?: string;
    /** Pack items only: 160px WebP of the first frame — for viewers who've
     *  turned animated emoji off (reduce motion / lite mode). */
    packStill?: string;
  };

  /**
   * Byte size of each stored variant — captured at ingest time (from the actual encoded buffer,
   * not re-measured later) so the upload response can show a real "HD vs compressed" size
   * comparison without a second pass over storage. Null on rows created before this field
   * existed; those still work everywhere else, they just can't show a before/after size.
   */
  @Prop({
    type: {
      original: Number,
      web: Number,
      thumb: Number,
      poster: Number,
      packThumb: Number,
      packStill: Number,
    },
    default: null,
  })
  variantSizes: {
    original?: number;
    web?: number;
    thumb?: number;
    poster?: number;
    packThumb?: number;
    packStill?: number;
  } | null;

  /** First uploader — attribution/audit metadata only. Not an access-control owner, and
   *  (deliberately) not enforced against any per-user storage cap — uploads are unlimited. */
  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  ownerId: Types.ObjectId;

  @Prop({ type: Number, default: 1 })
  refCount: number;

  /**
   * Lifecycle tiering (B11 — "tags media by age/last-access... never delete"). `hot` is normal;
   * the nightly `MediaLifecycleService` sweep tags anything not read via `lastAccessedAt` in
   * `MEDIA_COLD_TIER_DAYS` days as `cold`. A cold asset is still served exactly the same way —
   * with a real cloud backend (R2/B2/Glacier-IR) a distinct storage *class* would mean higher
   * latency on that read; MinIO has no such distinct class, so today this field only records
   * the intent, not an actual storage-tier transition (see README's B11 section for the honest
   * scope note). `MediaServeController` flips a cold asset back to `hot` the moment it's read
   * again, rather than waiting for the next nightly sweep.
   */
  @Prop({ type: String, enum: ["hot", "cold"], default: "hot" })
  tier: MediaAssetTier;

  @Prop({ type: Date, default: Date.now })
  lastAccessedAt: Date;
}

export const MediaAssetSchema = SchemaFactory.createForClass(MediaAsset);
MediaAssetSchema.index({ ownerId: 1 });
MediaAssetSchema.index({ tier: 1, lastAccessedAt: 1 });
MediaAssetSchema.index({ refCount: 1 });
