import { extname } from "node:path";
import { Response } from "express";

const INLINE_MEDIA_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
  ".mp4",
  ".webm",
  ".ogg",
  ".mp3",
  ".wav",
  ".m4a",
  ".mov",
  ".m4v",
]);

/** Prevent active generic uploads from executing when opened in a browser. */
export function setUploadSafetyHeaders(
  res: Pick<Response, "setHeader">,
  filePath: string,
) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  if (!INLINE_MEDIA_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    res.setHeader("Content-Disposition", "attachment");
  }
}
