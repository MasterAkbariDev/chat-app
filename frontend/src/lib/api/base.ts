/** The backend's address. It may include a path when a reverse proxy mounts the API under one
 *  (e.g. `https://example.com/api/chat`), so URLs are built by appending to it, never with
 *  `new URL(path, base)`, which would drop that path. */
export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001").replace(/\/+$/, "");

/** `apiUrl("/v1/x?y=1")` → `${API_BASE_URL}/v1/x?y=1` */
export function apiUrl(path: string): URL {
  return new URL(API_BASE_URL + (path.startsWith("/") ? path : `/${path}`));
}
