import { legacyResizedUrl, resolveAttachmentUrl, type ImageSources } from "@/lib/media-src";

/** The one resolver for every profile photo, group/channel image and avatar in the app.
 *
 *  A photo field (`avatarUrl[0]`, `image[0]`, `photos[].url`, a call's photo, a bot's avatar)
 *  can hold any of these, and all of them must end up on the API that serves them:
 *  - an absolute link to an explicitly configured previous origin → the current API;
 *  - a relative `/uploads/<file>` (legacy photo) → the API, with the resized route first;
 *  - a MediaService path `/uploads/media/<hash>/<variant>` → the small `thumb.jpg` (or the
 *    `web.jpg` for large views), falling back to the original;
 *  - a bare media path `<hash>/<variant>` (packs and older clients) → the media route;
 *  - any other absolute URL, `blob:` or `data:` → as it is.
 *
 *  Use `large` for full-screen or hero views; everything else gets the small file. */

export interface PhotoSourcesOptions {
  /** Full-screen or hero view: the larger variant, not the 320px one. */
  large?: boolean;
}

const MEDIA_SERVICE_IMAGE = /^(.*\/uploads\/media\/[^/]+)\/(original|web)\.(jpe?g|png|webp)$/i;

/** A stored photo reference as the path the resolver understands. */
function normalizePhotoPath(raw: string): string {
  if (/^(https?:|blob:|data:)/i.test(raw)) return raw;
  if (raw.startsWith("/uploads/")) return raw;
  // A bare `<hash>/<variant>` (or `/<hash>/<variant>`) is a MediaService path.
  return `/uploads/media${raw.startsWith("/") ? raw : `/${raw}`}`;
}

/** Image sources for a photo reference, or null when there is no photo. The fallback is always
 *  the original: an animated WebP has no `thumb.jpg`/`web.jpg`, and a resized variant that
 *  cannot be made already redirects to the original on the server. */
export function photoSources(raw: string | null | undefined, opts: PhotoSourcesOptions = {}): ImageSources | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const url = resolveAttachmentUrl(normalizePhotoPath(trimmed));
  const m = MEDIA_SERVICE_IMAGE.exec(url);
  if (m) return { src: `${m[1]}/${opts.large ? "web" : "thumb"}.jpg`, fallback: url };
  const resized = legacyResizedUrl(url, opts.large ? 1280 : 320);
  if (resized) return { src: resized, fallback: url };
  return { src: url };
}

/** The single URL to load for a photo reference (no fallback), or null. */
export function resolvePhotoSrc(raw: string | null | undefined, opts: PhotoSourcesOptions = {}): string | null {
  return photoSources(raw, opts)?.src ?? null;
}
