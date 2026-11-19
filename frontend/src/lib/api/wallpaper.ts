import { ApiError, apiFetch, parseErrorMessage, refreshSession } from "./client";
import { clearTokens, getAccessToken } from "./token-store";
import { apiUrl } from "./base";


export type WallpaperFitMode = "cover" | "contain" | "stretch";

export interface WallpaperSettings {
  blur: number;
  dim: number;
  brightness: number;
  fitMode: WallpaperFitMode;
}

/** GET/PATCH/DELETE /v2/wallpapers — one doc per (owner, scope), upserted in
 * place by the backend rather than accumulating one per apply. `mediaId` is
 * only set for a wallpaper that came through the upload endpoints (bumping
 * the nightly GC's reference count) — omitted entirely for a bundled preset,
 * per the backend DTO's own doc comment ("a default/preset wallpaper not
 * backed by an upload"), so presets never need real file upload at all. */
export interface Wallpaper extends WallpaperSettings {
  id: string;
  type: "image" | "video";
  mediaUrl: string;
  thumbnailUrl: string | null;
  /** The upload behind this wallpaper (null for presets) — send it back when re-picking it. */
  mediaId?: string | null;
  channelId: string | null;
  ownerId: string;
}

export interface EffectiveWallpaper extends Wallpaper {
  source: "chat" | "global" | "default";
}

export type WallpaperType = "image" | "video";

/** What to apply: the media itself plus what the upload endpoint handed back.
 * `thumbnailUrl` is the video's poster frame; `mediaId` lets the backend's GC
 * track the upload. Both are omitted for a bundled preset. */
export interface WallpaperMedia {
  type: WallpaperType;
  mediaUrl: string;
  thumbnailUrl?: string | null;
  mediaId?: string | null;
}

function applyBody(media: WallpaperMedia, settings: WallpaperSettings) {
  return {
    mediaUrl: media.mediaUrl,
    type: media.type,
    ...(media.thumbnailUrl ? { thumbnailUrl: media.thumbnailUrl } : {}),
    ...(media.mediaId ? { mediaId: media.mediaId } : {}),
    ...settings,
  };
}

export const WALLPAPER_GLOBAL_QUERY_KEY = ["wallpaper", "global"] as const;
export const wallpaperEffectiveKey = (channelId: string) => ["wallpaper", "effective", channelId] as const;

// All three GET-a-wallpaper-or-nothing calls below coerce `undefined` to
// `null`: the backend returns a genuinely empty 200 body (not a JSON
// `null`) when no wallpaper is set at that scope — confirmed via curl
// (`Content-Length: 0`) — and `apiFetch` resolves an empty body to
// `undefined`, not `null`. Left uncoerced, that's a real bug, not just an
// awkward type: TanStack Query hard-requires a query function to resolve
// to something other than `undefined` and throws in the console every time
// it doesn't, right up until whatever *does* get cached. Reported here as
// `T | null` because "no wallpaper" is a legitimate value, not a loading
// or error state.
export async function getGlobalWallpaper() {
  return (await apiFetch<Wallpaper | null>("/v2/wallpapers/global")) ?? null;
}

export async function getEffectiveWallpaper(channelId: string) {
  return (await apiFetch<EffectiveWallpaper | null>(`/v2/wallpapers/effective/${channelId}`)) ?? null;
}

export function applyGlobalWallpaper(media: WallpaperMedia, settings: WallpaperSettings) {
  return apiFetch<Wallpaper>("/v2/wallpapers/global", {
    method: "PATCH",
    body: applyBody(media, settings),
  });
}

export function resetGlobalWallpaper() {
  return apiFetch<void>("/v2/wallpapers/global", { method: "DELETE" });
}

/** Adjusts an already-applied wallpaper's visual settings without re-sending
 * `mediaUrl` — needs `scope` since the same route also serves per-chat
 * wallpapers. */
export function updateGlobalWallpaperSettings(wallpaperId: string, settings: Partial<WallpaperSettings>) {
  return apiFetch<Wallpaper>(`/v2/wallpapers/${wallpaperId}/settings`, {
    method: "PATCH",
    body: { ...settings, scope: "global" },
  });
}

export async function getChatWallpaper(channelId: string) {
  return (await apiFetch<Wallpaper | null>(`/v2/wallpapers/chat/${channelId}`)) ?? null;
}

/** Private/group only — the backend 400s for a channel (per-chat wallpapers
 * don't make sense for a broadcast-style channel the same way they do for a
 * DM or a group). Also posts a real "wallpaper_changed" system message into
 * the chat for other members to independently accept (see
 * `acceptSharedWallpaper`) — unlike the global scope, this one is meant to
 * be seen and opted into by others, not just a private preference. */
export function applyChatWallpaper(channelId: string, media: WallpaperMedia, settings: WallpaperSettings) {
  return apiFetch<{ wallpaper: Wallpaper; messageId: string }>(`/v2/wallpapers/chat/${channelId}`, {
    method: "PATCH",
    body: applyBody(media, settings),
  });
}

export function resetChatWallpaper(channelId: string) {
  return apiFetch<void>(`/v2/wallpapers/chat/${channelId}`, { method: "DELETE" });
}

export function updateChatWallpaperSettings(wallpaperId: string, channelId: string, settings: Partial<WallpaperSettings>) {
  return apiFetch<Wallpaper>(`/v2/wallpapers/${wallpaperId}/settings`, {
    method: "PATCH",
    body: { ...settings, scope: "chat", channelId },
  });
}

/** Points *this* member's own `chatWallpaperId` at someone else's already-
 * shared wallpaper — doesn't touch the wallpaper doc itself, just adopts it,
 * with its own optional blur/dim/brightness override (defaults to the
 * sharer's own values when omitted). */
export function acceptSharedWallpaper(wallpaperId: string, channelId: string) {
  return apiFetch<Wallpaper>(`/v2/wallpapers/${wallpaperId}/accept`, {
    method: "POST",
    body: { channelId },
  });
}

/** Mirrors the backend's own caps (wallpaper-media.service.ts). */
export const WALLPAPER_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const WALLPAPER_MAX_VIDEO_BYTES = 60 * 1024 * 1024;

export interface UploadedWallpaperImage {
  url: string;
  mediaId: string;
}

/** The server cuts the clip to its first 10 s, drops the audio, caps it at
 * 1280px / 24 fps and re-encodes it as a small H.264 loop with a poster. */
export interface UploadedWallpaperVideo {
  url: string;
  duration: number;
  thumbnailUrl: string;
  mediaId: string;
}

/** `loaded`/`total` are the request body's bytes. Once they're equal the file
 * is on the server and (for a video) being transcoded. */
export type UploadProgress = (loaded: number, total: number) => void;

/** Multipart upload with progress. Same auth + refresh-on-401 + error
 * envelope handling as `uploadImage` in media.ts, but over XHR, since fetch
 * can't report upload progress. */
function uploadWallpaper<T>(kind: "image" | "video", file: File, onProgress?: UploadProgress, signal?: AbortSignal, retried = false): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const token = getAccessToken();
    const form = new FormData();
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(`/v2/wallpapers/upload/${kind}`).toString());
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => signal?.removeEventListener("abort", onAbort);
    xhr.onabort = () => {
      done();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    xhr.onerror = () => {
      done();
      reject(new ApiError(0, "Couldn't upload. Check your connection and try again.", null));
    };
    xhr.onload = async () => {
      done();
      let parsed: unknown = null;
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        // non-JSON body — leave parsed as null
      }
      if (xhr.status === 401 && !retried) {
        const refreshed = await refreshSession();
        if (refreshed) {
          uploadWallpaper<T>(kind, file, onProgress, signal, true).then(resolve, reject);
          return;
        }
        clearTokens();
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiError(xhr.status, parseErrorMessage(parsed, xhr.statusText || "Upload failed"), parsed));
        return;
      }
      resolve(parsed as T);
    };
    xhr.send(form);
  });
}

export function uploadWallpaperImage(file: File, onProgress?: UploadProgress, signal?: AbortSignal) {
  return uploadWallpaper<UploadedWallpaperImage>("image", file, onProgress, signal);
}

export function uploadWallpaperVideo(file: File, onProgress?: UploadProgress, signal?: AbortSignal) {
  return uploadWallpaper<UploadedWallpaperVideo>("video", file, onProgress, signal);
}
