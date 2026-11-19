"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeEvent } from "@/hooks/use-realtime-event";
import { getUserStatus } from "@/lib/api/users";
import type { LastSeenBucket } from "@/lib/api/types";

export interface PresenceEntry {
  isOnline: boolean;
  lastSeen: string | null;
  /** Their last-seen privacy hides the exact time from you: show this
   *  approximation instead (see lib/last-seen.ts). */
  lastSeenBucket?: LastSeenBucket;
}

interface PresenceContextValue {
  presence: Map<string, PresenceEntry>;
  ensureTracked: (userId: string) => void;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

// There's no batch presence endpoint on this backend (confirmed by reading
// every controller — only a single-user GET /users/:userId/status, plus
// GET /v1/contacts which enriches its own list but nothing else). So this
// seeds presence one user at a time, on first ask (`ensureTracked`), and
// keeps it live afterward purely from `user_status_changed` — which the
// gateway sends only to people who share a direct chat or group with the user
// AND whose last-seen privacy allows it (both ways). Everyone else keeps the
// approximate `lastSeenBucket` ("last seen recently") from the first fetch.
export function PresenceProvider({ children }: { children: React.ReactNode }) {
  const [presence, setPresence] = useState<Map<string, PresenceEntry>>(new Map());
  const trackedRef = useRef<Set<string>>(new Set());

  useRealtimeEvent(
    "user_status_changed",
    useCallback((payload) => {
      setPresence((prev) => {
        const next = new Map(prev);
        next.set(payload.userId, {
          isOnline: payload.status === "online",
          lastSeen: payload.lastSeen ?? next.get(payload.userId)?.lastSeen ?? null,
        });
        return next;
      });
    }, []),
  );

  const ensureTracked = useCallback((userId: string) => {
    if (trackedRef.current.has(userId)) return;
    trackedRef.current.add(userId);
    getUserStatus(userId)
      .then((res) => {
        setPresence((prev) => {
          const next = new Map(prev);
          next.set(userId, { isOnline: res.isOnline, lastSeen: res.lastSeen, lastSeenBucket: res.lastSeenBucket });
          return next;
        });
      })
      .catch(() => {
        trackedRef.current.delete(userId);
      });
  }, []);

  const value = useMemo(() => ({ presence, ensureTracked }), [presence, ensureTracked]);

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

/** Presence for one user — triggers a one-time fetch on first render for a
 * given id (if not already known/tracked), then stays live from the socket.
 * Returns `undefined` until the initial fetch resolves or an event arrives. */
export function usePresence(userId: string | null | undefined): PresenceEntry | undefined {
  const ctx = useContext(PresenceContext);
  if (!ctx) throw new Error("usePresence must be used within PresenceProvider");
  useEffect(() => {
    if (userId) ctx.ensureTracked(userId);
  }, [userId, ctx]);
  return userId ? ctx.presence.get(userId) : undefined;
}
