import { ApiError, apiFetch, parseErrorMessage, refreshSession } from "./client";
import { clearTokens, getAccessToken } from "./token-store";
import type { BotDirectoryEntry, BotMenuScreen } from "./types";
import { apiUrl } from "./base";


export function getBots() {
  return apiFetch<BotDirectoryEntry[]>("/v1/bots");
}

export function getBotMessages(key: string) {
  return apiFetch<string[]>(`/v1/bots/${key}/messages`);
}

/** Omit `screen` for the bot's home screen. Extra `params` become the
 * screen's context (e.g. `{type: "sticker"}` for "My Sticker Packs") — a
 * plain GET, no server mutation. */
export function getBotMenu(key: string, screen?: string, params?: Record<string, unknown>) {
  const query: Record<string, string> = {};
  if (screen) query.screen = screen;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) query[k] = String(v);
    }
  }
  return apiFetch<BotMenuScreen>(`/v1/bots/${key}/menu`, { query });
}

/** For actions with no file field — `type: "invoke"`, or `type: "form"`
 * with no `kind: "file"` field. */
export function invokeBotAction(key: string, actionId: string, screenId: string, params?: Record<string, unknown>) {
  return apiFetch<{ screen: BotMenuScreen }>(`/v1/bots/${key}/action`, {
    method: "POST",
    body: { actionId, screenId, params: params ?? {} },
  });
}

/** Multipart variant for a form action with a `kind: "file"` field —
 * apiFetch is JSON-only, so this builds the FormData request directly,
 * replaying the same auth + refresh-on-401 + dual-error-envelope handling
 * apiFetch does (see client.ts) since it can't call through to it. */
export async function invokeBotActionUpload(
  key: string,
  actionId: string,
  screenId: string,
  params: Record<string, unknown> | undefined,
  files: File[],
  _retried = false,
): Promise<{ screen: BotMenuScreen }> {
  const token = getAccessToken();
  const form = new FormData();
  form.append("actionId", actionId);
  form.append("screenId", screenId);
  form.append("params", JSON.stringify(params ?? {}));
  // The backend's FilesInterceptor reads the field named exactly "files" —
  // "files[]" was rejected with 400 "Unexpected field", so adding items
  // through the Pack Manager bot never worked.
  for (const file of files) form.append("files", file);

  const res = await fetch(apiUrl(`/v1/bots/${key}/action/upload`), {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });

  if (res.status === 401 && !_retried) {
    const refreshed = await refreshSession();
    if (refreshed) return invokeBotActionUpload(key, actionId, screenId, params, files, true);
    clearTokens();
  }

  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // non-JSON error body — leave parsed as null
    }
    throw new ApiError(res.status, parseErrorMessage(parsed, res.statusText), parsed);
  }

  return res.json();
}
