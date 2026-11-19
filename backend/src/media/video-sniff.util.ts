/**
 * Magic-byte sniffing for the video containers this service accepts — never trust a client-
 * supplied extension or `Content-Type` header (same rule as `file-sniff.util.ts`'s image
 * sniffing). Returns null for anything that doesn't match a known signature.
 */

export interface SniffedVideoType {
  mimeType:
    | "video/mp4"
    | "video/quicktime"
    | "video/webm"
    | "video/x-matroska"
    | "video/x-msvideo";
  ext: "mp4" | "mov" | "webm" | "mkv" | "avi";
}

export function sniffVideoType(buf: Buffer): SniffedVideoType | null {
  if (buf.length < 12) return null;

  // ISO base media container (mp4/mov/m4v/...): a 4-byte box size then ascii "ftyp" at offset 4.
  if (
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70
  ) {
    const majorBrand = buf.subarray(8, 12).toString("ascii");
    if (majorBrand === "qt  ") {
      return { mimeType: "video/quicktime", ext: "mov" };
    }
    return { mimeType: "video/mp4", ext: "mp4" };
  }

  // EBML header — shared by WebM and Matroska; ffmpeg handles both identically, so this
  // service doesn't need to tell them apart beyond picking a plausible extension.
  if (
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3
  ) {
    return { mimeType: "video/webm", ext: "webm" };
  }

  // RIFF....AVI  container.
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x41 &&
    buf[9] === 0x56 &&
    buf[10] === 0x49 &&
    buf[11] === 0x20
  ) {
    return { mimeType: "video/x-msvideo", ext: "avi" };
  }

  return null;
}
