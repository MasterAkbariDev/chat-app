# Feature Inventory

Every feature confirmed to exist in `legacy-chat` (backend) and/or `legacy-frontend`
(web). Status legend: **CONFIRMED** (full stack evidence), **PARTIAL** (implemented but
incomplete / half-wired), **UNKNOWN** (cannot confirm from code).

Refactor priority legend: **P0** (do first / blocking), **P1** (high value), **P2**
(worthwhile), **P3** (nice to have).

---

## Technology inventory

### Backend (`legacy-chat`)

| Concern | Value | Evidence |
|---|---|---|
| Framework | NestJS `^11.0.1` | `package.json` |
| Language | TypeScript `^5.7.3`, target ES2023, `module: commonjs`, `strictNullChecks: true`, `noImplicitAny: false` | `tsconfig.json` |
| Runtime | Node 20 (Docker `node:20-alpine`) | `Dockerfile` |
| Package manager | npm (package-lock.json) | repo |
| Database | MongoDB 7 (`mongo:7` / `mongo` image) | `docker-compose.yml` |
| ODM | Mongoose `^8.16.1` via `@nestjs/mongoose ^11` | `package.json`, `app.module.ts` |
| Auth | JWT (`@nestjs/jwt`), Passport JWT strategy, `expiresIn: 7d`, `tokenVersion` invalidation | `auth/*` |
| Authorization | Per-handler `JwtAuthGuard`; role checks inline in services (`UserRole` owner/admin/member) | `chat.service.ts`, `message.service.ts` |
| WebSockets | Socket.IO `^4.8.3` via `@nestjs/platform-socket.io`, single gateway, namespace `/` | `gateway/chat.gateway.ts` |
| Queues / jobs | **None** | — |
| Caching | **None** (no Redis; some in-process `Map`s in the gateway & wallpaper rate-limit) | `chat.gateway.ts`, `wallpaper.service.ts` |
| Storage | Local disk `uploads/` served by `ServeStaticModule` at `/uploads`; SHA-256 content dedupe | `app.module.ts`, `upload/*` |
| Media processing | `ffmpeg-static` + `ffmpeg` CLI for video→GIF and wallpaper video clip/thumbnail | `gif/gif-conversion.service.ts`, `wallpaper/wallpaper-media.service.ts` |
| Email | **None** | — |
| Push notifications | **None server-side** (web `Notification` API only, client-side) | `app-shell.tsx` |
| External APIs | Giphy referenced in `API_SUMMARY.md` but **no live Giphy code** in `src` (only local GIF library) | `gif.service.ts` |
| Validation | `class-validator` + global `ValidationPipe({ whitelist, transform })` | `main.ts` |
| Serialization | Mongoose `toJSON` transforms strip `password`/`isDeleted`; mostly `.lean()` + manual mapping | schemas |
| Logging | `console.*` + a few `Logger` instances (gif/wallpaper media) | scattered |
| Testing | Jest configured; **only** `app.e2e-spec.ts` and zero `*.spec.ts` unit tests | `test/` |
| Config | `@nestjs/config` global; `.env` (`PORT`, `DATABASE_URL`, `JWT_SECRET`, `CONFIG_BOT_PASSWORD`, `CORS_ORIGIN`, `GIPHY_API_KEY`, `FFMPEG_PATH`) | `.env.example` |
| API docs | Swagger at `/docs` | `main.ts` |
| Deployment | Dockerfile (multi-stage, non-root, standalone) + docker-compose (app + mongo) | repo |

### Frontend (`legacy-frontend`)

| Concern | Value | Evidence |
|---|---|---|
| Framework | Next.js `15.3.5` App Router, `output: "standalone"`, Turbopack dev | `package.json`, `next.config.ts` |
| React | `^19.0.0` | `package.json` |
| Language | TypeScript `^5` | `package.json` |
| Rendering | Almost entirely `"use client"`; no server components/data fetching; SSR shell only | every `page.tsx` |
| Routing | App Router; route groups: `chats/`, `contacts/`, `profile/` | `src/app/**` |
| State | React Context only (`auth`, `theme`, `call`, `current-voice`, `overlay`); heavy local `useState`/`useRef`; no Redux/Zustand/Jotai | `src/contexts/**` |
| Data fetching | Hand-rolled `axios` wrapper in `lib/api.ts`; **no** React Query / SWR; manual caching in refs | `lib/api.ts`, `chats/[channelId]/page.tsx` |
| Caching | In-memory `Map` refs per component (`messageCacheRef`), module-level wallpaper cache, `localStorage` for token/user/theme/notify flags | scattered |
| WebSocket client | `socket.io-client ^4.8.3`, singleton in `lib/socket.ts`, `useSocket()` hook | `lib/socket.ts` |
| Styling | Tailwind CSS v4 (`@tailwindcss/postcss`), one 1568-line `globals.css` with CSS-variable theming + custom component classes | `globals.css` |
| Component libs | `@radix-ui/react-dropdown-menu` only | `package.json` |
| Animation | `framer-motion ^12` + many hand-written CSS keyframes | `globals.css`, `message-bubble.tsx` |
| Forms | Uncontrolled/controlled `useState`; small `app-form.tsx` helpers; no form lib | `components/app-form.tsx` |
| Validation | Ad-hoc inline (regex/length checks) | pages |
| Image handling | `blurhash` / `react-blurhash`, `react-easy-crop`, canvas export utils | `lib/*`, `components/media-edit/*` |
| File uploads | `XMLHttpRequest` with progress in `lib/api.ts` (`uploadWithProgress`, `uploadGifVideo`, `uploadWallpaperFile`) | `lib/api.ts` |
| WebRTC | `simple-peer ^9` mesh in `hooks/use-call-webrtc.ts` | that file |
| Fonts | `@fontsource` Geist / Geist Mono / Vazirmatn (Persian) — bundled, no network | `globals.css` |
| PWA | `manifest.ts` + `pwa-registry.tsx` (SW registration) | `app/manifest.ts` |
| Testing | **None** | — |
| i18n | None; UI is English, but Persian/Arabic text is detected for RTL rendering | `message-composer.tsx`, `globals.css` |

---

# Feature: Registration

**Status:** CONFIRMED
**Description:** Email + username + password (+ optional first/last name, phone) account creation. Returns a JWT immediately (auto-login).
**User-facing behavior:** `/register` form → on success routed to `/chats`. Errors surfaced inline + as sonner toast.
**Frontend:** `app/register/page.tsx`, `contexts/auth-context.tsx#register`, `lib/api.ts#authApi.register`.
**Backend:** `auth.controller.ts POST /auth/register` → `auth.service.register` → `user.service.create` (bcrypt hash, uniqueness checks on email + username) → `signToken`.
**Database:** `user` collection insert. Unique sparse indexes on `email`, `username`.
**API endpoints:** `POST /auth/register`.
**WebSocket events:** none.
**State involved:** `AuthContext` (`user`, `token`), `localStorage` (`legacy_chat_token`, `legacy_chat_user`).
**Dependencies:** User model, JWT.
**Permissions:** public.
**Current UX:** Single long form (email, username, password, first, last, phone). No inline availability check, no password confirm, no strength meter, no email verification.
**Current problems:** No email/phone verification anywhere; `phoneNumber` accepted but never validated as a phone; password min 6 only; username lowercased server-side but not shown to user; no rate limiting → account-spam risk.
**Performance:** fine.
**Security:** No verification, no captcha, no throttling; bcrypt cost 10 (ok). `email` stored lowercased+trimmed.
**Redundant behavior:** `AuthResponse.user` returned from register is the raw Mongoose doc from `user.service.create` (includes `password` field until `toJSON`), whereas `login` strips `_doc`. Inconsistent shapes.
**Potential simplification:** Merge login+register into one `/auth` module with a shared response mapper; add optional verification behind a flag.
**Refactor priority:** P1
**Evidence:** `auth/auth.controller.ts:210`, `auth/auth.service.ts:482`, `user/user.service.ts:585`.

---

# Feature: Login (email or phone + password)

**Status:** CONFIRMED
**Description:** Authenticate with **either** email or phone number plus password.
**User-facing behavior:** `/login` toggles between "Email" and "Phone number" input; on success → `/chats`.
**Frontend:** `app/login/page.tsx`, `auth-context.tsx#login`.
**Backend:** `POST /auth/login` → `validateUser($or email/phoneNumber)` → bcrypt compare → `login()` returns `{ access_token, user: _doc }`.
**Database:** `user` read.
**API endpoints:** `POST /auth/login`.
**State:** as registration.
**Permissions:** public.
**Current UX:** Clean. No "remember me" (always persists), no forgot-password, no error for locked/nonexistent account distinction (good for security).
**Current problems:** `login()` does `const { _doc } = safeUser` — depends on Mongoose internal `_doc`; fragile. Generic "Invalid credentials" is good. Response `user` shape differs from `/auth/profile`.
**Security:** No brute-force protection / lockout / throttle. JWT lives 7d with no refresh token; only `tokenVersion` bump invalidates.
**Potential simplification:** Return a single normalized `UserPublic` from a mapper; add rate limit (e.g. `@nestjs/throttler`).
**Refactor priority:** P1
**Evidence:** `auth/auth.controller.ts:226`, `auth/auth.service.ts:440`.

---

# Feature: Session / token handling

**Status:** CONFIRMED
**Description:** Stateless JWT (7-day). `tokenVersion` integer on the user doc is embedded in the token; every request re-reads the user and rejects if `tokenVersion` mismatch.
**Frontend:** token in `localStorage`; `setApiTokenGetter`/`setOnUnauthorized` wire the axios wrapper; 401 → wipe + `/login`.
**Backend:** `jwt.strategy.ts#validate` re-queries user (`isDeleted`, `tokenVersion`) on **every** request; gateway does the same on connect.
**API endpoints:** implicit; `POST /auth/profile` fetches the current user.
**Current problems:**
- Every authenticated request performs an **extra DB round-trip** to `user` to check `tokenVersion` (N+1 on the hot path).
- No refresh-token / sliding session; a 7-day token cannot be revoked except by bumping `tokenVersion` (which kills *all* devices).
- Token + full user object cached in `localStorage` (XSS-exfiltratable).
- `AuthContext` trusts stored `user` blob and skips `/auth/profile` when both token+user present → stale profile after edits on other devices.
**Potential simplification:** Short-lived access token (15 min) + refresh token in httpOnly cookie; or keep 7-day JWT but cache `tokenVersion` in memory/Redis to avoid the per-request read.
**Refactor priority:** P0 (security + performance)
**Evidence:** `auth/jwt.strategy.ts:636`, `auth/auth.service.ts:395`, `contexts/auth-context.tsx:1565`.

---

# Feature: Logout (this device)

**Status:** CONFIRMED
**Description:** Client-only: clears `localStorage`, routes to `/login`. No server call.
**Frontend:** `auth-context.tsx#logout`.
**Backend:** none.
**Current problems:** Token remains valid server-side for up to 7 days after "logout".
**Refactor priority:** P2
**Evidence:** `contexts/auth-context.tsx:1536`.

---

# Feature: Logout all other sessions

**Status:** CONFIRMED
**Description:** Bumps `tokenVersion` (invalidating every existing JWT), then issues a fresh token for the current device.
**Frontend:** `auth-context.tsx#logoutAllSessions` — **wired but has no UI trigger** in `profile/page.tsx` (only "Change password" and "Log out" are shown).
**Backend:** `POST /auth/logout-all` → `revokeAllSessions`.
**Current problems:** Feature is reachable only via `useAuth().logoutAllSessions()` with no button → effectively dead from the UI. There is no device/session list.
**Refactor priority:** P2 (either surface it or remove the button-less path; add a real "Devices" screen)
**Evidence:** `auth/auth.controller.ts:270`, `contexts/auth-context.tsx:1546`.

---

# Feature: Change password

**Status:** CONFIRMED
**Description:** Verify current password → set new (must differ) → bump `tokenVersion` → return new token for this device.
**Frontend:** `app/profile/change-password/page.tsx`.
**Backend:** `POST /auth/change-password`.
**Permissions:** authenticated.
**Current problems:** min length 6; no strength check; other devices are logged out silently (documented in subtitle, ok).
**Refactor priority:** P3
**Evidence:** `auth/auth.controller.ts:288`, `auth/auth.service.ts:497`.

---

# Feature: Password reset / forgot password

**Status:** UNKNOWN → **NOT IMPLEMENTED**
**Evidence of absence:** No `/auth/forgot*`, `/auth/reset*` routes; no email module; no reset-token schema. A user who forgets their password has no recovery path.
**Refactor priority:** P1 (needs email or admin reset; see OPEN_QUESTIONS).

---

# Feature: OAuth / social login / 2FA

**Status:** NOT IMPLEMENTED. No providers, no TOTP, no `passport-*` beyond `passport-jwt`.

---

# Feature: User profile (view/edit)

**Status:** CONFIRMED
**Description:** First/last name, username (unique), bio, multiple avatar images (`avatarUrl: string[]`), `bigEmojis` toggle, `quickReaction` emoji.
**User-facing behavior:** `/profile` (read + toggles), `/profile/edit` (name/bio/username), avatar add/remove with lightbox + crop.
**Frontend:** `app/profile/page.tsx`, `app/profile/edit/page.tsx`, `usersApi.update`, `uploadApi.uploadImage`.
**Backend:** `POST /users` (`UpdateUserDto`), `GET /users/:username`, `GET /users/by-id/:userId`, `GET /users/:userId/status`.
**Database:** `user` doc. `image` (schema) vs `avatarUrl` (API/type) — **field name mismatch**: schema stores `image: string[]`, but `UpdateUserDto` sends `image`, while frontend type `UserPublic` uses `avatarUrl`. The chat service maps `avatarUrl` from `image` in some places and not others.
**API endpoints:** see above; also `PATCH /users/quick-reaction`.
**WebSocket events:** none for profile changes → other users see stale name/avatar until refetch.
**Permissions:** self-edit only; `GET` blocked if target has blocked requester.
**Current problems:**
- `image` vs `avatarUrl` naming inconsistency across schema/DTO/frontend (bug-prone; see `chat.service` mapping `u.avatarUrl?.[0]` off a `.select("... avatarUrl ...")` that will be `undefined` because the field is `image`). **Confirmed latent bug.**
- `findByUsername` returns a hand-picked subset (`image, bio, firstName, lastName, lastSeen, username, _id`) — **omits `avatarUrl`/`isOnline`/`bio` inconsistencies**, and throws 404 (not null) despite signature saying `| null`.
- No profile-updated broadcast → names/avatars go stale in open chats.
- Multiple avatars supported but product value unclear (`REQUIRES PRODUCT DECISION`).
**Potential simplification:** Rename to one field (`avatarUrls`), one `PublicUser` DTO mapper, emit `user_profile_updated` over WS.
**Refactor priority:** P1
**Evidence:** `user/schema/user.schema.ts:7188`, `user/user.service.ts:7662`, `chat/chat.service.ts:1421`.

---

# Feature: Presence (online/offline + last seen)

**Status:** CONFIRMED
**Description:** Online = has ≥1 live socket. On connect: `isOnline=true`, `lastSeen=now`, broadcast `user_status_changed{online}` to **all** connected sockets. On last disconnect: `isOnline=false`, broadcast `{offline, lastSeen}`.
**Frontend:** `app-shell.tsx` (`updateStatus(ONLINE)`), chat page + chat list subscribe to `user_status_changed`; `GET /users/:id/status` for `lastSeen` fallback.
**Backend:** `chat.gateway.ts` connection/disconnection handlers; in-process `userSockets`, `socketUsers`, `userStatuses` maps.
**Database:** `user.isOnline`, `user.lastSeen` written on every connect/disconnect.
**WebSocket events:** `user_status_changed` (server→all), `update_status` (client→server, sets an in-memory status only).
**Current problems:**
- `this.server.emit("user_status_changed", …)` is a **global broadcast** to every connected client on every connect/disconnect — O(users²) chatter, leaks presence of users you don't share a chat with.
- `isOnline` persisted to Mongo on every connect/disconnect → write amplification; also goes stale forever if the process crashes.
- `update_status` (`typing`/`away`) is stored only in a `Map` and broadcast globally but the frontend never sends anything except `ONLINE`.
- Presence is not scoped to "people you can see" (privacy).
**Potential simplification:** Emit presence only into rooms the user shares (`channel:*` they're in); keep `isOnline` in memory (or Redis) not Mongo; drop `away`/`typing` from `update_status`.
**Refactor priority:** P1
**Evidence:** `gateway/chat.gateway.ts:2786`, `gateway/chat.gateway.ts:2862`, `gateway/chat.gateway.ts:3167`.

---

# Feature: Block / unblock user

**Status:** CONFIRMED
**Description:** One-directional block. Blocked user's DMs are silently dropped for the blocker (gateway filters `new_message` per-socket in private chats). Profile fetch of a user who blocked you → 403.
**Frontend:** `usersApi.block/unblock/getBlocked/hasBlockedMe`; chat page shows Block/Unblock in the private-chat menu; `user_unblocked_you` event.
**Backend:** `blocks` collection; `user.service.block/unblock/isBlocked/getBlockedUserIds`; `chat.gateway.handleSendMessage` checks `isBlocked` per recipient socket.
**Database:** `blocks` (blockerId, blockedId), unique compound index.
**API endpoints:** `POST/DELETE /users/block/:userId`, `GET /users/blocked`, `GET /users/block/check/:userId`.
**WebSocket events:** `user_unblocked_you`.
**Current problems:**
- Block only filters **realtime** delivery; a blocked user's messages are still **persisted** and appear on `GET /messages/...` refetch/reload. Inconsistent.
- No block enforcement on `call_request`, reactions, or REST message send — only the socket `new_message` fan-out.
- `getById`/`findOne` check "did target block me" but message history endpoints do not.
**Potential simplification:** Enforce block at `message.service.create` (reject) and at history read (filter), not only in the gateway.
**Refactor priority:** P1 (correctness + safety)
**Evidence:** `user/user.service.ts:7745`, `gateway/chat.gateway.ts:3016`, `user/user.controller.ts:7407`.

---

# Feature: Report user / content

**Status:** NOT IMPLEMENTED. No report endpoint, schema, or UI. `REQUIRES PRODUCT DECISION` (family app — may be intentionally out of scope).

---

# Feature: Direct messages (1:1)

**Status:** CONFIRMED
**Description:** `GET /chats/direct/:userId` finds-or-creates a `private` chat with deterministic link `private-<sortedId1>-<sortedId2>`. Both users get `new_chat` over WS and are auto-joined to the room.
**Frontend:** `contacts/page.tsx#startChat`, chat list "new message", `chatsApi.getOrCreateDirect`.
**Backend:** `chat.service.findOrCreatePrivateChat` → `create` with `type=private`, `name="Private"`.
**Database:** `chats` (type `private`) + 2 `chatmembers`.
**Current problems:**
- Private chat `name` stored as literal `"Private"`; display name is recomputed on every `my-chats` call by looking up the *other* member and their user doc (extra queries per private chat, per list load).
- `unsubscribe` on a private chat sets `isJoined=false` and `$addToSet deletedFor` on **every message** (`updateMany` over full history) — expensive, and re-messaging silently re-joins.
- Deterministic link exposes both raw user ids.
**Refactor priority:** P1
**Evidence:** `chat/chat.service.ts:1856`, `chat/chat.service.ts:1277`, `chat/chat.service.ts:1307`.

---

# Feature: Saved Messages

**Status:** CONFIRMED
**Description:** A per-user self-chat (`type: saved_messages`, link `saved-<userId>`), auto-created on first `my-chats` load. Excluded from discovery search.
**Frontend:** `chatsApi.savedMessages`; contacts list filters out "Saved Messages".
**Backend:** `chat.service.findOrCreateSavedMessages`, called inside `findUserJoinedChatsWithDisplay`.
**Current problems:** `ChatType.SAVED_MESSAGES` exists in backend enum but **not** in the frontend `types/enums.ts` (`ChatType` has only channel/group/private) → frontend treats it as an unknown type. Creation is a side-effect of a GET (surprising).
**Refactor priority:** P2
**Evidence:** `chat/chat.service.ts:1895`, `enum/base.enum.ts:2602`, `types/enums.ts:137`.

---

# Feature: Group chats

**Status:** PARTIAL
**Description:** `type: group`. Members join via link/subscribe. Admin roles, admin-mute of members, ban, pin messages by admin, per-member wallpaper.
**Frontend:** create via `/chats/new?type=group`; management modals in `chats/[channelId]/page.tsx` (members, admins, banned).
**Backend:** `chat.*`, `message.service` role checks.
**Current problems:**
- **No "add member" endpoint.** `/chats/new` step 3 ("Add members") calls `chatsApi.getOrCreateDirect(u._id)` for each selected user — this creates **DM chats**, it does **not** add them to the group. Group members can only self-join by link. Confirmed dead/broken flow.
- `CreateChatDto` accepts `members[]`/`admins[]` and `create()` inserts `chatmembers`, but the web "new" page never sends them.
- Owner is always the creator; no ownership transfer.
- `chatmembers` has no unique index on `(channelId, userId)` → duplicate memberships possible under races (several code paths do find-then-create).
**Refactor priority:** P0 (broken core flow)
**Evidence:** `app/chats/new/page.tsx:1478`, `chat/chat.service.ts:1091`, `chat/schema/chat-members.schema.ts:2133`.

---

# Feature: Channels (broadcast)

**Status:** CONFIRMED
**Description:** `type: channel`. Only admins/owner can post; members read-only. System "member_joined" messages are hidden in channels. Public discovery + join by link.
**Backend:** `message.service.create` rejects `MEMBER` role posting in a `channel`; `findAll` filters `type: {$ne: 'system'}` for channels.
**Current problems:** No subscriber count shown consistently; "who can post" is not surfaced in UI beyond a disabled composer.
**Refactor priority:** P2
**Evidence:** `message/message.service.ts:5299`, `message/message.service.ts:5525`.

---

# Feature: Chat list (my chats)

**Status:** CONFIRMED
**Description:** `GET /chats/my-chats` returns joined chats with computed `displayName`, `isPinned`, `isMuted`, `mutedByAdmin`, `myRole`, `lastReadMessageId`, `membersCount`, `lastMessageAt`, and (for private) the other user's `username/firstName/lastName/avatarUrl/bio/userId`. Sorted pinned-first then by `lastMessageAt` desc.
**Frontend:** `components/chat-list.tsx` (1411 lines): search, pin/mute swipe/menu, unread badges, last-message preview, live updates via `new_message`/`new_chat`/`user_status_changed`/`message_deleted`.
**Backend:** `chat.service.findUserJoinedChatsWithDisplay`.
**Current problems (data + performance):**
- Per request: 1 membership query + 1 chats query + 2 aggregations (last message, member counts) + **for every private chat a separate `chatmembers.find` and `user.findById`** (N+1). A user in 20 DMs = ~42 queries per list load.
- Returns lots of unused fields (`bio` in list, full `link`, `tags`, `admins` array, `image[]`).
- No unread **count** in the payload — the list calls `GET /messages/channel/:id/unread` **per chat** separately (another N requests).
- No pagination — returns all chats.
- Sort is done in JS after fetching everything.
**Potential simplification:** One aggregation pipeline returning `{ id, kind, title, avatar, lastMessage:{preview,at,senderId,type}, unreadCount, isPinned, isMuted, myRole }`; denormalise `lastMessageAt`/`lastMessagePreview` onto the chat or a `chat_state` doc; cursor pagination.
**Refactor priority:** P0
**Evidence:** `chat/chat.service.ts:1307`–`1507`, `components/chat-list.tsx`.

---

# Feature: Text messaging

**Status:** CONFIRMED
**Description:** Send via WS `send_message` (preferred, with `tempId` ack + optimistic UI) or `POST /messages`. Rendered in `message-list.tsx` / `message-bubble.tsx`.
**Backend:** `message.service.create`: membership check, admin-mute check, channel-post check, mention resolution, reply linkage, private-chat auto-rejoin of the other member, emoji-usage tracking, populate sender + replyTo.
**WebSocket:** `send_message` → server persists → broadcasts `new_message` to `channel:<id>` (per-socket block filtering in private chats).
**Current problems:**
- `message.service.create` runs **up to ~8 sequential awaits** per message (membership, chat, forward lookup + user, mentions [2 queries], replyTo, other-member, emoji usage loop, create, then `findById().populate().populate()`). Message-send latency is high.
- `content` is stored/sent verbatim; XSS protection relies entirely on React escaping (no server sanitisation) — links, mentions, markdown all parsed client-side.
- Reply auto-adds original sender to `mentions` (so "replies to you" show in mentions) — clever but surprising and un-opt-out-able.
- REST `POST /messages` does **not** broadcast (`message.controller` create returns but never calls the gateway) → REST-sent messages don't appear live for others. Only the WS path broadcasts. Inconsistent.
**Refactor priority:** P0
**Evidence:** `message/message.service.ts:5279`, `message/message.controller.ts:4640`, `gateway/chat.gateway.ts:2978`.

---

# Feature: Replies

**Status:** CONFIRMED. `replyTo` ObjectId; `populate("replyTo")` returns the full referenced message (including its own populate-less sender). Reply preview rendered in bubble.
**Problems:** `populate("replyTo")` returns the **entire** original message (content, attachments, reactions map, readBy map) — over-fetch; only need `{id, senderName, snippet, type}`. Deleted reply targets still resolve.
**Refactor priority:** P2
**Evidence:** `message/message.service.ts:5461`.

---

# Feature: Edit message

**Status:** CONFIRMED. Sender-only. Sets `isEdited`, re-resolves mentions. Broadcasts `message_updated`.
**Problems:** No edit history; no edit time-limit; editing does not re-run link previews. `UpdateMessageDto.content` allows `MinLength(0)` (empty edit allowed → blank message).
**Refactor priority:** P3
**Evidence:** `message/message.service.ts:5779`, `message/message.controller.ts:4983`.

---

# Feature: Delete message (for everyone / for me)

**Status:** CONFIRMED
- **For everyone:** soft-delete (`isDeleted=true`, `isPinned=false`), sender or admin/owner. Broadcasts `message_deleted`.
- **For me:** `$addToSet deletedFor: userId`; history queries exclude `deletedFor: {$nin:[me]}`.
**Problems:** Soft-deleted messages stay in the DB forever (no purge job); `deletedFor` grows unbounded on `unsubscribe` from a private chat (adds you to every message). No "delete for everyone" time window.
**Refactor priority:** P2
**Evidence:** `message/message.service.ts:5820`, `message/message.service.ts:5857`.

---

# Feature: Reactions (emoji + "quick reaction")

**Status:** CONFIRMED
**Description:** Toggle any emoji (`POST /messages/:id/reaction`) or double-tap → user's `quickReaction` (`POST /messages/:id/quick-reaction`). Stored as `Map<emoji, userId[]>`. Reaction adds are recorded in `emoji_usage`. Broadcasts `message_updated`.
**Frontend:** `message-bubble.tsx` long-press menu + `emoji-picker.tsx` (1225 lines) + double-tap.
**Problems:**
- `message_updated` broadcasts the **whole message** on every reaction toggle → large payloads for a 1-emoji change; also re-renders the bubble fully.
- `reactions` as a Mongo `Map` complicates queries (`getUnreadReactions` needs `$objectToArray` `$expr` — cannot use an index).
- No cap on distinct emojis per message (UI shows `MAX_REACTIONS = 6` but server doesn't enforce).
- `addReaction` does `findById` → mutate → `findByIdAndUpdate` → `findById().populate().populate()` = 3–4 queries per toggle.
**Refactor priority:** P1
**Evidence:** `message/message.service.ts:5880`, `message/message.service.ts:6163`, `message/schema/message.schema.ts:6351`.

---

# Feature: Mentions

**Status:** CONFIRMED
**Description:** `@username` in content → resolved to user ids that are members of the channel and stored in `message.mentions: string[]`. Replies implicitly mention the original sender. "Unread mentions" queue + jump navigation in chat.
**Frontend:** composer autocomplete via `GET /chats/:id/participants`; `messagesApi.unreadMentions`; mention navigator UI in chat page.
**Backend:** `message.service.resolveMentions` (2 queries: users by username, then membership filter).
**Problems:** mention parsing regex `/@([a-zA-Z0-9_]+)/g` — no support for names with dots/dashes; case-insensitive username but stored ids only; `getUnreadMentions` uses index `channelId+mentions+createdAt` (good). Notification for mentions is client-side only (`app-shell`).
**Refactor priority:** P2
**Evidence:** `message/message.service.ts:5235`, `message/message.controller.ts:4901`.

---

# Feature: Attachments — images & video

**Status:** CONFIRMED
**Description:** Up to 6 media per message (`MAX_MEDIA_PER_MESSAGE`), client-side crop (`react-easy-crop`) + video trim/crop + optional "send as GIF" (mutes → server converts). Optimistic upload with progress ring; `uploading_start/stop` typing-style indicator.
**Frontend:** `message-composer.tsx` (2433 lines), `media-panel.tsx`, `media-edit/*`, `pending-media-*`, `lib/video-export.ts`, `lib/crop-image.ts`. Upload via `uploadWithProgress` → `POST /upload`.
**Backend:** `POST /upload` (250 MB, all types), `POST /upload/image` (10 MB, images). SHA-256 dedupe via `upload_records`.
**Database:** message `attachments: string[]` (absolute URLs). `upload_records` (hash, filename).
**Problems:**
- Stored URLs are **absolute** (`http://host/uploads/...`) built from request `Host` header → breaks when the host/proto changes (dev vs prod, reverse proxy). Frontend `getMediaUrl` then has to detect and rebuild.
- No server-side image resizing / thumbnail / transcoding (except the GIF path). Full-res originals served directly. No blurhash generated server-side (frontend imports blurhash libs but there's no hash source).
- 250 MB single-file limit on a disk with no quota; no virus scan; `fileFilter` for `/upload` accepts **everything**.
- No EXIF stripping.
- `attachments` typed `string[]` but treated as "0 or 1" in most bubble code; multi-image = one message with N urls, rendered as a grid.
**Refactor priority:** P0 (storage + URL correctness)
**Evidence:** `upload/upload.controller.ts:6892`, `components/message-composer.tsx`, `lib/api.ts:816`.

---

# Feature: Voice messages

**Status:** CONFIRMED
**Description:** Record in composer (MediaRecorder, waveform bars), preview, send as `type: voice` with `duration`. Global mini-player (`current-voice-context.tsx`) that persists across navigation, auto-advances to next voice in channel, marks read on end.
**Frontend:** `message-composer.tsx` recording bar, `voice-player.tsx` (356), `current-voice-bar.tsx`, `contexts/current-voice-context.tsx` (301).
**Backend:** just a message with a `/upload` URL; `duration` in `CreateMessageDto` but **not stored** on the `Message` schema (no `duration` prop) — so duration is lost server-side and re-derived from audio metadata on the client.
**Problems:** `duration` silently dropped (DTO has it, schema doesn't); no waveform persisted; no transcription.
**Refactor priority:** P2
**Evidence:** `message/dto/create-message.dto.ts:4563`, `message/schema/message.schema.ts:6298`.

---

# Feature: Files (documents)

**Status:** CONFIRMED. `type: file` message, `POST /upload`, rendered as a download card with `originalFilename`. No preview.
**Problems:** `originalFilename` is passed as a form field and returned but **not stored on the message** — only the URL is stored; the display name is only known at send time and lost on reload (bubble falls back to URL basename = the hash).
**Refactor priority:** P2
**Evidence:** `upload/upload.controller.ts:6914`, `message/schema/message.schema.ts`.

---

# Feature: GIFs

**Status:** PARTIAL
**Description:** Personal GIF library + optional global "trending" (gated by `app_settings.trendingGifs`, editable only in Compass). Create a GIF by uploading a short video → server ffmpeg conversion. "Use" tracking updates `lastUsedAt`/`usageCount`. Add-to-mine from a message URL.
**Frontend:** `gif-picker.tsx`, `app/chats/gifs/new/page.tsx`, `gif-hold-preview.tsx`, `lib/sort-gifs.ts`.
**Backend:** `gif.*` module, `user_gifs` collection, `gif-conversion.service.ts`.
**Problems:**
- No external GIF search (Giphy referenced in docs/env but **no code**) — "GIFs" is really "your uploaded GIF clips". Product mismatch with user expectation.
- `browse` returns `mine` + `trending` + `settings` in one payload; `trending` is an expensive `$group` aggregation over all public gifs on every open.
- `recordUse` does `updateMany({filename, isPublic:true})` — updates *every user's* copy of the same file.
- ffmpeg dependency is a deploy fragility (bundled static binary + alpine `apk add ffmpeg`).
**Refactor priority:** P2 (`REQUIRES PRODUCT DECISION`: is Giphy wanted?)
**Evidence:** `gif/gif.service.ts:4075`, `gif/gif.controller.ts`, `app-settings/*`.

---

# Feature: Stickers

**Status:** PARTIAL
**Description:** Create sticker packs from image URLs, list/search public packs, add stickers to own pack, send a sticker as `type: sticker`.
**Frontend:** `sticker-picker.tsx` (112), `app/chats/stickers/new/page.tsx` (114).
**Backend:** `sticker.*`, `sticker_packs` collection.
**Problems:**
- `POST /stickers/bot/create-from-message` is a **stub** that always throws `BadRequestException` telling you to use the other endpoint. Dead endpoint.
- `createFromMessage` in the service checks admin role then throws — pure dead code.
- No sticker upload endpoint — packs are "array of URLs you already host somewhere".
- `usageCount` never incremented anywhere (no "use sticker" endpoint) → sort by `usageCount` is meaningless.
- Small UI footprint; unclear if used.
**Refactor priority:** P3 (`REQUIRES PRODUCT DECISION`: keep stickers?)
**Evidence:** `sticker/sticker.service.ts:6765`, `sticker/sticker.controller.ts:6578`.

---

# Feature: Message forwarding

**Status:** CONFIRMED
**Description:** `forwardFrom: <messageId>` in `CreateMessageDto` → server copies content/type/attachments/duration from the original and stores a `forwardFrom` snapshot `{userId, name, image}`. Picker: `ForwardChatPickerModal.tsx`.
**Problems:**
- Schema stores `forwardFrom.image` but service writes `forwardFrom.avatarUrl` (`messageData.forwardFrom = { userId, name, avatarUrl }`) — **field mismatch**, avatar never persists (schema has `image`, not `avatarUrl`). Frontend type `ForwardFromMeta` uses `avatarUrl`. Confirmed bug.
- `duration` copy references `original.duration` which is never stored (see Voice) → always undefined.
- Forward doesn't preserve a link back to the original / original channel.
**Refactor priority:** P2
**Evidence:** `message/message.service.ts:5316`, `message/schema/message.schema.ts:6322`.

---

# Feature: Pin message / pinned bar

**Status:** CONFIRMED. Admin/owner in groups/channels; anyone in private. `isPinned` flag; `GET /messages/channel/:id/pinned`; `pinned-bar.tsx` carousel with jump-to.
**Problems:** No pin limit; pinned list is a full message fetch; no "unpin all"; pin state is global (not per-user).
**Refactor priority:** P3
**Evidence:** `message/message.service.ts:5997`, `components/pinned-bar.tsx`.

---

# Feature: Bookmarking / disappearing messages

**Status:** NOT IMPLEMENTED. No bookmark schema; "Saved Messages" chat is the only save mechanism (manual forward). No TTL/ephemeral messages.

---

# Feature: Read receipts / delivery status

**Status:** CONFIRMED (read only; no "delivered")
**Description:** `mark_read` (WS) or `POST /messages/channel/:id/read` sets `chatmembers.lastReadMessageId/lastReadAt` and writes `readBy.<userId> = now` on **every** message up to that timestamp (`updateMany`). Broadcasts `messages_read`. Bubbles show tick state from `readBy`.
**Problems:**
- `markAsRead` does an unbounded `updateMany` over channel history (`createdAt <= target`) writing a per-user key into a `readBy` Map on each — **write amplification**, grows the `readBy` map on every message to O(members). In a 50-person group every read touches up to N messages × writes.
- Legacy-data guard (`$or: [readBy $exists false, readBy $type object]`) implies past schema churn / dirty data.
- No "delivered" state; `getUnreadCount` recomputes by timestamp comparison per chat.
- `readBy` map is returned to clients in full on every message (privacy: everyone sees exactly who read and when).
**Refactor priority:** P0 (perf) / P1 (privacy)
**Evidence:** `message/message.service.ts:6218`, `gateway/chat.gateway.ts:3141`.

---

# Feature: Typing & "uploading" indicators

**Status:** CONFIRMED. `typing_start/stop` + `uploading_start/stop` → `user_typing` event with `{isTyping, uploading}`. 5s server-side auto-timeout for typing.
**Problems:** Two near-identical mechanisms; `uploadingUsers`/`typingUsers` maps never cleaned on disconnect (leak); event carries `username` from the socket (could be stale).
**Refactor priority:** P3
**Evidence:** `gateway/chat.gateway.ts:3030`–`3139`.

---

# Feature: Unread counts / unread mentions / unread reactions

**Status:** CONFIRMED. Three separate endpoints: `/unread` (count), `/unread-mentions` (list+count), `/unread-reactions` (list+count). Chat page builds mention/reaction "jump" queues.
**Problems:** Chat list calls `/unread` **per chat**; chat page calls all three on open + on events. `/unread-reactions` uses an unindexable `$expr`. Lots of round-trips for what could be one payload.
**Refactor priority:** P1
**Evidence:** `message/message.controller.ts:4851`–`4931`, `message/message.service.ts:6088`–`6216`.

---

# Feature: In-chat search (keyword + @mentions-of-me + date jump)

**Status:** CONFIRMED
**Description:** `GET /messages/channel/:id/search?q=` returns ordered message ids (regex on `content`, or `@` for "mentions me"); chat page loads pages until each hit is in view and highlights it. Date picker jumps via `/first-of-date`, `/first-from-date`, `/oldest`.
**Problems:** `content` regex search with no text index (full collection scan per query, `$options:i`); returns up to 500 ids; the "load until visible then scroll" client loop is complex and can thrash pagination.
**Refactor priority:** P2
**Evidence:** `message/message.service.ts:5701`, `components/search-date-picker.tsx`.

---

# Feature: Global chat/channel discovery search

**Status:** CONFIRMED. `GET /chats/search` / `GET /chats` — regex on `name`/`link`, excludes Saved Messages, returns full chat docs. `/chats/search/page.tsx` "Discover" screen + join.
**Problems:** Regex not text-index; returns all fields; no relevance ranking; `findChat` and `searchChannels` are the **same** service call wired to two routes.
**Refactor priority:** P2
**Evidence:** `chat/chat.service.ts:1922`, `chat/chat.controller.ts:960`.

---

# Feature: User search

**Status:** CONFIRMED. `GET /users/search?q=` regex across username/email/firstName/lastName/phoneNumber. Used in contacts, new chat, admin add.
**Problems:** Returns every non-deleted user matching a substring of **email or phone** → email/phone enumeration. No text index. Exposes `email`, `phoneNumber`, `lastSeen`, `isOnline` of arbitrary users.
**Refactor priority:** P1 (privacy)
**Evidence:** `user/user.service.ts:7694`.

---

# Feature: Chat wallpaper (v2)

**Status:** CONFIRMED (large subsystem)
**Description:** Per-user global wallpaper + per-user-per-chat wallpaper. Image or ≤5s video (server clips + thumbnails via ffmpeg). Visual params: blur/dim/brightness/fitMode/parallax/videoStartSec. "Share to chat" posts a `system` message with metadata; recipients accept/decline; accepting copies settings to their membership. `wallpaper_updated` WS event.
**Frontend:** `components/wallpaper/*` (8 files), `hooks/use-chat-wallpaper.ts`, `app/profile/chat-background/page.tsx`, chat page integration.
**Backend:** `wallpaper.*` (controller `/v2/wallpapers`, service, media service), `wallpapers` collection, membership fields (`chatWallpaperId`, `wallpaperBlur/Dim/Brightness`), `user.globalWallpaperId`.
**Problems:**
- Big feature (schema + 3 backend files + 8 frontend files + membership columns + a system message type) for a cosmetic feature — high complexity budget spend.
- `Wallpaper` docs are created on **every apply** (new doc each time) with no cleanup → `wallpapers` collection and disk grow unbounded.
- `getById` has no ownership/membership check (any authed user can read any wallpaper doc).
- `declineShared` is a no-op endpoint.
- ffmpeg dependency (see GIF).
- Per-chat visual overrides duplicated between the `Wallpaper` doc and `chatmembers` columns.
**Refactor priority:** P2 (`REQUIRES PRODUCT DECISION`: keep video wallpapers? keep per-chat?)
**Evidence:** `wallpaper/wallpaper.service.ts:8562`, `wallpaper/wallpaper.controller.ts:8311`, `chat/schema/chat-members.schema.ts:2169`.

---

# Feature: Voice calls (1:1 and group) — WebRTC

**Status:** CONFIRMED (large subsystem)
**Description:** 1:1 ring/accept/decline + group "join anytime" calls. WebRTC **mesh** via `simple-peer`, signalling over the same Socket.IO connection. Call-log system messages (`type: voice_call`: declined/cancelled/ended+duration). Global call bar, incoming modal, minimise, mic device selection, noise/echo/gain toggles, speaking detection (Web Audio), health check.
**Frontend:** `hooks/use-call-webrtc.ts` (772), `contexts/call-context.tsx` (259), `components/call-*.tsx` (7 files), `call-socket-listener.tsx`, `current-voice`/`group-call-banner`.
**Backend:** `chat.gateway.ts` — `activeCalls` / `privateCallByChannel` in-process maps; ~13 `call_*` message handlers; call-log messages via `message.service.create`.
**Problems:**
- **All call state is in one process's memory** — no horizontal scaling, lost on restart, races on reconnect (code has manual "swap stale socketId" patches).
- **Mesh** topology: N participants = N² peer connections; fine for a family, breaks past ~5–6.
- No TURN server configured (`simple-peer` default) → calls fail across strict NATs.
- `NEXT_PUBLIC_CALL_HOST` points at a hardcoded external domain (`calls.example.com/en`) via `lib/call-room.ts` — an **external call-room page** is launched in some flows; its code is not in this repo (`UNKNOWN` component).
- Video calls: not implemented (audio only) despite `MessageType.VIDEO`.
- Enormous surface area (~2000 LoC across both repos) for a feature whose usage is `UNKNOWN`.
**Refactor priority:** P1 (`REQUIRES PRODUCT DECISION`: is calling a core feature? if yes → SFU + TURN; if rarely used → drop or externalise)
**Evidence:** `gateway/chat.gateway.ts:2682`, `hooks/use-call-webrtc.ts`, `lib/call-room.ts`.

---

# Feature: Emoji usage tracking

**Status:** CONFIRMED. Per-user counts of emojis typed in messages and emojis used as reactions (`emoji_usage` collection). `GET /emoji-usage/me` → top 60 emoji + top 24 reactions, used to order the emoji picker.
**Problems:** Emoji detection regex is crude (`[\uD800-\uDBFF][\uDC00-\uDFFF]|[☀-⛿]|[✀-➿]`) — misses ZWJ sequences, skin tones, flags; matches non-emoji symbols. Every message create does an `updateOne(upsert)` per distinct emoji. Marginal value.
**Refactor priority:** P3 (could be client-side `localStorage` instead of a collection + write on every message)
**Evidence:** `emoji-usage/*`, `message/message.service.ts:5445`.

---

# Feature: App settings singleton

**Status:** CONFIRMED. Single `app_settings` doc (`key: "default"`), one field `trendingGifs: boolean`, no write API (Compass-only). Read via `GET /gifs` payload.
**Problems:** A whole module + schema + `OnModuleInit` upsert for one boolean with no admin UI. Over-engineered.
**Refactor priority:** P3 (fold into env var or a config file)
**Evidence:** `app-settings/*`.

---

# Feature: Config-log bot endpoint

**Status:** CONFIRMED. `POST /config-logs` (no JWT) — password-gated (`process.env.CONFIG_LOG_PASSWORD ?? "change-this-config-password"`), auto-creates a `config-bot` user + `configs` channel, posts a message, broadcasts `new_message`.
**Problems:**
- **Security:** unauthenticated endpoint whose default password is a hardcoded string; `.env.example` documents `CONFIG_BOT_PASSWORD=123456` but the code reads `CONFIG_LOG_PASSWORD` (different var) → **default password active in every deployment that didn't set the undocumented var**. Anyone can post into a channel as a bot.
- Creates real DB users/channels as a side effect of an HTTP call.
- Purpose (deployment log feed into a chat channel) is niche.
**Refactor priority:** P0 (security) — remove or lock down.
**Evidence:** `config-log/config-log.service.ts:2389`, `.env.example`.

---

# Feature: Ban / unban member; admin-mute member

**Status:** CONFIRMED. Admin/owner ban (adds to `chat.banned`, deletes membership, `chat_banned` WS event); admin-mute (`chatmembers.mutedByAdmin`, blocks sending, `user_muted` WS event). Groups only for mute; groups+channels for ban.
**Problems:** `chat.banned` is a `Types.ObjectId[]` scanned with `.some(id.toString()===userId)` on nearly **every** message/history/preview call (linear scan, no index use). Ban list read separately (`GET /:id/banned`). No ban reason / duration / audit.
**Refactor priority:** P2
**Evidence:** `chat/chat.service.ts:1586`, `message/message.service.ts` (banned checks repeated ~6×).

---

# Feature: Admin management (promote/demote)

**Status:** CONFIRMED. `POST /chats/update/:channelId` with `admins[]` (ids or usernames) → normalises to ids, updates `chat.admins` + syncs `chatmembers.role`, emits `channel_roles_updated`.
**Problems:** Admin list lives in **two places** (`chat.admins` array + `chatmembers.role`) kept in sync by a loop that `save()`s each member individually. `chat.admins` vs `chatmembers.role` can drift. Owner cannot be changed.
**Refactor priority:** P2 (single source of truth = `chatmembers.role`)
**Evidence:** `chat/chat.service.ts:1124`–`1225`.

---

# Feature: Chat pin / mute (per user)

**Status:** CONFIRMED. `chatmembers.isPinned` / `isMuted`. Mute only affects client-side notification decisions (`app-shell` checks `muteMap`); server still delivers everything.
**Refactor priority:** P3
**Evidence:** `chat/chat.service.ts:1509`–`1527`, `components/app-shell.tsx:321`.

---

# Feature: Chat tags

**Status:** PARTIAL. `chat.tags: string[]`, `POST /chats/:id/tags` (any member can set — no permission check beyond membership), indexed. No visible UI for filtering by tag in the reviewed pages.
**Refactor priority:** P3 (`REQUIRES PRODUCT DECISION`: is tagging used?)
**Evidence:** `chat/chat.service.ts:1844`, `chat/chat.controller.ts:941`.

---

# Feature: Chat preview (pre-join)

**Status:** CONFIRMED. `GET /chats/preview/:channelId` — channel/group info without membership (private auto-subscribes you; banned blocked). Used when opening a link to a chat you haven't joined.
**Refactor priority:** P3
**Evidence:** `chat/chat.service.ts:1957`.

---

# Feature: Notifications (web)

**Status:** PARTIAL (client-only)
**Description:** Browser `Notification` API + optional sound (`/sounds/new-message.mp3`), gated by `localStorage` flags set in `/profile`. Tab-title unread counter when hidden. Incoming-call notification.
**Backend:** **none** — no push service, no Web Push / VAPID, no service-worker push handler.
**Problems:** Only works while a tab is open; iOS Safari unsupported (UI explains "add to home screen"); no true background push; per-message notification decision recomputes mute map.
**Refactor priority:** P1 (if push matters) — needs Web Push + SW + a `push_subscriptions` collection.
**Evidence:** `components/app-shell.tsx:377`, `app/profile/page.tsx:2014`, `components/pwa-registry.tsx`.

---

# Feature: Theme (light/dark)

**Status:** CONFIRMED. `theme-context.tsx` toggles `.dark` on `<html>`, persists in `localStorage`, respects `prefers-color-scheme` first load. All colours are CSS variables in `globals.css`.
**Refactor priority:** P3 (solid; keep)
**Evidence:** `contexts/theme-context.tsx`, `globals.css:15`.

---

# Feature: PWA / installability

**Status:** PARTIAL. `manifest.ts` (icons are `window.svg`/`globe.svg` placeholders), `pwa-registry.tsx` registers a service worker. No offline strategy reviewed; SW file not in `src` (in `public/`, `UNKNOWN` contents).
**Refactor priority:** P2
**Evidence:** `app/manifest.ts`, `components/pwa-registry.tsx`.

---

## Summary counts

| Category | Count |
|---|---|
| CONFIRMED features | ~34 |
| PARTIAL / half-wired | 8 (groups add-member, GIFs, stickers, tags, notifications, PWA, saved-messages type, wallpaper cleanup) |
| NOT IMPLEMENTED (commonly expected) | password reset, email/phone verification, OAuth, 2FA, report, bookmarks, disappearing messages, delivered receipts, server push, video calls, message translation, link previews (server), threads |
| Dead / stub code | `POST /stickers/bot/create-from-message`, `stickerService.createFromMessage`, `logoutAllSessions` (no UI), chat "new" step-3 member add, `declineShared` |
| Confirmed latent bugs | `image` vs `avatarUrl` field mismatch (users), `forwardFrom.image` vs `.avatarUrl`, voice `duration` dropped, file `originalFilename` not persisted, config-log password env var name mismatch |
