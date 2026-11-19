# Refactor Spec: Read Receipts & Unread State

> **RESOLVED (DECISIONS Q8): author-only, Telegram-style.** In DMs **and** groups, the message
> **author** can see who saw **their own** message; no one sees who saw someone else's.
> **Channels: no read data at all.** `GET /messages/:id/reads` → author + (DM|group) only, else
> 403/empty. Keep the "privacy toggle" idea as optional; default on. Delivery: BACKEND B5.

## 1. Current implementation
`mark_read` (WS) / `POST /messages/channel/:id/read` sets `chatmembers.lastReadMessageId` +
`lastReadAt`, then `messages.updateMany` writes `readBy.<userId> = now` on **every** message with
`createdAt <= target` (guarded for legacy array-vs-object `readBy`). Broadcasts `messages_read`
with the full `readBy`. Bubbles show ticks from `readBy`. Separate `/unread`, `/unread-mentions`,
`/unread-reactions` endpoints.

## 2. Current architecture
```
mark_read → chatmembers.updateOne(pointer) → messages.updateMany(readBy.<uid>=now, createdAt<=X)
          → server.emit messages_read {channelId, readBy, lastReadMessageId}
unread    → count messages after pointer timestamp, not mine, not system  (per chat, separately)
```

## 3. Current problems
- **Write amplification** (PERF C4): one catch-up read touches O(history) messages × writes.
- `readBy` Map grows to O(members) per message; shipped in full to every client (SECURITY D4).
- `getUnreadReactions` needs `$expr $objectToArray` → unindexable scan.
- Legacy-data guard proves prior schema churn.
- 3 unread endpoints; chat list calls `/unread` per chat (PERF H2).
- No "delivered" state.

## 4. Refactor goal
Read state = one pointer per membership. Ticks derived from timestamps. One delta event. Counts
folded into the channel summary. `readBy` map removed.

## 5. New architecture
```
POST /v1/channels/:id/read { lastReadMessageId }
  → chatmembers.updateOne({ lastReadMessageId, lastReadAt })   [1 write]
  → emit read:updated { channelId, byUserId, lastReadMessageId }
tick state (own messages): derived on the client from other members' lastReadAt vs the message's createdAt
  (DM: 1 other pointer; group: "read by N" from members' pointers, fetched lazily via GET /channels/:id/messages/:mid/reads)
unread counts: chat_state.lastMessageAt + membership.lastReadAt → computed in the /channels/mine aggregation
attention lists: GET /v1/channels/:id/attention → { unreadMentionIds, unreadReactionMessageIds }
```

## 6. Backend changes
- Delete `message.readBy`; migration drops the field.
- `markAsRead` = single `updateOne` on the membership pointer + event. No history `updateMany`.
- "Read by" for a specific message (group, on demand): query memberships where `lastReadAt >= message.createdAt` (indexed on `{channelId, lastReadAt}` if needed) — computed, not stored.
- Fold `unreadCount` into `/channels/mine`; single `/attention` endpoint replaces the 2 list endpoints.
- `getUnreadReactions`: with reactions moved to a `message_reactions` collection (see reactions spec), this becomes an indexed query `{channelId, createdAt > lastReadAt}` joined to reactions.

## 7. Frontend changes
- `use-read-tracking(channelId)` — IntersectionObserver on the last visible message → debounced `read` call; optimistic pointer.
- Tick component reads from a small `channelReadState` (peer pointers) in the RQ cache, patched by `read:updated`.
- Remove `messages_read` full-map handling; remove per-chat `/unread` loop.

## 8. UI/UX
- DM: single/double tick (sent/read) from the peer's pointer; timestamp on long-press.
- Group: "Seen by 4" chip on own messages, tap → list (lazy). No per-message eye-icons.
- List row unread badge from the summary; mention badge (`@`) takes priority.
- "Mark all as read" on long-press of a chat row.
- Privacy: Settings → "Send read receipts" toggle (`REQUIRES PRODUCT DECISION` — likely on by default for a family app, but offer it).

## 9. Data contract
- `read:updated { channelId, byUserId, lastReadMessageId }`.
- `GET /v1/channels/:id/messages/:mid/reads → { count, users?: PublicUserDto[] }` (users only if ≤ 20).
- `ChannelSummaryDto.unreadCount` / `unreadMentions`.

## 10. Performance
- Read = 1 write (was O(history) writes).
- Message payload shrinks (no `readBy`).
- No per-chat unread request (folded into one list query).
- `read:updated` event < 200 B.

## 11. Migration
- Add the pointer-only path; keep writing `readBy` for one release for old clients' ticks.
- Ship the new tick logic (from pointers) behind a client flag.
- Drop `readBy` writes, then the field, after old clients age out.

## 12. Tests
- "read touches exactly 1 document" (query-count).
- Tick correctness DM + group from pointers.
- Unread count in `/channels/mine` matches computed truth under concurrent sends.
- Privacy toggle: receipts suppressed both directions when off.

## 13. Risks
- "Seen by N" semantics change slightly (timestamp-based vs explicit) → acceptable; document.
- Old clients lose ticks during migration window → keep `readBy` writes until they age out.

## 14. Acceptance criteria
- `message.readBy` removed.
- `read` performs 1 DB write regardless of history size.
- Unread counts come from the single list query; no per-chat `/unread` calls.
- `read:updated` is a delta < 200 B.
- Read receipts have a privacy toggle.
