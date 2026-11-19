/** Photo quality tiers for sending (Telegram's "Standard" / "HD"). The browser makes the file,
 *  the server keeps those bytes (MediaService only re-encodes to strip metadata), so the size
 *  shown before sending is the size that's sent. */
export type QualityTier = "standard" | "hd";

export const QUALITY_TIERS: Record<QualityTier, { maxEdge: number; quality: number; label: string }> = {
  standard: { maxEdge: 1280, quality: 0.8, label: "Standard" },
  hd: { maxEdge: 2560, quality: 0.9, label: "HD" },
};

/** Formats we keep as-is when nothing about them needs to change. */
const KEEPABLE = new Set(["image/jpeg", "image/png", "image/webp"]);

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "…";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** Long edge after capping at `maxEdge` (never upscaled). */
export function cappedSize(w: number, h: number, maxEdge: number): { w: number; h: number } {
  const s = Math.min(1, maxEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode the image."))), type, quality);
  });
}

/** True when any pixel is (even slightly) transparent — sampled on a small copy. */
export function hasAlpha(canvas: HTMLCanvasElement): boolean {
  const s = document.createElement("canvas");
  const k = Math.min(1, 256 / Math.max(canvas.width, canvas.height));
  s.width = Math.max(1, Math.round(canvas.width * k));
  s.height = Math.max(1, Math.round(canvas.height * k));
  const ctx = s.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(canvas, 0, 0, s.width, s.height);
  const d = ctx.getImageData(0, 0, s.width, s.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

export interface EncodedImage {
  blob: Blob;
  width: number;
  height: number;
  /** The original file, untouched. */
  kept: boolean;
}

/**
 * Encodes one tier. `render(maxEdge)` draws the (edited) picture at most `maxEdge` on its long
 * edge. The original file is kept instead when nothing was edited, it already fits the tier,
 * and re-encoding wouldn't make it smaller.
 */
export async function encodeTier(opts: {
  file: File;
  width: number;
  height: number;
  edited: boolean;
  tier: QualityTier;
  render: (maxEdge: number) => HTMLCanvasElement;
  /** Set when the picture has transparency (kept as WebP instead of JPEG). */
  alpha?: boolean;
}): Promise<EncodedImage> {
  const { maxEdge, quality } = QUALITY_TIERS[opts.tier];
  const fits = Math.max(opts.width, opts.height) <= maxEdge;
  const canvas = opts.render(maxEdge);
  const type = opts.alpha ? "image/webp" : "image/jpeg";
  const blob = await canvasToBlob(canvas, type, quality);
  if (!opts.edited && fits && KEEPABLE.has(opts.file.type) && opts.file.size <= blob.size) {
    return { blob: opts.file, width: opts.width, height: opts.height, kept: true };
  }
  return { blob, width: canvas.width, height: canvas.height, kept: false };
}

/**
 * Both tiers, with the guarantee the user expects from the labels: Standard is never bigger
 * than HD (when the photo is small enough that both come out alike, Standard just uses the
 * smaller of the two).
 */
export async function encodeBothTiers(opts: Omit<Parameters<typeof encodeTier>[0], "tier">): Promise<Record<QualityTier, EncodedImage>> {
  const hd = await encodeTier({ ...opts, tier: "hd" });
  let standard = await encodeTier({ ...opts, tier: "standard" });
  if (standard.blob.size > hd.blob.size) standard = hd;
  return { standard, hd };
}

/** A File for upload, named after the original with the right extension. */
export function toFile(blob: Blob, originalName: string): File {
  if (blob instanceof File) return blob;
  const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : "jpg";
  const base = originalName.replace(/\.[^.]+$/, "") || "photo";
  return new File([blob], `${base}.${ext}`, { type: blob.type });
}
