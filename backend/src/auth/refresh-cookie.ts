import { ForbiddenException } from "@nestjs/common";
import type { CookieOptions, Request, Response } from "express";
import { isOriginAllowed, parseCorsAllowlist } from "src/common/cors-allowlist";

/**
 * The web app keeps its refresh token in an HttpOnly cookie, out of reach of page scripts (an XSS
 * bug can no longer carry a long-lived credential off the device). Native clients keep the
 * original contract: tokens in the JSON body, refresh token sent back in the body.
 *
 * A browser opts in with the `X-Auth-Transport: cookie` request header. A custom header can't be
 * set by a cross-site form post, and it forces a CORS preflight, so together with the SameSite
 * attribute and the Origin check below it is the CSRF defence for the cookie-authenticated routes.
 */
export const REFRESH_COOKIE = "chat_refresh";
export const TRANSPORT_HEADER = "x-auth-transport";
const REFRESH_COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export function wantsCookieTransport(req: Request): boolean {
  return req.headers[TRANSPORT_HEADER] === "cookie";
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function cookieOptions(): CookieOptions {
  const sameSite = (process.env.AUTH_COOKIE_SAMESITE ?? "lax").toLowerCase();
  const secure = process.env.AUTH_COOKIE_SECURE
    ? process.env.AUTH_COOKIE_SECURE === "true"
    : process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    // SameSite=None is only accepted by browsers together with Secure.
    secure: secure || sameSite === "none",
    sameSite: sameSite === "none" || sameSite === "strict" ? sameSite : "lax",
    path: process.env.AUTH_COOKIE_PATH ?? "/",
    domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
  };
}

/**
 * The refresh token for this request: the cookie for a browser opted into cookie transport,
 * otherwise the body field. A cookie-borne token is only honoured from an allowed origin.
 */
export function resolveRefreshToken(
  req: Request,
  bodyToken: string | undefined,
): string | undefined {
  if (!wantsCookieTransport(req)) return bodyToken;
  const origin = req.headers.origin;
  if (
    origin &&
    !isOriginAllowed(origin, parseCorsAllowlist(process.env.CORS_ORIGIN))
  ) {
    throw new ForbiddenException("Origin not allowed");
  }
  // A body token alongside the header is the one-time migration of a legacy localStorage token.
  return readCookie(req, REFRESH_COOKIE) ?? bodyToken;
}

/**
 * Hands the session's tokens to the caller. A cookie-transport browser gets the refresh token as
 * a cookie and not in the body; anyone else gets the body unchanged.
 */
export function deliverRefreshToken<T extends { refresh_token?: string }>(
  req: Request,
  res: Response,
  payload: T,
): Omit<T, "refresh_token"> & { refresh_token?: string } {
  if (!wantsCookieTransport(req) || !payload.refresh_token) return payload;
  const { refresh_token, ...rest } = payload;
  res.cookie(REFRESH_COOKIE, refresh_token, {
    ...cookieOptions(),
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
  });
  return rest;
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
}
