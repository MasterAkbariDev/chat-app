# Refactor Spec: Presence (online / last seen)

## 1. Current implementation
Gateway maps (`userSockets`, `socketUsers`, `userStatuses`). On connect/last-disconnect:
`user.isOnline` + `user.lastSeen` written to Mongo, then `server.emit("user_status_changed")` to
**every connected socket**. `update_status` sets an in-memory status and broadcasts globally
(frontend only ever sends `ONLINE`). REST `GET /users/:id/status` returns `{ userId, username,
email, lastSeen }`.

## 2. Current architecture
```
connect → userSockets.add → user.updateOne(lastSeen) → user.findOneAndUpdate(isOnline:true) → server.emit(ALL)
disconnect(last) → userStatuses=OFFLINE → user writes ×2 → server.emit(ALL, {offline, lastSeen})
```

## 3. Current problems
- Global broadcast: O(connections) per event, O(connections²) aggregate (PERF C5).
- 2 Mongo writes per connect/disconnect (PERF M5); `isOnline` permanently stale on crash.
- Presence leaks to users who share nothing with you (SECURITY D3).
- `GET /users/:id/status` leaks `email` (SECURITY D2).
- `away`/`typing` in `UserStatus` unused; `update_status` is dead-ish.
- `lastSeen` schema default `new Date()` evaluated once at module load.

## 4. Refactor goal
Redis-backed presence, scoped to shared rooms, debounced; no `isOnline` column; `lastSeen`
written sparingly; status endpoint minimal.

## 5. New architecture
```
Redis: presence:<userId> = "online" with EX 30s, refreshed by a heartbeat; on expiry/last-disconnect → offline
On change → realtime module emits presence:changed into every `channel:<id>` room the user shares
lastSeen: written to Mongo only on transition-to-offline (or at most every 5 min)
GET /v1/users/:id/presence → { status, lastSeen? }  (respects the viewer's right to see it)
```

## 6. Backend changes
- `PresenceService` (Redis): `setOnline(userId)`, `heartbeat`, `markOffline`, `getMany(userIds)`.
- Realtime emits `presence:changed` only to shared rooms; batch/debounce to ≤ 1 event/user/second.
- Remove `user.isOnline`; keep `lastSeen` but write only on offline transition.
- Drop `update_status`, `UserStatus.AWAY/TYPING` (typing has its own channel).
- `GET /users/:id/presence` returns `{ status, lastSeen? }` — no email; honours a future privacy setting ("who can see my last seen": everyone / contacts / nobody).

## 7. Frontend changes
- `usePresence(userIds)` — subscribes to `presence:changed`, seeds from a batch `GET /v1/presence?ids=`.
- Chat header + list rows read from that hook; remove ad-hoc `user_status_changed` handling in 3 places.
- Client sends a heartbeat ping every ~20s while a tab is focused.

## 8. UI/UX
- DM header: "online" / "last seen 5m ago" / "last seen recently" (fuzzed if privacy-limited).
- List rows: green dot only for online DMs; groups show "N online" (from a room count).
- No visual change otherwise; the difference is you stop seeing strangers' status.

## 9. Data contract
`presence:changed { userId, status: "online"|"offline", lastSeen? }` into shared rooms only.
`GET /v1/presence?ids=a,b,c → { a: {status}, b: {status, lastSeen}, ... }`.

## 10. Performance
- Presence writes: from 2 per connect/disconnect to ~0 (Redis) + 1 lastSeen per offline.
- Broadcast fan-out: from all-connections to shared-room membership.
- Status reads: O(1) Redis batch.

## 11. Migration
- Add `PresenceService` writing to both Redis and (temporarily) `user.isOnline`.
- Switch the gateway broadcast to scoped emits.
- Stop writing `isOnline`; drop the column in a later migration.
- Old clients listening to `user_status_changed` still work (same event name, narrower audience).

## 12. Tests
- Presence-leak test (no shared chat → no event).
- Heartbeat expiry → offline within 30s.
- `lastSeen` written once per offline transition (not per disconnect burst).
- Batch presence endpoint correctness.

## 13. Risks
- Redis outage → presence degrades to "unknown" (show nothing) rather than erroring.
- Heartbeat battery cost on mobile → 20s interval, pause when hidden.

## 14. Acceptance criteria
- No `user.isOnline` column.
- `presence:changed` reaches only shared rooms.
- `lastSeen` write frequency ≤ 1 per user per offline transition.
- Status endpoint returns no `email`.
- Presence survives an API node restart (Redis).
