import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Sharp, SharpOptions } from "sharp";
import { encode as encodeBlurhash } from "blurhash";
import { MediaAsset } from "./schema/media-asset.schema";
import { MEDIA_STORAGE, MediaStorage } from "./storage/media-storage.interface";
import { sniffImageType } from "./file-sniff.util";
import { sniffVideoType } from "./video-sniff.util";
import {
  compressVideo,
  extractVideoThumbnail,
  probeVideoDurationSec,
  probeVideoResolution,
  compressLoopVideo,
  compressVideoNote,
  VIDEO_NOTE_PX,
  type LoopVideoOptions,
  type VideoEdits,
  videoEditsKey,
} from "./video-processing.util";
import { extractAudioCover, probeAudio } from "./audio-processing.util";

// `sharp`'s own .d.ts declares an ESM `export default`, but its actual CJS export (verified via
// `require("sharp")`) is the callable itself with no `.default` — esModuleInterop is off in this
// project's tsconfig, so a plain `import sharp from "sharp"` would call an interop shim that was
// never applied. Bind the real runtime value and keep sharp's own types for the returned `Sharp`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require("sharp") as (
  input?: Buffer | string,
  options?: SharpOptions,
) => Sharp;

const PACK_VARIANT_PX = 128;
/** Animated pack variants are re-timed to roughly this frame interval
 * (~17 fps). Emoji shown at 20–40px look the same, and the file shrinks
 * by about the same factor as the frames dropped (Noto's 33 fps sources:
 * ~5× smaller overall at 128px). */
const PACK_MIN_FRAME_MS = 60;

// Per-content-type upload caps (docs/plans/BACKEND_PLAN.md B9 follow-up — "make sure media are
// compressing and there is a limit"). Enforced here, not just at the controller's multer
// `limits.fileSize`, so every caller — including a future remote-fetch path like B9's Giphy
// mirror-on-first-use — gets the same ceiling regardless of how the buffer arrived.
const IMAGE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB — jpg/png/webp
const GIF_MAX_BYTES = 8 * 1024 * 1024; // 8 MB — animated GIFs are stored unre-encoded, so a
// large one stays large; this is the one place we can cap it (a real recompression pass would
// mean re-running the same palette/fps/scale pipeline gif-conversion.service.ts already uses
// for video→GIF — out of scope for this pass, see README).
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024; // 200 MB — checked here too (see above) even
// though the controller's multer limit is the primary gate for the actual upload path.

/** Documents/music sent as files (Telegram-style) — kept byte-for-byte, so this is the one cap. */
export const FILE_MAX_BYTES = 200 * 1024 * 1024;

/** Content types for music the browser can play, keyed by the extension we store it under —
 *  MediaServeController serves `audio.<ext>` with these. */
export const AUDIO_EXT_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  wav: "audio/wav",
  weba: "audio/webm",
};

/** A safe storage extension from a client-supplied filename: 1–8 lowercase alphanumerics, else
 *  `bin`. The name never reaches a path otherwise (stored under `<hash>/file.<ext>`). */
export function safeExtension(name: string | undefined | null): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec((name ?? "").trim());
  return m ? m[1].toLowerCase() : "bin";
}

/** Trims a client-claimed MIME type to a plausible `type/subtype`, or null. */
function cleanMime(mime: string | undefined | null): string | null {
  const v = (mime ?? "").trim().toLowerCase().split(";")[0];
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(
    v,
  )
    ? v
    : null;
}

export type MediaVariant =
  "original" | "web" | "thumb" | "poster" | "packThumb" | "packStill";

@Injectable()
export class MediaService {
  constructor(
    @InjectModel(MediaAsset.name)
    private readonly mediaAssetModel: Model<MediaAsset>,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
  ) {}

  /**
   * Ingests an image buffer: magic-byte sniff → dedupe by SHA-256 → (on a new hash) EXIF-stripped
   * variants + blurhash → `media_assets` row. Never trusts the client's claimed extension/mimetype.
   * See docs/plans/BACKEND_PLAN.md B2 "MediaService".
   */
  async ingestImage(buffer: Buffer, ownerId: string): Promise<MediaAsset> {
    const sniffed = sniffImageType(buffer);
    if (!sniffed) {
      throw new BadRequestException(
        "Unrecognized image format (checked file contents, not the extension)",
      );
    }
    // Read once up front: `pages > 1` is how sharp reports an animated WebP,
    // which needs the same handling as an animated GIF below (and its cap).
    const isAnimatedWebp =
      sniffed.ext === "webp" &&
      (await sharp(buffer, { failOn: "none" })
        .metadata()
        .then(m => m.pages ?? 1)
        .catch(() => 1)) > 1;
    const maxBytes =
      sniffed.ext === "gif" || isAnimatedWebp ? GIF_MAX_BYTES : IMAGE_MAX_BYTES;
    if (buffer.length > maxBytes) {
      throw new BadRequestException(
        `${sniffed.ext.toUpperCase()} must be ${Math.round(maxBytes / (1024 * 1024))}MB or smaller`,
      );
    }

    const hash = createHash("sha256").update(buffer).digest("hex");

    const existing = await this.mediaAssetModel.findOne({ hash }).exec();
    if (existing) {
      await this.mediaAssetModel
        .updateOne({ hash }, { $inc: { refCount: 1 } })
        .exec();
      return existing;
    }

    // `.rotate()` applies the EXIF orientation tag before we drop it — otherwise a phone photo
    // would come out sideways once metadata is gone. We never call `.withMetadata()`, so no EXIF
    // (GPS included) survives into any variant we re-encode through sharp.
    const metadata = await sharp(buffer, { failOn: "none" })
      .rotate()
      .metadata();

    const originalRelPath = `${hash}/original.${sniffed.ext}`;
    let webRelPath = originalRelPath;
    let thumbRelPath = originalRelPath;

    // Animated GIFs are stored byte-for-byte: sharp only reads the first frame unless told
    // otherwise, so reprocessing would silently de-animate the upload. GIF also doesn't carry
    // EXIF/GPS the way JPEG/PNG do, so skipping the strip here isn't a privacy regression.
    // Every other format is re-encoded even for "original" — same pixels, metadata gone.
    let variantSizes: { original: number; web?: number; thumb?: number };

    if (sniffed.ext === "gif") {
      await this.storage.put(originalRelPath, buffer);
      variantSizes = { original: buffer.length };
    } else if (isAnimatedWebp) {
      // Animated WebP (e.g. animated emoji/stickers): re-encoded with every
      // frame kept — the default single-frame read was silently flattening
      // these to a still image.
      // Only re-encode when there's actually EXIF/XMP to drop — a lossy
      // re-encode roughly doubles a typical animated emoji's size.
      const meta = await sharp(buffer, { failOn: "none" }).metadata();
      const stored =
        meta.exif || meta.xmp
          ? await sharp(buffer, { failOn: "none", animated: true })
              .webp({ quality: 90, alphaQuality: 100, effort: 4 })
              .toBuffer()
          : buffer;
      await this.storage.put(originalRelPath, stored);
      variantSizes = { original: stored.length };
    } else {
      // Nothing to strip (no EXIF/XMP/IPTC, upright) — e.g. a photo the web editor already
      // re-encoded at the sender's chosen quality: keep its bytes. Re-encoding would only lose
      // quality and, at sharp's default q80, change the size the sender was shown.
      const rawMeta = await sharp(buffer, { failOn: "none" }).metadata();
      const needsStrip =
        !!rawMeta.exif ||
        !!rawMeta.xmp ||
        !!rawMeta.iptc ||
        (rawMeta.orientation ?? 1) > 1;
      const strippedOriginal = needsStrip
        ? await sharp(buffer, { failOn: "none" }).rotate().toBuffer()
        : buffer;
      await this.storage.put(originalRelPath, strippedOriginal);
      const webBuffer = await sharp(buffer, { failOn: "none" })
        .rotate()
        .resize({
          width: 1600,
          height: 1600,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer();
      // A "compressed" copy that came out bigger than the original (a small, already well
      // compressed photo) is pointless — the web variant is the original then.
      const webIsSmaller =
        webBuffer.length < strippedOriginal.length ||
        (metadata.width ?? 0) > 1600 ||
        (metadata.height ?? 0) > 1600;
      if (webIsSmaller) {
        webRelPath = `${hash}/web.jpg`;
        await this.storage.put(webRelPath, webBuffer);
      }

      const thumbBuffer = await sharp(buffer, { failOn: "none" })
        .rotate()
        .resize({
          width: 320,
          height: 320,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 70 })
        .toBuffer();
      thumbRelPath = `${hash}/thumb.jpg`;
      await this.storage.put(thumbRelPath, thumbBuffer);

      variantSizes = {
        original: strippedOriginal.length,
        web: webIsSmaller ? webBuffer.length : strippedOriginal.length,
        thumb: thumbBuffer.length,
      };
    }

    const blurhash = await this.computeBlurhash(buffer);

    return this.mediaAssetModel.create({
      hash,
      kind: "image",
      mimeType: sniffed.mimeType,
      sizeBytes: buffer.length,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      blurhash,
      variants: {
        original: originalRelPath,
        web: webRelPath,
        thumb: thumbRelPath,
      },
      variantSizes,
      ownerId: new Types.ObjectId(ownerId),
      refCount: 1,
    });
  }

  /**
   * Ingests a video buffer: magic-byte sniff → dedupe by SHA-256 of the *original* upload →
   * (on a new hash) transcode to H.264/AAC mp4 (scaled down to fit 1280 on the long side,
   * never upscaled) + a JPEG poster frame — this is the "videos actually get compressed" gap
   * this method exists to close (previously a chat video attachment went through the generic,
   * uncompressed `POST /upload`). `sizeBytes` on the resulting row is the *compressed* size
   * (what's actually stored/served); the hash still keys on the original bytes so re-uploading
   * the same source file is detected as a duplicate without re-encoding it twice.
   */
  async ingestVideo(
    buffer: Buffer,
    ownerId: string,
    targetMaxDimension?: number,
    edits?: VideoEdits | null,
  ): Promise<MediaAsset> {
    const sniffed = sniffVideoType(buffer);
    if (!sniffed) {
      throw new BadRequestException(
        "Unrecognized video format (checked file contents, not the extension). Supported: mp4, mov, webm, mkv, avi.",
      );
    }
    if (buffer.length > VIDEO_MAX_BYTES) {
      throw new BadRequestException(
        `Video must be ${Math.round(VIDEO_MAX_BYTES / (1024 * 1024))}MB or smaller`,
      );
    }

    const contentHash = createHash("sha256").update(buffer).digest("hex");
    // Dedupe (and the storage path) is keyed on content *and* target resolution — the same
    // source video re-uploaded at a different quality tier is a genuinely different compressed
    // file, not a cache hit; without this, picking 1080p after an earlier 480p upload of the
    // same file would silently hand back the old, lower-res asset.
    // Sender edits (trim/mute/rotate/crop/cover) also produce a different file.
    const editsKey = videoEditsKey(edits);
    const hash =
      (targetMaxDimension != null
        ? `${contentHash}:r${targetMaxDimension}`
        : contentHash) + (editsKey ? `:${editsKey}` : "");

    const existing = await this.mediaAssetModel.findOne({ hash }).exec();
    if (existing) {
      await this.mediaAssetModel
        .updateOne({ hash }, { $inc: { refCount: 1 } })
        .exec();
      return existing;
    }

    const tempDir = mkdtempSync(join(tmpdir(), "video-ingest-"));
    try {
      const inputPath = join(tempDir, `input.${sniffed.ext}`);
      const outputPath = join(tempDir, "output.mp4");
      const posterPath = join(tempDir, "poster.jpg");
      writeFileSync(inputPath, buffer);

      await compressVideo(inputPath, outputPath, targetMaxDimension, edits);
      // The cover frame is picked on the source's timeline; the output starts at trimStart.
      const coverAt =
        edits?.coverSec != null
          ? Math.max(0, edits.coverSec - (edits.trimStartSec ?? 0))
          : 0;
      await extractVideoThumbnail(outputPath, posterPath, coverAt);

      const compressedBuffer = readFileSync(outputPath);
      const posterBuffer = readFileSync(posterPath);

      // Measured on the output: trim, crop and rotation all change them.
      const [durationSec, outRes] = await Promise.all([
        probeVideoDurationSec(outputPath),
        probeVideoResolution(outputPath),
      ]);
      const outWidth = outRes?.width ?? null;
      const outHeight = outRes?.height ?? null;

      // Path-safe: `hash` may carry edit parameters (commas, dots).
      const dir = editsKey ? hash.replace(/[^a-zA-Z0-9]/g, "_") : hash;
      const originalRelPath = `${dir}/original.mp4`;
      const posterRelPath = `${dir}/poster.jpg`;
      await this.storage.put(originalRelPath, compressedBuffer);
      await this.storage.put(posterRelPath, posterBuffer);

      return this.mediaAssetModel.create({
        hash,
        kind: "video",
        mimeType: "video/mp4",
        sizeBytes: compressedBuffer.length,
        width: outWidth,
        height: outHeight,
        durationSec,
        variants: {
          original: originalRelPath,
          web: originalRelPath,
          thumb: posterRelPath,
          poster: posterRelPath,
        },
        variantSizes: {
          original: compressedBuffer.length,
          web: compressedBuffer.length,
          poster: posterBuffer.length,
        },
        ownerId: new Types.ObjectId(ownerId),
        refCount: 1,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * A round video message recorded in the browser — see `compressVideoNote` (square, 30 fps
   * CFR, audio resynced, full length kept). Duration is probed from the *output*: MediaRecorder
   * WebM usually has no duration in its header, so probing the upload gave null.
   */
  async ingestVideoNote(buffer: Buffer, ownerId: string): Promise<MediaAsset> {
    const sniffed = sniffVideoType(buffer);
    if (!sniffed) {
      throw new BadRequestException(
        "Unrecognized video format (checked file contents, not the extension). Supported: mp4, mov, webm, mkv, avi.",
      );
    }
    if (buffer.length > VIDEO_MAX_BYTES) {
      throw new BadRequestException(
        `Video must be ${Math.round(VIDEO_MAX_BYTES / (1024 * 1024))}MB or smaller`,
      );
    }
    const hash = `note${VIDEO_NOTE_PX}-${createHash("sha256").update(buffer).digest("hex")}`;
    const existing = await this.findAndRetain(hash);
    if (existing) return existing;

    const tempDir = mkdtempSync(join(tmpdir(), "video-note-"));
    try {
      const inputPath = join(tempDir, `input.${sniffed.ext}`);
      const outputPath = join(tempDir, "output.mp4");
      const posterPath = join(tempDir, "poster.jpg");
      writeFileSync(inputPath, buffer);
      await compressVideoNote(inputPath, outputPath);
      await extractVideoThumbnail(outputPath, posterPath);
      const durationSec = await probeVideoDurationSec(outputPath);
      const compressed = readFileSync(outputPath);
      const poster = readFileSync(posterPath);
      const videoRel = `${hash}/original.mp4`;
      const posterRel = `${hash}/poster.jpg`;
      await this.storage.put(videoRel, compressed);
      await this.storage.put(posterRel, poster);
      return this.mediaAssetModel.create({
        hash,
        kind: "video",
        mimeType: "video/mp4",
        sizeBytes: compressed.length,
        width: VIDEO_NOTE_PX,
        height: VIDEO_NOTE_PX,
        blurhash: await this.computeBlurhash(poster),
        durationSec,
        variants: {
          original: videoRel,
          web: videoRel,
          thumb: posterRel,
          poster: posterRel,
        },
        variantSizes: {
          original: compressed.length,
          web: compressed.length,
          poster: poster.length,
        },
        ownerId: new Types.ObjectId(ownerId),
        refCount: 1,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * A silent looping clip (profile video, video wallpaper) — see `compressLoopVideo`. Deduped
   * on content + options, stored as `<hash>/original.mp4` + `poster.jpg` like `ingestVideo`.
   */
  async ingestLoopVideo(
    buffer: Buffer,
    ownerId: string,
    opts: LoopVideoOptions,
    edits?: VideoEdits | null,
  ): Promise<MediaAsset> {
    const sniffed = sniffVideoType(buffer);
    if (!sniffed) {
      throw new BadRequestException(
        "Unrecognized video format (checked file contents, not the extension). Supported: mp4, mov, webm, mkv, avi.",
      );
    }
    if (buffer.length > VIDEO_MAX_BYTES) {
      throw new BadRequestException(
        `Video must be ${Math.round(VIDEO_MAX_BYTES / (1024 * 1024))}MB or smaller`,
      );
    }
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const editsKey = videoEditsKey(edits);
    const hash =
      `${contentHash}:loop${opts.square ? "sq" : ""}${opts.maxDimension}x${opts.maxSec}@${opts.fps}` +
      (editsKey ? `:${editsKey}` : "");
    const existing = await this.mediaAssetModel.findOne({ hash }).exec();
    if (existing) {
      await this.mediaAssetModel
        .updateOne({ hash }, { $inc: { refCount: 1 } })
        .exec();
      return existing;
    }
    const tempDir = mkdtempSync(join(tmpdir(), "loop-video-"));
    try {
      const inputPath = join(tempDir, `input.${sniffed.ext}`);
      const outputPath = join(tempDir, "output.mp4");
      const posterPath = join(tempDir, "poster.jpg");
      writeFileSync(inputPath, buffer);
      await compressLoopVideo(inputPath, outputPath, opts, edits);
      await extractVideoThumbnail(
        outputPath,
        posterPath,
        edits?.coverSec != null
          ? Math.max(0, edits.coverSec - (edits.trimStartSec ?? 0))
          : 0,
      );
      const [durationSec, resolution] = await Promise.all([
        probeVideoDurationSec(outputPath),
        probeVideoResolution(outputPath),
      ]);
      const compressed = readFileSync(outputPath);
      const poster = readFileSync(posterPath);
      const safe = hash.replace(/[^a-zA-Z0-9]/g, "_");
      const videoRel = `${safe}/original.mp4`;
      const posterRel = `${safe}/poster.jpg`;
      await this.storage.put(videoRel, compressed);
      await this.storage.put(posterRel, poster);
      return this.mediaAssetModel.create({
        hash,
        kind: "video",
        mimeType: "video/mp4",
        sizeBytes: compressed.length,
        width: resolution?.width ?? null,
        height: resolution?.height ?? null,
        durationSec,
        variants: {
          original: videoRel,
          web: videoRel,
          thumb: posterRel,
          poster: posterRel,
        },
        variantSizes: {
          original: compressed.length,
          web: compressed.length,
          poster: poster.length,
        },
        ownerId: new Types.ObjectId(ownerId),
        refCount: 1,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * A document or music track sent as a file (the attach menu's "File"/"Music"). Stored
   * byte-for-byte (`<hash>/file.<ext>` or `<hash>/audio.<ext>`) — no re-encode, like Telegram.
   * With `preferAudio`, a file ffmpeg can decode as audio becomes an `audio` asset: duration and
   * title/artist read from its own tags, embedded cover art stored as the `thumb` variant
   * (320px JPEG). Anything else is a `file` asset; images sent as files also get a small
   * `thumb` (+ width/height/blurhash) so the bubble can show a preview. Deduped by content,
   * separately per kind (`file-<sha>` / `audio-<sha>`), so the same bytes sent once as a photo
   * and once as a file never share a row.
   */
  async ingestFile(
    buffer: Buffer,
    ownerId: string,
    opts: {
      originalName?: string | null;
      mimeType?: string | null;
      preferAudio?: boolean;
    },
  ): Promise<MediaAsset> {
    if (!buffer.length) throw new BadRequestException("The file is empty");
    if (buffer.length > FILE_MAX_BYTES) {
      throw new BadRequestException(
        `Files must be ${Math.round(FILE_MAX_BYTES / (1024 * 1024))}MB or smaller`,
      );
    }
    const sha = createHash("sha256").update(buffer).digest("hex");
    const ext = safeExtension(opts.originalName);

    if (opts.preferAudio) {
      const audioHash = `audio-${sha}`;
      const existingAudio = await this.findAndRetain(audioHash);
      if (existingAudio) return existingAudio;
      const audio = await this.tryIngestAudio(buffer, ownerId, audioHash, ext);
      if (audio) return audio;
    }

    const hash = `file-${sha}`;
    const existing = await this.findAndRetain(hash);
    if (existing) return existing;

    const sniffedImage = sniffImageType(buffer);
    const mimeType =
      sniffedImage?.mimeType ??
      (AUDIO_EXT_MIME[ext] && opts.mimeType?.startsWith("audio/")
        ? AUDIO_EXT_MIME[ext]
        : null) ??
      cleanMime(opts.mimeType) ??
      "application/octet-stream";
    const originalRelPath = `${hash}/file.${ext}`;
    await this.storage.put(originalRelPath, buffer);

    let thumbRelPath: string | undefined;
    let thumbSize: number | undefined;
    let width: number | null = null;
    let height: number | null = null;
    let blurhash: string | null = null;
    if (sniffedImage && buffer.length <= IMAGE_MAX_BYTES) {
      try {
        const meta = await sharp(buffer, { failOn: "none" })
          .rotate()
          .metadata();
        const rotated = (meta.orientation ?? 1) >= 5;
        width = (rotated ? meta.height : meta.width) ?? null;
        height = (rotated ? meta.width : meta.height) ?? null;
        const thumb = await sharp(buffer, { failOn: "none" })
          .rotate()
          .resize({
            width: 320,
            height: 320,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: 70 })
          .toBuffer();
        thumbRelPath = `${hash}/thumb.jpg`;
        thumbSize = thumb.length;
        await this.storage.put(thumbRelPath, thumb);
        blurhash = await this.computeBlurhash(buffer);
      } catch {
        thumbRelPath = undefined;
      }
    }

    return this.mediaAssetModel.create({
      hash,
      kind: "file",
      mimeType,
      sizeBytes: buffer.length,
      width,
      height,
      blurhash,
      variants: {
        original: originalRelPath,
        ...(thumbRelPath ? { thumb: thumbRelPath } : {}),
      },
      variantSizes: {
        original: buffer.length,
        ...(thumbSize ? { thumb: thumbSize } : {}),
      },
      ownerId: new Types.ObjectId(ownerId),
      refCount: 1,
    });
  }

  private async findAndRetain(hash: string): Promise<MediaAsset | null> {
    const existing = await this.mediaAssetModel.findOne({ hash }).exec();
    if (!existing) return null;
    await this.mediaAssetModel
      .updateOne({ hash }, { $inc: { refCount: 1 } })
      .exec();
    return existing;
  }

  /** The `audio` half of `ingestFile` — null when ffmpeg finds no audio stream. */
  private async tryIngestAudio(
    buffer: Buffer,
    ownerId: string,
    hash: string,
    ext: string,
  ): Promise<MediaAsset | null> {
    const tempDir = mkdtempSync(join(tmpdir(), "audio-ingest-"));
    try {
      const inputPath = join(tempDir, `input.${ext}`);
      writeFileSync(inputPath, buffer);
      const probe = await probeAudio(inputPath);
      if (!probe.hasAudio || !probe.durationSec) return null;

      const storeExt = AUDIO_EXT_MIME[ext] ? ext : "bin";
      const originalRelPath = `${hash}/audio.${storeExt}`;
      await this.storage.put(originalRelPath, buffer);

      let thumbRelPath: string | undefined;
      let thumbSize: number | undefined;
      let width: number | null = null;
      let height: number | null = null;
      let blurhash: string | null = null;
      const cover = probe.hasCover
        ? await extractAudioCover(inputPath, join(tempDir, "cover.jpg"))
        : null;
      if (cover) {
        try {
          const thumb = await sharp(cover, { failOn: "none" })
            // Square, like the round cover in the music bubble (a non-square cover is
            // centre-cropped).
            .resize({ width: 320, height: 320, fit: "cover" })
            .jpeg({ quality: 78 })
            .toBuffer({ resolveWithObject: true });
          thumbRelPath = `${hash}/cover.jpg`;
          thumbSize = thumb.data.length;
          width = thumb.info.width;
          height = thumb.info.height;
          await this.storage.put(thumbRelPath, thumb.data);
          blurhash = await this.computeBlurhash(thumb.data);
        } catch {
          thumbRelPath = undefined;
        }
      }

      return this.mediaAssetModel.create({
        hash,
        kind: "audio",
        mimeType: AUDIO_EXT_MIME[ext] ?? "application/octet-stream",
        sizeBytes: buffer.length,
        width,
        height,
        blurhash,
        durationSec: probe.durationSec,
        title: probe.title,
        artist: probe.artist,
        variants: {
          original: originalRelPath,
          ...(thumbRelPath ? { thumb: thumbRelPath } : {}),
        },
        variantSizes: {
          original: buffer.length,
          ...(thumbSize ? { thumb: thumbSize } : {}),
        },
        ownerId: new Types.ObjectId(ownerId),
        refCount: 1,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Drops one reference to a `MediaAsset` (a clip/wallpaper/etc. that pointed at it was
   * deleted or replaced). Never deletes the asset row or its stored files — an actual orphan
   * sweep (deleting rows that reach `refCount: 0`) is explicitly B11 work; this only keeps the
   * count accurate so that future sweep knows what's safe to archive.
   */
  /**
   * Small display variants for a sticker/animated-emoji pack item, made once
   * and reused (idempotent — returns the asset untouched when it already has
   * them, so it also lazily backfills items uploaded before this existed).
   * Pickers show dozens of items at ~40px; loading each 512px original
   * (often 300–800 KB of animated WebP) was the bottleneck.
   *  - `packThumb`: 160px WebP, every frame kept for animated sources.
   *  - `packStill`: 160px WebP of the first frame only.
   * Both keep transparency. Failures leave the asset as-is (callers fall
   * back to the original), never fail the request.
   */
  async ensurePackVariants(
    asset: MediaAsset & { _id: Types.ObjectId },
  ): Promise<MediaAsset & { _id: Types.ObjectId }> {
    if (asset.kind !== "image" || MediaService.hasCurrentPackVariants(asset))
      return asset;
    try {
      const { stream } = await this.storage.getStream(asset.variants.original);
      const chunks: Buffer[] = [];
      for await (const chunk of stream)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const source = Buffer.concat(chunks);

      const meta = await sharp(source, { failOn: "none" }).metadata();
      const animated = (meta.pages ?? 1) > 1;
      const resize = {
        width: PACK_VARIANT_PX,
        height: PACK_VARIANT_PX,
        fit: "inside" as const,
        withoutEnlargement: true,
      };
      const still = await sharp(source, { failOn: "none" })
        .resize(resize)
        .webp({ quality: 82, alphaQuality: 100 })
        .toBuffer();
      const thumb = animated
        ? await this.decimatedAnimatedWebp(
            source,
            meta.pages ?? 1,
            meta.delay,
            meta.loop,
          )
        : still;

      const thumbPath = `${asset.hash}/pack-${PACK_VARIANT_PX}.webp`;
      const stillPath = animated
        ? `${asset.hash}/pack-still-${PACK_VARIANT_PX}.webp`
        : thumbPath;
      await this.storage.put(thumbPath, thumb);
      if (animated) await this.storage.put(stillPath, still);

      const updated = await this.mediaAssetModel
        .findByIdAndUpdate(
          asset._id,
          {
            $set: {
              "variants.packThumb": thumbPath,
              "variants.packStill": stillPath,
              // Whole object, not dotted paths: older rows have
              // `variantSizes: null`, which a dotted $set can't write into.
              variantSizes: {
                original: asset.variantSizes?.original,
                web: asset.variantSizes?.web,
                thumb: asset.variantSizes?.thumb,
                poster: asset.variantSizes?.poster,
                packThumb: thumb.length,
                packStill: still.length,
              },
            },
          },
          { new: true },
        )
        .lean()
        .exec();
      return (
        (updated as (MediaAsset & { _id: Types.ObjectId }) | null) ?? asset
      );
    } catch {
      return asset;
    }
  }

  /** True when the asset's pack variants were made with the current settings
   *  (the size is part of the file name), so changing PACK_VARIANT_PX later
   *  regenerates old ones instead of serving stale variants forever. */
  static hasCurrentPackVariants(asset: Pick<MediaAsset, "variants">): boolean {
    return (
      !!asset.variants.packStill &&
      !!asset.variants.packThumb?.endsWith(`/pack-${PACK_VARIANT_PX}.webp`)
    );
  }

  /** Small animated WebP: every frame decoded and resized once (one raw
   *  strip), every Nth frame kept, delays summed so playback speed is
   *  unchanged. */
  private async decimatedAnimatedWebp(
    source: Buffer,
    pages: number,
    delays: number[] | undefined,
    loop: number | undefined,
  ): Promise<Buffer> {
    const { data, info } = await sharp(source, {
      failOn: "none",
      animated: true,
    })
      .resize({
        width: PACK_VARIANT_PX,
        height: PACK_VARIANT_PX * pages,
        fit: "inside",
        withoutEnlargement: true,
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pageHeight = info.pageHeight ?? Math.round(info.height / pages);
    const frameBytes = info.width * pageHeight * 4;
    const frameDelays =
      delays?.length === pages ? delays : Array<number>(pages).fill(40);
    const step = Math.max(
      1,
      Math.round(PACK_MIN_FRAME_MS / Math.max(10, Math.min(...frameDelays))),
    );
    const frames: Buffer[] = [];
    const outDelays: number[] = [];
    for (let i = 0; i < pages; i += step) {
      const raw = data.subarray(i * frameBytes, (i + 1) * frameBytes);
      frames.push(
        await sharp(raw, {
          raw: { width: info.width, height: pageHeight, channels: 4 },
        })
          .png()
          .toBuffer(),
      );
      outDelays.push(frameDelays.slice(i, i + step).reduce((a, b) => a + b, 0));
    }
    return (sharp as unknown as (input: Buffer[], options: object) => Sharp)(
      frames,
      { join: { animated: true } },
    )
      .webp({
        quality: 62,
        alphaQuality: 85,
        effort: 5,
        loop: loop ?? 0,
        delay: outDelays,
      })
      .toBuffer();
  }

  findById(mediaId: string) {
    if (!Types.ObjectId.isValid(mediaId)) return Promise.resolve(null);
    return this.mediaAssetModel
      .findById(mediaId)
      .select("refCount")
      .lean()
      .exec();
  }

  async retain(mediaId: string): Promise<void> {
    await this.mediaAssetModel
      .updateOne(
        { _id: new Types.ObjectId(mediaId) },
        { $inc: { refCount: 1 } },
      )
      .exec();
  }

  async release(mediaId: string): Promise<void> {
    await this.mediaAssetModel
      .updateOne(
        { _id: new Types.ObjectId(mediaId), refCount: { $gt: 0 } },
        { $inc: { refCount: -1 } },
      )
      .exec();
  }

  /** Relative path only — resolving it to a servable URL is the caller's job (see buildMediaUrl). */
  variantPath(
    asset: Pick<MediaAsset, "variants">,
    variant: MediaVariant = "web",
  ): string {
    return asset.variants[variant] ?? asset.variants.original;
  }

  private async computeBlurhash(buffer: Buffer): Promise<string | null> {
    try {
      const { data, info } = await sharp(buffer, { failOn: "none" })
        .rotate()
        .raw()
        .ensureAlpha()
        .resize(32, 32, { fit: "inside" })
        .toBuffer({ resolveWithObject: true });
      return encodeBlurhash(
        new Uint8ClampedArray(data),
        info.width,
        info.height,
        4,
        4,
      );
    } catch {
      // Best-effort only — a missing blurhash never blocks the upload.
      return null;
    }
  }
}
