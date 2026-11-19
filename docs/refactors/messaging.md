# Refactor Spec: Messaging (text, replies, edit, delete, forward, pin, mentions)

## 1. Current implementation
`messages` collection; create via WS `send_message` (optimistic + `tempId` ack) or `POST /messages`
(**no broadcast**). `MessageService.create` = 6–10 sequential awaits (membership, chat, forward
lookup+user, mentions ×2, replyTo, private other-member rejoin, emoji-usage loop, create, then
`findById().populate(sender).populate(replyTo)`). Edit (sender only, re-resolves mentions,
`message_updated`), delete-for-everyone (soft, `message_deleted`), delete-for-me
(`$addToSet deletedFor`), forward (`forwardFrom` snapshot — avatar field mismatch), pin
(admin/owner, or anyone in private).

## 2. Current architecture
```
WS send_message → MessageService.create (persist) → gateway broadcast new_message to channel:<id>
REST POST /messages → MessageService.create → return  (NO broadcast — bug)
edit/react/delete via REST → controller calls gateway.notifyMessage*
```

## 3. Current problems
- **REST create is silent** (REALTIME #1). Two write paths, one broadcasts.
- 6–10 sequential queries per send (PERF C3); re-`findById().populate()` after create.
- `populate("replyTo")` returns the whole original message (PERF M2).
- `populate("senderId", "...email")` leaks email to the UI.
- `content` unsanitised server-side; no max length (SECURITY I1/I3).
- Reply silently force-adds the original sender to `mentions` (un-opt-out).
- Forward: `forwardFrom` avatar lost (schema `image` vs service `avatarUrl`); `duration` copied from a field that's never stored.
- Edit allows empty content (`@MinLength(0)`); no edit history / time limit.
- `deletedFor` grows unbounded (private-chat unsubscribe adds you to every message).
- Soft-deletes never purged.
- `skip`/`offset` history pagination (PERF C6).

## 4. Refactor goal
One write path, one event per message, cursor pagination, minimal message DTO, ≤ 3 queries per
send, sanitised content, fixed forward/reply/duration.

## 5. New architecture
```
POST /v1/channels/:id/messages   → MessageService.send (the ONLY persist path)
   guard: ChannelMemberGuard (+ not-banned + can-post)
   parallel: [membership already in guard ctx], reply snapshot lookup (projected), mention resolve
   persist → emit domain event message.created
WS send_message → thin wrapper → same MessageService.send (ack with server id + echo tempId)
realtime module subscribes message.created → fan out message:new {message, tempId?} exactly once
edit  → PATCH /v1/messages/:id → message.updated event (edit only)
delete→ DELETE /v1/messages/:id (everyone) | POST /v1/messages/:id/hide (me) → message.deleted event
forward→ POST .../messages { forwardOf: id } → copy content/media/duration + forwardFrom snapshot
pin   → POST/DELETE /v1/messages/:id/pin → channel.pinned.changed event
history→ GET /v1/channels/:id/messages?cursor=&limit=30  keyset on (createdAt,_id)
locate → GET /v1/channels/:id/messages/locate?anchor=messageId|date|oldest → returns a cursor window
```

## 6. Backend changes
- `MessageRepository`; `MessageDto` mapper.
- Schema: add `durationSec?`, `forwardFrom { userId, name, avatarUrl }` (fix field name), normalised `media[]`, drop the double `createdAt/updatedAt` `@Prop`s.
- Reply: store a `replySnapshot { messageId, senderName, snippet, type }` at send time (no runtime populate).
- Sanitise `content` (strip control chars; define allowed formatting); `@MaxLength(4000)`; `@MinLength(1)` on edit.
- Mentions: explicit only; do **not** auto-add reply target to `mentions` (track "replies to me" via `replyTo.senderId` in the attention query instead).
- Move emoji-usage + forward-snapshot enrichment to the `message.created` subscriber (off the hot path).
- Merge the 3 date-nav endpoints into `locate`.
- Purge job for `isDeleted` + retention (product decision).
- `deletedFor`: cap or move to a `message_hides` collection; private-chat leave should not touch every message (soft "left at" pointer instead).

## 7. Frontend changes
- `use-messages(channelId)` — RQ infinite query (keyset) + socket merge (append/replace/remove by id, patch reactions/reads via deltas).
- One optimistic path: temp message → `send` → reconcile on `message:new` by `tempId` → on error mark failed + retry.
- `<MessageItem>` + per-type renderers, `React.memo`.
- Deep-link `?m=` uses `locate`.
- Delete the manual "load until visible then scroll" loop → `locate` returns the window.

## 8. UI/UX
- Bubble: grouped corners, sender name (groups/channels, first in run), avatar (last in run), meta row (time · edited · ticks) inline for short / wrapped for long.
- Long-press / hover → action bar: reply, react, copy, forward, pin, edit (own), delete.
- Reply context strip in composer with cancel (Esc). Edit mode shows "editing" bar.
- Forward: dialog picker; forwarded bubble shows "Forwarded from <name>".
- Failed send: red retry affordance inline.
- System / call-log messages: centered pills, no avatar.
- Empty: kind-specific.

## 9. Data contract
`MessageDto { id, channelId, senderId, senderName, senderAvatarUrl?, type, text?, media?: [{url,kind,w?,h?,blurhash?,durationSec?}], reply?: {id,senderName,snippet,type}, forwardFrom?: {name,avatarUrl?}, edited, pinned, reactions: [{emoji,count,me}], mentionsMe: boolean, createdAt }`
— **no `readBy`, no full `reactions` map, no `deletedFor`, no `email`.**

## 10. Performance
- Send: ≤ 3 queries (was 6–10); no post-create re-fetch; P95 target < 400 ms.
- History page < 60 KB; keyset (no deep-skip scans).
- Reply/forward: no runtime populate.
- One `message:new` per persisted message (REST + WS unified).

## 11. Migration
- `/v1` message endpoints alongside old; WS `send_message` switched to the new service internally first (no client change), then REST.
- Backfill `replySnapshot` lazily on read for old messages (fallback to a light populate if missing).
- Old `mentions`-includes-reply-target data stays; new attention query handles both.

## 12. Tests
- Query-count on send (≤ 3); "one event per message" (REST + WS).
- Keyset pagination: no dupes/gaps across pages, stable under concurrent inserts.
- Optimistic send/fail/retry; reconcile by `tempId`.
- Sanitisation (XSS payloads inert in the DTO + rendered output).
- Forward preserves media + duration + snapshot; reply snapshot correct; edit rejects empty.

## 13. Risks
- Changing the reply model → keep a runtime-populate fallback for legacy messages.
- Removing auto-mention-on-reply changes "mentions" counts → the attention endpoint must cover replies explicitly (test).
- Unified event could double-fire during migration → feature-flag the REST broadcast.

## 14. Acceptance criteria
- Every persisted message (REST or WS) produces exactly one `message:new`.
- Send P95 < 400 ms; ≤ 3 DB queries.
- `MessageDto` carries no `readBy`/full-reactions/email.
- History is keyset-paginated; deep scroll is O(1) per page.
- Forward avatar + duration correct; reply is a snapshot; empty edits rejected.
- `content` sanitised server-side; max length enforced.
