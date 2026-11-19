import { apiFetch } from "./client";
import type { AuthResponse, Me, Session } from "./types";

export interface LoginInput {
  email?: string;
  phoneNumber?: string;
  password: string;
}

export function login(input: LoginInput) {
  return apiFetch<AuthResponse>("/auth/login", { method: "POST", body: input, anonymous: true });
}

export interface RegisterInput {
  email: string;
  username: string;
  password: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
}

export function register(input: RegisterInput) {
  return apiFetch<AuthResponse>("/auth/register", { method: "POST", body: input, anonymous: true });
}

/** Note: this is a POST on the backend, not a GET (same as the legacy
 * profile endpoint it's named after). */
export function getProfile() {
  return apiFetch<Me>("/v1/auth/me", { method: "GET" });
}

export function getSessions() {
  return apiFetch<Session[]>("/v1/auth/sessions");
}

export function revokeSession(sessionId: string) {
  return apiFetch<void>(`/v1/auth/sessions/${sessionId}`, { method: "DELETE" });
}

/** Revokes every session (bumps tokenVersion server-side) and issues a
 * fresh session for THIS device in the same response — the new refresh
 * cookie replaces the revoked one, and the caller must store the new
 * access token. */
export function logoutAllSessions() {
  return apiFetch<{ access_token: string }>("/auth/logout-all", { method: "POST" });
}

export function changePassword(input: { currentPassword: string; newPassword: string }) {
  return apiFetch<{ access_token: string }>("/auth/change-password", { method: "POST", body: input });
}

/** Re-verifies the current password before deleting. Confirmed by reading
 * `AccountDeletionService.deleteAccount`: leaves every chat/group/channel,
 * removes blocks in both directions, releases owned media, anonymizes the
 * profile (future messages show as "Deleted User"), and — unlike
 * `changePassword` — revokes every session including the calling device's
 * own, so the caller must treat a success here as an immediate logout,
 * not just a token swap. */
export function deleteAccount(password: string) {
  return apiFetch<{ success: true }>("/v1/auth/account", { method: "DELETE", body: { password } });
}

/** Admin-mediated recovery (no automated emailed link) — always returns
 * {ok:true} regardless of whether the identifier matched anyone, to avoid
 * account enumeration. See auth.service.ts's requestRecovery. */
export function requestRecovery(identifier: string) {
  return apiFetch<{ ok: true }>("/auth/recovery-request", { method: "POST", body: { identifier }, anonymous: true });
}

export function validateRecoveryToken(token: string) {
  return apiFetch<{ valid: boolean }>(`/auth/recovery/${token}`, { method: "GET", anonymous: true });
}

/** Single-use — the backend marks the token used immediately after, bumps
 * tokenVersion, and revokes every existing session (auth.service.ts). */
export function resetPasswordWithRecoveryToken(token: string, newPassword: string) {
  return apiFetch<{ ok: true }>(`/auth/recovery/${token}`, { method: "POST", body: { newPassword }, anonymous: true });
}
