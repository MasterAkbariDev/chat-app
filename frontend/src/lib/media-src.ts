import { API_BASE_URL } from "@/lib/api/base";

/** Widths the backend makes for old `/uploads/<file>` photos (`GET /uploads/_w/<w>/<file>`,
 *  backend/src/media/legacy-resize.*). Anything else 404s. */
export const LEGACY_WIDTHS = [320, 640, 1280] as const;
export type LegacyWidth = (typeof LEGACY_WIDTHS)[number];

const RESIZABLE = /\.(jpe?g|png|webp)$/i;
const MEDIA_SERVICE_IMAGE = /^(.*\/uploads\/media\/[^/]+)\/(original|web)\.(jpe?g|png|webp)$/i;

/** An attachment URL as stored on a message → something the browser can load. Migrated
 *  messages hold relative `/uploads/...` paths; they live on the API's origin (which may sit
 *  under a path prefix in production), not the web app's. */
/** Rewrite uploads from explicitly configured previous origins, leaving other URLs alone. */
function previousUploadPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    const origins = (process.env.NEXT_PUBLIC_LEGACY_MEDIA_ORIGINS ?? "").split(",").map((s) => s.trim());
    if (!origins.includes(parsed.origin)) return null;
    const path = parsed.pathname.replace(/^\/api\/chat(?=\/uploads\/)/, "");
    return path.startsWith("/uploads/") ? `${path}${parsed.search}` : null;
  } catch {
    return null;
  }
}

export function resolveAttachmentUrl(url: string): string {
  const previousPath = previousUploadPath(url);
  if (previousPath) return `${API_BASE_URL}${previousPath}`;
  if (/^(https?:|blob:|data:)/i.test(url)) return url;
  if (url.startsWith("/uploads/")) return `${API_BASE_URL}${url}`;
  return url;
}

/** `/uploads/<file>` part of an old upload (relative, or absolute on our own API), or null
 *  for MediaService media, other hosts, and anything else. */
export function legacyUploadPath(url: string): string | null {
  let path: string | null = null;
  const previousPath = previousUploadPath(url);
  if (previousPath) path = previousPath;
  else if (url.startsWith("/uploads/")) path = url;
  else if (url.startsWith(`${API_BASE_URL}/uploads/`)) path = url.slice(API_BASE_URL.length);
  if (!path) return null;
  const rest = path.slice("/uploads/".length);
  if (!rest || /^(media|_w|_resized)\//.test(rest) || rest.split("/").includes("..")) return null;
  return rest;
}

/** A resized (WebP) variant of an old upload photo, or null when it has none (GIF, SVG, …). */
export function legacyResizedUrl(url: string, width: LegacyWidth): string | null {
  const rest = legacyUploadPath(url);
  if (!rest || !RESIZABLE.test(rest.split("?")[0])) return null;
  return `${API_BASE_URL}/uploads/_w/${width}/${rest}`;
}

export interface ImageSources {
  /** What to put in `src`. */
  src: string;
  srcSet?: string;
  sizes?: string;
  /** Try this if `src` fails (e.g. a variant that was never made) before giving up. */
  fallback?: string;
}

/** Sizes of a photo in a chat bubble: at most 300px wide, 64vw on phones; half that in a grid. */
const BUBBLE_SIZES = "(max-width: 470px) 64vw, 300px";
const GRID_SIZES = "(max-width: 470px) 32vw, 150px";

/** The right file for a photo shown in a message bubble — never the full original when a
 *  smaller one exists. */
export function bubbleImageSources(url: string, opts: { grid?: boolean } = {}): ImageSources {
  const original = resolveAttachmentUrl(url);
  const sizes = opts.grid ? GRID_SIZES : BUBBLE_SIZES;
  const small = legacyResizedUrl(url, 320);
  if (small) {
    return {
      src: legacyResizedUrl(url, 640)!,
      srcSet: `${small} 320w, ${legacyResizedUrl(url, 640)} 640w`,
      sizes,
      fallback: original,
    };
  }
  const m = MEDIA_SERVICE_IMAGE.exec(original);
  if (m) {
    // MediaService wrote thumb.jpg (≤320px) and web.jpg (≤1600px) next to the original.
    // Animated WebPs have neither — the fallback catches that.
    return {
      src: `${m[1]}/web.jpg`,
      srcSet: `${m[1]}/thumb.jpg 320w, ${m[1]}/web.jpg 1600w`,
      sizes,
      fallback: original,
    };
  }
  return { src: original };
}

/** A small square thumbnail (shared-media grid): only the ≤320px variant, with the larger
 *  one — then the original — as fallbacks. A dense grid never loads the 1600px copy. */
export function thumbImageSources(url: string): ImageSources {
  const original = resolveAttachmentUrl(url);
  const small = legacyResizedUrl(url, 320);
  if (small) return { src: small, fallback: legacyResizedUrl(url, 640) ?? original };
  const m = MEDIA_SERVICE_IMAGE.exec(original);
  if (m) return { src: `${m[1]}/thumb.jpg`, fallback: `${m[1]}/web.jpg` };
  return { src: original };
}

/** The file to show full-screen in the media viewer. */
export function viewerImageSources(url: string): ImageSources {
  const original = resolveAttachmentUrl(url);
  const large = legacyResizedUrl(url, 1280);
  if (large) return { src: large, fallback: original };
  return { src: original };
}

/** Clamped display aspect ratio (width / height) for a media box, so a very tall or very
 *  wide photo doesn't take over the chat. Falls back when the size isn't known. */
export function displayAspect(width: number | null | undefined, height: number | null | undefined, fallback = 4 / 3): number {
  if (!width || !height) return fallback;
  return Math.min(1.9, Math.max(0.6, width / height));
}

/** Download name for a media URL (last path segment). */
export function mediaFileName(url: string): string {
  try {
    const last = new URL(resolveAttachmentUrl(url), "http://x").pathname.split("/").filter(Boolean);
    const name = decodeURIComponent(last[last.length - 1] ?? "media");
    // MediaService names files by variant (`original.jpg`); prefix the hash's start.
    if (/^(original|web|thumb)\./.test(name) && last.length >= 2) return `${last[last.length - 2].slice(0, 12)}-${name}`;
    return name;
  } catch {
    return "media";
  }
}
