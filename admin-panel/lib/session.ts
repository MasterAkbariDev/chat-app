import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { adminFetch, AdminApiError } from "./api";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "./constants";
import type { AdminMe } from "./types";

export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

async function readToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/**
 * The signed-in admin, or null. Asks the backend, which checks the token signature, its
 * expiry, and that the admin still exists and is enabled. Memoised per request.
 */
export const currentAdmin = cache(
  async (): Promise<{ admin: AdminMe; token: string } | null> => {
    const token = await readToken();
    if (!token) {
      return null;
    }
    try {
      const admin = await adminFetch<AdminMe>("auth/me", { token });
      return { admin, token };
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 401) {
        return null;
      }
      throw error;
    }
  },
);

/** For every panel page: sends the visitor to /login if there is no valid admin session. */
export async function requireAdmin(): Promise<{ admin: AdminMe; token: string }> {
  const session = await currentAdmin();
  if (!session) {
    redirect("/login");
  }
  return session;
}
