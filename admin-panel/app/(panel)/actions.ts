"use server";

import { redirect } from "next/navigation";
import { adminFetch } from "@/lib/api";
import { clearSessionCookie, requireAdmin } from "@/lib/session";

/** Drops this browser's session cookie. The token stays valid until it expires or is revoked. */
export async function logoutAction() {
  await clearSessionCookie();
  redirect("/login");
}

/** Revokes every admin token, this one included, then drops the cookie. */
export async function logoutEverywhereAction() {
  const { token } = await requireAdmin();
  await adminFetch("auth/logout-all", { token, method: "POST" });
  await clearSessionCookie();
  redirect("/login");
}
