import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { resolveFfmpegPath } from "./ffmpeg-path.util";

const execFileAsync = promisify(execFile);

export interface AudioProbe {
  /** At least one decodable audio stream. */
  hasAudio: boolean;
  /** An embedded picture (ID3 APIC / MP4 covr / FLAC picture) — ffmpeg lists it as a video
   *  stream flagged `(attached pic)`. */
  hasCover: boolean;
  durationSec: number | null;
  title: string | null;
  artist: string | null;
  album: string | null;
}

function stderrOf(err: unknown): string {
  if (!err || typeof err !== "object" || !("stderr" in err)) return "";
  const v = (err as { stderr?: unknown }).stderr;
  return typeof v === "string"
    ? v
    : Buffer.isBuffer(v)
      ? v.toString("utf-8")
      : "";
}

/** Unescapes one ffmetadata value (`\=`, `\;`, `\#`, `\\`, `\<newline>`). */
function unescapeMeta(value: string): string {
  return value.replace(/\\(.)/gs, "$1");
}

/** Parses ffmpeg's `-f ffmetadata` output: `key=value` lines up to the first `[SECTION]`
 *  (global tags only — per-stream/chapter sections are ignored). Keys are lower-cased. */
export function parseFfmetadata(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // A value may continue on the next line after a trailing backslash.
  const CONT = "\uE000"; // private-use placeholder for an escaped newline
  const lines = text.replace(/\\\r?\n/g, `\\${CONT}`).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.split(CONT).join("\n");
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;
    const m = /^((?:[^=\\]|\\.)+)=(.*)$/s.exec(line);
    if (!m) continue;
    const key = unescapeMeta(m[1]).trim().toLowerCase();
    const value = unescapeMeta(m[2]).trim();
    if (key && value && !(key in out)) out[key] = value;
  }
  return out;
}

/** Reads `Duration:` and the stream list from ffmpeg's `-i` banner. */
export function parseStreamInfo(text: string): {
  durationSec: number | null;
  hasAudio: boolean;
  hasCover: boolean;
} {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const durationSec = d
    ? parseInt(d[1], 10) * 3600 + parseInt(d[2], 10) * 60 + parseFloat(d[3])
    : null;
  const streams = text.split("\n").filter(l => /Stream #\d+:\d+/.test(l));
  return {
    durationSec:
      durationSec != null && Number.isFinite(durationSec) && durationSec > 0
        ? Math.round(durationSec * 100) / 100
        : null,
    hasAudio: streams.some(l => /: Audio:/.test(l)),
    hasCover: streams.some(l => /: Video:/.test(l) && /attached pic/.test(l)),
  };
}

function clean(value: string | undefined, max = 200): string | null {
  if (!value) return null;
  // Strip control characters some taggers leave in (NULs from padded ID3v1 fields etc.).
  const v = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return v ? v.slice(0, max) : null;
}

/**
 * Probes an audio file with the bundled ffmpeg (no ffprobe on the server): duration and streams
 * from the `-i` banner, tags via `-f ffmetadata` (handles escaping and multi-line values, unlike
 * scraping the banner's "Metadata:" block). Never throws — an unreadable file is `hasAudio: false`.
 */
export async function probeAudio(filePath: string): Promise<AudioProbe> {
  const ffmpeg = resolveFfmpegPath();
  let banner = "";
  let tags: Record<string, string> = {};
  try {
    const { stdout, stderr } = await execFileAsync(
      ffmpeg,
      [
        "-hide_banner",
        "-i",
        filePath,
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-f",
        "ffmetadata",
        "-",
      ],
      { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
    );
    banner = String(stderr);
    tags = parseFfmetadata(String(stdout));
  } catch (err) {
    banner = stderrOf(err);
  }
  const info = parseStreamInfo(banner);
  return {
    ...info,
    title: clean(tags.title),
    artist: clean(tags.artist ?? tags.album_artist ?? tags.performer),
    album: clean(tags.album),
  };
}

/** Writes the embedded cover art as a JPEG (first attached picture), or returns null. */
export async function extractAudioCover(
  inputPath: string,
  outputPath: string,
): Promise<Buffer | null> {
  const ffmpeg = resolveFfmpegPath();
  try {
    await execFileAsync(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-an",
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-q:v",
        "3",
        outputPath,
      ],
      { timeout: 30_000 },
    );
    const buf = readFileSync(outputPath);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}
