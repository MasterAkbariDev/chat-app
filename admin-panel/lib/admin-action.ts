import "server-only";
import { redirect } from "next/navigation";
import { adminFetch, AdminApiError } from "./api";
import { requireAdmin } from "./session";

/**
 * Runs one admin write from a form and sends the admin back to `back` with a flash message.
 * The message goes in the query string; it never carries a secret (the one-time recovery link
 * is shown by its own client component, not through here).
 */
export async function runAdminAction(options: {
  back: string;
  method?: "POST" | "PATCH";
  /** Relative to /v1/admin/, e.g. `users/<id>/suspend`. */
  path: string;
  body?: unknown;
  okMessage: string;
}): Promise<never> {
  const { token } = await requireAdmin();
  let flash: URLSearchParams;
  try {
    await adminFetch(options.path, {
      token,
      method: options.method ?? "POST",
      body: options.body,
    });
    flash = new URLSearchParams({ ok: options.okMessage });
  } catch (error) {
    const message =
      error instanceof AdminApiError ? error.message : "Something went wrong. Try again.";
    flash = new URLSearchParams({ error: message });
  }
  // Outside the try: redirect() works by throwing.
  redirect(`${options.back}?${flash.toString()}`);
}

/** Optional text from a form field, trimmed; empty becomes undefined. */
export function field(formData: FormData, name: string): string | undefined {
  const v = String(formData.get(name) ?? "").trim();
  return v === "" ? undefined : v;
}
