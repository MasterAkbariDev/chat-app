"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "@/hooks/use-app-router";
import { useQueryClient } from "@tanstack/react-query";
import * as authApi from "@/lib/api/auth";
import { setOnSuspended, setOnUnauthorized } from "@/lib/api/client";
import { COOKIE_TRANSPORT_HEADERS, refreshSession } from "@/lib/api/client";
import { clearTokens, getAccessToken, getLegacyRefreshToken, hasSessionHint, setAccessToken } from "@/lib/api/token-store";
import { apiUrl } from "@/lib/api/base";
import { disconnectSocket, getSocket } from "@/lib/socket";
import { disablePushNotifications } from "@/lib/push";
import type { Me } from "@/lib/api/types";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: Me | null;
  /** Set when an already-authenticated request comes back 403 "suspended"
   *  (an admin can suspend an account mid-session, not just at sign-in —
   *  see client.ts's `setOnSuspended`). AppShell renders a blocking screen
   *  instead of the app while this is set. */
  suspended: boolean;
  login: (input: authApi.LoginInput) => Promise<void>;
  register: (input: authApi.RegisterInput) => Promise<void>;
  logout: () => void;
  /** Patches the cached profile after a settings change the server doesn't
   *  echo back a full `Me` for (e.g. PATCH /users/notifications only
   *  returns `{success}`) — avoids a full GET /auth/me round trip just to
   *  reflect a one-field change the caller already knows succeeded. */
  updateUser: (patch: Partial<Me>) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // "loading" only when there's actually something async to verify (a
  // session to restore through the refresh cookie, then GET /v1/auth/me) — computed synchronously
  // here rather than set from inside the effect below, same reasoning as
  // ThemeProvider's initializer (see its comment for why an effect alone
  // races the "persist" effect).
  const [status, setStatus] = useState<AuthStatus>(() => (getAccessToken() || hasSessionHint() ? "loading" : "unauthenticated"));
  const [user, setUser] = useState<Me | null>(null);
  const [suspended, setSuspended] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();

  const logout = useCallback(() => {
    // Best-effort, not awaited — logout shouldn't wait on it, and a failure
    // here (offline, token already gone) shouldn't block signing out.
    disablePushNotifications().catch(() => {});
    // Ends this device's session on the server, so it leaves the signed-in devices list. Best effort.
    // The backend reads the refresh cookie and clears it in the response.
    const legacyToken = getLegacyRefreshToken();
    void fetch(apiUrl("/auth/logout"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...COOKIE_TRANSPORT_HEADERS },
      body: JSON.stringify(legacyToken ? { refresh_token: legacyToken } : {}),
      keepalive: true,
    }).catch(() => {});
    clearTokens();
    disconnectSocket();
    // Drop every cached query (chat list, messages, sessions, folders,
    // blocked list…) — a client-side navigation keeps the QueryClient alive,
    // so without this the next account to sign in on this tab is briefly
    // served the previous account's data (anything still inside staleTime
    // isn't even refetched).
    queryClient.clear();
    setUser(null);
    setSuspended(false);
    setStatus("unauthenticated");
    router.push("/login");
  }, [router, queryClient]);

  // Restore the session on first load. The access token lives in memory, so a fresh page has none:
  // the refresh cookie (sent automatically) buys a new one, then GET /v1/auth/me loads the
  // profile. A truly dead session ends up here as a rejection.
  useEffect(() => {
    setOnUnauthorized(() => logout());
    setOnSuspended(() => setSuspended(true));
    let cancelled = false;
    const restore = async () => {
      // No session hint: nobody signed in here, so don't ask for a refresh (it would only 401).
      if (!getAccessToken() && (!hasSessionHint() || !(await refreshSession()))) {
        clearTokens();
        if (!cancelled) setStatus("unauthenticated");
        return;
      }
      try {
        const profile = await authApi.getProfile();
        if (cancelled) return;
        setUser(profile);
        setStatus("authenticated");
        getSocket();
      } catch {
        clearTokens();
        if (!cancelled) setStatus("unauthenticated");
      }
    };
    void restore();
    return () => {
      cancelled = true;
      setOnUnauthorized(null);
      setOnSuspended(null);
    };
  }, [logout]);

  const login = useCallback(async (input: authApi.LoginInput) => {
    const res = await authApi.login(input);
    setAccessToken(res.access_token);
    setUser(res.user);
    setStatus("authenticated");
    getSocket();
  }, []);

  const register = useCallback(async (input: authApi.RegisterInput) => {
    const res = await authApi.register(input);
    setAccessToken(res.access_token);
    setUser(res.user);
    setStatus("authenticated");
    getSocket();
  }, []);

  const updateUser = useCallback((patch: Partial<Me>) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const value = useMemo(
    () => ({ status, user, suspended, login, register, logout, updateUser }),
    [status, user, suspended, login, register, logout, updateUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
