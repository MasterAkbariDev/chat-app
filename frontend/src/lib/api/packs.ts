import { apiFetch } from "./client";
import type { PackDetail, PackItemSearchHit, PackSummary, PackType } from "./types";

// Creating/editing/deleting a pack (and uploading/editing/removing its
// items) all go through the pack-manager BOT's action flow (lib/api/bots.ts),
// not a direct packs endpoint — per the brief, pack management is bot-only,
// never a settings-page-style CRUD UI. Everything here is the read/consume
// side: browse, search, subscribe, and record usage.

export function getMyPacks(type?: PackType) {
  return apiFetch<PackSummary[]>("/v1/packs/mine", { query: { type } });
}

/** Discover public packs by name/description/tags — never returns private packs. */
export function searchPacks(q: string, type?: PackType, limit = 20, offset = 0) {
  return apiFetch<PackSummary[]>("/v1/packs/search", { query: { q, type, limit, offset } });
}

/** Scoped server-side to the caller's own collection. Confirmed live: a
 * missing/empty `q` 500s — always pass a real, non-empty query. */
export function searchPackItems(q: string, type?: PackType, limit = 30) {
  return apiFetch<PackItemSearchHit[]>("/v1/packs/search-items", { query: { q, type, limit } });
}

/** Feed the slug segment of a shared link (or a bare pasted code) — works
 * for private packs too. */
export function getPackByLink(slugOrLink: string) {
  const slug = slugOrLink.trim().split("/").filter(Boolean).pop() || slugOrLink.trim();
  return apiFetch<PackDetail>(`/v1/packs/by-slug/${encodeURIComponent(slug)}`);
}

export function getPack(packId: string) {
  return apiFetch<PackDetail>(`/v1/packs/${packId}`);
}

/** Idempotent — calling it twice isn't an error. Works on your own pack too
 * (removes it from your collection without deleting it). */
export function subscribeToPack(packId: string) {
  return apiFetch<unknown>(`/v1/packs/${packId}/subscribe`, { method: "POST" });
}

export function unsubscribeFromPack(packId: string) {
  return apiFetch<unknown>(`/v1/packs/${packId}/subscribe`, { method: "DELETE" });
}

/** The shareable "add this pack" link: `/app/addpack/<slug>` on this site. */
export function packLink(slug: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/app/addpack/${encodeURIComponent(slug)}`;
}

/** Copies the pack's add-link; resolves false when the clipboard refused. */
export async function copyPackLink(slug: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(packLink(slug));
    return true;
  } catch {
    return false;
  }
}

/** New order for some of my packs (e.g. one type's list) — they take over
 * the positions they already had, so the other type's packs keep theirs. */
export function reorderMyPacks(packIds: string[]) {
  return apiFetch<{ ok: true }>("/v1/packs/mine/order", { method: "PUT", body: { packIds } });
}

/** Owner only — takes the pack down for everyone who added it. */
export function deletePack(packId: string) {
  return apiFetch<{ deleted: true }>(`/v1/packs/${packId}`, { method: "DELETE" });
}
