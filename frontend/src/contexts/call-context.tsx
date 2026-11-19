"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRealtimeEvent, useSocketInstance } from "@/hooks/use-realtime-event";
import { ApiError } from "@/lib/api/client";
import {
  createCall,
  declineCall,
  getIncomingCalls,
  groupCallKey,
  joinCall,
  leaveCall,
  type GroupCallInfo,
  type JoinCallResult,
} from "@/lib/api/calls";
import { CHANNELS_QUERY_KEY } from "@/lib/api/chats";
import { channelDisplayName, type ChannelSummary, type ChannelsPage } from "@/lib/api/types";
import { primeRingtone, startRingtone, stopRingtone } from "@/lib/ringtone";
import { closeIncomingCallNotification, showIncomingCallNotification } from "@/lib/call-notification";

export interface IncomingCall {
  callId: string;
  channelId: string;
  fromUserId: string;
  fromUsername: string;
  isPrivate: boolean;
  /** Epoch ms when the ring gives up (server-side ring timeout). */
  expiresAt?: number;
}

export interface ActiveCall extends JoinCallResult {
  channelId: string;
  title: string;
  isPrivate: boolean;
  /** Private calls: the other person's user id (their LiveKit identity) —
   *  lets the call screen show who's being rung before they've joined. */
  peerId: string | null;
  /** The other person's photo (private) or the group's photo, from the
   *  chat list cache; null when there's none or the chat isn't cached. */
  photo: string | null;
}

/** What the chat-list cache knows about a call's chat: its display title, the
 *  other member (private chats) and a photo for the waiting screen. */
export function callPeerInfo(channel: ChannelSummary | undefined, fallbackTitle: string) {
  if (!channel) return { title: fallbackTitle, peerId: null, photo: null };
  const other = channel.otherUser;
  return {
    title: channelDisplayName(channel) || fallbackTitle,
    peerId: other?._id ?? null,
    photo: (other ? other.avatarUrl?.[0] : channel.image?.[0]) || null,
  };
}

/** Fallback ring length when the server didn't say (matches its 45 s). */
const DEFAULT_RING_MS = 45_000;

/** Whether a ring that arrives while `current` is showing should replace it:
 *  never for the same call; yes when the current one has already expired
 *  (a stale ring whose `call:ended` never arrived must not block new calls). */
export function shouldReplaceIncoming(current: IncomingCall | null, next: IncomingCall, now = Date.now()): boolean {
  if (!current) return true;
  if (current.callId === next.callId) return false;
  return (current.expiresAt ?? 0) <= now;
}

interface CallContextValue {
  incomingCall: IncomingCall | null;
  activeCall: ActiveCall | null;
  /** Only true while `createCall`/`joinCall` is in flight — lets a Call
   *  button show a spinner instead of double-firing on a slow network. */
  connecting: boolean;
  error: string | null;
  /** DM: ring the other person. Group/channel: start the voice chat, or join
   *  the one already running (the server decides). */
  startCall: (channelId: string, title: string, isPrivate: boolean) => void;
  acceptIncomingCall: () => void;
  declineIncomingCall: () => void;
  endCall: () => void;
  dismissError: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

/** Global (mounted once in Providers, above AppShell) rather than scoped to
 * a conversation — a ring can arrive while the user is anywhere in the app,
 * same reasoning as NotificationsHost. */
export function CallProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const socket = useSocketInstance();

  // Read through a ref rather than inside a `setActiveCall` updater: an
  // updater must be pure (Strict Mode runs it twice, which fired two
  // `leaveCall` requests), and CallView can call this twice for one hang-up
  // (End call, then LiveKit's own `onDisconnected` as the room unmounts).
  const activeCallRef = useRef(activeCall);
  const connectingRef = useRef(connecting);
  useLayoutEffect(() => {
    activeCallRef.current = activeCall;
    connectingRef.current = connecting;
  });

  useEffect(() => {
    primeRingtone();
  }, []);

  const resolvePeer = useCallback(
    (channelId: string, fallback: string) =>
      callPeerInfo(
        queryClient.getQueryData<ChannelsPage>(CHANNELS_QUERY_KEY)?.items.find((c) => c.channelId === channelId),
        fallback,
      ),
    [queryClient],
  );

  // Ringing side effects (sound, system notification, tab title, give-up
  // timer) follow `incomingCall` — every way a ring ends (answer, decline,
  // call:ended, another device answering, the timeout) just clears it.
  const ringingId = incomingCall?.callId ?? null;
  const ringingRef = useRef(incomingCall);
  useLayoutEffect(() => {
    ringingRef.current = incomingCall;
  });
  useEffect(() => {
    const ring = ringingRef.current;
    if (!ringingId || !ring) return;
    startRingtone();
    void showIncomingCallNotification(ring);
    const left = (ring.expiresAt ?? Date.now() + DEFAULT_RING_MS) - Date.now();
    const timer = setTimeout(() => setIncomingCall((c) => (c?.callId === ringingId ? null : c)), Math.max(0, left) + 2_000);
    return () => {
      clearTimeout(timer);
      stopRingtone();
      void closeIncomingCallNotification(ringingId);
    };
  }, [ringingId]);

  const ring = useCallback((payload: IncomingCall) => {
    if ((payload.expiresAt ?? Infinity) <= Date.now()) return;
    // No call-waiting: while on a call (or setting one up) a new one rings
    // out on its own (the server ends it as missed).
    if (activeCallRef.current || connectingRef.current) return;
    setIncomingCall((current) => (shouldReplaceIncoming(current, payload) ? payload : current));
  }, []);

  const startCall = useCallback(
    (channelId: string, title: string, isPrivate: boolean) => {
      if (activeCall || incomingCall || connecting) return;
      setConnecting(true);
      setError(null);
      createCall(channelId)
        .then((result) => {
          const peer = resolvePeer(channelId, title);
          setActiveCall({ ...result, channelId, title: peer.title || title, isPrivate, peerId: isPrivate ? peer.peerId : null, photo: peer.photo });
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't start the call."))
        .finally(() => setConnecting(false));
    },
    [activeCall, incomingCall, connecting, resolvePeer],
  );

  const acceptCall = useCallback(
    (call: IncomingCall) => {
      const { callId, channelId, fromUsername, isPrivate } = call;
      setIncomingCall(null);
      setConnecting(true);
      setError(null);
      joinCall(callId)
        .then((result) => {
          const peer = resolvePeer(channelId, fromUsername);
          setActiveCall({
            ...result,
            channelId,
            title: peer.title,
            isPrivate,
            peerId: peer.peerId ?? (isPrivate ? call.fromUserId : null),
            photo: peer.photo,
          });
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't join the call."))
        .finally(() => setConnecting(false));
    },
    [resolvePeer],
  );

  const acceptIncomingCall = useCallback(() => {
    if (incomingCall) acceptCall(incomingCall);
  }, [incomingCall, acceptCall]);

  const declineIncomingCall = useCallback(() => {
    if (!incomingCall) return;
    const { callId } = incomingCall;
    setIncomingCall(null);
    declineCall(callId).catch(() => {});
  }, [incomingCall]);

  const endCall = useCallback(() => {
    const current = activeCallRef.current;
    if (!current) return;
    activeCallRef.current = null;
    leaveCall(current.callId).catch(() => {});
    setActiveCall(null);
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  // Opened from an "Incoming call" notification (service worker → URL
  // `?call=<id>&callAction=answer|decline`), or the worker messaging an open
  // tab: look the ring up (it may have been sent before this tab's socket
  // existed) and act on it.
  const handleCallAction = useCallback(
    (callId: string, action: "answer" | "decline" | null) => {
      getIncomingCalls()
        .then(({ calls }) => {
          const call = calls.find((c) => c.callId === callId);
          if (!call) return;
          if (action === "answer") acceptCall(call);
          else if (action === "decline") declineCall(callId).catch(() => {});
          else ring(call);
        })
        .catch(() => {});
    },
    [acceptCall, ring],
  );

  const handledUrl = useRef(false);
  useEffect(() => {
    if (handledUrl.current || !socket || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const callId = params.get("call");
    if (!callId) return;
    handledUrl.current = true;
    const action = params.get("callAction");
    params.delete("call");
    params.delete("callAction");
    const qs = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
    handleCallAction(callId, action === "answer" || action === "decline" ? action : null);
  }, [socket, handleCallAction]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; callId?: string; action?: string } | null;
      if (data?.type !== "call-action" || !data.callId) return;
      handleCallAction(data.callId, data.action === "answer" || data.action === "decline" ? data.action : null);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [handleCallAction]);

  // Handlers read state through refs / functional updates —
  // `useRealtimeEvent` keeps the latest closure in a ref anyway.
  useRealtimeEvent("call:ringing", (payload) => ring(payload));

  const clearRing = (callId: string) => setIncomingCall((c) => (c?.callId === callId ? null : c));

  useRealtimeEvent("call:ended", (payload) => {
    if (activeCallRef.current?.callId === payload.callId) {
      activeCallRef.current = null;
      setActiveCall(null);
    }
    clearRing(payload.callId);
  });

  // Targeted at this user — a safety net for when the chat-room broadcast
  // above doesn't reach this socket.
  useRealtimeEvent("call:missed", (payload) => clearRing(payload.callId));

  // Answered or declined on another tab/device — stop ringing here.
  useRealtimeEvent("call:handled", (payload) => clearRing(payload.callId));

  // Group voice chats: keep the chat's bar (["group-call", id]) and the chat
  // list's indicator (`activeCall` on the summary) live.
  useRealtimeEvent("group_call_updated", (payload) => {
    const info: GroupCallInfo | null = payload.callId
      ? { callId: payload.callId, channelId: payload.channelId, startedAt: payload.startedAt, participants: payload.participants }
      : null;
    queryClient.setQueryData(groupCallKey(payload.channelId), info);
    queryClient.setQueryData<ChannelsPage>(CHANNELS_QUERY_KEY, (prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((c) =>
              c.channelId === payload.channelId
                ? {
                    ...c,
                    activeCall: info ? { callId: info.callId, startedAt: info.startedAt, participantCount: info.participants.length } : undefined,
                  }
                : c,
            ),
          }
        : prev,
    );
  });

  const value = useMemo<CallContextValue>(
    () => ({ incomingCall, activeCall, connecting, error, startCall, acceptIncomingCall, declineIncomingCall, endCall, dismissError }),
    [incomingCall, activeCall, connecting, error, startCall, acceptIncomingCall, declineIncomingCall, endCall, dismissError],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall() {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used within CallProvider");
  return ctx;
}
