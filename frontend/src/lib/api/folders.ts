import { apiFetch } from "./client";
import type { ChatFolder, ChatFolderFilters } from "./types";

/** Shared TanStack Query key — folders are cheap and rarely change, one
 * cache entry is enough for both the chat-list tabs and the editor page. */
export const FOLDERS_QUERY_KEY = ["folders"] as const;

/** Ordered ascending by `order` — render as tabs in this order directly. */
export function getFolders() {
  return apiFetch<ChatFolder[]>("/v1/folders");
}

/** Appended last (`order` = current folder count) — omitted `filters` keys
 * default to empty/false server-side, not required here. */
export function createFolder(name: string, filters?: Partial<ChatFolderFilters>) {
  return apiFetch<ChatFolder>("/v1/folders", { method: "POST", body: { name, filters } });
}

/** `filters` merges shallowly into the existing object server-side (only
 * the keys you send are replaced) — safe to send just `{onlyUnread: true}`
 * without clobbering `includeTypes` etc. */
export function updateFolder(folderId: string, patch: { name?: string; order?: number; filters?: Partial<ChatFolderFilters> }) {
  return apiFetch<ChatFolder>(`/v1/folders/${folderId}`, { method: "PATCH", body: patch });
}

/** Always resolves `{success: true}`, even for an id that doesn't exist or
 * isn't yours — the server doesn't 404 on a no-op delete. */
export function deleteFolder(folderId: string) {
  return apiFetch<{ success: boolean }>(`/v1/folders/${folderId}`, { method: "DELETE" });
}
