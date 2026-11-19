# Refactor Spec: Reactions & Quick Reaction

## 1. Current implementation
`message.reactions: Map<emoji, userId[]>`. `POST /messages/:id/reaction {emoji}` toggles;
`POST /messages/:id/quick-reaction` uses `user.quickReaction` (default 👍, settable via
`PATCH /users/quick-reaction`). Each toggle: `findById` → mutate Map → `findByIdAndUpdate` →
`findById().populate(sender).populate(replyTo)` (3–4 queries), records `emoji_usage`, then
broadcasts the **whole message** as `message_updated`. Double-tap in the bubble = quick reaction.

## 2. Current architecture
```
tap emoji → messagesApi.reaction → service (4 queries) → gateway.notifyMessageUpdated(FULL message) → all members
```

## 3. Current problems
- 3–4 queries per toggle (PERF M1).
- Full-message rebroadcast per toggle (PERF H1) → bubble subtree re-render for everyone.
- `reactions` Map is unindexable → `getUnreadReactions` uses `$expr` scan.
- No server cap on distinct emojis (UI shows 6, server unbounded).
- `emoji_usage` write per reaction (PERF M4).

## 4. Refactor goal
One write per toggle, delta event, queryable reactions, server cap, `emoji_usage` gone.

## 5. New architecture
```
message_reactions collection: { messageId, channelId, emoji, userId, createdAt }
  indexes: {messageId, userId, emoji} unique ; {messageId} ; {channelId, createdAt}
POST /v1/messages/:id/reactions { emoji }  → upsert/delete one row (1 op) → emit reaction:changed {messageId, emoji, delta, byUserId}
quick reaction: client sends the user's quickReaction emoji to the same endpoint (no separate route)
MessageDto.reactions: [{ emoji, count, me }]  (aggregated, small)
```

## 6. Backend changes
- New `message_reactions` collection + repository; drop `message.reactions` Map (migration flattens it).
- `ReactionService.toggle` = one `updateOne(upsert)` or `deleteOne` + emit delta.
- Aggregate `[{emoji,count,me}]` in the `MessageDto` mapper (one `$group` per message page, batched).
- Cap distinct emojis per message (e.g. 20) — reject beyond.
- Remove `POST /messages/:id/quick-reaction` (client resolves the emoji).
- Delete `emoji_usage` collection + the per-message write; recents move client-side.
- Attention/"unread reactions": indexed query on `message_reactions {channelId, createdAt > lastReadAt, userId != me}`.

## 7. Frontend changes
- `use-reactions` patches the RQ message cache from `reaction:changed` (increment/decrement the pill).
- Double-tap → send `user.quickReaction` to `/reactions`.
- Recent emojis: `localStorage` list, updated on pick; seed the picker.
- Remove full-message replace on `message_updated` for reactions.

## 8. UI/UX
- Reaction pills under the bubble: `emoji count`, `me` highlighted, tap toggles, long-press → "reacted by" list.
- Picker: recents row + categories + search; skin-tone support.
- Quick reaction configurable in Settings → Appearance (keep).
- Optimistic toggle with rollback on error.

## 9. Data contract
- `reaction:changed { messageId, emoji, delta: 1 | -1, byUserId }` — < 300 B.
- `MessageDto.reactions: [{ emoji, count, me }]`.
- `GET /v1/messages/:id/reactions?emoji= → PublicUserDto[]` (lazy, for the list).

## 10. Performance
- Toggle: 1 op (was 3–4) + delta event (was full message).
- "Unread reactions" becomes an indexed query.
- `emoji_usage` writes eliminated.

## 11. Migration
- Backfill `message_reactions` from the `reactions` Map (one script).
- Serve `MessageDto.reactions` from the new collection; keep writing the Map for one release for old clients, then drop.
- Delta event behind a client flag alongside `message_updated`.

## 12. Tests
- Toggle idempotency + count correctness under concurrency.
- Delta patch on the client cache.
- Emoji cap enforced.
- "Unread reactions" query uses an index (`explain`).

## 13. Risks
- Aggregating reactions per message page adds a `$group` — batch it (one aggregation for the page, keyed by messageId) and index `{messageId}`.
- Old clients need the Map during migration → dual-write briefly.

## 14. Acceptance criteria
- `message.reactions` Map removed; `message_reactions` collection with indexes.
- Toggle = 1 DB op + 1 delta event < 300 B.
- No `emoji_usage` collection / per-message emoji write.
- Server enforces a distinct-emoji cap.
- Bubble re-renders only the reacting message's pill, not the subtree, and only for affected clients.
