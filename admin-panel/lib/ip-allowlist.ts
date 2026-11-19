/**
 * IPv4 allowlist for the panel (ADMIN_PANEL_PLAN D0: internal-only, behind an allowlist / VPN).
 * Entries are exact IPv4 addresses or CIDR blocks, comma-separated.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** `203.0.113.9` → 32-bit unsigned int, or null if it is not a plain IPv4 address. */
export function ipv4ToInt(ip: string): number | null {
  const m = IPV4.exec(ip.trim());
  if (!m) {
    return null;
  }
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) {
    return null;
  }
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

export interface AllowEntry {
  network: number;
  mask: number;
}

/** Parses `1.2.3.4` or `1.2.3.0/24`. Throws on anything else, so a typo fails loudly at startup. */
export function parseEntry(raw: string): AllowEntry {
  const value = raw.trim();
  const [addr, bits] = value.split("/");
  const ip = ipv4ToInt(addr);
  if (ip === null) {
    throw new Error(`ADMIN_IP_ALLOWLIST: "${raw}" is not an IPv4 address or CIDR block`);
  }
  const prefix = bits === undefined ? 32 : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`ADMIN_IP_ALLOWLIST: "${raw}" has an invalid prefix length`);
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (ip & mask) >>> 0, mask };
}

export function parseAllowlist(value: string | undefined): AllowEntry[] {
  if (!value || value.trim() === "") {
    return [];
  }
  return value.split(",").filter((s) => s.trim() !== "").map(parseEntry);
}

export function isAllowed(ip: string | null, entries: AllowEntry[]): boolean {
  if (!ip) {
    return false;
  }
  const n = ipv4ToInt(ip);
  if (n === null) {
    return false;
  }
  return entries.some((e) => ((n & e.mask) >>> 0) === e.network);
}

/**
 * The client's address, read from `X-Forwarded-For` only when the panel sits behind a proxy the
 * operator trusts (ADMIN_TRUST_PROXY=true). Otherwise a client could spoof it, so it is null.
 */
export function clientIp(headers: Headers, trustProxy: boolean): string | null {
  if (!trustProxy) {
    return null;
  }
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || null;
}
