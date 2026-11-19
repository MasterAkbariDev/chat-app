import { clearLegacyTokens, clearTokens, getAccessToken, getLegacyRefreshToken, setAccessToken } from "./token-store";
import type { AuthResponse } from "./types";
import { apiUrl } from "./base";


export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setOnUnauthorized(handler: UnauthorizedHandler | null) {
  onUnauthorized = handler;
}

/** Fired when an *already-authenticated* request comes back 403 "suspended"
 * — a real, verified backend condition (see auth.service.ts/jwt.strategy.ts:
 * an admin can suspend an account mid-session, not just at sign-in, and it's
 * distinguishable from a plain 401 by status + this message). Not fired for
 * `anonymous` calls (i.e. the login request itself) — the login page already
 * handles that case locally with its own, friendlier copy. */
type SuspendedHandler = (message: string) => void;
let onSuspended: SuspendedHandler | null = null;

export function setOnSuspended(handler: SuspendedHandler | null) {
  onSuspended = handler;
}

/** Sent on every /auth/* call: it tells the backend to deliver the refresh token as an HttpOnly
 *  cookie instead of in the response body, and to read it from the cookie. */
export const COOKIE_TRANSPORT_HEADERS = { "X-Auth-Transport": "cookie" } as const;

// Access tokens are short-lived (15 min) with a *rotating* refresh token, now an HttpOnly cookie
// shared by every tab — presenting an already-rotated one revokes the whole session family
// (backend's reuse-detection). Two refreshes racing on the same cookie would kill the session, so
// they're serialised twice over: one in-flight promise per tab (every concurrent 401 awaits the
// *same* call), and a Web Lock across tabs (the next tab sends the cookie the previous one just
// received).
let refreshInFlight: Promise<boolean> | null = null;

async function refreshOnce(): Promise<boolean> {
  // An earlier version kept the refresh token in localStorage: send it once so the backend swaps
  // it for the cookie, then forget it.
  const legacy = getLegacyRefreshToken();
  try {
    const res = await fetch(apiUrl("/auth/refresh"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...COOKIE_TRANSPORT_HEADERS },
      body: JSON.stringify(legacy ? { refresh_token: legacy } : {}),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) clearLegacyTokens();
      return false;
    }
    const data = (await res.json()) as AuthResponse;
    setAccessToken(data.access_token);
    clearLegacyTokens();
    return true;
  } catch {
    return false;
  }
}

/** Exported for the callers outside this module that can't go through apiFetch itself (the
 * multipart uploads, the socket handshake): same single-in-flight refresh-on-401 behavior. */
export async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    return locks ? locks.request("chat:refresh", refreshOnce) : refreshOnce();
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Skip attaching the Authorization header (login/register/refresh). */
  anonymous?: boolean;
  /** Internal — set when retrying after a refresh, to stop at one retry. */
  _retried?: boolean;
}

function buildUrl(path: string, query?: RequestOptions["query"]) {
  const url = apiUrl(path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

// Two different error envelopes are live on this backend, not one: most
// controllers fall through to Nest's default `{message, error, statusCode}`
// (ValidationPipe returns `message` as a string[], one entry per failed
// field — join those); but any controller with
// `@UseFilters(AllExceptionsFilter)` instead returns `{error: {code,
// message}}`. Exported so bots.ts's multipart upload (which can't go
// through apiFetch below) parses errors the same way.
export function parseErrorMessage(parsed: unknown, fallback: string): string {
  if (parsed && typeof parsed === "object") {
    if ("message" in parsed) {
      const raw = (parsed as { message: unknown }).message;
      if (typeof raw === "string") return raw;
      if (Array.isArray(raw)) return raw.join("; ");
    } else if ("error" in parsed && parsed.error && typeof parsed.error === "object" && "message" in parsed.error) {
      const raw = (parsed.error as { message: unknown }).message;
      if (typeof raw === "string") return raw;
    }
  }
  return fallback;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, anonymous, _retried } = options;
  const token = anonymous ? null : getAccessToken();

  // /auth/* may set or read the refresh cookie, so those calls carry credentials.
  const viaCookie = path.startsWith("/auth/");
  const res = await fetch(buildUrl(path, query), {
    method,
    ...(viaCookie ? { credentials: "include" as const } : {}),
    headers: {
      "Content-Type": "application/json",
      ...(viaCookie ? COOKIE_TRANSPORT_HEADERS : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !anonymous && !_retried) {
    const refreshed = await refreshSession();
    if (refreshed) return apiFetch<T>(path, { ...options, _retried: true });
    clearTokens();
    onUnauthorized?.();
  }

  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // non-JSON error body — leave parsed as null
    }
    const message = parseErrorMessage(parsed, res.statusText);
    if (!anonymous && res.status === 403 && /suspend/i.test(message)) {
      onSuspended?.(message);
    }
    throw new ApiError(res.status, message, parsed);
  }

  if (res.status === 204) return undefined as T;
  // Some endpoints return a genuinely empty body on a 200/201 (e.g.
  // POST/DELETE /users/block/:userId — the service method really is
  // Promise<void> end to end, not just a `void`-typed client call over a
  // real DTO) rather than a 204 — `res.json()` throws a SyntaxError on an
  // empty string, so read as text first and only parse when non-empty.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
