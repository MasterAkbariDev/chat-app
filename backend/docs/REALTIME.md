# Realtime contract (Socket.IO)

> Source of truth: `src/gateway/chat.gateway.ts` (single file, ~1067 lines). This document is a
> hand-maintained mirror of that file for B1 ("API & realtime contract"). If you change an event
> name, payload, room, or ack shape in the gateway, update this file in the same commit.

There is **one** Socket.IO gateway, mounted on the default namespace `/` (no sub-namespaces —
`@WebSocketGateway({ namespace: "/", cors: { origin: parseCorsAllowlist(process.env.CORS_ORIGIN),
credentials: true } })`, `chat.gateway.ts:34-42`).

## Connection / authentication

`handleConnection` (`chat.gateway.ts:184-260`) runs for every new socket:

1. `extractToken(client)` (`chat.gateway.ts:1035-1041`) reads the JWT from, in order:
   - the `Authorization: Bearer <jwt>` HTTP header sent with the handshake, or
   - `handshake.auth.token` (the Socket.IO client's `auth` option), if no `Bearer` header is
     present.
2. The token is verified with `jwtService.verify(token, { secret: JWT_SECRET })`.
3. The referenced user is loaded (`username email tokenVersion isDeleted`); a missing or
   soft-deleted user disconnects the socket.
4. `authService.assertTokenVersion(dbUser, payload)` is checked (rejects tokens issued before a
   password change / forced logout); failure disconnects the socket.
5. On success: the socket is tagged with `client.userId` / `client.userEmail` / `client.username`,
   registered in the in-memory `userSockets` / `socketUsers` maps, marked `UserStatus.ONLINE`,
   `User.isOnline` is set `true` in Mongo, the socket joins room `user:<userId>`, and it auto-joins
   `channel:<channelId>` for every `ChatMembers` row the user belongs to.
6. `user_status_changed` is broadcast (see below).

**Any socket that fails steps 1-4 is disconnected immediately** (`client.disconnect()`, no error
event emitted back) — there is no unauthenticated access to any event below.

`handleDisconnect` (`chat.gateway.ts:262-339`) cleans up: removes the socket from any active call
(emitting `call_ended` / `call_participants` / `call_participant_left` as appropriate — see the
call events below), and once a user's last socket disconnects, marks them `OFFLINE`, persists
`lastSeen` / `isOnline: false`, and broadcasts `user_status_changed`.

Rooms used throughout the gateway:
- `user:<userId>` — every socket belonging to one user (used for direct/targeted emits).
- `channel:<channelId>` — every socket subscribed to a chat/group/channel.
- `call:<callId>` — every socket currently participating in a voice call.

---

## Client → Server events

19 handlers, all registered with `@SubscribeMessage(...)` directly on `ChatGateway`. Unless noted,
a handler with no explicit auth check still requires `client.userId` (set at connection time) —
every handler returns `{ error: "Unauthorized" }` (or, for a few void-return handlers, simply
returns nothing) when `client.userId` is missing, i.e. the socket never authenticated.

### `join_channel`
- **Payload:** `{ channelId: string }`
- **Handler:** `handleJoinChannel`, `chat.gateway.ts:341-367`
- **Access check:** requires a `ChatMembers` row for `(channelId, userId)`.
- **Effect:** joins room `channel:<channelId>`. If a group/channel call is already active for that
  channel, emits `call_created` back to just this socket (so a late joiner sees the "call in
  progress" banner).
- **Ack:** `{ success: true, channelId }` or `{ error: "Unauthorized" | "Access denied" }`.
- **Rate limit:** none.

### `leave_channel`
- **Payload:** `{ channelId: string }`
- **Handler:** `handleLeaveChannel`, `chat.gateway.ts:369-377`
- **Effect:** leaves room `channel:<channelId>`. No membership check.
- **Ack:** `{ success: true, channelId }` or `{ error: "Unauthorized" }`.
- **Rate limit:** none.

### `send_message`
- **Payload:** `CreateMessageDto` (`src/message/dto/create-message.dto.ts`):
  ```ts
  {
    channelId: string;
    content: string;          // required unless attachments present, max 4000 chars
    type?: MessageType;       // text|image|file|system|gif|sticker|voice|video|voice_call
    attachments?: string[];
    replyTo?: string;
    duration?: number;        // voice message duration (seconds)
    tempId?: string;          // client-generated id, echoed back for optimistic-UI reconciliation
    forwardFrom?: string;     // source message id when forwarding
  }
  ```
- **Handler:** `handleSendMessage`, `chat.gateway.ts:379-432`
- **Rate limit:** **yes** — a per-socket in-memory token bucket added in B0
  (`SEND_MESSAGE_LIMIT = 20` messages per `SEND_MESSAGE_WINDOW_MS = 10_000`ms,
  `chat.gateway.ts:59-78`). Exceeding it returns `{ error: "rate_limited" }` without persisting
  anything. The bucket is keyed by `socket.id` and is cleared on disconnect — it does not persist
  across reconnects or across a user's multiple sockets.
- **Effect:** persists the message via `MessageService.create(dto, userId)`, joins the sender's
  socket to `channel:<channelId>` (defensive, in case it wasn't already joined), then:
  - if the chat is **not** `ChatType.PRIVATE` (group/channel), broadcasts to the whole
    `channel:<channelId>` room via `new_message`;
  - if the chat **is** `ChatType.PRIVATE`, iterates every socket currently in that room and emits
    `new_message` individually to the sender's own socket and to any other socket whose user is
    **not** blocked by the sender (`userService.isBlocked`) — i.e. a blocked recipient's socket is
    silently skipped even though it's in the room.
- **Ack:** `{ success: true, message: Message }` or `{ error: string }` (validation errors from
  `MessageService.create`, or `"rate_limited"`, or `"Unauthorized"`).

### `typing_start`
- **Payload:** `{ channelId: string }`
- **Handler:** `handleTypingStart`, `chat.gateway.ts:434-473`
- **Access check:** requires `ChatMembers` membership.
- **Effect:** records a 5-second server-side timeout per `(channelId, userId)`; if the timeout
  fires without a follow-up `typing_stop`, the server auto-emits `user_typing` with
  `isTyping: false`. Emits `user_typing` (`isTyping: true`) immediately to the rest of
  `channel:<channelId>` (`client.to(...)`, sender excluded).
- **Ack:** `{ success: true }` or `{ error: "Unauthorized" | "Access denied" }`.

### `uploading_start`
- **Payload:** `{ channelId: string }`
- **Handler:** `handleUploadingStart`, `chat.gateway.ts:475-500`
- **Access check:** requires `ChatMembers` membership.
- **Effect:** adds the user to an in-memory "currently uploading" set for the channel; emits
  `user_typing` with `{ isTyping: false, uploading: true }` to the rest of the channel room.
- **Ack:** `{ success: true }` or `{ error: "Unauthorized" | "Access denied" }`.

### `uploading_stop`
- **Payload:** `{ channelId: string }`
- **Handler:** `handleUploadingStop`, `chat.gateway.ts:502-522`
- **Effect:** removes the user from the "uploading" set; emits `user_typing` with
  `{ isTyping: false, uploading: false }` to the rest of the channel room. No membership check
  (unlike `uploading_start`).
- **Ack:** `{ success: true }` or `{ error: "Unauthorized" }`.

### `typing_stop`
- **Payload:** `{ channelId: string }`
- **Handler:** `handleTypingStop`, `chat.gateway.ts:524-543`
- **Effect:** clears the pending typing timeout; emits `user_typing` with
  `{ isTyping: false, uploading: false }` to the rest of the channel room. No membership check.
- **Ack:** `{ success: true }` or `{ error: "Unauthorized" }`.

### `mark_read`
- **Payload:** `{ channelId: string; lastReadMessageId: string }`
- **Handler:** `handleMarkRead`, `chat.gateway.ts:545-569`
- **Effect:** `MessageService.markAsRead(channelId, userId, lastReadMessageId)`, then emits
  `messages_read` to the **entire** `channel:<channelId>` room (including the caller) so senders
  can update read-receipt ticks.
- **Ack:** `{ success: true }` or `{ error: string }`.

### `update_status`
- **Payload:** `{ status: UserStatus }` (`online | offline | typing | away`)
- **Handler:** `handleUpdateStatus`, `chat.gateway.ts:571-583`
- **Effect:** updates the in-memory `userStatuses` map and broadcasts `user_status_changed` — via
  `this.server.emit(...)`, i.e. **to every connected socket in the namespace, not just the user's
  contacts/channels** (see Known gaps).
- **Ack:** `{ success: true, status }` or `{ error: "Unauthorized" }`.

### `call_request` (private 1:1 — ring the callee)
- **Payload:** `{ channelId: string; otherUserId: string }`
- **Handler:** `handleCallRequest`, `chat.gateway.ts:592-628`
- **Checks:** caller must be a member of `channelId`; the chat must be `ChatType.PRIVATE`; no call
  already in progress for that channel (`privateCallByChannel`).
- **Effect:** creates a call id, registers it in the in-memory `activeCalls` map, emits
  `call_incoming` to `user:<otherUserId>`.
- **Ack:** `{ success: true, callId }` or `{ error: "Unauthorized" | "Access denied" | "Private chat only" | "Call already in progress" }`.

### `call_accept`
- **Payload:** `{ callId: string; channelId: string }`
- **Handler:** `handleCallAccept`, `chat.gateway.ts:631-677`
- **Checks:** call must exist and `call.channelId === data.channelId`.
- **Effect:** registers the callee as a participant and joins `call:<callId>`; also looks up the
  initiator's live socket (by the id captured at `call_request` time) and joins it to the same
  call room. Emits `call_participants` to `call:<callId>`, and `call_accepted` directly to the
  initiator (`emitToUser`). Marks `call.startedAt` (private calls only, used later for duration
  logging).
- **Ack:** `{ success: true }` or `{ error: "Unauthorized" | "Call not found" }`.

### `call_decline`
- **Payload:** `{ callId: string; channelId: string }`
- **Handler:** `handleCallDecline`, `chat.gateway.ts:680-713`
- **Effect:** writes a `MessageType.VOICE_CALL` log message (`{ callLog: true, kind: "declined" }`)
  and broadcasts it via `new_message` to `channel:<channelId>`; emits `call_declined` to the
  initiator; ends the call (removes it from `activeCalls`/`privateCallByChannel`).
- **Ack:** `{ success: true }` (even if the call was already gone) or `{ error: "Unauthorized" }`.

### `call_create` (group/channel call)
- **Payload:** `{ channelId: string }`
- **Handler:** `handleCallCreate`, `chat.gateway.ts:716-777`
- **Checks:** caller must be a channel member; chat must **not** be `ChatType.PRIVATE`; only one
  active group call per channel at a time.
- **Effect:** writes a `MessageType.VOICE_CALL` message (`{ callId }`) as the "call started" chat
  entry, registers the call, then emits `call_created` to the **entire** `channel:<channelId>`
  room (everyone in the channel, not only current participants).
- **Ack:** `{ success: true, callId, messageId }` or `{ error: "Unauthorized" | "Access denied" | "Group/channel only" | "Call already in progress" }`.

### `call_join`
- **Payload:** `{ callId: string }`
- **Handler:** `handleCallJoin`, `chat.gateway.ts:780-814`
- **Checks:** call must exist; caller must be a member of `call.channelId`.
- **Effect:** registers the caller as a participant, joins `call:<callId>`, emits
  `call_participants` to the whole call room (including the joiner).
- **Ack:** `{ success: true, participants }` or `{ error: "Unauthorized" | "Call ended" | "Access denied" }`.

### `call_leave`
- **Payload:** `{ callId: string }`
- **Handler:** `handleCallLeave`, `chat.gateway.ts:817-884`
- **Effect:** removes the caller from `call.participants`, leaves `call:<callId>`, emits updated
  `call_participants` to the remaining call room. Then:
  - private call, other participant(s) still present → emits `call_ended` to each remaining
    participant directly (`emitToUser`) and ends the call (private calls don't "continue" with one
    side gone);
  - no participants left at all → if it was a private call with `startedAt` set, writes a
    `MessageType.VOICE_CALL` "ended" log message (with computed `durationMinutes`) broadcast via
    `new_message` to the channel, then emits `call_ended` to `channel:<channelId>` and ends the
    call;
  - group call with participants still remaining → emits `call_still_active` back to the leaving
    socket only (so its UI can show "still going" instead of assuming the call ended).
- **Ack:** `{ success: true }`, or nothing if `client.userId` is missing (this handler returns
  `undefined` rather than an error object in that case — an inconsistency vs. other handlers).

### `call_signal` (WebRTC offer/answer/ICE relay)
- **Payload:** `{ callId: string; targetUserId: string; type: string; payload: unknown }` — `type`
  and `payload` are opaque to the gateway (WebRTC SDP/ICE data defined by the client's peer
  connection implementation, not validated server-side).
- **Handler:** `handleCallSignal`, `chat.gateway.ts:887-915`
- **Checks:** call must exist; `targetUserId` must currently be a participant of that call.
- **Effect:** relays to **every** socket of the target user via room `user:<targetUserId>` (not
  `call:<callId>`) — chosen so a stale/reconnected socket doesn't miss signaling.
- **Ack:** `{ success: true }` if relayed; otherwise no return value (silent no-op) if the call or
  target isn't found — the sender gets no explicit failure signal.

### `call_health_check`
- **Payload:** `{ callId: string }`
- **Handler:** `handleCallHealthCheck`, `chat.gateway.ts:918-937`
- **Effect:** read-only — no room joins/emits. Confirms the caller is still a participant and
  returns the current roster.
- **Ack:** `{ ok: true, callId, participantsCount: number, participants: { userId, muted, username? }[] }`
  or `{ error: "Call ended" | "Not in call", ok: false }` or `{ error: "Unauthorized" }`.

### `call_mute`
- **Payload:** `{ callId: string; muted: boolean }`
- **Handler:** `handleCallMute`, `chat.gateway.ts:940-958`
- **Effect:** updates the caller's own `muted` flag in `call.participants`, emits refreshed
  `call_participants` to `call:<callId>`.
- **Ack:** `{ success: true }`, or nothing if unauthorized/call not found (no error object).

### `call_cancel`
- **Payload:** `{ callId: string }`
- **Handler:** `handleCallCancel`, `chat.gateway.ts:961-995`
- **Checks:** only meaningful for **private** calls, and only the initiator may cancel (group
  calls are a no-op here — they only end via everyone leaving through `call_leave`).
- **Effect:** writes a `MessageType.VOICE_CALL` "cancelled" log message broadcast via `new_message`
  to the channel; emits `call_ended` to `channel:<channelId>`; ends the call.
- **Ack:** `{ success: true }` for a group call or an already-ended call (no-op), or nothing if
  unauthorized / caller isn't the initiator (no error object returned in that branch).

---

## Server → Client events

19 distinct event names are emitted from the gateway (directly, or via the `emitToUser` /
`notifyXxx` helper methods that `ChatService` / `MessageController` / etc. call into from outside
the gateway).

| Event | Payload shape | Sent to | Consumer intent (inferred) |
|---|---|---|---|
| `user_status_changed` | `{ userId: string; status: UserStatus; lastSeen?: string }` (`lastSeen` only present on the offline transition, `chat.gateway.ts:330-334`) | **All connected sockets** (`server.emit`, unscoped — `chat.gateway.ts:252`, `330`, `578`) | Update a contact's online/offline/last-seen indicator anywhere in the UI. |
| `call_ended` | `{ callId: string }` | Either `channel:<channelId>` room, or specific `user:<userId>` room(s) via `emitToUser`, depending on which code path ended the call (`chat.gateway.ts:276`, `281`, `313`, `837`, `870`, `992`) | Tear down the active call UI / WebRTC peer connection for that call id. |
| `call_participants` | `{ callId: string; participants: { userId: string; muted: boolean; username?: string }[] }` | `call:<callId>` room | Re-render the in-call roster / mute indicators. |
| `call_participant_left` | `{ callId: string; userId: string; username?: string }` | `call:<callId>` room (`chat.gateway.ts:296-300`, disconnect path only) | Show a "user left the call" transient notice. |
| `call_created` | `{ callId: string; channelId: string; messageId?: string; initiatorId: string; initiatorUsername?: string; message?: Message }` (`message` only present on the `call_create` broadcast, not the `join_channel` late-joiner replay, `chat.gateway.ts:356-362` vs `764-771`) | `channel:<channelId>` room, or (late-joiner case) the single joining socket | Show the "incoming group call" banner in the channel. |
| `new_message` | `{ message: Message; channelId: string; tempId?: string }` — `Message` is the raw Mongoose document (see Known gaps re: `readBy`) | `channel:<channelId>` room (group/channel messages, call logs), or targeted per-socket for private chats (blocked recipients' sockets skipped) | Append the message to the open conversation / update the channel list preview. |
| `user_typing` | `{ userId: string; username?: string; channelId: string; isTyping: boolean; uploading: boolean }` | `channel:<channelId>` room, sender excluded (`client.to(...)`) | Drive the "X is typing…" / "X is uploading a file…" indicator. |
| `messages_read` | `{ channelId: string; readBy: string; lastReadMessageId: string }` | `channel:<channelId>` room (includes the reader) | Update read-receipt ticks on the sender's own messages. |
| `call_incoming` | `{ callId: string; channelId: string; fromUserId: string; fromUsername?: string }` | `user:<otherUserId>` room | Show the "incoming call" ringing screen. |
| `call_accepted` | `{ callId: string; acceptedBy: string; acceptedByUsername?: string; participants: { userId: string; muted: boolean; username?: string }[] }` | `user:<initiatorId>` room | Transition the initiator's UI from "ringing" to "in call". |
| `call_declined` | `{ callId: string; declinedBy: string }` | `user:<initiatorId>` room | Show "call declined" and close the ringing screen. |
| `call_still_active` | `{ callId: string; channelId: string; messageId?: string; initiatorId: string; initiatorUsername?: string }` | The single leaving socket only | Tell a user who just left a group call that it's still going (in case they want to rejoin). |
| `call_signal` | `{ fromUserId: string; type: string; payload: unknown }` | `user:<targetUserId>` room | Feed a WebRTC offer/answer/ICE candidate into the local peer connection. |
| `new_chat` | `{ chat: unknown }` — shape is whatever `ChatController`/`ChatService` passes into `notifyNewChat`, not validated/typed at the gateway boundary | `user:<targetUserId>` room | Insert a newly-created direct chat into the chat list without a refetch. |
| `channel_roles_updated` | `{ channelId: string; admins: string[] }` | `channel:<channelId>` room | Refresh admin badges / permission-gated UI for the channel. |
| `chat_banned` | `{ channelId: string }` | `user:<userId>` room | Remove the channel from the banned user's chat list / block further access. |
| `user_muted` | `{ channelId: string; muted: boolean }` | `user:<userId>` room | Update the local mute toggle for that channel's notifications. |
| `message_updated` | `{ channelId: string; message: Record<string, unknown> }` | `channel:<channelId>` room | Patch an edited message in place in the open conversation. |
| `message_deleted` | `{ channelId: string; messageId: string }` | `channel:<channelId>` room | Remove/redact a message that was deleted for everyone. |

Notes on the table:
- `channel_roles_updated`, `chat_banned`, `user_muted`, `new_message` (REST path via
  `broadcastNewMessage`), `message_updated`, and `message_deleted` are **not** emitted from inside
  a `@SubscribeMessage` handler — they're public methods on `ChatGateway`
  (`notifyChannelRolesUpdated`, `notifyChatBanned`, `notifyUserMuted`, `broadcastNewMessage`,
  `notifyMessageUpdated`, `notifyMessageDeleted`, `notifyNewChat`, `chat.gateway.ts:115-169`,
  `1020-1033`) called from REST controllers/services (e.g. `ChatController`,
  `MessageController`) after a mutation persists. They're documented here because they're part of
  the same event contract clients listen for, even though the trigger is an HTTP request, not a
  WS message.
- `Message` above refers to the raw `src/message/schema/message.schema.ts` document as returned by
  `MessageService.create` (JSON round-tripped, not passed through a DTO) — see Known gaps.

---

## Known gaps / not yet accurate to the target architecture

This section is descriptive of the **current state** of `chat.gateway.ts`, not a to-do list to
action here — B1/B3 in `BACKEND_PLAN.md` cover the rework.

- **Global broadcasts instead of scoped rooms.** `user_status_changed` is emitted via
  `this.server.emit(...)` on both the connect and disconnect paths (`chat.gateway.ts:252`, `330`)
  and from `update_status` (`chat.gateway.ts:578`) — every connected socket in the namespace
  receives every user's presence change, regardless of whether they share a channel or contact
  relationship. This will not scale past a small user base and leaks presence to unrelated users.
- **Presence stored in gateway-local memory + a field on `User`, not a shared store.**
  `userSockets`, `socketUsers`, `userStatuses`, `typingUsers`, `uploadingUsers` are plain in-process
  `Map`s (`chat.gateway.ts:48-52`), and `User.isOnline` is written directly via
  `userModel.findOneAndUpdate` (`chat.gateway.ts:225-228`, `326-329`). None of this is visible
  across multiple server instances (no Redis/adapter-backed presence), so horizontal scaling would
  produce inconsistent online/offline state and duplicate `user_status_changed` storms per
  instance.
- **Voice call state is in-memory and single-instance only.** `activeCalls` and
  `privateCallByChannel` (`chat.gateway.ts:81-99`) live in the gateway instance's memory. A server
  restart silently drops all active calls (clients would need a client-side timeout/health-check
  fallback — `call_health_check` exists but nothing proactively notifies clients on server restart),
  and calls cannot be joined across multiple server instances without a shared adapter (e.g.
  `socket.io-redis`) — this gateway does not configure one.
- **`new_message` / `message_updated` ship the raw Mongoose document, not a DTO.** The message
  schema includes `readBy: Map<string, Date>` (`src/message/schema/message.schema.ts`), which is
  serialized straight into the socket payload via `JSON.parse(JSON.stringify(message))`
  (`chat.gateway.ts:390`, `697-699`, `859-861`, `980-982`). `BACKEND_PLAN.md`'s B1 item explicitly
  calls for a `MessageDto` mapper that never leaks `readBy` (or other internal fields); today's
  socket payload does not have that mapping applied — it flows straight from the DB document.
- **Inconsistent unauthorized/no-op returns.** Most handlers return `{ error: "Unauthorized" }`
  when `client.userId` is missing, but `call_leave`, `call_signal`, `call_mute`, and `call_cancel`
  simply `return;` (no payload) in that case — a client can't distinguish "silently ignored" from
  "no ack expected" without reading the handler source.
- **No per-event rate limiting except `send_message`.** The B0 token bucket
  (`chat.gateway.ts:54-78`) only guards `send_message`; `typing_start`/`uploading_start`/call
  signaling/etc. have no throttling, so a misbehaving client could still spam room broadcasts on
  those events. `BACKEND_PLAN.md` calls this out directly ("the full realtime rework — one write
  path, per-socket limits on every event — is B3").
- **Gateway does application logic directly** (DB membership checks, message persistence, call
  bookkeeping) rather than being a transport-only layer over domain events. B1's plan text notes
  the target architecture is "Gateway → transport-only: domain services emit `EventEmitter2`
  events; a `realtime` module subscribes" — the current gateway does not match that shape yet.
- **No sub-namespaces / no per-event payload validation.** `main.ts` registers a global
  `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`, which Nest
  does apply across HTTP and WS contexts — but validation only runs against `class`-based DTOs
  with `class-validator` metadata. `send_message` is the only client→server event whose payload is
  a real class (`CreateMessageDto`), so it's the only one actually validated/whitelisted at
  runtime. Every other event (`@MessageBody() data: { channelId: string }`, etc.) is typed with a
  plain TypeScript object literal, which has no runtime metadata for the pipe to check — a
  malformed or extra-field payload on any of those 18 events passes straight into the handler
  unvalidated.
