# Refactor Spec: Channels & Membership (was "Chats")

## 1. Current implementation
`chats` (type: private | group | channel | saved_messages) + `chatmembers` (string `channelId`/
`userId`, role, read pointer, pin/mute/ban/mutedByAdmin/isJoined, per-chat wallpaper cols).
`ChatController` = 30 handlers. `ChatService` = ~980 LoC. Roles duplicated in `chat.admins[]` +
`chatmembers.role`; bans in `chat.banned[]`. `GET /chats/my-chats` computes display name +
last-message + counts with N+1. No "add member" endpoint. Saved Messages + direct chats are
find-or-create side effects.

## 2. Current architecture
```
create → findOne(link) → chat.create → chatMembers.insertMany(members+admins) → chatMembers.create(owner)
my-chats → chatMembers.find → chat.find($in) → 2 aggregations → per private: chatMembers.find + user.findById
message send → chatMembers.findOne({channelId,userId})  [collection scan, no index]
```

## 3. Current problems
- **No `(channelId,userId)` index or unique constraint** on `chatmembers` (PERF C2) → scans + duplicate memberships under races.
- `my-chats` N+1 + over-fetch + no pagination + JS sort (PERF C1).
- **No add-member endpoint**; `/chats/new` step 3 is broken (creates DMs) — FEATURE_INVENTORY "Groups".
- Roles in two stores; sync loop `save()`s per member.
- `chat.banned[]` linear-scanned in ~8 hot paths (PERF H7).
- Side-effectful GETs (Saved Messages, direct).
- `channelId`/`userId` stored as strings, not refs.
- 30 endpoints incl. redundancies (`/chats` == `/chats/search`, `/:id/display` ⊂ `my-chats`).
- `GET /:id/members` says admin-only, checks only membership (SECURITY Z4).

## 4. Refactor goal
One indexed membership model, one role store, one bans model; `POST /channels/:id/members`;
one aggregation for the list; explicit (non-side-effect) creation; ~12 endpoints.

## 5. New architecture
```
channels/       ChannelService (use-cases) → ChannelRepository + MembershipRepository
chat_state       denormalised { channelId, lastMessageAt, lastMessagePreview, memberCount } maintained on events
roles            chatmembers.role only (owner|admin|member)
bans             chatmembers.isBanned (indexed) [or channel_bans collection]
GET /channels/mine      one $lookup/$facet aggregation → ChannelSummaryDto[], cursor-paginated
GET /channels/:id       ChannelDto (title, avatar, kind, myRole, memberCount|otherUser, wallpaper.effective, permissions)
POST /channels          explicit; type in body; owner = creator
POST /channels/:id/members     admin: add users        [NEW]
POST /channels/:id/invites     admin: create invite link/code   [NEW]
POST /channels/:id/join        self-join (by code or public)
POST /channels/:id/leave
PATCH /channels/:id            name/photo/description (owner+admin)
PATCH /channels/:id/roles      set admins (derived from membership)
POST/DELETE /channels/:id/bans/:userId
POST/DELETE /channels/:id/(pin|mute)            per-user membership flags
GET /channels/discover?q=      $text search, cursor
GET /channels/:id/members      admin/owner only (fixed)
GET /channels/:id/participants any member, minimal (mention autocomplete)
saved messages   POST /channels/saved (explicit) or auto on first app open, added to ChatType on both sides
direct           POST /channels/direct { userId } (explicit); returns existing or new
```

## 6. Backend changes
- Indexes: `chatmembers {channelId,userId} unique`, `{userId,isJoined}`, `{channelId,role}`, `{channelId,isBanned}`.
- De-dupe migration for existing membership rows before the unique index.
- `chat_state` doc + maintainers subscribed to `message.created|deleted`, `membership.changed`.
- Drop `chat.admins[]` (migrate → `chatmembers.role`), `chat.banned[]` (migrate → `isBanned`).
- One `MembershipGuard` + `ChannelAdminGuard`.
- `$text` search (chat text index already exists) with escaped input.
- Remove `/chats` (keep discover), `/:id/display`.

## 7. Frontend changes
- `useChannels()` (RQ) → one query, `select` per view; socket events patch the cache.
- `/app/new` sheet with Direct/Group/Channel/Discover tabs; real member-add for groups/channels.
- Members panel (admin) vs participants (any) — separate hooks.
- Delete `/contacts`, `/chats/search`, add-contact modal, `chats:invalidate` bus.

## 8. UI/UX
- List row anatomy: avatar (+presence for DM / group glyph), title, last-message preview (type icon + sender prefix in groups), time, unread badge / mention badge, mute glyph. Pinned float to top.
- Filter chips: All · Unread · Groups · Channels.
- Empty: "No conversations yet — start one." Error: keep last-good list + retry banner.
- Channel header: name + member count; group: name + "N members, M online"; DM: name + presence/last seen.
- Manage members: role change, remove, ban, mute — with confirms; owner-only for owner-level actions.
- Mobile: list full screen; panels are sheets. Desktop: 320px rail + reading pane + optional right panel.

## 9. Data contract
- `ChannelSummaryDto { id, kind, title, avatarUrl?, lastMessage?: {preview,at,type,senderName?}, unreadCount, unreadMentions, isPinned, isMuted, myRole }` — nothing else.
- `ChannelDto` adds `description?, memberCount?, otherUser?: PublicUserDto, wallpaper?: EffectiveWallpaper, permissions: {canPost,canPin,canManage}`.

## 10. Performance
- Membership check O(1) (was collection scan).
- `/channels/mine`: ≤ 3 queries for any chat count (was ~2 + 2·N_private); payload < 40 KB / 50 chats.
- Ban check indexed (was array scan ×8 paths).
- No per-chat `/unread` calls (count in the summary).

## 11. Migration
- Additive `/v1` endpoints alongside old ones.
- Migrations (idempotent, dry-run first): de-dupe memberships → add unique index; `chat.admins` → `chatmembers.role`; `chat.banned` → `isBanned`; backfill `chat_state`.
- Consistency cron comparing `chat_state` vs computed for 2 weeks.

## 12. Tests
- Query-count integration test for `/channels/mine` (≤ 3, any N).
- Concurrency test: 10 parallel joins → exactly 1 membership.
- Role migration reconciliation test; ban enforcement (REST send + history + WS room).
- Member-add flow e2e; discover search ReDoS test (pathological `q`).

## 13. Risks
- Unique index creation fails on dupes → gated on the de-dupe migration + count check.
- Denormalisation drift → consistency cron + self-heal.
- Role/ban migration is one-way → snapshot collections first.

## 14. Acceptance criteria
- `chatmembers` has the unique index; no duplicate memberships creatable.
- `/channels/mine` ≤ 3 queries, < 40 KB / 50 chats, cursor-paginated, no N+1.
- Groups/channels support admin member-add + invite links; `/chats/new` step 3 works.
- One role store, one bans model; `chat.admins[]`/`chat.banned[]` gone.
- No side-effectful GET creates data.
- Endpoint count ≤ 14 (from 30).
