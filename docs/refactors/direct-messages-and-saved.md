# Refactor Spec: Direct Messages & Saved Messages

## 1. Current implementation
- **DM:** `GET /chats/direct/:userId` → `findOrCreatePrivateChat` with link
  `private-<sortedId1>-<sortedId2>`, `type: private`, `name: "Private"`. Controller then calls
  `chatGateway.notifyNewChat` for **both** users (side effect on a GET). Display name recomputed
  per `my-chats` by loading the other member + their user doc.
- **Saved Messages:** `type: saved_messages`, link `saved-<userId>`, auto-created inside
  `findUserJoinedChatsWithDisplay` (side effect of a GET). Excluded from discovery. Frontend
  `ChatType` enum **doesn't include `saved_messages`**.
- **Leave DM:** `unsubscribe` sets `isJoined=false` **and** `messages.updateMany($addToSet
  deletedFor: me)` over the entire history. Re-messaging silently re-joins (`message.service.create`).

## 2. Current problems
- Side-effectful GETs (creation + WS emit).
- DM `name` is `"Private"`; display name recomputed every list load (extra queries per DM — PERF C1).
- Leave-DM is O(history) writes; "delete conversation" semantics are muddled with "leave".
- `saved_messages` type unknown to the frontend enum → rendered as a fallback.
- Link exposes both raw user ids (SECURITY D6).
- `getOrCreateDirect` doesn't check block (SECURITY Z5) — see blocking spec.

## 3. Refactor goal
Explicit DM creation, cheap display name, clean "hide vs leave", Saved Messages as a first-class
concept on both sides, opaque link.

## 4. New architecture
```
POST /v1/channels/direct { userId }
  → block check ; returns existing or creates { kind: "direct", participants: [me, other] }
  → link: opaque nanoid (not id-derived)
  → emit channel.created to both users (from the service event, not the controller)
display name: resolved by the /channels/mine aggregation via one $lookup on the DM peer (PublicUserDto fields)
"Hide conversation": chatmembers.hiddenAt = now  → excluded from the list; un-hidden on next message; NO per-message writes
"Clear history for me": chatmembers.clearedBeforeMessageId  → history query filters createdAt > that message; NO deletedFor writes
Saved Messages: kind "saved" ; POST /v1/channels/saved (idempotent) called on first app open ; added to the shared enum
```

## 5. Backend changes
- `ChannelService.direct` (explicit, block-aware, emits event).
- Replace `deletedFor` on leave-DM with a `clearedBeforeMessageId` pointer on the membership.
- `hiddenAt` pointer for "remove from list".
- `my-chats` aggregation resolves the DM peer in one `$lookup` (no per-DM `user.findById`).
- Add `saved` to `ChatType` (backend) and to the generated frontend enum.
- Opaque link generation; migrate existing links lazily (keep resolvable).

## 6. Frontend changes
- Start-DM from `/app/new?tab=dm` or a user profile → `POST /channels/direct`.
- DM row: peer avatar + name + presence.
- Swipe / menu: "Hide" (soft), "Clear history", "Block", "Delete DM" (both sides — needs confirm + peer notification, or just "leave").
- Saved Messages pinned at the top with a bookmark glyph; "Forward to Saved" from any message menu.

## 7. UI/UX
- Hidden DM reappears (top) when the peer messages, with the new message.
- "Clear history" confirm: "Only for you. <name> still sees the messages."
- Saved Messages: no presence, no typing, self-only; used as a personal scratchpad / bookmark store.

## 8. Data contract
`ChannelSummaryDto` for a DM includes `otherUser: PublicUserDto`. `kind: "direct" | "saved" | "group" | "channel"`.

## 9. Performance
- Leave/clear DM: O(1) pointer write (was O(history)).
- DM display name: 1 `$lookup` in the list pipeline (was N+1).

## 10. Migration
- New explicit endpoint; keep `GET /chats/direct/:id` resolving during transition (no side-effect emit — move that to the event).
- `deletedFor` stays readable; new leaves use the pointer; a cleanup job can prune old `deletedFor` arrays later.
- Backfill `saved` kind on existing `saved_messages` chats.

## 11. Tests
- `POST /channels/direct` idempotent; block-aware; emits one `channel.created` per user.
- Hide → peer messages → reappears with the message.
- Clear history → only the clearer's view filtered; peer unaffected; no message writes.
- Saved Messages: created once, self-only, forward-to works.

## 12. Risks
- Changing leave semantics may surprise users who relied on "unsubscribe hides everything" — the pointer model is equivalent from the UI.
- Opaque link migration → keep the id-derived resolver as a fallback.

## 13. Acceptance criteria
- DM creation is an explicit POST; no GET creates a channel or emits WS.
- Leave/clear DM is O(1) (pointer), not O(history).
- DM display name resolved in the list pipeline (no N+1).
- `saved` is a known kind on both backend and frontend.
- DM links are opaque.
