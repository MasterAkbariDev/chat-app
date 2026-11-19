import { BadRequestException, Injectable } from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, renameSync, unlinkSync } from "fs";
import { basename, dirname, extname, join } from "path";
import { resolveFfmpegPath } from "src/media/ffmpeg-path.util";
import { probeVideoDurationSec } from "src/media/video-processing.util";

const execFileAsync = promisify(execFile);

export const WALLPAPER_MAX_VIDEO_SEC = 10;
// Longer clips are simply cut to the first WALLPAPER_MAX_VIDEO_SEC seconds; only absurdly long
// uploads are refused.
const WALLPAPER_DURATION_HARD_MAX_SEC = 180;
export const WALLPAPER_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const WALLPAPER_MAX_VIDEO_BYTES = 60 * 1024 * 1024;

/**
 * Wallpaper-specific video handling that sits in front of the real `MediaService.ingestVideo`
 * (B9, docs/plans/BACKEND_PLAN.md — "media via MediaService"): a wallpaper clip must be short
 * (≤5s, browser-trim overshoot allowed up to +1.25s and then hard-clipped), which
 * `MediaService` has no reason to know about generically. Duration probing and dedupe/
 * compression/poster-frame extraction now come from the one real media pipeline instead of a
 * second copy of it — this class keeps only what's actually wallpaper-specific.
 */
@Injectable()
export class WallpaperMediaService {
  /** Probes duration and, if over the cap, re-encodes the file in place to fit it. Returns the
   *  final duration in seconds. Throws if the file isn't a readable video or is too long even
   *  to trim sensibly. */
  async assertVideoMaxDuration(
    filePath: string,
    maxSec = WALLPAPER_MAX_VIDEO_SEC,
  ): Promise<number> {
    let duration = await probeVideoDurationSec(filePath);
    if (duration == null) {
      throw new BadRequestException(
        "Could not read video duration. Ensure the file is a valid video.",
      );
    }
    if (duration > WALLPAPER_DURATION_HARD_MAX_SEC) {
      throw new BadRequestException(
        `Video must be ${maxSec} seconds or shorter (got ${duration.toFixed(1)}s). Trim before uploading.`,
      );
    }
    if (duration > maxSec + 0.05) {
      await this.trimVideoToMaxDuration(filePath, maxSec);
      duration = maxSec;
    }
    return duration;
  }

  /** Re-mux/encode to hard-cap length when browser trim overshoots (e.g. 5.2s for a 5s clip). */
  async trimVideoToMaxDuration(
    filePath: string,
    maxSec: number,
  ): Promise<void> {
    const ffmpeg = resolveFfmpegPath();
    const ext = extname(filePath) || ".webm";
    const tmpPath = join(
      dirname(filePath),
      `${basename(filePath, ext)}-cap${ext}`,
    );
    try {
      await execFileAsync(
        ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          filePath,
          "-t",
          String(maxSec),
          "-c",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          tmpPath,
        ],
        { timeout: 60_000 },
      );
    } catch {
      const mp4Path = tmpPath.replace(/\.[^.]+$/, ".mp4") || `${tmpPath}.mp4`;
      await execFileAsync(
        ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          filePath,
          "-t",
          String(maxSec),
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "28",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          mp4Path,
        ],
        { timeout: 120_000 },
      );
      try {
        unlinkSync(filePath);
      } catch {
        /* best-effort */
      }
      renameSync(mp4Path, filePath);
      return;
    }
    try {
      unlinkSync(filePath);
    } catch {
      /* best-effort */
    }
    renameSync(tmpPath, filePath);
    if (!existsSync(filePath)) {
      throw new BadRequestException("Video trim failed to produce output");
    }
  }
}
