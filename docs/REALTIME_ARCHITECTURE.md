# Real-time Architecture (Socket.IO)

One gateway: `legacy-chat/src/gateway/chat.gateway.ts` (~980 lines), `@WebSocketGateway({ cors: { origin: "*", credentials: true }, namespace: "/" })`.

> **Doc drift:** `API_SUMMARY.md` and `FLUTTER_INTEGRATION.md` say the namespace is `/chat`.
> The **code uses the default namespace `/`** and the frontend connects with `io(url)` (no
> namespace). Treat `/` as authoritative.

Client: `legacy-frontend/src/lib/socket.ts` — module-level singleton `Socket`, `useSocket(token)`
hook with a local listener registry that re-attaches on reconnect.

---

## 1. Connection lifecycle

### Handshake / auth (`handleConnection`)
1. Extract token: `Authorization: Bearer …` header **or** `handshake.auth.token`.
2. No token → `client.disconnect()`.
3. `jwtService.verify(token)` → `JWTPayload { userId, email, tokenVersion }`.
4. `user.findById(payload.userId).select("username email tokenVersion isDeleted")`.
5. `isDeleted` or `tokenVersion` mismatch → `disconnect()`.
6. Register socket: `userSockets: Map<userId, Set<socketId>>`, `socketUsers: Map<socketId, userId>`, `userStatuses: Map<userId, ONLINE>`.
7. `user.updateOne({ lastSeen })` + `user.findOneAndUpdate({ isOnline: true })` (**2 writes per connect**).
8. `client.join("user:<userId>")`.
9. Re-point any `activeCalls` participant with a stale socket to this new socket.
10. `chatMembers.find({ userId })` → `client.join("channel:<id>")` for **every** membership (**unbounded joins**).
11. `server.emit("user_status_changed", { userId, status: ONLINE })` — **global broadcast to all connected sockets**.

### Disconnect (`handleDisconnect`)
1. Look up `userId` from `socketUsers`.
2. For every active call: if this socket was the participant's socket → remove; handle private vs group end / participant list update / call-log message.
3. Remove socket from `userSockets`. If it was the **last** socket:
   - `userStatuses = OFFLINE`, `user.updateOne({ lastSeen })`, `user.findOneAndUpdate({ isOnline: false })` (**2 writes**),
   - `server.emit("user_status_changed", { userId, OFFLINE, lastSeen })` — **global broadcast**.

### Reconnect
- Client `socket.io-client` auto-reconnects; `useSocket` re-attaches registered listeners.
- Server re-runs `handleConnection` (fresh room joins). Call code manually patches stale `socketId`s.
- **No heartbeat/ack beyond Socket.IO defaults.** No message re-sync on reconnect (client relies on refetch when a chat is opened).

### Rooms
| Room | Members | Purpose |
|---|---|---|
| `user:<userId>` | all of a user's sockets | targeted user events (ban, unblock, wallpaper, call signalling fan-out) |
| `channel:<channelId>` | all members currently connected | message / typing / read / roles fan-out |
| `call:<callId>` | call participants' sockets | call participant list + mute updates |

---

## 2. Client → Server events

| Event | Payload | Guard | Effect | Ack |
|---|---|---|---|---|
| `join_channel` | `{ channelId }` | membership | join `channel:<id>`; if a group call is active, emit `call_created` to this socket | `{ success, channelId }` / `{ error }` |
| `leave_channel` | `{ channelId }` | auth | leave room | `{ success }` |
| `send_message` | `CreateMessageDto` (+ `tempId`) | `messageService.create` (membership, mute, channel-post, block per-recipient) | persist + broadcast `new_message` to `channel:<id>` (private: per-socket, skips blockers) | `{ success, message }` / `{ error }` |
| `typing_start` | `{ channelId }` | membership | emit `user_typing {isTyping:true}` to others in room; 5s auto-stop timeout | `{ success }` |
| `typing_stop` | `{ channelId }` | auth | emit `user_typing {isTyping:false}` | `{ success }` |
| `uploading_start` | `{ channelId }` | membership | emit `user_typing {uploading:true}` | `{ success }` |
| `uploading_stop` | `{ channelId }` | auth | emit `user_typing {uploading:false}` | `{ success }` |
| `mark_read` | `{ channelId, lastReadMessageId }` | `messageService.markAsRead` | update membership + `readBy` bulk write; emit `messages_read` to `channel:<id>` | `{ success }` / `{ error }` |
| `update_status` | `{ status: UserStatus }` | auth | set `userStatuses` map; `server.emit("user_status_changed")` **globally** | `{ success, status }` |
| **Calls** | | | | |
| `call_request` | `{ channelId, otherUserId }` | membership, private-only, no existing call | register `activeCalls`; emit `call_incoming` to `user:<otherUserId>` | `{ success, callId }` / `{ error }` |
| `call_accept` | `{ callId, channelId }` | call exists | add participant, join `call:<id>`, pull initiator in; emit `call_participants` + `call_accepted` | `{ success }` |
| `call_decline` | `{ callId, channelId }` | — | post `voice_call` "declined" message; emit `call_declined`; end call | `{ success }` |
| `call_create` | `{ channelId }` | membership, group/channel, no existing call | post `voice_call` message; emit `call_created` to `channel:<id>` | `{ success, callId, messageId }` |
| `call_join` | `{ callId }` | membership | add participant, join `call:<id>`; emit `call_participants` | `{ success, participants }` |
| `call_leave` | `{ callId }` | — | remove participant; private → end + optional duration log; group → `call_still_active` to this socket or `call_ended` when empty | `{ success }` |
| `call_signal` | `{ callId, targetUserId, type, payload }` | call exists, target participant | relay to `user:<targetUserId>` as `call_signal { fromUserId, type, payload }` | `{ success }` |
| `call_mute` | `{ callId, muted }` | — | update participant; emit `call_participants` | `{ success }` |
| `call_cancel` | `{ callId }` | private + initiator only | post "cancelled" log; `call_ended` to channel; end | `{ success }` |
| `call_health_check` | `{ callId }` | in-call | returns `{ ok, participantsCount, participants }` | that |

---

## 3. Server → Client events

| Event | Target | Payload | Consumers (frontend) |
|---|---|---|---|
| `new_message` | `channel:<id>` (private: filtered per-socket) | `{ message, channelId, tempId? }` | `chat/[channelId]/page.tsx` (append + optimistic reconcile), `chat-list.tsx` (bump/preview/unread), `app-shell.tsx` (notification/sound/title) |
| `message_updated` | `channel:<id>` | `{ channelId, message }` | chat page (replace by id) — fired on **edit + every reaction** |
| `message_deleted` | `channel:<id>` | `{ channelId, messageId }` | chat page (remove), chat-list (preview refresh) |
| `messages_read` | `channel:<id>` | `{ channelId, readBy, lastReadMessageId }` | chat page (tick state) |
| `user_typing` | `channel:<id>` (others) | `{ userId, username, channelId, isTyping, uploading }` | chat page typing indicator |
| `user_status_changed` | **all sockets** | `{ userId, status, lastSeen? }` | chat page (other user), chat-list (dot) |
| `new_chat` | `user:<id>` | `{ chat }` | chat-list (insert), app-shell (refresh mute map) — also joins the socket to `channel:<id>` |
| `channel_roles_updated` | `channel:<id>` | `{ channelId, admins: string[] }` | chat page (composer/admin UI) |
| `chat_banned` | `user:<id>` | `{ channelId }` | chat page (close chat) |
| `user_muted` | `user:<id>` | `{ channelId, muted }` | chat page (composer disabled) |
| `user_unblocked_you` | `user:<id>` | `{ unblockedBy }` | chat page (re-enable send) |
| `wallpaper_updated` | `user:<id>` | `{ channelId, wallpaper }` | `use-chat-wallpaper` (apply/refresh) |
| **Calls** | | | |
| `call_incoming` | `user:<id>` | `{ callId, channelId, fromUserId, fromUsername }` | `call-socket-listener` → incoming modal + notification |
| `call_accepted` | `user:<initiator>` | `{ callId, acceptedBy, participants }` | listener → join call |
| `call_declined` | `user:<initiator>` | `{ callId, declinedBy }` | listener → outgoing modal "declined" |
| `call_created` | `channel:<id>` | `{ callId, channelId, messageId, initiatorId, initiatorUsername, message? }` | `group-call-banner` |
| `call_participants` | `call:<id>` | `{ callId, participants }` | call context (single source of truth) |
| `call_participant_left` | `call:<id>` | `{ callId, userId, username }` | toast |
| `call_still_active` | one socket | `{ callId, channelId, messageId, initiatorId, initiatorUsername }` | "rejoin" state |
| `call_ended` | `channel:<id>` or `user:<id>` | `{ callId }` | listener → leaveCall |
| `call_signal` | `user:<id>` | `{ fromUserId, type, payload }` | `use-call-webrtc` (simple-peer signal) |

---

## 4. Problems

### Correctness / consistency
1. **REST-created messages are never broadcast.** Only `send_message` emits `new_message`. `POST /messages` and message pin (`POST /messages/:id/pin`) do not notify. Config-log endpoint emits manually with a hand-built payload shape.
2. **`new_message` payload shape varies** — gateway sends `{ message, channelId, tempId? }`; config-log sends `{ message, channelId }` with a differently-populated `message` (`image` vs `avatarUrl`).
3. **No ordering guarantee / dedupe.** Client relies on `_id` set membership + `createdAt` sort. On reconnect there is no gap-fill; missed messages appear only when the chat is reopened (refetch).
4. **Typing/uploading maps leak** — `typingUsers`, `uploadingUsers` entries are not cleared on `handleDisconnect`.
5. **Read receipts fan out the whole `readBy` map** to every channel member on every `messages_read`.

### Performance / scale
6. **`server.emit("user_status_changed")` is global** — every connect/disconnect/`update_status` hits every connected socket. O(connections) per presence change; O(connections²) aggregate churn.
7. **`isOnline` persisted to Mongo** on every connect/disconnect (2 writes each) — write amplification, and permanently stale on crash.
8. **`handleConnection` joins every channel room** for the user with no cap; a user in 500 chats joins 500 rooms on every (re)connect.
9. **All call state in one Node process memory** (`activeCalls`, `privateCallByChannel`, participant socket maps). Cannot run >1 replica; restart drops every call; reconnection races are patched by hand.
10. **`message_updated` broadcasts the full message on every reaction toggle** — a thumbs-up on a 2 KB message with a big `readBy` map ships the whole thing to every member.
11. **No Redis adapter** — Socket.IO is single-node; `@socket.io/redis-adapter` is not installed.

### Security
12. Gateway CORS hardcoded `origin: "*"` (separate from the HTTP `CORS_ORIGIN`).
13. `call_signal` relays arbitrary `payload` to `user:<targetUserId>` with only "is a participant" check — a participant can spam signals.
14. Presence leaks: you learn the online status of users you share no chat with.
15. No per-socket rate limiting on `send_message`, `typing_start`, `call_signal`.

---

## 5. Target real-time contract (summary — see REFACTOR_PLAN)

- **Namespace `/` kept**, add `@socket.io/redis-adapter` for multi-node.
- **Presence scoped to shared rooms only.** Keep online state in Redis (TTL), not Mongo. Batch presence deltas (e.g. 1 event/sec/room).
- **One write path for messages:** REST `POST /messages` persists and the service emits `message.created`; the gateway subscribes and fans out. WS `send_message` becomes a thin wrapper over the same service call. Every persisted message → exactly one `message:new`.
- **Delta events for reactions/reads:** `reaction:changed { messageId, emoji, delta, byUserId }`, `read:updated { channelId, byUserId, lastReadMessageId }` — never the whole message.
- **Reconnect resync:** client sends `since: <lastMessageId per open channel>`; server streams the gap.
- **Calls:** move signalling state to Redis; adopt an SFU (mediasoup / LiveKit) + TURN if calling stays; otherwise externalise or drop (see OPEN_QUESTIONS).
- **Every server event documented with a single consumer** (ARCHITECTURE_RULES).
