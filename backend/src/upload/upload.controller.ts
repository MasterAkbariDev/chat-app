import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
  Req,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Throttle } from "@nestjs/throttler";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { diskStorage, memoryStorage } from "multer";
import { extname, join } from "path";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "fs";
import { createHash } from "crypto";
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { Request } from "express";
import { JWTPayload } from "src/interface/base.interface";
import { UploadRecord } from "./schema/upload-record.schema";
import { FILE_MAX_BYTES, MediaService } from "src/media/media.service";
import { buildMediaUrl } from "src/media/media-url.util";
import { parseVideoEdits } from "src/media/video-processing.util";

const uploadsDir = join(process.cwd(), "uploads");
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

const buildStorage = (destination: string = uploadsDir) =>
  diskStorage({
    destination,
    filename: (_req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const ext = extname(file.originalname) || "";
      const mime = file.mimetype || "";
      if (mime.startsWith("image/") || mime.startsWith("video/")) {
        cb(null, `${unique}${ext}`);
      } else {
        cb(null, `${unique}${ext}`);
      }
    },
  });

@ApiTags("Upload")
@Controller("upload")
export class UploadController {
  constructor(
    @InjectModel(UploadRecord.name)
    private uploadRecordModel: Model<UploadRecord>,
    private readonly mediaService: MediaService,
  ) {}

  /** Generic upload — images, videos, audio (up to 250 MB). Deduplicated by content hash (SHA-256). */
  @Post()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 600_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: "Upload a file (image, video, audio)" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: buildStorage(),
      limits: { fileSize: 250 * 1024 * 1024 },
      fileFilter: (_req, _file, cb) => {
        // Accept all file types for the generic upload endpoint
        cb(null, true);
      },
    }),
  )
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
    @Body("originalFilename") originalFilename?: string,
  ): Promise<{ url: string; originalFilename?: string }> {
    if (!file) throw new BadRequestException("No file provided");
    const filename = await this.dedupeOrStore(file);
    const url = buildMediaUrl(req, `/uploads/${filename}`);
    const displayName =
      typeof originalFilename === "string" && originalFilename.trim()
        ? originalFilename.trim()
        : file.originalname;
    return { url, originalFilename: displayName };
  }

  /**
   * Image-only upload — for avatars and chat photos. Routed through `MediaService`: content is
   * verified by magic bytes (not the filename/mimetype the client claims), deduplicated by
   * SHA-256, and re-encoded (EXIF/GPS stripped) into web/thumb variants — this endpoint's
   * response still just returns the one URL to use, now pointing at the "web" variant.
   */
  @Post("image")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 600_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: "Upload an image file (avatar / chat photo)" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      // 20 MB ceiling for images; MediaService additionally caps animated GIFs at 8 MB (they're
      // stored un-re-encoded, so a large one stays large — see media.service.ts).
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: JWTPayload },
  ): Promise<{
    url: string;
    mediaId: string;
    width: number | null;
    height: number | null;
    blurhash: string | null;
    variants: {
      original: { url: string; sizeBytes: number | null };
      web: { url: string; sizeBytes: number | null };
    };
  }> {
    if (!file) throw new BadRequestException("No image file provided");
    const asset = await this.mediaService.ingestImage(
      file.buffer,
      req.user.userId,
    );
    const relPath = `/uploads/media/${this.mediaService.variantPath(asset, "web")}`;
    const originalRelPath = `/uploads/media/${this.mediaService.variantPath(asset, "original")}`;
    // width/height/blurhash were already computed by ingestImage — previously
    // discarded here, so a message attachment had no way to show a blurred
    // placeholder or reserve its real aspect ratio before it loaded. mediaId
    // lets the sender's own `POST /messages`/`send_message` call reference
    // this exact MediaAsset row (see CreateMessageDto.attachmentMediaIds).
    // `variants` exposes both the original (HD) and web (compressed) copies the
    // backend already produces for every image, with their real stored sizes, so
    // the frontend's HD/Compressed toggle can show a real before/after without a
    // second upload — the client only ever picks which already-stored URL to send.
    return {
      url: buildMediaUrl(req, relPath),
      mediaId: String(asset._id),
      width: asset.width,
      height: asset.height,
      blurhash: asset.blurhash,
      variants: {
        original: {
          url: buildMediaUrl(req, originalRelPath),
          sizeBytes: asset.variantSizes?.original ?? null,
        },
        web: {
          url: buildMediaUrl(req, relPath),
          sizeBytes:
            asset.variantSizes?.web ?? asset.variantSizes?.original ?? null,
        },
      },
    };
  }

  /**
   * Video-only upload — for chat video messages. Routed through `MediaService`: content is
   * verified by magic bytes, deduplicated by SHA-256 of the original upload (plus the chosen
   * quality tier — see `ingestVideo`), and transcoded (H.264/AAC) — the previous path for a
   * chat video attachment was the generic `POST /upload` above, which never compressed anything.
   * `targetResolution` (optional form field, "480"/"720"/"1080") picks the long-edge cap the
   * frontend's quality picker offers; omitted defaults to the pipeline's own 1280px/~720p cap.
   */
  @Post("video")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: "Upload a video file (chat video message)" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: { type: "string", format: "binary" },
        targetResolution: { type: "string", enum: ["480", "720", "1080"] },
        kind: { type: "string", enum: ["video", "video_note"] },
        edits: {
          type: "string",
          description:
            'JSON: {"trimStartSec","trimEndSec","muted","rotate":0|90|180|270,"flipH","crop":{x,y,w,h} (0–1, after rotation),"coverSec"} — applied server-side with ffmpeg.',
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
    }),
  )
  async uploadVideo(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: JWTPayload },
    @Body("targetResolution") targetResolution?: string,
    @Body("edits") editsRaw?: string,
    @Body("kind") kind?: string,
  ): Promise<{
    url: string;
    posterUrl: string;
    durationSec: number | null;
    mediaId: string;
    sizeBytes: number | null;
    width: number | null;
    height: number | null;
  }> {
    if (!file) throw new BadRequestException("No video file provided");
    // Long-edge pixel cap per quality label — matches the pipeline's own convention (the
    // existing 1280 default is exactly the "720p" row here) rather than the "height" a resolution
    // label usually names, since `compressVideo`'s scale filter always caps the longer side.
    const RESOLUTION_CAPS: Record<string, number> = {
      "480": 854,
      "720": 1280,
      "1080": 1920,
    };
    let targetMaxDimension: number | undefined;
    if (targetResolution !== undefined) {
      targetMaxDimension = RESOLUTION_CAPS[targetResolution];
      if (!targetMaxDimension) {
        throw new BadRequestException(
          `targetResolution must be one of: ${Object.keys(RESOLUTION_CAPS).join(", ")}`,
        );
      }
    }
    // A round video message gets its own pipeline (square, steady 30 fps, audio resynced) —
    // see MediaService.ingestVideoNote; quality tiers and edits don't apply to it.
    const asset =
      kind === "video_note"
        ? await this.mediaService.ingestVideoNote(file.buffer, req.user.userId)
        : await this.mediaService.ingestVideo(
            file.buffer,
            req.user.userId,
            targetMaxDimension,
            parseVideoEdits(editsRaw),
          );
    const relPath = `/uploads/media/${this.mediaService.variantPath(asset, "original")}`;
    const posterRelPath = `/uploads/media/${this.mediaService.variantPath(asset, "poster")}`;
    return {
      url: buildMediaUrl(req, relPath),
      posterUrl: buildMediaUrl(req, posterRelPath),
      durationSec: asset.durationSec,
      mediaId: String(asset._id),
      sizeBytes: asset.variantSizes?.original ?? asset.sizeBytes ?? null,
      width: asset.width,
      height: asset.height,
    };
  }

  /**
   * A document or music track for a file message (the attach menu's "File" / "Music"), kept
   * byte-for-byte through MediaService (content-hashed, deduped, served from
   * `/uploads/media/...`). `mode: "music"` asks for an audio track: if ffmpeg can decode it the
   * response is `kind: "audio"` with its duration, tags and cover art (send it as an `audio`
   * message); otherwise — or in the default `mode: "file"` — it's `kind: "file"`.
   * The client's filename is only used for the stored extension and echoed back as
   * `fileName` for the message's `originalFilename`.
   */
  @Post("file")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 60, ttl: 600_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Upload a document or music file (file / audio message)",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: { type: "string", format: "binary" },
        originalFilename: { type: "string" },
        mode: { type: "string", enum: ["file", "music"] },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: FILE_MAX_BYTES },
    }),
  )
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: JWTPayload },
    @Body("originalFilename") originalFilename?: string,
    @Body("mode") mode?: string,
  ): Promise<{
    url: string;
    mediaId: string;
    kind: "file" | "audio";
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    durationSec: number | null;
    title: string | null;
    artist: string | null;
    thumbUrl: string | null;
    width: number | null;
    height: number | null;
  }> {
    if (!file) throw new BadRequestException("No file provided");
    // Multer decodes the multipart filename as latin1; the explicit field is the reliable one
    // (Persian names especially).
    const fileName = (
      typeof originalFilename === "string" && originalFilename.trim()
        ? originalFilename
        : Buffer.from(file.originalname ?? "file", "latin1").toString("utf8")
    )
      .trim()
      .slice(0, 255);
    const asset = await this.mediaService.ingestFile(
      file.buffer,
      req.user.userId,
      {
        originalName: fileName,
        mimeType: file.mimetype,
        preferAudio: mode === "music",
      },
    );
    const thumb = asset.variants.thumb;
    return {
      url: buildMediaUrl(
        req,
        `/uploads/media/${this.mediaService.variantPath(asset, "original")}`,
      ),
      mediaId: String(asset._id),
      kind: asset.kind === "audio" ? "audio" : "file",
      fileName,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      durationSec: asset.durationSec ?? null,
      title: asset.title ?? null,
      artist: asset.artist ?? null,
      thumbUrl: thumb ? buildMediaUrl(req, `/uploads/media/${thumb}`) : null,
      width: asset.width ?? null,
      height: asset.height ?? null,
    };
  }

  /**
   * A profile video: centre-cropped square, 640px, ≤10 s, ≤30 fps, no sound — loops on the
   * profile (Telegram-style). Lists show `posterUrl` instead, so it costs nothing there.
   */
  @Post("avatar-video")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: "Upload a profile video (square, ≤10 s, silent)" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: { type: "string", format: "binary" },
        edits: { type: "string", description: "Same as POST /upload/video" },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async uploadAvatarVideo(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: JWTPayload },
    @Body("edits") editsRaw?: string,
  ): Promise<{
    url: string;
    posterUrl: string;
    durationSec: number | null;
    mediaId: string;
    sizeBytes: number | null;
  }> {
    if (!file) throw new BadRequestException("No video file provided");
    const asset = await this.mediaService.ingestLoopVideo(
      file.buffer,
      req.user.userId,
      {
        maxDimension: 640,
        square: true,
        maxSec: 10,
        fps: 30,
      },
      parseVideoEdits(editsRaw),
    );
    return {
      url: buildMediaUrl(
        req,
        `/uploads/media/${this.mediaService.variantPath(asset, "original")}`,
      ),
      posterUrl: buildMediaUrl(
        req,
        `/uploads/media/${this.mediaService.variantPath(asset, "poster")}`,
      ),
      durationSec: asset.durationSec,
      mediaId: String(asset._id),
      sizeBytes: asset.sizeBytes ?? null,
    };
  }

  /**
   * Computes SHA-256 hash of file contents (streaming, so safe for large files).
   * Used for content-based deduplication — same bytes => same hash.
   */
  private async hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk: Buffer) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });
  }

  /**
   * Deduplicate by content: if this file's SHA-256 was seen before, delete the
   * new copy and return the existing filename. Otherwise rename to hash+ext and store.
   */
  private async dedupeOrStore(
    file: Express.Multer.File,
    targetDir: string = uploadsDir,
  ): Promise<string> {
    const currentPath = join(targetDir, file.filename);
    const hash = await this.hashFile(currentPath);
    const ext = extname(file.filename);

    const existing = await this.uploadRecordModel
      .findOne({ hash })
      .lean()
      .exec();
    if (existing) {
      try {
        unlinkSync(currentPath);
      } catch {
        /* best-effort */
      }
      return existing.filename;
    }

    const stableFilename = `${hash}${ext}`;
    const stablePath = join(targetDir, stableFilename);

    try {
      if (currentPath !== stablePath) {
        renameSync(currentPath, stablePath);
      }
      await this.uploadRecordModel.create({ hash, filename: stableFilename });
      return stableFilename;
    } catch (err: unknown) {
      const isDup =
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: number }).code === 11000;
      if (isDup) {
        const record = await this.uploadRecordModel
          .findOne({ hash })
          .lean()
          .exec();
        if (record) return record.filename;
      }
      throw err;
    }
  }
}
