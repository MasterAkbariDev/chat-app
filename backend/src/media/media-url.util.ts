import { Request } from "express";

/**
 * The one `buildUrl` implementation — replaces the 3 identical copies in
 * upload/gif/wallpaper (docs/plans/BACKEND_PLAN.md B2). Still absolute (derived from the
 * request), matching today's wire contract; switching to relative URLs is a coordinated
 * frontend+backend change that lands with the B11 storage migration, not here.
 */
export function buildMediaUrl(req: Request, relativePath: string): string {
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
  const host = req.headers.host ?? "localhost:3000";
  const path = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  return `${proto}://${host}${path}`;
}
