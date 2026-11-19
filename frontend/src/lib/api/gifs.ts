import { ApiError, apiFetch, parseErrorMessage, refreshSession } from "./client";
import { clearTokens, getAccessToken } from "./token-store";
import { apiUrl } from "./base";

/** One GIF in your personal library (backend `clips` module). `relativePath`
 * is media-relative — resolve it with resolveMediaUrl() from lib/media-url.ts. */
export interface SavedGif {
  id: string;
  mediaId: string;
  title: string;
  relativePath: string;
  lastUsedAt: string | null;
  usageCount: number;
}

/** A Giphy search/trending hit. `previewUrl` is Giphy-hosted (small, for the
 * grid only); sending goes through `mirrorGiphyGif`, which mirrors it into our
 * own storage on first use. */
export interface GiphyHit {
  id: string;
  title: string;
  originalUrl: string;
  previewUrl: string;
  cachedRelativePath: string | null;
}

export const SAVED_GIFS_KEY = ["gifs", "saved"] as const;

/** Most recently used first. */
export function getSavedGifs(limit = 100, offset = 0) {
  return apiFetch<SavedGif[]>("/v1/clips", { query: { limit, offset } });
}

/** Saves the GIF of a message you can see — re-uses the stored media. */
export function saveGifFromMessage(messageId: string) {
  return apiFetch<SavedGif>(`/v1/clips/from-message/${encodeURIComponent(messageId)}`, { method: "POST" });
}

export function removeSavedGif(id: string) {
  return apiFetch<{ removed: true }>(`/v1/clips/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Bumps it to the front of the library. Fire-and-forget. */
export function markSavedGifUsed(id: string) {
  return apiFetch<{ ok: true }>(`/v1/clips/${encodeURIComponent(id)}/use`, { method: "POST" });
}

/** Adds a GIF (stored as-is) or a short video (converted to a looping GIF,
 * max 10 s) from the device. Multipart, so it can't go through apiFetch —
 * same auth/refresh handling as lib/api/media.ts's uploadImage. */
export async function uploadSavedGif(file: File, _retried = false): Promise<SavedGif> {
  const token = getAccessToken();
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(apiUrl("/v1/clips"), {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (res.status === 401 && !_retried) {
    const refreshed = await refreshSession();
    if (refreshed) return uploadSavedGif(file, true);
    clearTokens();
  }
  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, parseErrorMessage(parsed, res.statusText), parsed);
  }
  return res.json();
}

export function searchGiphy(q: string, limit = 24, offset = 0) {
  return apiFetch<GiphyHit[]>("/gifs/giphy/search", { query: { q, limit, offset } });
}

/** Also the "is Giphy configured?" probe: the server answers 503 without a key. */
export function trendingGiphy(limit = 24, offset = 0) {
  return apiFetch<GiphyHit[]>("/gifs/giphy/trending", { query: { limit, offset } });
}

/** Mirrors the GIF into our storage on first use; returns a sendable URL. */
export function mirrorGiphyGif(giphyId: string) {
  return apiFetch<{ url: string; title: string }>(`/gifs/giphy/${encodeURIComponent(giphyId)}/use`, { method: "POST" });
}
