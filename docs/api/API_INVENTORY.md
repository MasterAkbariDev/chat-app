# API Inventory (REST)

Base URL: `NEXT_PUBLIC_API_URL` (default `http://localhost:3000`). **No global route prefix**
(`main.ts` sets none; the frontend's `resolveApiUrl` has dead handling for a `/api` prefix).
All protected routes: `Authorization: Bearer <jwt>`. Global `ValidationPipe({ whitelist, transform })`.
Swagger UI: `/docs`.

Auth model: per-handler `@UseGuards(JwtAuthGuard)`. **There is no global guard** — every unguarded
handler is public. `JwtStrategy.validate` re-reads the user from Mongo on every request
(checks `isDeleted` + `tokenVersion`).

Legend — **Consumers**: frontend call sites. **Problems / Optimization** are the audit notes.

---

## Health

### `GET /`
- **Purpose:** health check → `{ message, date }`.
- **Auth:** none. **DB:** none.
- **Consumers:** none in frontend.
- **Problems:** trivial; fine.

---

## Auth (`/auth`) — `auth/auth.controller.ts`

### `POST /auth/register`
- **Purpose:** create account, return `{ access_token, user }`.
- **Auth:** public. **Request:** `CreateUserDto` (email, username, password≥6, firstName?, lastName?, phoneNumber?).
- **DB:** `user.findOne(email)`, `user.findOne(username)`, `user.save()` (3 queries).
- **Response:** `{ access_token, user }` where `user` is the **raw Mongoose doc** (differs from login/profile shape).
- **Consumers:** `auth-context.register`.
- **Problems:** no verification, no throttle, no captcha; inconsistent user shape; `phoneNumber` unvalidated.
- **Optimization:** combine the two uniqueness lookups into one `$or` query; normalise response via a `PublicUser` mapper.

### `POST /auth/login`
- **Purpose:** email **or** phone + password → `{ access_token, user }`.
- **Auth:** public. **Request:** `LoginDto` (`ValidateIf` email/phone, password≥6).
- **DB:** `user.findOne($or)` (1).
- **Problems:** relies on Mongoose `_doc` internal; no rate limit / lockout; response shape ≠ profile.

### `POST /auth/profile`
- **Purpose:** current user profile.
- **Auth:** JWT. **DB:** `user.findByEmail` (1) — note it looks up by **email from the token**, not id.
- **Consumers:** `auth-context` (first load only, when no cached user).
- **Problems:** `POST` for a read; lookups by email; throws 404 instead of returning null; `findByEmail` returns full doc minus password.

### `POST /auth/logout-all`
- **Purpose:** bump `tokenVersion`, return fresh token for this device.
- **Auth:** JWT. **DB:** `findOneAndUpdate($inc tokenVersion)` + `findOne` (2).
- **Consumers:** `auth-context.logoutAllSessions` — **no UI button**.
- **Problems:** dead from UI; all-or-nothing (no per-device revoke).

### `POST /auth/change-password`
- **Purpose:** verify current, set new, bump `tokenVersion`, return fresh token.
- **Auth:** JWT. **Request:** `ChangePasswordDto`. **DB:** `findOne` + `findOneAndUpdate` (2).
- **Consumers:** `profile/change-password/page.tsx`.

---

## Users (`/users`) — `user/user.controller.ts`

> **Route-ordering hazard:** `GET /users/:username` and `GET /users/:userId/status` are declared
> **after** `GET /users/search`, `/users/by-id/:userId`, `/users/blocked`, `/users/block/check/:userId`.
> `search`, `blocked` work only because they're registered first. Any new literal route added
> after `:username` would be shadowed.

### `POST /users`
- **Purpose:** update current user (partial). **Auth:** JWT. **Request:** `UpdateUserDto` (email?, username?, firstName?, lastName?, image? [note: DTO field is `image`], bio?, bigEmojis?).
- **DB:** optional username-uniqueness `findOne` + `findOneAndUpdate` (1–2).
- **Consumers:** `profile/edit`, `profile/page` (avatar, bigEmojis), `chat` (n/a).
- **Problems:** `POST` for update (should be `PATCH`); `image` vs `avatarUrl` naming mismatch with frontend + schema-vs-DTO; no `user_profile_updated` broadcast; password change not allowed here (good) but `email` change is allowed with no re-verification.

### `PATCH /users/quick-reaction`
- **Purpose:** set `quickReaction` emoji. **Auth:** JWT. **Body:** `{ emoji }`.
- **DB:** `findOne` (via `findOne(userId)`) + `updateOne` (2).
- **Consumers:** `profile/page`.
- **Problems:** does a full `findOne` just to validate existence; `@ApiParam` doc says "param" but it's a body field.

### `GET /users/search?q=&limit=&offset=`
- **Purpose:** substring search over username/email/firstName/lastName/phoneNumber.
- **Auth:** JWT. **DB:** regex `find` (no index) + `select(-password -__v -isDeleted)`.
- **Consumers:** `contacts`, `chats/new`, chat admin "add".
- **Problems:** **email + phone enumeration**; returns `email`, `phoneNumber`, `lastSeen`, `isOnline` of arbitrary users; collection scan.
- **Optimization:** restrict to username/name; add a text index; return `{id, displayName, username, avatar}` only; require a min query length.

### `GET /users/by-id/:userId`
- **Purpose:** user by id (blocked-check). **DB:** `isBlocked` + `findOne` (2).
- **Consumers:** `user-profile-modal`, chat page.
- **Problems:** returns full user doc (minus password); `isBlocked` short-circuits invalid ids to `false`.

### `GET /users/:username`
- **Purpose:** user by username. **DB:** `findByUsername` (1) + `isBlocked` (1).
- **Problems:** `findByUsername` returns a **hand-picked subset** (`image, bio, firstName, lastName, lastSeen, username, _id`) — no avatar in the resolved shape frontend expects; declared `| null` but throws 404.
- **Consumers:** `usersApi.getByUsername`, `chat` username-click.

### `GET /users/:userId/status`
- **Purpose:** `{ userId, username, email, lastSeen }`. **DB:** `findById.select(...)` (1).
- **Problems:** leaks `email` in a "status" response; real-time status is WS-only.

### `GET /users/blocked`
- **Purpose:** array of blocked user ids. **DB:** `find` (1).

### `GET /users/block/check/:userId`
- **Purpose:** `{ blocked: boolean }` — has *that* user blocked me. **DB:** `findOne` (1).

### `POST /users/block/:userId` · `DELETE /users/block/:userId`
- **Purpose:** block / unblock. **DB:** `findOne`+`create` / `deleteOne`. Unblock emits `user_unblocked_you`.
- **Problems:** block only affects WS `new_message` fan-out in private chats (not history, not REST send, not reactions, not calls).

### `DELETE /users/:id`
- **Purpose:** soft-delete self (`isDeleted=true`, bump `tokenVersion`). Path id must equal token id.
- **Problems:** no data cleanup (memberships, messages, blocks, uploads orphaned); soft-deleted user still referenced by name in others' chats/messages.

---

## Chats (`/chats`) — `chat/chat.controller.ts` (30 handlers)

> **Route-ordering hazard:** literal routes (`search`, `link`, `preview/:id`, `saved-messages`,
> `my-chats`, `direct/:userId`) are declared **before** `GET /` and `GET /:channelId/*`. It works
> today but is fragile — several `:channelId`-prefixed routes (`/:channelId/pin`, `/mute`,
> `/ban/:userId`, `/participants`, `/members`, `/tags`, `/display`, `/banned`) sit **above**
> `GET /` and `GET /link`. Adding a new bare `GET /:something` would collide.

### `POST /chats/create`
- **Request:** `CreateChatDto` (name, link, type, admins?, members?, description?, image?[], tags?).
- **DB:** `findOne(link)` + `chat.create` + `chatMembers.insertMany` + `chatMembers.create(owner)` (4+).
- **Consumers:** `chats/new`.
- **Problems:** `link` uniqueness raced (findOne then create; there is a unique index so create can 500); `members`/`admins` accepted but web UI never sends them; no membership de-dupe.

### `POST /chats/update/:channelId`
- **Request:** `UpdateChatDto` (link?, name?, admins?, description?, image?[]).
- **DB:** owner check + `findOne` + `findOneAndUpdate` + (if admins) per-member `find`/`save` loop + `user.findOne` per username (many).
- **Problems:** owner-only (admins can't edit name/photo); admin sync loop; emits `channel_roles_updated`; `description`/`image` only applied here (not on create for groups from UI).

### `POST /chats/subscribe?channelId=` · `POST /chats/unsubscribe?channelId=`
- **subscribe:** join; ban check; re-activate `isJoined`; posts `member_joined` system message for channel/group.
- **unsubscribe:** private → `isJoined=false` + `updateMany($addToSet deletedFor)` over **all messages**; else `deleteOne` membership.
- **Problems:** channelId as query param (inconsistent with path style elsewhere); unsubscribe from private is O(messages); returns `true/false` (swallows errors).

### `GET /chats/my-chats`
- **Purpose:** joined chats + computed display fields + last-message + member counts + membership flags.
- **DB:** `chatMembers.find` + `chat.find($in)` + 2 aggregations + **per private chat**: `chatMembers.find` + `user.findById` (N+1).
- **Consumers:** `chat-list`, `app-shell` (mute map), `contacts`.
- **Problems / Optimization:** see FEATURE_INVENTORY "Chat list". Biggest single perf offender. No pagination. Over-returns.

### `GET /chats/saved-messages`
- Find-or-create the user's Saved Messages chat.

### `GET /chats/direct/:userId`
- Find-or-create private chat; controller then calls `chatGateway.notifyNewChat` for **both** users.
- **Problems:** side-effectful GET; `console.error` on gateway failure; two WS emits per call.

### `GET /chats/search?q=` and `GET /chats?keyword=`
- Same service method (`findChat`) wired twice. Regex on name/link, excludes `saved-*`. Returns full docs.

### `GET /chats/link?link=`
- Chat by link; 400 if missing. Used to resolve `@username`/channel links.

### `GET /chats/preview/:channelId`
- Channel/group info without membership; private → auto-subscribe; banned → 403; adds `membersCount`.

### `GET /chats/:channelId/display`
- `{ displayName }` — for private, the other member's name; else chat name. **Redundant** with `my-chats` output.

### `GET /chats/:channelId/participants`
- Member list (any member) for mention autocomplete: `{userId, username, firstName, lastName, avatarUrl, role}` minus banned.
- **DB:** membership check + chat + `chatMembers.find` + `user.find($in)` (4).

### `GET /chats/:channelId/members`
- Management list (any member can call, despite `@ApiOperation` saying admin/owner) with `isBanned`, `mutedByAdmin`.
- **Problems:** doc says admin-only; code only checks membership → any member sees the full management list.

### `GET /chats/:channelId/banned`
- Banned users (admin/owner). **DB:** chat + membership + `user.find($in)` (3).

### `POST /chats/:channelId/ban/:userId` · `DELETE .../ban/:userId`
- Ban: `$addToSet chat.banned` + `chatMembers.deleteOne` + `chat_banned` WS. Unban: `$pull`.

### `POST /chats/:channelId/mute-member/:userId` · `DELETE` (groups only)
- `chatmembers.mutedByAdmin` + `user_muted` WS. Owner can mute admins; admins can't mute admins.

### `POST /chats/:channelId/pin` · `DELETE` (per-user) — `chatmembers.isPinned`
### `POST /chats/:channelId/mute` · `DELETE` (per-user) — `chatmembers.isMuted`
### `POST /chats/:channelId/tags` — `{ tags }`, any member, `chat.tags`.
### `DELETE /chats/delete/:channelId`
- Owner-only (private: any member). `chat.isDeleted=true` + `chatMembers.deleteMany` + `message.updateMany(isDeleted)`.
- **Problems:** hard-scans; no soft "leave then archive"; messages soft-deleted but not purged.

---

## Messages (`/messages`) — `message/message.controller.ts` (19 handlers)

> Controller injects `ChatGateway` and calls `notifyMessageUpdated`/`notifyMessageDeleted` for
> edit/reaction/delete, but **not** for `POST /messages` create → REST-created messages are not broadcast.

### `POST /messages`
- **Request:** `CreateMessageDto` (channelId, content|attachments, type?, attachments?, replyTo?, duration?, tempId?, forwardFrom?).
- **DB:** ~6–10 sequential queries (see FEATURE_INVENTORY "Text messaging").
- **Problems:** no broadcast; `duration` accepted but not stored; heavy per-call.

### `GET /messages/channel/:channelId?limit=&offset=&afterDate=&beforeDate=`
- Paginated history (max 100, default 100), `sort createdAt desc` then `.reverse()`. Excludes `deletedFor: me`, `isDeleted`, and (channels) `type: system`.
- **DB:** chat + membership + `find().limit().skip().populate(sender).populate(replyTo)` (3).
- **Problems:** `skip`-based pagination (slow deep); `populate(replyTo)` over-fetches; banned check via array `.some`.

### `GET /messages/channel/:channelId/first-of-date?date=` · `/first-from-date?date=` · `/oldest`
- Date-jump helpers. Each repeats the full chat+ban+membership guard then one `findOne.sort`.
- **Problems:** guard code duplicated ~5×; could be one endpoint `?date=&mode=`.

### `GET /messages/channel/:channelId/search?q=&limit=`
- Returns `{ messageIds, total }`. `q === '@'` → `mentions: userId`; else `content` regex `i`.
- **Problems:** no text index; up to 500 ids; `total` is a second `countDocuments`.

### `GET /messages/channel/:channelId/pinned`
- Full pinned messages (sender + replyTo populated).

### `GET /messages/channel/:channelId/unread`
- Count of messages after `lastReadMessageId` timestamp, not system, not mine.
- **Consumers:** chat-list calls this **per chat**.

### `GET /messages/channel/:channelId/unread-mentions?limit=` · `/unread-reactions?limit=`
- List + count. `unread-reactions` uses `$expr $objectToArray` on `reactions` (**unindexable**).

### `POST /messages/channel/:channelId/read` — `{ lastReadMessageId }`
- Sets membership `lastReadMessageId/At` + `updateMany` `readBy.<uid>=now` over history ≤ target.
- **Problems:** write amplification (see FEATURE_INVENTORY "Read receipts").

### `GET /messages/:messageId`
- Single message (membership required).

### `PUT /messages/:messageId` — `{ content }` (MinLength 0). Sender-only. Re-resolves mentions. Broadcasts `message_updated`.

### `POST /messages/:messageId/reaction` — `{ emoji }` toggle. Records `emoji_usage`. Broadcasts full message.
### `POST /messages/:messageId/quick-reaction` — uses `user.quickReaction`. Broadcasts full message.

### `POST /messages/:messageId/pin` · `DELETE .../pin`
- Admin/owner in group/channel; any member in private.

### `DELETE /messages/:messageId` — soft-delete for everyone (sender/admin/owner). Broadcasts `message_deleted`.
### `POST /messages/:messageId/delete-for-me` — `$addToSet deletedFor`.

---

## Upload (`/upload`) — `upload/upload.controller.ts`

### `POST /upload` — multipart `file`, ≤250 MB, **all types accepted**. SHA-256 dedupe (`upload_records`). Returns `{ url, originalFilename }`.
### `POST /upload/image` — multipart `file`, ≤10 MB, `jpg|jpeg|png|gif|webp`. Returns `{ url }`.
- **Problems:** absolute URLs from `Host` header; no resize/thumbnail/transcode; no AV scan; no per-user quota; `originalFilename` returned but callers don't persist it on the message.

---

## GIFs (`/gifs`) — all JWT — `gif/gif.controller.ts`

### `GET /gifs?mine=&limit=&offset=`
- `mine=true` → flat paginated library. Else `browse()` → `{ mine, trending, settings }`.
- **Problems:** `trending` = `$group` aggregation over all public gifs each call.

### `POST /gifs/:gifId/use` — bump `usageCount`/`lastUsedAt` (`updateMany` by filename for public).
### `POST /gifs/upload` — multipart video ≤50 MB → ffmpeg → gif; returns GifItem.
### `POST /gifs` — `{ id }` publish to public.
### `POST /gifs/mine` — `{ id } | { url }` add to library (url must be `/uploads/gifs/…`).
### `DELETE /gifs/mine/:gifId` — remove from library (soft if public).

---

## Stickers (`/stickers`) — all JWT — `sticker/sticker.controller.ts`

### `POST /stickers/packs` — `CreateStickerPackDto` (name, stickers: URL[]).
### `GET /stickers/packs?public=&limit=&offset=` — public + own.
### `GET /stickers/packs/search?q=` — public, name/description/tags regex.
### `GET /stickers/packs/:packId` — pack detail (public or owner).
### `POST /stickers/packs/:packId/stickers` — `{ stickers: URL[] }` add to own pack.
### `POST /stickers/bot/create-from-message` — **always throws** `BadRequestException`. Dead.

---

## Emoji usage (`/emoji-usage`) — JWT

### `GET /emoji-usage/me` — `{ emoji: {emoji,count}[], reactions: {emoji,count}[] }` (top 60 / 24).

---

## Wallpapers v2 (`/v2/wallpapers`) — all JWT — `wallpaper/wallpaper.controller.ts`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v2/wallpapers/upload/image` | upload image ≤15 MB, dedupe, rate-limited (10/10min in-memory) |
| POST | `/v2/wallpapers/upload/video` | upload video ≤20 MB → probe/clip ≤5s → thumbnail |
| GET | `/v2/wallpapers/global` | current user's global wallpaper |
| PATCH | `/v2/wallpapers/global` | `ApplyWallpaperDto` → **creates a new Wallpaper doc** + sets `user.globalWallpaperId` |
| DELETE | `/v2/wallpapers/global` | clear |
| GET | `/v2/wallpapers/chat/:channelId` | per-chat wallpaper (with membership visual overrides) |
| GET | `/v2/wallpapers/effective/:channelId` | resolved: chat > global > null |
| PATCH | `/v2/wallpapers/chat/:channelId` | apply to chat + post `system` message + `wallpaper_updated` |
| DELETE | `/v2/wallpapers/chat/:channelId` | reset per-chat |
| GET | `/v2/wallpapers/:id` | **no ownership check** — any authed user reads any wallpaper doc |
| POST | `/v2/wallpapers/:id/accept` | copy settings to membership |
| POST | `/v2/wallpapers/:id/decline` | **no-op** |
| PATCH | `/v2/wallpapers/:id/settings` | owner-only visual params update |

- **Problems:** new doc per apply → unbounded growth; `getById` unauthorised read; `decline` dead; ffmpeg dependency.

---

## Config Logs (`/config-logs`) — **no JWT** — `config-log/config-log.controller.ts`

### `POST /config-logs` — `{ password, message }`
- Password compared to `process.env.CONFIG_LOG_PASSWORD ?? "change-this-config-password"` (**note:** `.env.example` documents `CONFIG_BOT_PASSWORD` — different variable). Auto-creates `config-bot` user + `configs` channel; posts message; emits `new_message`.
- **Problems:** unauthenticated write path with a hardcoded default password; creates DB records as a side effect. **Remove or lock down (P0).**

---

## Cross-cutting API problems

1. **No consistent response envelope** — some endpoints return raw docs, some `{ data, pagination }`, some `true`, some `{ success }`, some `void`. Frontend `api.ts` has per-endpoint `.then(r => Array.isArray(r) ? r : r.data)` shims.
2. **`POST` used for reads and updates** (`/auth/profile`, `/users`). Should be `GET`/`PATCH`.
3. **`skip`/`offset` pagination everywhere** — no cursors; deep pages are slow.
4. **Guard duplication** — the "chat exists + not deleted + not banned + membership (if private)" block is copy-pasted in ~8 message-service methods.
5. **Two sources for the same data** — `/chats/:id/display` vs `my-chats.displayName`; `/chats/search` vs `/chats`; `chat.admins` vs `chatmembers.role`.
6. **No rate limiting** anywhere (`@nestjs/throttler` not installed).
7. **CORS** defaults to `*` with `credentials: true` when `CORS_ORIGIN` unset (invalid combo; browsers reject, but the gateway separately hardcodes `origin: "*"`).
8. **Absolute media URLs** baked from request headers → environment-fragile.
9. **REST vs WS message create** — only WS broadcasts. Pick one write path.
10. **Swagger tag `access-token` vs guard** — Swagger declares bearer as `access-token`; fine, but there is no machine-readable contract shared with the frontend (types are hand-duplicated in `legacy-frontend/src/types`).
