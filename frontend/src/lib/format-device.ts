/**
 * The backend stores the raw `User-Agent` header verbatim as a session's `device`
 * field (see backend/src/auth/auth.controller.ts's `clientInfo`) — there's no UA
 * parsing anywhere server-side. This turns that into a short "Browser on OS" label
 * for display; deliberately not a full UA-parser dependency for a handful of
 * regexes covering the browsers/platforms this app's own users actually show up
 * with. Falls back to a truncated raw string for anything it doesn't recognize,
 * rather than hiding real (if unfamiliar) data.
 */
export function formatDeviceLabel(userAgent: string | undefined | null): string {
  if (!userAgent) return "Unknown device";

  let os: string | null = null;
  if (/iPhone|iPod/.test(userAgent)) os = "iPhone";
  else if (/iPad/.test(userAgent)) os = "iPad";
  else if (/Android/.test(userAgent)) os = "Android";
  else if (/Mac OS X/.test(userAgent)) os = "macOS";
  else if (/Windows/.test(userAgent)) os = "Windows";
  else if (/CrOS/.test(userAgent)) os = "ChromeOS";
  else if (/Linux/.test(userAgent)) os = "Linux";

  let browser: string | null = null;
  if (/EdgA?\//.test(userAgent)) browser = "Edge";
  else if (/OPR\//.test(userAgent)) browser = "Opera";
  else if (/CriOS\//.test(userAgent)) browser = "Chrome";
  else if (/FxiOS\//.test(userAgent)) browser = "Firefox";
  else if (/Chrome\//.test(userAgent)) browser = "Chrome";
  else if (/Firefox\//.test(userAgent)) browser = "Firefox";
  else if (/Version\/.*Safari\//.test(userAgent)) browser = "Safari";
  else if (/Safari\//.test(userAgent)) browser = "Safari";

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;

  // Not a recognizable browser UA at all (a bot, a bare API client, something
  // unusual) — show a short prefix of the real string rather than a generic
  // "Unknown device" that would hide genuinely useful info.
  return userAgent.length > 40 ? `${userAgent.slice(0, 40)}…` : userAgent;
}
