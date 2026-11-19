/**
 * Magic-byte sniffing for the image types this service accepts — never trust a client-supplied
 * extension or `Content-Type` header (docs/plans/BACKEND_PLAN.md B2: "magic-byte sniffing + type
 * allowlist"). Returns null for anything that doesn't match a known signature, regardless of what
 * the filename/mimetype claimed.
 */

export interface SniffedImageType {
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  ext: "jpg" | "png" | "gif" | "webp";
}

export function sniffImageType(buf: Buffer): SniffedImageType | null {
  if (buf.length < 12) return null;

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mimeType: "image/jpeg", ext: "jpg" };
  }

  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { mimeType: "image/png", ext: "png" };
  }

  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return { mimeType: "image/gif", ext: "gif" };
  }

  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { mimeType: "image/webp", ext: "webp" };
  }

  return null;
}
