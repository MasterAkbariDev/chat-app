import { existsSync } from "fs";

/**
 * The one ffmpeg-binary resolver — was duplicated byte-for-byte in `wallpaper-media.service.ts`
 * and `gif-conversion.service.ts` (docs/plans/BACKEND_PLAN.md B2 "unify the 2 ffmpeg helpers").
 * Order: `FFMPEG_PATH` env override → bundled `ffmpeg-static` binary → bare `"ffmpeg"` (PATH lookup).
 */
export function resolveFfmpegPath(): string {
  const fromEnv = process.env.FFMPEG_PATH?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const bundled = getBundledFfmpegPath();
  if (bundled) return bundled;

  return "ffmpeg";
}

/** ffmpeg-static is CJS: `module.exports = path` (no `.default`). Optional dependency. */
function getBundledFfmpegPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bundled = require("ffmpeg-static") as string | { default?: string };
    const path =
      typeof bundled === "string"
        ? bundled
        : typeof bundled?.default === "string"
          ? bundled.default
          : undefined;
    if (path && existsSync(path)) return path;
  } catch {
    /* optional dependency */
  }
  return undefined;
}
