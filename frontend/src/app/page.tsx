"use client";

import { useEffect } from "react";
import { useRouter } from "@/hooks/use-app-router";
import { useAuth } from "@/contexts/auth-context";

// No server-side session check yet — the backend hands back a bearer
// token, not a cookie, so there's nothing to read on the server. This
// waits for the client-side token check (POST /auth/profile) to resolve.
export default function RootPage() {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") router.replace("/app");
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

  return <div className="flex h-dvh items-center justify-center bg-canvas text-sm text-muted">Loading…</div>;
}
