/**
 * Single source of truth for the CORS allowlist, shared by the HTTP server,
 * the Socket.IO gateway, and the static /uploads handler so they never drift.
 */
export function parseCorsAllowlist(raw: string | undefined): string[] {
  const origins = (raw ?? "")
    .split(",")
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0);

  if (origins.length === 0) {
    throw new Error(
      "CORS_ORIGIN must be set to a comma-separated list of allowed origins " +
        "(no wildcard fallback — set it explicitly, even for local dev).",
    );
  }

  return origins;
}

export function isOriginAllowed(
  origin: string | undefined,
  allowlist: string[],
): boolean {
  return !!origin && allowlist.includes(origin);
}
