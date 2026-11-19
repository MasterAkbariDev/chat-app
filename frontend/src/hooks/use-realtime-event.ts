"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { getSocket, peekSocket, subscribeSocket, type ServerToClientEvents } from "@/lib/socket";

/** The current socket instance, re-rendering when one is created (sign-in)
 * or dropped (sign-out). */
export function useSocketInstance() {
  return useSyncExternalStore(subscribeSocket, peekSocket, () => null);
}

/** Subscribe to a socket event for the lifetime of the component. Reads the
 * handler from a ref so callers can pass an inline closure without
 * resubscribing on every render. Re-attaches whenever the socket instance
 * changes — a component mounted before sign-in (the call provider sits above
 * the app shell) picks up the socket created by signing in, and a sign-out →
 * sign-in in the same tab moves to the new socket instead of staying bound to
 * the dead one. */
export function useRealtimeEvent<K extends keyof ServerToClientEvents>(event: K, handler: ServerToClientEvents[K]) {
  const handlerRef = useRef(handler);
  const instance = useSocketInstance();

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const socket = instance ?? getSocket();
    if (!socket) return;
    const listener = (...args: unknown[]) => {
      (handlerRef.current as (...a: unknown[]) => void)(...args);
    };
    // socket.io's typed `on`/`off` overloads don't distribute over a
    // generic `K` at this call site (K isn't narrowed to one literal
    // here) — the runtime behavior is exactly what the types describe for
    // any concrete K, so the cast is safe, just not provable generically.
    socket.on(event, listener as never);
    return () => {
      socket.off(event, listener as never);
    };
  }, [event, instance]);
}
