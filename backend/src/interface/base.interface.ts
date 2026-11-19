export interface JWTPayload {
  userId: string;
  email: string;
  tokenVersion: number;
  /** The session family this access token came from (see AuthService.revokeFamilyAccess). */
  sid?: string;
}

/**
 * Admin JWTs carry `aud: "admin"` — a claim the regular user `JwtStrategy` never sets and
 * `AdminJwtStrategy` explicitly requires, so a leaked/misdirected user token can never pass as
 * an admin one and vice versa (B4, docs/plans/BACKEND_PLAN.md — "admin JWT audience separate
 * from user JWT"). Same signing secret as user tokens; the claim, not a second secret, is what
 * separates them.
 */
export interface AdminJWTPayload {
  adminId: string;
  email: string;
  role: string;
  aud: "admin";
  /** The admin's tokenVersion when this token was issued. Missing on tokens from before revocation existed (treated as 0). */
  tv?: number;
}

export interface SocketUser {
  userId: string;
  socketId: string;
  status: string;
  lastSeen?: Date;
}
