"use client";

import { io, type Socket } from "socket.io-client";
import { getAccessToken } from "./api/token-store";
import type { ChatMessage, MessageType } from "./api/types";
import { API_BASE_URL } from "@/lib/api/base";

/** Matches backend's CreateMessageDto (src/message/dto/create-message.dto.ts) exactly —
 *  `duration` doesn't exist there, it's `durationSec`. */
export interface CreateMessageInput {
  channelId: string;
  content: string;
  type?: MessageType;
  attachments?: string[];
  /** The `mediaId` from each attachment's `POST /upload/image` response, in
   *  the same order as `attachments` — lets the backend build a real
   *  blurhash/width/height placeholder (`ChatMessage.attachmentMeta`)
   *  instead of trusting whatever the client claims those are. */
  attachmentMediaIds?: string[];
  /** File / music groups: each attachment's file name, same order. */
  attachmentNames?: string[];
  replyTo?: string;
  durationSec?: number;
  waveform?: number[];
  originalFilename?: string;
  /** Echoed back on the ack and on the `new_message` broadcast, for optimistic-UI reconciliation. */
  tempId?: string;
  forwardFrom?: string;
  /** Set when sending a sticker/animated-emoji pack item (usually with `type: "sticker"`) — the
   *  caller must already have the pack (owner or subscriber), same rule as reacting with one;
   *  the server authorizes it, bumps its usage, and resolves+persists `packId` alongside it. */
  packItemId?: string;
  /** Inline animated emoji for a text message — the server re-resolves and
   *  authorizes each item, so only these three fields are sent. */
  customEmoji?: { offset: number; length: number; packItemId: string }[];
}

type Ack<T> = (res: T) => void;
type SendMessageAck = { success: true; message: ChatMessage } | { error: string };
type JoinLeaveAck = { success: true; channelId: string } | { error: string };

export interface ServerToClientEvents {
  new_message: (payload: { message: ChatMessage; channelId: string; tempId?: string }) => void;
  message_updated: (payload: { channelId: string; message: ChatMessage }) => void;
  /** Carries the chat's recomputed list summary (see lib/chat-list.ts applyMessageDeleted). */
  message_deleted: (payload: { channelId: string; messageId: string; lastMessageAt?: string | null; lastMessagePreview?: string | null }) => void;
  /** Reaction delta (B5) — not a full message, patch `reactions` into the
   *  cached one. Exactly one of `emoji`/`packItemId` is set, matching the
   *  reaction itself; `relativePath`/`packId` are only populated on
   *  `action: "added"` (null on "removed" — a client removing a reaction it
   *  can already render doesn't need to re-resolve its media). */
  reaction_changed: (payload: {
    channelId: string;
    messageId: string;
    emoji: string | null;
    packItemId: string | null;
    relativePath: string | null;
    packId: string | null;
    userId: string;
    action: "added" | "removed";
  }) => void;
  /** Read-receipt delta (B5). Note the colon — not `messages_read`. */
  "read:updated": (payload: { channelId: string; userId: string; lastReadMessageId: string; upToCreatedAt?: string | null }) => void;
  user_typing: (payload: {
    userId: string;
    username: string;
    channelId: string;
    isTyping: boolean;
    uploading: boolean;
  }) => void;
  /** Scoped to the caller's own channel rooms server-side (B3), not a global broadcast. */
  user_status_changed: (payload: { userId: string; status: "online" | "offline"; lastSeen?: string }) => void;
  new_chat: (payload: { chat: unknown }) => void;
  channel_roles_updated: (payload: { channelId: string; admins: string[] }) => void;
  chat_banned: (payload: { channelId: string }) => void;
  /** Someone blocked you (their DM with you refuses your messages), or unblocked you. */
  user_blocked_you: (payload: { blockedBy: string }) => void;
  user_unblocked_you: (payload: { unblockedBy: string }) => void;
  /** The group/channel (or DM) was deleted for everyone. */
  chat_deleted: (payload: { channelId: string }) => void;
  /** Name, description, photo, visibility or @link changed. */
  chat_updated: (payload: {
    channelId: string;
    name: string;
    description: string | null;
    image: string[];
    isPublic: boolean;
    link: string;
    signature?: boolean;
  }) => void;
  /** Default member permissions changed (no `userId`), or one member's exceptions did. */
  chat_permissions_updated: (payload: { channelId: string; userId?: string }) => void;
  user_muted: (payload: { channelId: string; muted: boolean }) => void;
  "call:ringing": (payload: {
    callId: string;
    channelId: string;
    fromUserId: string;
    fromUsername: string;
    isPrivate: boolean;
    /** Epoch ms when the ring gives up (the server then ends it as missed). */
    expiresAt?: number;
  }) => void;
  "call:ended": (payload: { channelId: string; callId: string; kind: "missed" | "declined" | "ended" }) => void;
  "call:missed": (payload: { callId: string; channelId: string }) => void;
  /** A ring was answered/declined on another of this user's tabs or devices. */
  "call:handled": (payload: { callId: string; channelId: string; action: "answered" | "declined" }) => void;
  /** Group voice chat roster changed; `callId: null` once it ended. */
  group_call_updated: (payload: {
    channelId: string;
    callId: string | null;
    startedAt: number | null;
    participants: { _id: string; name: string; photo: string | null }[];
  }) => void;
}

interface ClientToServerEvents {
  join_channel: (payload: { channelId: string }, ack?: Ack<JoinLeaveAck>) => void;
  leave_channel: (payload: { channelId: string }, ack?: Ack<JoinLeaveAck>) => void;
  send_message: (dto: CreateMessageInput, ack?: Ack<SendMessageAck>) => void;
  typing_start: (payload: { channelId: string }) => void;
  typing_stop: (payload: { channelId: string }) => void;
  uploading_start: (payload: { channelId: string }) => void;
  uploading_stop: (payload: { channelId: string }) => void;
  mark_read: (payload: { channelId: string; lastReadMessageId: string }, ack?: Ack<{ success: true } | { error: string }>) => void;
  /** Reconnect resync (B3): "what did each of these channels miss while I
   *  was down." `since[channelId]` is a message `_id` (not a timestamp) —
   *  the last one this client actually saw for that channel; the ack
   *  returns everything strictly newer, per channel, capped at 200. New
   *  messages only — edits/deletes/reactions/pins during the gap aren't
   *  covered by this RPC (confirmed by reading `MessageService.findSinceMessage`),
   *  so a plain refetch elsewhere is still the fallback for those. A given
   *  channel entry in the ack is either the array of missed messages, or
   *  `{error}` if that channel's anchor didn't resolve (not a member
   *  anymore, or the anchor message itself is gone) — one bad channel
   *  doesn't fail the whole call. */
  resync: (
    payload: { since: Record<string, string> },
    ack?: Ack<{ success: true; channels: Record<string, ChatMessage[] | { error: string }> } | { error: string }>,
  ) => void;
}

export type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// Socket.IO reads a path in its URL as a namespace, so it connects to the API's origin (where
// `/socket.io/` is served) unless NEXT_PUBLIC_SOCKET_URL says otherwise.
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? new URL(API_BASE_URL).origin;

let socket: ChatSocket | null = null;

// Who wants to know when the socket instance changes (created after sign-in,
// dropped on sign-out). `useRealtimeEvent` listens so a handler mounted
// before sign-in — e.g. the call provider, which lives above the app shell —
// attaches to the socket that exists later instead of never attaching at all
// (that was why a tab where you'd just signed in never rang for calls).
const socketListeners = new Set<() => void>();
function emitSocketChange() {
  for (const l of socketListeners) l();
}
export function subscribeSocket(listener: () => void): () => void {
  socketListeners.add(listener);
  return () => socketListeners.delete(listener);
}
/** The current socket without creating or connecting one. */
export function peekSocket(): ChatSocket | null {
  return socket;
}

/** Seconds left on a JWT, or -1 when it can't be read. */
function tokenSecondsLeft(token: string): number {
  try {
    const part = token.split(".")[1];
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    return typeof json.exp === "number" ? json.exp - Date.now() / 1000 : -1;
  } catch {
    return -1;
  }
}

/** An access token the server will accept for the handshake: the stored one,
 * refreshed first when it's expired or about to be. An idle tab makes no HTTP
 * requests, so nothing else refreshes it — and a handshake with an expired
 * token is rejected with a server-side disconnect, which socket.io never
 * retries on its own: the tab silently stopped receiving anything, calls
 * included, until reloaded. */
async function handshakeToken(): Promise<string | null> {
  const current = getAccessToken();
  if (current && tokenSecondsLeft(current) > 30) return current;
  const { refreshSession } = await import("./api/client");
  await refreshSession().catch(() => false);
  return getAccessToken() ?? current;
}

/**
 * A connected socket for the current access token, or null if there's no
 * token (not signed in). Namespace is root "/", auth is the handshake
 * `auth.token` option (confirmed via chat.gateway.ts's `extractToken()`,
 * which checks the Authorization header first, then `handshake.auth.token`).
 *
 * The access token is short-lived (15 min) — a socket connected with one
 * doesn't get bumped when it expires mid-session (the gateway only checks
 * at `handleConnection`). Every (re)connect handshake re-reads the token
 * from token-store (see the `auth` callback below), so a reconnect picks up
 * whatever an HTTP-side refresh last stored.
 */
export function getSocket(): ChatSocket | null {
  const token = getAccessToken();
  if (!token) return null;

  if (!socket) {
    const created: ChatSocket = io(SOCKET_URL, {
      // A callback, not a fixed object: socket.io re-runs it on every
      // (re)connect attempt, so its own automatic reconnects (network blip,
      // server restart) present the *current* token — refreshed first if
      // it has expired (see `handshakeToken`).
      auth: (cb) => {
        handshakeToken()
          .then((t) => cb({ token: t ?? token }))
          .catch(() => cb({ token: getAccessToken() ?? token }));
      },
      autoConnect: false,
    });
    socket = created;
    attachRecovery(created);
    emitSocketChange();
  }

  if (!socket.connected && !socket.active) socket.connect();
  return socket;
}

/** The server dropped us ("io server disconnect" — a rejected handshake,
 * usually an expired token): socket.io won't reconnect by itself, so do it,
 * with a fresh token and backoff (a suspended account would otherwise loop).
 * Also reconnect as soon as the tab is visible again or the network is back
 * — a phone that slept with the tab open comes back ringing-capable. */
function attachRecovery(s: ChatSocket) {
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const reconnectSoon = (delay: number) => {
    if (timer || socket !== s) return;
    timer = setTimeout(() => {
      timer = null;
      if (socket === s && !s.connected) s.connect();
    }, delay);
  };
  s.on("connect", () => {
    attempts = 0;
  });
  s.on("disconnect", (reason) => {
    if (reason !== "io server disconnect" || socket !== s) return;
    attempts += 1;
    if (attempts > 6) return;
    reconnectSoon(Math.min(30_000, 1_000 * 2 ** (attempts - 1)));
  });
  if (typeof window !== "undefined") {
    const wake = () => {
      if (socket !== s) {
        window.removeEventListener("online", wake);
        document.removeEventListener("visibilitychange", wake);
        return;
      }
      if (document.visibilityState === "visible" && !s.connected && !s.active) {
        attempts = 0;
        s.connect();
      }
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
  }
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
  emitSocketChange();
}
