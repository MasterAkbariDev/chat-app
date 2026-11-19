# Performance Audit

Severity: **CRITICAL** (user-visible latency or won't-scale-past-a-family), **HIGH**,
**MEDIUM**, **LOW**. Where no measurement exists it is marked `TARGET TO MEASURE` with a method.

---

## CRITICAL

### C1 — `GET /chats/my-chats` is O(N) queries per load
`chat.service.findUserJoinedChatsWithDisplay`: membership query + chats query + 2 aggregations
+ **per private chat**: `chatMembers.find` + `user.findById`. 20 DMs ≈ 42 queries. Runs on every
chat-list mount, `new_chat`, focus, and `chats:invalidate`.
- **Fix:** one aggregation pipeline; denormalise `lastMessageAt` + `lastMessagePreview` +
  `memberCount` onto the chat (or a `chat_state` doc); resolve DM peer via a single `$lookup`.
- **Measure:** log query count per request (mongoose `Query.prototype` hook) in staging.

### C2 — `chatmembers` has no index on `(channelId, userId)`
The most frequent query in the codebase (`findOne({channelId, userId})`, dozens of call sites,
every message send, every history read, every guard) is a **collection scan**.
- **Fix:** `ChatMembersSchema.index({ channelId:1, userId:1 }, { unique:true })` + `{ userId:1, isJoined:1 }`.
- **Impact:** membership checks go from O(collection) to O(1). Also fixes duplicate-membership races.

### C3 — `message.service.create` = 6–10 sequential awaits
Membership → chat → (forward: message + user) → mentions (users + membership) → replyTo →
private other-member → emoji-usage loop → `create` → `findById().populate().populate()`.
- **Measure:** `TARGET TO MEASURE` message-send P50/P95 (client `send_message` → `new_message` ack).
- **Fix:** parallelise independent reads (`Promise.all`), drop the re-`findById().populate()` (build
  the response from the created doc + already-loaded sender), move emoji-usage + forward-avatar to
  a background event, precompute reply snapshot.

### C4 — Read receipts write-amplify
`markAsRead` → `updateMany(readBy.<uid>=now)` over **all** history ≤ target timestamp, adding a
per-user key to each message's `readBy` Map. In a 30-person group, one catch-up read touches
hundreds of messages × writes; `readBy` grows to O(members) per message and ships to every client.
- **Fix:** store only `chatmembers.lastReadMessageId/lastReadAt`; compute "read by N" from
  membership timestamps; emit a delta event; never write per-message read keys.
- **Impact:** read = 1 write; message payload shrinks; `getUnreadReactions` stops needing `$expr`.

### C5 — Presence global broadcast
`this.server.emit("user_status_changed")` on every connect/disconnect/`update_status` → every
connected socket. Aggregate churn O(connections²). Plus 2 Mongo writes per event (`isOnline`,
`lastSeen`).
- **Fix:** emit only into rooms the user shares; presence in Redis with TTL, not Mongo; debounce.

### C6 — Message history uses `skip`/`offset`
`messages.find().sort({createdAt:-1}).limit(100).skip(offset)` — deep scroll = large `skip` =
linear scan. Same for chat/user/message search and GIF lists.
- **Fix:** keyset pagination (`createdAt < cursor` / `_id < cursor`).

---

## HIGH

### H1 — `message_updated` broadcasts the full message on every reaction toggle
Whole doc (content, attachments, `reactions` Map, `readBy` Map) to every channel member for a
1-emoji change; bubble subtree re-renders.
- **Fix:** `reaction:changed { messageId, emoji, delta, byUserId }`.

### H2 — Chat list fetches unread count per chat
`components/chat-list.tsx` calls `messagesApi.unreadCount(channelId)` per chat, plus re-sorts the
list on every `new_message`.
- **Fix:** include `unreadCount` in `my-chats`; maintain client counts from socket events.

### H3 — Every authenticated request does an extra `user` read
`JwtStrategy.validate` → `user.findById().select("isDeleted tokenVersion")` on the hot path.
- **Fix:** cache `tokenVersion` in memory/Redis (invalidate on password change / logout-all);
  or accept short-lived tokens and skip the check.

### H4 — No message-list virtualization
`message-list.tsx` renders every loaded message; a long session = thousands of DOM nodes;
`message-bubble` is 3397 LoC and re-renders broadly.
- **Fix:** virtualize (e.g. `@tanstack/react-virtual`); `React.memo` the item with stable props;
  split the bubble by message type.

### H5 — Bundle: chat route ships everything eagerly
`emoji-picker` (1225), `media-edit/*` (~2000), `call-*` (~1500), `video-lightbox` (817),
`framer-motion`, `simple-peer`, `blurhash` all reachable on chat open.
- **Measure:** `TARGET TO MEASURE` — `next build` route JS for `/chats/[channelId]`; Lighthouse TBT/TTI on mid mobile.
- **Fix:** `next/dynamic` for pickers, media editor, call UI, lightboxes; lazy `simple-peer` only when a call starts.

### H6 — `GET /gifs` trending aggregation on every open
`$group` dedupe over all public gifs each browse.
- **Fix:** materialise a `trending_gifs` cache (cron / on write) or drop trending.

### H7 — `chat.banned[]` linear scan in ~8 hot paths
Loaded and `.some()`-scanned on every message send / history / preview / participants call.
- **Fix:** `chatmembers.isBanned` flag (indexed) or `chat_bans` collection.

### H8 — Media served full-resolution
No resize / thumbnail / transcode / blurhash server-side (except GIF conversion). A 12 MP photo
in a chat = 8 MB download per viewer.
- **Fix:** `sharp` pipeline: store original + web-size + thumb + blurhash; `<img srcset>`.

---

## MEDIUM

- **M1** `addReaction`/`addQuickReaction`: 3–4 queries per toggle (findById → update → findById.populate.populate). Collapse to one `findByIdAndUpdate` + build response.
- **M2** `.populate("replyTo")` returns the whole original message. Project or snapshot.
- **M3** `.populate("senderId", "... email")` — email not used by UI; drop.
- **M4** `emoji_usage` upsert on every message per emoji + every reaction. Move to client recents or batch.
- **M5** `isOnline` + `lastSeen` Mongo writes on every connect/disconnect. Memory/Redis.
- **M6** 3 date-navigation endpoints each re-run the full guard + a `findOne.sort`. Merge + index.
- **M7** `my-chats` sort done in JS after loading all chats. Sort in the pipeline; paginate.
- **M8** Chat page `mergedMessages` `useMemo` rebuilds + re-sorts on every `messages`/`optimistic`/`dateJump` change; dedupe via `Set` each time.
- **M9** `chat.service.update` admin sync `save()`s each member in a loop. `bulkWrite`.
- **M10** Wallpaper: new `Wallpaper` doc per apply; orphan disk files. Upsert + cleanup job.
- **M11** `app-shell` `new_message` handler reads `localStorage` synchronously per message and recomputes mention/mute logic.
- **M12** No HTTP caching headers on `/uploads` beyond static defaults; no CDN.
- **M13** `next.config.ts` has no `images` optimization config; `<img>` used directly (no `next/image`).

## LOW

- **L1** `console.log`/`console.error` in hot paths (gateway, socket lib, chat controller).
- **L2** `createdAt`/`updatedAt` double-declared on `Message` (`@Prop` + `timestamps:true`).
- **L3** `lastSeen` default `new Date()` evaluated once at module load.
- **L4** `globals.css` 1568 lines, many unused component classes.
- **L5** `dist/` committed → repo bloat.
- **L6** Two always-mounted hidden `<audio>` elements.

---

## Performance budgets (proposed — `TARGET TO MEASURE`)

| Metric | Target | How to measure |
|---|---|---|
| Chat route initial JS (gzip) | < 180 KB | `next build` output / `@next/bundle-analyzer` |
| Time to first message painted (warm cache, mid mobile) | < 1.2 s | Lighthouse / RUM mark `chat:first-paint` |
| Message send latency (`send_message` → ack) | P50 < 150 ms, P95 < 400 ms | client timestamp diff, logged |
| `new_message` → rendered for other clients | P95 < 500 ms | two-client harness |
| `my-chats` query count | ≤ 3 regardless of chat count | mongoose query counter |
| `my-chats` payload (50 chats) | < 40 KB | response size log |
| Message history page (100 msgs) payload | < 60 KB | response size log |
| DB queries per authenticated REST call (non-list) | ≤ 3 | query counter |
| WebSocket event size (reaction) | < 300 B | event serializer log |
| Largest chat image transferred to a viewer | ≤ 400 KB (web size) | media pipeline |
| Concurrent users on one API node (messaging only) | 2,000 | load test (k6 + socket.io-client) |
| Group call participants (if calls kept) | 8 with SFU, 4 with mesh | manual + WebRTC stats |

## Quick-win order (impact/effort)

1. Add `chatmembers` indexes (C2) — 1 line, huge.
2. Delta reaction events (H1) + stop full-message rebroadcast.
3. `my-chats` single pipeline + denormalised `lastMessageAt` (C1, H2).
4. Keyset pagination for history (C6).
5. Read-state = membership pointer only (C4).
6. `next/dynamic` the heavy chat-route chunks (H5).
7. Scope presence to shared rooms + Redis (C5, M5).
8. `sharp` media pipeline + relative URLs (H8).
