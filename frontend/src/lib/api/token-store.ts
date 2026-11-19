"use client";

// The backend issues a short-lived (15 min) access token plus a rotating refresh token.
//
// - The refresh token lives in an HttpOnly cookie that the browser attaches by itself (see
//   backend/src/auth/refresh-cookie.ts). Page scripts can't read it, so an XSS bug can't carry it
//   off the device — this module never sees it.
// - The access token is kept in memory only. A reload loses it and the first refresh gets a new
//   one (see client.ts's `refreshSession`).
// - `chat:session` in localStorage is a non-secret hint that "this browser has a session", so a
//   signed-out visitor doesn't make a pointless refresh request on every page load.
//
// The two `chat:*-token` keys below are where earlier versions kept both tokens. They're read once
// to move an already-signed-in user onto the cookie, then deleted.

const SESSION_HINT_KEY = "chat:session";
const LEGACY_ACCESS_KEY = "chat:access-token";
const LEGACY_REFRESH_KEY = "chat:refresh-token";

let memoryAccess: string | null = null;

function readStorage(key: string): string | null | undefined {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return undefined; // storage blocked
  }
}

export function getAccessToken(): string | null {
  return memoryAccess;
}

export function setAccessToken(access: string) {
  memoryAccess = access;
  try {
    window.localStorage.setItem(SESSION_HINT_KEY, "1");
  } catch {
    // storage unavailable — the hint is optional
  }
}

/** Whether a refresh is worth trying on load. Errs towards yes when storage can't say. */
export function hasSessionHint(): boolean {
  const hint = readStorage(SESSION_HINT_KEY);
  if (hint === undefined) return true;
  return hint === "1" || !!readStorage(LEGACY_REFRESH_KEY);
}

/** A refresh token left in localStorage by an earlier version, to be swapped for the cookie. */
export function getLegacyRefreshToken(): string | null {
  return readStorage(LEGACY_REFRESH_KEY) ?? null;
}

export function clearLegacyTokens() {
  try {
    window.localStorage.removeItem(LEGACY_ACCESS_KEY);
    window.localStorage.removeItem(LEGACY_REFRESH_KEY);
  } catch {
    // storage unavailable
  }
}

export function clearTokens() {
  memoryAccess = null;
  clearLegacyTokens();
  try {
    window.localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // storage unavailable
  }
}
