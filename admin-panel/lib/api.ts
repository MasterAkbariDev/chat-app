import "server-only";

/** An error the admin API returned, with its HTTP status and the message to show. */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function apiBase(): string {
  const base = process.env.ADMIN_API_BASE;
  if (!base) {
    throw new Error("ADMIN_API_BASE is not set (see .env.example)");
  }
  return base.replace(/\/+$/, "");
}

interface RequestOptions {
  /** Admin JWT. Omit only for the login call itself. */
  token?: string;
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  query?: Record<string, string | undefined>;
}

/**
 * Calls the backend's `/v1/admin/*` API. Runs only on the server, so the token never reaches the
 * browser. Errors come back in the backend's `{ error: { code, message } }` envelope.
 */
export async function adminFetch<T>(
  path: string,
  { token, method = "GET", body, query }: RequestOptions = {},
): Promise<T> {
  const url = new URL(`${apiBase()}/v1/admin/${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string | string[] };
    } | null;
    const message = Array.isArray(payload?.error?.message)
      ? payload.error.message.join(", ")
      : payload?.error?.message;
    throw new AdminApiError(
      res.status,
      payload?.error?.code ?? "error",
      message ?? `Request failed (${res.status})`,
    );
  }

  return (await res.json()) as T;
}
