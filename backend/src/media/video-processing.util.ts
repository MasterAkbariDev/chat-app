import { execFile } from "child_process";
import { existsSync, statSync } from "fs";
import { promisify } from "util";
import { Logger } from "@nestjs/common";
import { resolveFfmpegPath } from "./ffmpeg-path.util";

const execFileAsync = promisify(execFile);
const logger = new Logger("Ffmpeg");

/** The longer side of the frame is capped here; the shorter side scales to match, so a
 *  landscape video is width-capped and a portrait one is height-capped — neither axis is ever
 *  upscaled past the source. */
const MAX_DIMENSION = 1280;

function collectExecOutput(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const parts: string[] = [];
  const asString = (value: unknown): string | null =>
    typeof value === "string"
      ? value
      : Buffer.isBuffer(value)
        ? value.toString("utf-8")
        : null;
  if ("stdout" in err) {
    const stdout = asString((err as { stdout?: unknown }).stdout);
    if (stdout) parts.push(stdout);
  }
  if ("stderr" in err) {
    const stderr = asString((err as { stderr?: unknown }).stderr);
    if (stderr) parts.push(stderr);
  }
  return parts.join("\n");
}

/**
 * An ffmpeg run that failed. `stderrTail` is the end of ffmpeg's own output (where the actual
 * reason is), `input` a one-line description of the source (container, codec, size, duration)
 * — both are logged by `runFfmpeg`, so a failure in production is diagnosable from the logs.
 */
export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string,
    readonly input: string | null,
    readonly binary: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

/** Last `lines` non-empty lines of ffmpeg's stderr, trimmed. */
export function stderrTail(text: string, lines = 8): string {
  return text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" | ")
    .slice(0, 1200);
}

/**
 * Runs ffmpeg with `args`. On failure: logs the binary, a description of `inputPath`, the
 * command's arguments and the tail of ffmpeg's stderr, then throws a `FfmpegError` carrying
 * the same. `label` names the operation in the log ("gif", "compress", …).
 */
export async function runFfmpeg(
  label: string,
  args: string[],
  opts: { timeout: number; inputPath?: string },
): Promise<void> {
  const ffmpeg = resolveFfmpegPath();
  try {
    await execFileAsync(ffmpeg, args, {
      timeout: opts.timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const e = err as {
      code?: string | number;
      killed?: boolean;
      signal?: string;
      message?: string;
    };
    const output = collectExecOutput(err);
    const tail =
      stderrTail(output) ||
      (e.code === "ENOENT"
        ? `ffmpeg binary not found (${ffmpeg}) — install ffmpeg or set FFMPEG_PATH`
        : e.killed
          ? `timed out after ${Math.round(opts.timeout / 1000)}s (${e.signal ?? "killed"})`
          : (e.message ?? "unknown error").slice(0, 300));
    const input = opts.inputPath
      ? await describeVideoInput(opts.inputPath).catch(() => null)
      : null;
    logger.error(
      `ffmpeg ${label} failed — binary=${ffmpeg} exit=${String(e.code ?? "?")}` +
        `${input ? ` input=[${input}]` : ""} args=[${args.join(" ")}] stderr: ${tail}`,
    );
    throw new FfmpegError(
      `ffmpeg ${label} failed: ${tail}`,
      tail,
      input,
      ffmpeg,
    );
  }
}

function parseDurationSec(text: string): number | null {
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const s = parseFloat(match[3]);
  const total = h * 3600 + m * 60 + s;
  return Number.isFinite(total) && total > 0 ? total : null;
}

/** Matches the first `WxH` pair on a `Stream ... Video:` line (e.g. "1920x1080" or the
 *  "320x240 [SAR ...]" form ffmpeg prints when the source has non-square pixels). A
 *  "rotate: 90" / "displaymatrix: rotation of -90" side-data line swaps them, since ffmpeg
 *  auto-rotates such a source before any filter runs. */
function parseResolution(
  text: string,
): { width: number; height: number } | null {
  const line = text.split("\n").find(l => /Stream #.*Video:/.test(l));
  const match = (line ?? text).match(/(\d{2,5})x(\d{2,5})/);
  if (!match) return null;
  let width = parseInt(match[1], 10);
  let height = parseInt(match[2], 10);
  const rot =
    /rotation of (-?\d+(?:\.\d+)?)/.exec(text) ??
    /rotate\s*:\s*(-?\d+)/.exec(text);
  if (rot && Math.abs(Math.round(parseFloat(rot[1]))) % 180 === 90) {
    [width, height] = [height, width];
  }
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : null;
}

/** `ffmpeg -i` with no output: exits non-zero but prints the input's stream info to stderr. */
async function readInputInfo(filePath: string): Promise<string> {
  const ffmpeg = resolveFfmpegPath();
  try {
    await execFileAsync(ffmpeg, ["-hide_banner", "-i", filePath], {
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return "";
  } catch (err: unknown) {
    return collectExecOutput(err);
  }
}

/** One line describing a media file for logs: duration, then each stream's codec line. */
export async function describeVideoInput(filePath: string): Promise<string> {
  const text = await readInputInfo(filePath);
  const duration = /Duration:\s*([^,\n]+)/.exec(text)?.[1]?.trim();
  const streams = text
    .split("\n")
    .filter(l => /Stream #/.test(l))
    .map(l =>
      l
        .replace(/^\s*Stream #\S+\s*/, "")
        .trim()
        .slice(0, 160),
    );
  const invalid =
    /Invalid data found|could not find codec|moov atom not found/i.exec(text);
  return [
    duration ? `duration ${duration}` : null,
    ...streams,
    invalid ? `probe: ${invalid[0]}` : null,
  ]
    .filter(Boolean)
    .join("; ")
    .slice(0, 600);
}

/** Reads duration from ffmpeg's own `-i` stderr output — no ffprobe binary needed (only
 *  `ffmpeg-static` is bundled). Returns null if it can't be determined (never throws — a
 *  missing duration shouldn't block ingesting an otherwise-valid video). */
export async function probeVideoDurationSec(
  filePath: string,
): Promise<number | null> {
  return parseDurationSec(await readInputInfo(filePath));
}

/** Reads (display-oriented) frame dimensions from the same `-i` output. Returns null rather
 *  than throwing on a source ffmpeg can't parse. */
export async function probeVideoResolution(
  filePath: string,
): Promise<{ width: number; height: number } | null> {
  return parseResolution(await readInputInfo(filePath));
}

/**
 * Scale filter capping the long edge at `maxDimension` (never upscaling) with both output
 * sides even — H.264 in yuv420p refuses odd widths/heights ("width not divisible by 2"), which
 * the previous `min(cap,iw)` form produced for any odd-sized source at or under the cap.
 */
export function evenScaleFilter(maxDimension: number): string {
  return (
    `scale='if(gte(iw,ih),2*trunc(min(${maxDimension},iw)/2),-2)'` +
    `:'if(gte(iw,ih),-2,2*trunc(min(${maxDimension},ih)/2))'`
  );
}

/** Sender-side edits applied server-side (the web editor only previews them). Crop is in
 *  normalized (0–1) coordinates of the frame *after* rotation/flip. */
export interface VideoEdits {
  trimStartSec?: number;
  trimEndSec?: number;
  muted?: boolean;
  rotate?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  crop?: { x: number; y: number; w: number; h: number };
  /** Cover/poster frame, in seconds of the *source* (before trimming). */
  coverSec?: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

/**
 * Validates the `edits` form field (a JSON string) — anything malformed is dropped rather than
 * failing the upload. Returns null when nothing would change the video.
 */
export function parseVideoEdits(raw: unknown): VideoEdits | null {
  if (raw == null || raw === "") return null;
  let obj: Record<string, unknown>;
  try {
    obj = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const out: VideoEdits = {};
  if (finite(obj.trimStartSec) && obj.trimStartSec > 0.05)
    out.trimStartSec = Math.round(obj.trimStartSec * 1000) / 1000;
  if (finite(obj.trimEndSec) && obj.trimEndSec > (out.trimStartSec ?? 0) + 0.1)
    out.trimEndSec = Math.round(obj.trimEndSec * 1000) / 1000;
  if (obj.muted === true) out.muted = true;
  if (obj.flipH === true) out.flipH = true;
  const rot = Number(obj.rotate);
  if (rot === 90 || rot === 180 || rot === 270) out.rotate = rot;
  const c = obj.crop as Record<string, unknown> | undefined;
  if (c && finite(c.x) && finite(c.y) && finite(c.w) && finite(c.h)) {
    const x = clamp01(c.x);
    const y = clamp01(c.y);
    const w = Math.min(clamp01(c.w), 1 - x);
    const h = Math.min(clamp01(c.h), 1 - y);
    if (w >= 0.05 && h >= 0.05 && (w < 0.995 || h < 0.995)) {
      out.crop = {
        x: Math.round(x * 1e4) / 1e4,
        y: Math.round(y * 1e4) / 1e4,
        w: Math.round(w * 1e4) / 1e4,
        h: Math.round(h * 1e4) / 1e4,
      };
    }
  }
  if (finite(obj.coverSec) && obj.coverSec >= 0)
    out.coverSec = Math.round(obj.coverSec * 1000) / 1000;
  return Object.keys(out).length ? out : null;
}

/** Stable short key for dedupe (same source + same edits = same stored file). */
export function videoEditsKey(e: VideoEdits | null | undefined): string {
  if (!e) return "";
  const parts: string[] = [];
  if (e.trimStartSec != null) parts.push(`s${e.trimStartSec}`);
  if (e.trimEndSec != null) parts.push(`e${e.trimEndSec}`);
  if (e.muted) parts.push("m");
  if (e.rotate) parts.push(`r${e.rotate}`);
  if (e.flipH) parts.push("f");
  if (e.crop) parts.push(`c${e.crop.x},${e.crop.y},${e.crop.w},${e.crop.h}`);
  if (e.coverSec != null) parts.push(`p${e.coverSec}`);
  return parts.join("_");
}

/** Geometry filters for `edits` (rotate → flip → crop), before scaling. */
export function editFilters(e: VideoEdits | null | undefined): string[] {
  if (!e) return [];
  const f: string[] = [];
  if (e.rotate === 90) f.push("transpose=1");
  else if (e.rotate === 180) f.push("hflip", "vflip");
  else if (e.rotate === 270) f.push("transpose=2");
  if (e.flipH) f.push("hflip");
  if (e.crop) {
    const { x, y, w, h } = e.crop;
    f.push(
      `crop='max(2,2*trunc(iw*${w}/2))':'max(2,2*trunc(ih*${h}/2))':'trunc(iw*${x})':'trunc(ih*${y})'`,
    );
  }
  return f;
}

/** Input-side trim args (`-ss` before `-i`: fast and, since we re-encode, frame-accurate). */
function trimInputArgs(e: VideoEdits | null | undefined): string[] {
  return e?.trimStartSec ? ["-ss", String(e.trimStartSec)] : [];
}
function trimOutputArgs(e: VideoEdits | null | undefined): string[] {
  if (e?.trimEndSec == null) return [];
  return ["-t", String(e.trimEndSec - (e.trimStartSec ?? 0))];
}

/**
 * Transcodes to H.264/AAC mp4, scaling down to fit within `maxDimension` (never upscaling)
 * and re-encoding at a moderate CRF — this is the actual "compress video uploads" step; unlike
 * the wallpaper pipeline's stream-copy trim, this always re-encodes. `maxDimension` defaults to
 * `MAX_DIMENSION` (1280, ~720p on the long edge) when the caller doesn't ask for a specific
 * quality tier. `edits` (trim, mute, rotate, flip, crop) are applied in the same pass.
 */
export async function compressVideo(
  inputPath: string,
  outputPath: string,
  maxDimension: number = MAX_DIMENSION,
  edits?: VideoEdits | null,
): Promise<void> {
  await runFfmpeg(
    "compress",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...trimInputArgs(edits),
      "-i",
      inputPath,
      ...trimOutputArgs(edits),
      "-map",
      "0:v:0",
      ...(edits?.muted ? ["-an"] : ["-map", "0:a:0?"]),
      "-vf",
      [...editFilters(edits), evenScaleFilter(maxDimension)].join(","),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "26",
      "-pix_fmt",
      "yuv420p",
      ...(edits?.muted ? [] : ["-c:a", "aac", "-b:a", "128k"]),
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { timeout: 300_000, inputPath },
  );
}

/** Grabs one frame (default: the first) as a JPEG poster/thumbnail. A time past the end
 *  falls back to the first frame instead of producing nothing. */
export async function extractVideoThumbnail(
  inputPath: string,
  outputPath: string,
  atSec = 0,
): Promise<void> {
  const grab = (sec: number) =>
    runFfmpeg(
      "poster",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        String(Math.max(0, sec)),
        "-i",
        inputPath,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        "-update",
        "1",
        outputPath,
      ],
      { timeout: 30_000, inputPath },
    );
  await grab(atSec);
  if (atSec > 0) {
    if (!existsSync(outputPath) || statSync(outputPath).size === 0)
      await grab(0);
  }
}

export interface LoopVideoOptions {
  /** Long-edge cap (or the side length when `square`). Never upscales. */
  maxDimension: number;
  /** Centre-crop to a square first (profile videos). */
  square?: boolean;
  /** Hard cut after this many seconds. */
  maxSec: number;
  /** Frame-rate cap. */
  fps: number;
}

/**
 * For media that loops silently in the background — profile videos and wallpapers. Unlike
 * `compressVideo` it drops the audio track, caps the frame rate, cuts to `maxSec`, and uses a
 * higher CRF with short GOPs: a few hundred KB that decodes cheaply and seeks back to the
 * start instantly on every loop. `edits` (trim/rotate/flip/crop) apply before the square crop.
 */
export async function compressLoopVideo(
  inputPath: string,
  outputPath: string,
  { maxDimension, square, maxSec, fps }: LoopVideoOptions,
  edits?: VideoEdits | null,
): Promise<void> {
  const filters = [...editFilters(edits)];
  if (square) {
    filters.push(
      "crop='2*trunc(min(iw,ih)/2)':'2*trunc(min(iw,ih)/2)'",
      `scale='2*trunc(min(${maxDimension},iw)/2)':-2`,
    );
  } else {
    filters.push(evenScaleFilter(maxDimension));
  }
  filters.push(`fps='min(${fps},source_fps)'`);
  const span =
    edits?.trimEndSec != null
      ? Math.min(maxSec, edits.trimEndSec - (edits.trimStartSec ?? 0))
      : maxSec;
  await runFfmpeg(
    "loop",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...trimInputArgs(edits),
      "-i",
      inputPath,
      "-t",
      String(span),
      "-an",
      "-vf",
      filters.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "30",
      "-profile:v",
      "main",
      "-pix_fmt",
      "yuv420p",
      "-g",
      String(fps * 2),
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { timeout: 180_000, inputPath },
  );
}

/** Side length of a stored round video message. */
export const VIDEO_NOTE_PX = 480;

/**
 * Round video messages (recorded in the browser with MediaRecorder): centre-cropped square,
 * `VIDEO_NOTE_PX`, constant 30 fps, H.264/AAC mp4.
 *
 * MediaRecorder WebM is variable-frame-rate with sparse, sometimes late-starting timestamps
 * (a canvas capture only emits a frame when something was drawn) and usually no duration in its
 * header. Encoding that straight to mp4 let ffmpeg guess a frame rate from the timebase, which
 * played back jerky; the `fps=30` filter resamples onto a steady 30 fps grid (duplicating or
 * dropping frames by timestamp, never re-timing), so the clip keeps its real length.
 * `aresample=async=1` pads/stretches the audio over small timestamp gaps instead of letting it
 * drift out of sync, and `-g 60` keeps keyframes every 2 s so seeking (and the in-chat loop) is
 * quick. Nothing is trimmed.
 */
export async function compressVideoNote(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const ffmpeg = resolveFfmpegPath();
  await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-vf",
      `crop='min(iw,ih)':'min(iw,ih)',scale=${VIDEO_NOTE_PX}:${VIDEO_NOTE_PX}:flags=bicubic,setsar=1,fps=30`,
      "-af",
      "aresample=async=1:first_pts=0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "25",
      "-profile:v",
      "main",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "60",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-ac",
      "1",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
  );
}
