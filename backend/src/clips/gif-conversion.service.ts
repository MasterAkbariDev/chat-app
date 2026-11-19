import { Injectable, BadRequestException, Logger } from "@nestjs/common";
import { existsSync, statSync } from "fs";
import { dirname, join } from "path";
import {
  describeVideoInput,
  FfmpegError,
  runFfmpeg,
} from "src/media/video-processing.util";

/** Max clip length converted to GIF (seconds). */
const MAX_DURATION_SEC = 10;
/** Must stay under MediaService's GIF_MAX_BYTES (8 MB) — a bigger result is retried smaller. */
const TARGET_MAX_BYTES = 7.5 * 1024 * 1024;

/** Tried in order until the GIF fits TARGET_MAX_BYTES. */
const ATTEMPTS: { width: number; fps: number; colors: number }[] = [
  { width: 480, fps: 15, colors: 128 },
  { width: 360, fps: 12, colors: 96 },
  { width: 240, fps: 10, colors: 64 },
];

/**
 * Video clip → looping GIF (Telegram-exported "GIFs" are silent MP4s, so this is the common
 * path for "Add GIF"). Two ffmpeg passes — palette, then encode with it — each capped at 2
 * decoder threads. The previous single pass (`split` → palettegen → paletteuse) had to hold
 * every frame in memory until the palette was ready at end of stream: ~360 MB for a 10 s
 * portrait 1080p phone clip — with Node alongside, enough for the container (mem_limit 768m)
 * to be OOM-killed mid-conversion ("Video conversion failed"). Two passes stay ~50 MB. Long edge (not
 * width) is capped, so portrait clips are as small as landscape ones.
 */
@Injectable()
export class GifConversionService {
  private readonly logger = new Logger(GifConversionService.name);

  /** Square pixels, fps cap, long edge ≤ `width` (never upscaled). */
  static frameFilter(a: { width: number; fps: number }): string {
    const m = a.width;
    return (
      `setsar=1,fps=${a.fps},` +
      `scale='if(gte(iw,ih),min(${m},iw),-1)':'if(gte(iw,ih),-1,min(${m},ih))':flags=lanczos`
    );
  }

  async convertVideoToGif(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    if (!existsSync(inputPath)) {
      throw new BadRequestException("Video file not found");
    }
    try {
      await this.encodeAll(inputPath, outputPath);
      return;
    } catch (err: unknown) {
      // Some clips (HDR or 10-bit HEVC, unusual profiles, odd timestamps) make the GIF filters fail
      // even though ffmpeg can decode them. Transcode once to plain H.264 and convert that copy.
      if (
        !(err instanceof FfmpegError) ||
        isUnreadable(err) ||
        isMissingBinary(err)
      ) {
        throw toClientError(err);
      }
      this.logger.warn(
        "gif conversion failed directly — retrying from a plain H.264 copy",
      );
    }
    const plainPath = join(dirname(outputPath), "plain.mp4");
    try {
      await this.transcodePlain(inputPath, plainPath);
      await this.encodeAll(plainPath, outputPath);
    } catch (err: unknown) {
      throw toClientError(err);
    }
  }

  /** The two-pass palette conversion, smaller attempts until the GIF fits. Throws FfmpegError on a
   *  failed ffmpeg run (mapped by the caller) and BadRequestException when it's too big. */
  private async encodeAll(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    let lastSize = 0;
    const palettePath = join(dirname(outputPath), "palette.png");
    for (const attempt of ATTEMPTS) {
      const frames = GifConversionService.frameFilter(attempt);
      const input = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-threads",
        "2",
        "-t",
        String(MAX_DURATION_SEC),
        "-i",
        inputPath,
      ];
      // runFfmpeg already logged the stderr tail and the input description.
      await runFfmpeg(
        "gif",
        [
          ...input,
          "-vf",
          `${frames},palettegen=max_colors=${attempt.colors}:stats_mode=diff`,
          "-frames:v",
          "1",
          "-update",
          "1",
          palettePath,
        ],
        { timeout: 120_000, inputPath },
      );
      await runFfmpeg(
        "gif",
        [
          ...input,
          "-i",
          palettePath,
          "-filter_complex",
          `[0:v]${frames}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
          "-an",
          "-loop",
          "0",
          "-f",
          "gif",
          outputPath,
        ],
        { timeout: 120_000, inputPath },
      );

      if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
        const input = await describeVideoInput(inputPath).catch(() => null);
        this.logger.error(
          `ffmpeg gif produced no output — input=[${input ?? "?"}]`,
        );
        throw new FfmpegError(
          "ffmpeg gif produced no output",
          "no output file",
          input,
          "ffmpeg",
        );
      }
      lastSize = statSync(outputPath).size;
      if (lastSize <= TARGET_MAX_BYTES) return;
      this.logger.warn(
        `gif too large at ${attempt.width}px/${attempt.fps}fps (${lastSize} bytes) — retrying smaller`,
      );
    }
    throw new BadRequestException(
      `That clip is too long or detailed for a GIF (${Math.round(lastSize / 1024 / 1024)} MB). Trim it and try again.`,
    );
  }

  /** A short, silent, 8-bit H.264 copy of the clip: the fallback input for codecs the GIF path rejects. */
  private async transcodePlain(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    await runFfmpeg(
      "plain",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-threads",
        "2",
        "-t",
        String(MAX_DURATION_SEC),
        "-i",
        inputPath,
        "-an",
        "-vf",
        "scale='min(720,iw)':-2:flags=lanczos,format=yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "26",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      { timeout: 180_000, inputPath },
    );
  }
}

const UNREADABLE_RE =
  /Invalid data|moov atom|could not find codec|does not contain any stream|Output file .* does not contain/i;

function isUnreadable(err: FfmpegError): boolean {
  return UNREADABLE_RE.test(err.stderrTail);
}

function isMissingBinary(err: FfmpegError): boolean {
  return err.stderrTail.includes("binary not found");
}

/** The message a person sees: why it failed, in plain words. Non-ffmpeg errors pass through. */
function toClientError(err: unknown): unknown {
  if (!(err instanceof FfmpegError)) return err;
  if (isMissingBinary(err)) {
    return new BadRequestException(
      "Video conversion isn't available on this server right now.",
    );
  }
  if (isUnreadable(err)) {
    return new BadRequestException(
      "That video couldn't be read. Try a different file.",
    );
  }
  return new BadRequestException(
    "That video couldn't be converted to a GIF. Try a different file.",
  );
}
