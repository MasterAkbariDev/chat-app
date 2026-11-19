# Refactor Spec: Blocking

## 1. Current implementation
`blocks { blockerId, blockedId }` (unique compound). `POST/DELETE /users/block/:userId`,
`GET /users/blocked` (id array), `GET /users/block/check/:userId` (`{blocked}` — has *that* user
blocked me). Enforcement: the **gateway's `send_message`** filters `new_message` per recipient
socket in **private chats only** (`userService.isBlocked`). Profile reads of a blocker → 403.
Unblock emits `user_unblocked_you`.

## 2. Current architecture
```
block → blocks.create
send_message (private) → for each recipient socket → if isBlocked(recipient, sender) skip emit
GET /users/by-id|:username → if isBlocked(target, me) → 403
```

## 3. Current problems (SECURITY Z5)
- **Realtime-only enforcement.** Blocked user's messages are still **persisted** and reappear on
  `GET /messages/...` refetch / reload.
- Not enforced on: `POST /messages` (REST), reactions, `call_request`, history reads, `getOrCreateDirect`.
- Only private chats — a blocked user in a shared group is not filtered anywhere.
- `getBlockedUserIds` returns raw ids; the client fetches each user separately.

## 4. Refactor goal
Enforce block at the **domain layer** (write + read), consistently, in DMs and groups.

## 5. New architecture
```
block set cached in Redis per user (blockedBy + blocking sets)
message send (any path): if sender is blocked by any recipient in a DM → 403 "You can't message this person"
history read: exclude messages from users who block the reader (DM) ; in groups, the reader's client
  collapses messages from blocked users to "Blocked message" (kept, not deleted)
reactions / calls: rejected if blocked
new DM: blocked → cannot open a DM (button disabled with reason)
GET /v1/users/me/blocks → PublicUserDto[] (not just ids)
```

## 6. Backend changes
- `BlockService` with a Redis-cached membership check; invalidate on block/unblock.
- Enforce in `MessageService.send` (DM: reject if `isBlocked(recipient, sender)`), `ReactionService`, `CallsModule.request`, `ChannelService.direct`.
- DM history read: filter out messages from a user who blocks the reader.
- `GET /users/me/blocks` returns hydrated `PublicUserDto[]`.
- Keep the realtime per-socket filter as defence-in-depth.

## 7. Frontend changes
- `useBlocks()` (RQ) — hydrated list; `useIsBlocked(userId)`.
- DM composer disabled state: "You blocked this person" / "You can't reply".
- Group: messages from blocked users rendered as a muted "Blocked message — tap to show" collapse.
- Settings → Privacy → Blocked users list with unblock.

## 8. UI/UX
- Block from: user profile modal, DM header menu, message menu ("Block <name>").
- Confirm dialog: "They won't be able to message or call you. They won't be told."
- Unblock from the list or the DM header.
- Group behaviour explained once ("You've blocked this person; their messages are hidden").

## 9. Data contract
`GET /v1/users/me/blocks → PublicUserDto[]`. `403 { error: { code: "BLOCKED", message } }` on blocked actions.

## 10. Performance
- Redis-cached block check → O(1), no per-message `blocks.findOne`.
- Blocked-list screen: 1 request (hydrated) instead of N.

## 11. Migration
- Add domain-layer enforcement alongside the gateway filter.
- Backfill nothing (block data unchanged).
- Hydrated blocks endpoint replaces the id-array one.

## 12. Tests
- Blocked user: REST send → 403; reaction → 403; call → 403; open DM → blocked.
- DM history: blocker's messages excluded for the blocked reader.
- Group: blocked user's messages collapsed client-side, still fetchable ("show").
- Unblock restores everything; `user_unblocked_you` delivered.

## 13. Risks
- Group "collapse not hide" is a UX choice — confirm (a family app might prefer full hide). Default: collapse with reveal.
- Redis cache staleness → invalidate on write; short TTL fallback.

## 14. Acceptance criteria
- Block is enforced on message send (REST + WS), reactions, calls, DM creation, and DM history reads.
- Blocked user cannot get a message to the blocker by any path.
- Blocked-users settings screen shows hydrated profiles; unblock works.
- Block check does not hit Mongo per message.
