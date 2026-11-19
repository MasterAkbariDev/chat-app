import { AdminRole } from "./schema/admin-user.schema";

/**
 * Moderators see the reported content and its context, not each account's contact details
 * (ADMIN_PANEL_PLAN, PII care). Support and superadmin see full values, since support needs them
 * to help a user. Every read is still audited.
 */
export function shouldRedact(role: string): boolean {
  return role === (AdminRole.MODERATOR as string);
}

/** `bob@example.com` → `b***@example.com`. Keeps the first letter and the domain. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (!email || at <= 0) {
    return email ? "***" : "";
  }
  return `${email[0]}***${email.slice(at)}`;
}

/** `+15550001` → `***01`. Keeps the last two digits. */
export function maskPhone(phone: string): string {
  if (!phone) {
    return "";
  }
  return `***${phone.slice(-2)}`;
}

/** `203.0.113.5` → `203.0.x.x`. IPv6 and anything unusual is hidden entirely. */
export function maskIp(ip: string | null): string | null {
  if (!ip) {
    return null;
  }
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : "hidden";
}
