"use server";

import { redirect } from "next/navigation";
import { adminFetch, AdminApiError } from "@/lib/api";
import { setSessionCookie } from "@/lib/session";

export interface LoginState {
  error?: string;
  /** Echoed back so the email field keeps its value after a failed try (React resets the form). */
  email?: string;
}

/**
 * Password + TOTP, every time (the backend has no MFA bypass). On success the admin JWT goes into
 * an httpOnly cookie and never reaches the browser's scripts. The redirect sits outside the try
 * block: Next implements it by throwing.
 */
export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const totpCode = String(formData.get("totpCode") ?? "").replace(/\s+/g, "");

  if (!email || !password || !/^\d{6}$/.test(totpCode)) {
    return { error: "Enter your email, password and the 6-digit code.", email };
  }

  let token: string;
  try {
    const res = await adminFetch<{ access_token: string }>("auth/login", {
      method: "POST",
      body: { email, password, totpCode },
    });
    token = res.access_token;
  } catch (error) {
    if (error instanceof AdminApiError) {
      return { error: error.message, email };
    }
    return { error: "Could not reach the admin service. Try again.", email };
  }

  await setSessionCookie(token);
  redirect("/users");
}
