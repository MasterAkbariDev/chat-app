# Refactor Spec: Realtime Gateway

## 1. Current implementation
One `ChatGateway` (~980 LoC), namespace `/`, CORS `*`. Handles connection auth, presence, rooms,
typing ×2, read receipts, `send_message`, and **13 call handlers with in-memory call state**.
Domain services (`ChatService`, `MessageController`, `WallpaperService`, `ConfigLogService`)
inject `ChatGateway` and call `notify*` helpers. 6 `forwardRef` cycles involve the gateway.
Single Node process (no Redis adapter).

## 2. Current architecture
See `REALTIME_ARCHITECTURE.md`. Gateway is both transport and a dependency of the domain.

## 3. Current problems
- Gateway ⇄ domain cycles (6× `forwardRef`).
- Global `user_status_changed` broadcast (PERF C5).
- Full-message rebroadcast on every reaction (PERF H1).
- In-memory call + typing + presence state → no horizontal scale, lost on restart, reconnect races.
- No Redis adapter.
- No runtime validation on most `@MessageBody()` payloads (SECURITY W3).
- No per-socket rate limiting (W1/R3).
- Typing/uploading/call maps leak on disconnect (W4).
- REST message create not broadcast; config-log emits a hand-built payload.
- Gateway CORS hardcoded `*` (T1).

## 4. Refactor goal
Gateway = **transport only**. Domain emits in-process events; a `realtime` module is the sole
`server.emit` caller. Redis adapter + Redis-backed presence/typing/call state. Every event
validated, rate-limited, documented, single-consumer.

## 5. New architecture
```
domain service  ──EventEmitter2──►  realtime module (subscriber)  ──socket.io + redis-adapter──►  clients
events: message.created | message.updated | message.deleted | reaction.changed | read.updated
        presence.changed | typing.changed | channel.roles.changed | channel.pinned.changed
        wallpaper.updated | membership.banned | user.unblocked
gateway inbound handlers: connect(auth) · send_message(→MessageService.send) · typing · read
        · (calls → CallsModule if kept)
presence/typing state: Redis (TTL); reconnect resync via `since` cursors
```

## 6. Backend changes
- New `realtime/` module: `RealtimeGateway` (thin) + `RealtimeEmitter` (subscribes to domain events).
- Remove `ChatGateway` injection from `ChatService`, `MessageController`, `WallpaperService`, `ConfigLogService` → they emit events. Removes all 6 cycles.
- `@socket.io/redis-adapter`; Redis in compose + health check.
- Zod/class-validator schema per inbound event; reject invalid.
- Per-socket token-bucket rate limits (`send_message`, `typing`, `call_signal`).
- Clean all per-socket maps in `handleDisconnect`.
- Scoped emits: presence only to `channel:*` rooms the user shares (recompute on membership change).
- Delta payloads for reactions/reads.

## 7. Frontend changes
- One `RealtimeProvider` exposing a typed event map + `useRealtimeEvent(name, handler)`.
- Feature hooks subscribe (`use-chat-realtime`, `use-list-realtime`, `use-presence`).
- Reconnect: send `{ since: {channelId: lastMessageId} }` for open channels; apply the gap.
- Remove per-component `useSocket` listener registries.

## 8. UI/UX
- Connection status pill (connecting / reconnecting) — subtle, top of the conversation, auto-hides.
- Typing indicator: names for ≤3, "several people" beyond; disappears on 5s server timeout or `message:new`.
- No visible change to presence dots except they now only reflect people you share a chat with.

## 9. Data contract
- `reaction:changed { messageId, emoji, delta: 1|-1, byUserId }` — < 300 B.
- `read:updated { channelId, byUserId, lastReadMessageId }`.
- `presence:changed { userId, status: online|offline, lastSeen? }` — emitted into shared rooms only.
- `message:new { message: MessageDto, tempId? }`.

## 10. Performance
- Presence churn from O(connections²) → O(shared-room membership).
- Reaction event 2 KB+ → < 300 B; no bubble-wide re-render.
- Horizontal scale enabled (Redis adapter).
- 2 fewer Mongo writes per connect/disconnect (presence moves to Redis).

## 11. Migration
- Stand up `realtime` module emitting the **same** current event names/shapes first (no client change).
- Switch domain services to events one at a time.
- Add Redis adapter (compatible with a single node too).
- Introduce delta events behind a client capability flag; keep full-message `message_updated` for old clients during transition.

## 12. Tests
- Two-client harness: latency, ordering, reconnect gap-fill.
- Presence-leak test (no shared chat → no presence event).
- Event-size assertions; rate-limit tests; disconnect-cleanup test.
- "One `message:new` per persisted message" (REST + WS).
- Multi-node test with Redis adapter (message from node A reaches a client on node B).

## 13. Risks
- Redis becomes a hard dependency → health check + graceful degradation (single-node fallback).
- Presence scoping edge cases (join mid-session) → recompute rooms on `membership.changed`.
- Delta events + old clients → capability flag; drop the full path after soak.

## 14. Acceptance criteria
- No domain module imports the gateway; 0 gateway `forwardRef` cycles.
- App runs with ≥ 2 API replicas; cross-node delivery works.
- Presence events reach only shared rooms.
- Reaction/read events are deltas < 300 B.
- Every inbound event is schema-validated and rate-limited.
- Per-socket maps are empty after disconnect (leak test green).
