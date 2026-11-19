import { SkipThrottle } from "@nestjs/throttler";
import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Req,
  Res,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Request, Response } from "express";
import { Public } from "src/common/decorators/public.decorator";
import { parseCorsAllowlist, isOriginAllowed } from "src/common/cors-allowlist";
import { MEDIA_STORAGE, MediaStorage } from "./storage/media-storage.interface";
import { MediaAsset } from "./schema/media-asset.schema";

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  // Music (`<hash>/audio.<ext>`) and file messages. Anything not listed here — html, svg, js,
  // archives, office documents — is served as an opaque download (octet-stream + nosniff +
  // attachment), so a "file" can never run as a page on this origin.
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  wav: "audio/wav",
  weba: "audio/webm",
  pdf: "application/pdf",
};

export function contentTypeFor(relativePath: string): string {
  const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Parses a single-range `Range: bytes=start-end` header (the only form browsers send for
 *  media playback/seeking) — a list of ranges or a malformed header is treated as "no range". */
export function parseRange(
  header: string | undefined,
  sizeBytes: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return null;

  let start: number;
  let end: number;
  if (startRaw === "") {
    // Suffix range: "bytes=-500" means the last 500 bytes.
    const suffixLength = Number(endRaw);
    start = Math.max(0, sizeBytes - suffixLength);
    end = sizeBytes - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? sizeBytes - 1 : Number(endRaw);
  }
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    start > end ||
    start >= sizeBytes
  ) {
    return null;
  }
  return { start, end: Math.min(end, sizeBytes - 1) };
}

/**
 * Serves everything `MediaService` ever stored (images, videos, clips, stickers, wallpaper) by
 * reading through the `MediaStorage` interface instead of Express's static file middleware
 * (excluded for this one subpath in app.module.ts) — the only way to serve this content once
 * `MEDIA_STORAGE_DRIVER=s3` (B11) points it at a MinIO bucket, which static-file serving can't
 * reach into. URLs are unchanged for clients (`/uploads/media/<hash>/<variant>`) regardless of
 * which backend is actually configured. Content is addressed by its own hash, so it can never
 * change once written — `immutable` is a correct cache directive here, not just an optimistic one.
 */
@ApiExcludeController()
// Not rate-limited like the API: one picker open or chat scroll legitimately
// loads dozens of images, and the global 100/min limit was breaking them
// (429s showed up as broken stickers and emoji). These responses are
// immutable and year-cached, so repeat views don't hit the server at all.
@SkipThrottle()
@Controller("uploads/media")
@Public()
export class MediaServeController {
  constructor(
    @Inject(MEDIA_STORAGE) private storage: MediaStorage,
    @InjectModel(MediaAsset.name) private mediaAssetModel: Model<MediaAsset>,
  ) {}

  /** Best-effort, fire-and-forget — a lost access-time update should never fail or delay the
   *  actual response. Also flips a `cold`-tiered asset back to `hot` immediately on read,
   *  rather than waiting for the next nightly tiering sweep (B11). */
  private touchAccessTime(relativePath: string): void {
    const hash = relativePath.split("/")[0];
    if (!hash) return;
    this.mediaAssetModel
      .updateOne(
        { hash },
        { $set: { lastAccessedAt: new Date(), tier: "hot" } },
      )
      .exec()
      .catch(() => {
        /* best-effort */
      });
  }

  @Get("*path")
  @Header("Accept-Ranges", "bytes")
  async serve(
    @Param("path") pathParam: string | string[],
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const relativePath = Array.isArray(pathParam)
      ? pathParam.join("/")
      : pathParam;

    const allowlist = parseCorsAllowlist(process.env.CORS_ORIGIN);
    const origin = req.headers.origin;
    if (isOriginAllowed(origin, allowlist)) {
      res.setHeader("Access-Control-Allow-Origin", origin!);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    const contentType = contentTypeFor(relativePath);
    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (contentType === "application/octet-stream") {
      res.setHeader("Content-Disposition", "attachment");
    }
    this.touchAccessTime(relativePath);

    // Ask the storage backend for the total size first (an unranged getStream call) so an
    // invalid/out-of-bounds Range header can be resolved against the real size before deciding
    // whether to actually re-request a byte range.
    const probe = await this.storage.getStream(relativePath);
    // Set only once the file is known to exist — a decorator-level header would also
    // year-cache a 404 (e.g. a pack variant that's about to be generated).
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    const range = parseRange(req.headers.range, probe.sizeBytes);

    if (!range) {
      res.status(200);
      res.setHeader("Content-Length", String(probe.sizeBytes));
      probe.stream.pipe(res);
      return;
    }

    // Destroy the unranged probe stream — its bytes are never sent, this call only needed the
    // size. Backends where a second request is genuinely wasteful (S3) still only pay for one
    // extra HEAD-equivalent, not a full duplicate transfer, since nothing has been read from it.
    probe.stream.destroy();
    const ranged = await this.storage.getStream(relativePath, range);
    res.status(206);
    res.setHeader(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${probe.sizeBytes}`,
    );
    res.setHeader("Content-Length", String(range.end - range.start + 1));
    ranged.stream.pipe(res);
  }
}
