# Refactor Spec: Roles, Bans & Admin Moderation

## 1. Current implementation
- **Roles:** `owner | admin | member`. Stored in **both** `chat.admins: ObjectId[]` and
  `chatmembers.role`. `POST /chats/update/:channelId { admins: [] }` accepts ids **or** usernames,
  normalises, updates `chat.admins`, then loops members `save()`-ing `role`, emits `channel_roles_updated`.
  Owner = creator, unchangeable.
- **Bans:** `chat.banned: ObjectId[]`. Ban (`POST /chats/:id/ban/:userId`) → `$addToSet` +
  `chatMembers.deleteOne` + `chat_banned` WS. Unban → `$pull`. Banned check = `banned.some(id => id.toString() === userId)` in ~8 hot paths. `GET /chats/:id/banned` (admin/owner).
- **Admin-mute member:** `chatmembers.mutedByAdmin` (groups only), blocks sending, `user_muted` WS. Owner can mute admins; admins can't mute admins.
- **Channel posting:** members can't post in `channel` type (checked in `message.service.create`).
- `GET /chats/:id/members` (management list) — doc says admin-only, code checks only membership.

## 2. Current problems
- **Two role stores** → drift; sync loop is per-member `save()` (PERF M9).
- **`chat.banned[]` linear scans** in ~8 places, no index (PERF H7).
- `chatmembers.isBanned` field **exists but is unused** (ban logic uses the array).
- `GET /:id/members` authz bug (any member sees management data) (SECURITY Z4).
- No ownership transfer; no ban reason/duration; no audit log; no "kick without ban".
- Ban asks the client to leave via `chat_banned` but the socket stays in the room until it disconnects (SECURITY Z6).
- Admin can't edit channel name/photo (owner-only `update`).

## 3. Refactor goal
Single role store, indexed bans, correct authz, ownership transfer, kick vs ban, an audit trail,
server-enforced room removal.

## 4. New architecture
```
roles: chatmembers.role ONLY (owner|admin|member). "admins" in any DTO is derived.
PATCH /v1/channels/:id/members/:userId/role { role }   (owner sets admin/member; owner→owner = transfer)
POST  /v1/channels/:id/members/:userId/kick            (admin: remove membership, no ban)
POST  /v1/channels/:id/bans   { userId, reason?, until? }   → chatmembers.isBanned + ban record
DELETE /v1/channels/:id/bans/:userId
POST/DELETE /v1/channels/:id/members/:userId/mute       (admin-mute, groups)
GET   /v1/channels/:id/members    (admin/owner) — full ; /participants (any) — minimal
moderation_log { channelId, actorId, action, targetId?, meta, at }   (append-only)
on ban: realtime forces the target's sockets to leave channel:<id> (server-side socket.leave), emits channel:banned
posting rule: permissions.canPost computed server-side and returned on ChannelDto
```

## 5. Backend changes
- Drop `chat.admins[]` (migration → `chatmembers.role`); remove the sync loop.
- Bans → `chatmembers.isBanned` (indexed `{channelId, isBanned}`) + a `channel_bans` record for reason/until/audit; drop `chat.banned[]` scans (a single `isBanned` field on the membership the guard already loads).
- Ban with expiry → a job or lazy check unbans on `until`.
- Fix `GET /:id/members` to require admin/owner.
- `ChannelAdminGuard` / `ChannelOwnerGuard`.
- Ownership transfer endpoint; the old owner becomes admin.
- On ban, iterate the target's sockets in `channel:<id>` and `socket.leave` server-side.
- `moderation_log` written by a subscriber to role/ban/mute/kick events.
- Channel edit allowed for admins (name/photo/description); owner-only for delete + role changes + transfer.

## 6. Frontend changes
- Members panel (admin): role dropdown (Owner shows "Transfer ownership" with a strong confirm), Kick, Ban (with reason), Mute.
- Banned list panel with reason + unban.
- `permissions` from `ChannelDto` drives composer + menu (no client-side role guessing).
- Handle `channel:banned` → close the chat + toast; the socket is already removed server-side.
- Optional: moderation log view for owners.

## 7. UI/UX
- Role change: inline dropdown, immediate, toast; `channel_roles_updated` patches everyone's UI.
- Ban dialog: reason (optional), duration (Permanent / 1d / 7d), "They'll be removed and can't rejoin."
- Kick: "Remove <name>? They can rejoin via the link." (softer than ban).
- Transfer ownership: type the channel name to confirm.
- Channel non-admin composer: disabled with "Only admins can post in this channel."
- Admin-muted member: "You're muted in this group by an admin."

## 8. Data contract
`ChannelDto.permissions { canPost, canPin, canManage, canDelete }`.
`ChannelMemberDto { user: PublicUserDto, role, isBanned, mutedByAdmin, joinedAt }`.
`channel:roles { channelId, roles: [{ userId, role }] }` (delta).
`channel:banned { channelId, userId }`.

## 9. Performance
- Ban check = a field on the membership row the guard already loads (0 extra queries; was an array load + scan).
- Role sync = `bulkWrite` / single field update (was per-member `save()`).

## 10. Migration
- `chat.admins[]` → `chatmembers.role` reconciliation (owner from the existing OWNER row; admins from the array); verify counts; then drop the array.
- `chat.banned[]` → set `chatmembers.isBanned=true` for those users (re-create tombstone memberships if deleted) + `channel_bans` records; drop the array.
- Snapshot both collections first.

## 11. Tests
- Role migration reconciliation (no lost admins/owners).
- Ban: target removed from membership + sockets left server-side + can't rejoin + can't read history/send.
- Kick vs ban distinction.
- Ownership transfer (old owner → admin; only new owner can delete).
- `GET /:id/members` rejects non-admins.
- Ban expiry auto-unbans.
- `moderation_log` entries written.

## 12. Risks
- Ban migration for already-deleted memberships → need tombstone rows; verify the unique index handles them (`isBanned` + `isJoined:false`).
- Ownership transfer is high-impact → strong confirm + audit.

## 13. Acceptance criteria
- One role store (`chatmembers.role`); `chat.admins[]` gone.
- Bans are an indexed membership flag + an audit record; `chat.banned[]` scans gone.
- `GET /:id/members` is admin/owner-only.
- Banning a user removes their sockets from the channel room server-side.
- Ownership can be transferred; admins can edit channel metadata; only owner deletes.
- Every moderation action is logged.
