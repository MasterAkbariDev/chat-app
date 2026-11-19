import { API_BASE_URL as BASE_URL } from "@/lib/api/base";

/** Packs are the one place the backend hands back a bare relative path
 * instead of a server-resolved absolute URL — confirmed by reading
 * packs.service.ts (never calls the shared buildMediaUrl helper, unlike
 * uploads/stickers/gifs/wallpaper, which all do). Media is served at
 * /uploads/media/<hash>/<variant> on the API's own origin regardless. */
export function resolveMediaUrl(relativePath: string): string {
  const path = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  return `${BASE_URL}/uploads/media${path}`;
}

/** A still for a video. Two shapes exist:
 *  - new uploads, `/uploads/media/<hash>/original.mp4`: the backend's video pipeline writes
 *    `poster.jpg` next to it (see MediaService.ingestVideo), so derive that name;
 *  - migrated legacy clips, `/uploads/<file>.mp4`: no poster at all. The backend makes a
 *    JPEG first frame on demand at `/uploads/_poster/<file>.mp4` (LegacyPosterController).
 * Without one of these a video shows as an empty black box until it is played. */
export function videoPosterUrl(videoUrl: string): string | undefined {
  if (/\/uploads\/media\/[^/]+\/original\.mp4$/.test(videoUrl)) return videoUrl.replace(/original\.mp4$/, "poster.jpg");
  const legacy = /\/uploads\/([A-Za-z0-9][\w.-]{0,199}\.(?:mp4|m4v|mov|webm))$/i.exec(videoUrl);
  if (legacy) return videoUrl.replace(/\/uploads\/([^/]+)$/, "/uploads/_poster/$1");
  return undefined;
}
