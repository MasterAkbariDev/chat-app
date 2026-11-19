# legacy-backend

The backend refactor described in `../docs/plans/BACKEND_PLAN.md`
(**B0–B12** done — the plan's full scope). This is a new
project root: it started as a hardened copy of the existing
`legacy-chat` backend (all business logic ported as-is), with each phase's work applied on top.
See `../docs/plans/BACKEND_PLAN.md` for the full rationale and `docs/REALTIME.md` for the
Socket.IO event contract.

## What changed vs. the old backend

- `POST /config-logs` and the config-bot auto-create are gone entirely (unauthenticated write route
  with a hardcoded fallback password). A `TODO(config-bot)` marker is left in `src/app.module.ts`.
- Every route is guarded by default (`APP_GUARD` + `@Public()` opt-out) instead of guard-per-route.
- `@nestjs/throttler` (Redis-backed) rate-limits login, register, search, upload, and — at the
  socket layer — `send_message`.
- `helmet` + an explicit `CORS_ORIGIN` allowlist (no wildcard fallback) shared by the HTTP server,
  the Socket.IO gateway, and the `/uploads` static handler.
- `chatmembers` now has a unique `(channelId,userId)` index (plus 3 supporting indexes);
  `messages` has 2 additional indexes. See `docs/DATABASE_AUDIT.md` in the parent `chat-app` repo.
- `PublicUserDto`/`MeDto`/`SessionDto` (`src/common/dto/user-view.dto.ts`) so no response leaks
  `password`/`tokenVersion`/`email`/`phoneNumber` to anyone but the account owner.
- `chatmembers.role`/`isBanned` are the sole source of truth for roles/bans — `chat.admins[]` is
  now a derived, read-only mirror (the frontend still reads it) and `chat.banned[]` is gone.
- `POST /chats/:channelId/members` — adding members to a group actually works now (previously no
  endpoint existed; the frontend's flow created DM chats instead).
- `MediaService` (`src/media/`) is the one image-upload pipeline: magic-byte sniffing (never trusts
  the client's claimed extension), SHA-256 dedupe, `sharp`-generated `web`/`thumb` variants +
  blurhash, and EXIF/GPS stripped from every stored copy including the "original". Storage sits
  behind a `MediaStorage` interface (disk today; S3 in B11 with no call-site change). Replaces 3
  duplicated dedupe helpers and 2 duplicated ffmpeg-path resolvers.
- `GET /v1/channels/mine` — the first real `/v1` endpoint (Nest URI versioning is enabled;
  every other controller keeps responding unversioned). One aggregation, cursor-paginated,
  backed by a new `chat_state` collection kept in sync by `ChatStateListener` off
  `message.created|deleted`/`membership.changed` events (`@nestjs/event-emitter`) instead of
  aggregating `messages`/`chatmembers` live on every request — replaces the legacy
  `GET /chats/my-chats`'s N+1 (a separate query per DM to find the other member). List/error
  responses use the `{items, nextCursor}` / `{error: {code, message}}` envelope on this endpoint
  only; legacy routes are unchanged.
- `ResilientThrottlerGuard` (`src/common/guards/`) — the stock `ThrottlerGuard` turns *any* Redis
  error into an unhandled 500 on every throttled route (nearly all of them, per B0's global
  guard); this subclass fails **open** (allows the request, logs a warning) when the storage call
  itself errors, while still enforcing real rate-limit hits normally. Paired with a fail-fast
  ioredis config (`maxRetriesPerRequest: 1`, no reconnect backoff) so an unreachable Redis is
  detected in ~2s instead of the default retry storm taking 20+ seconds per request.
- **B3**: cross-node Socket.IO delivery (`@socket.io/redis-adapter`), presence moved from
  `user.isOnline` in Mongo to Redis (`src/presence/`), `user_status_changed` scoped to shared
  rooms instead of every connected socket, and a `resync` WS event for reconnect gap-filling.
- **B4**: rotating refresh tokens with reuse detection (`src/auth/schema/session.schema.ts`,
  `AuthService.rotateRefreshToken`) — access tokens are now 15 min (was 7 days); `POST
  /auth/login`/`register` return a `refresh_token` too, `POST /auth/refresh` rotates it, and
  presenting an already-rotated token revokes every session in its family. `JwtStrategy` reads a
  Redis-cached `{tokenVersion, isDeleted}` instead of Mongo on every request. New
  `GET /v1/auth/me`, `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/:id`.
  **⚠ frontend-breaking if not paired with a client update**: the old 7-day token meant the
  current frontend (which has no refresh flow) never needed to re-authenticate; at 15 min it
  will start seeing 401s mid-session until it's updated to call `/auth/refresh`. Also
  fixed during B4/B5 testing: `Session.userId` (and `@Prop({type: Types.ObjectId})` app-wide)
  resolves to a Mongoose `Mixed`-typed path in this project's Mongoose/NestJS versions, not a
  real ObjectId SchemaType — so a plain string never auto-casts against it. `listSessions` /
  `revokeSession` / `revokeAllSessions` were the one place relying on that cast instead of
  pre-casting like every other call site; `GET /v1/auth/sessions` always returned `[]`, and
  logout-all/change-password never actually revoked existing refresh-token sessions. Fixed by
  casting explicitly at those 3 call sites.
  - **Per-account login lockout**: on top of B0's IP-based throttler (which doesn't stop a
    distributed attempt against one specific account), `User` gains `failedLoginAttempts`/
    `lockedUntil` — 5 wrong passwords locks the account for 15 minutes, even against the
    correct password; a successful login resets the counter. Verified live: 5 wrong attempts,
    then confirmed via a real bcrypt-hashed test account that the account-level lock (not just
    the IP throttle, which shares the same 5/min threshold and otherwise masks it in a single
    HTTP burst) rejects the correct password too — see `AuthService.validateUser`'s tests for
    the clean isolation the shared-threshold collision makes hard to show over raw HTTP.
  - **Admin identities + mandatory MFA** (`src/admin/`): a separate `admin_users` collection
    (`AdminUser {email, passwordHash, role, mfaSecret, isDisabled}`) — an admin never has a
    regular `user` document, and nothing promotes one in place. `POST /v1/admin/auth/login`
    requires password **and** a valid 6-digit TOTP code every time (`otplib`'s classic
    `authenticator` API — see the version note below); there is no MFA bypass and no public
    "register admin" endpoint — the only way to create one is `npm run seed:admin -- --email=...
    --password=... [--role=superadmin|support|moderator]`, which prints an `otpauth://` URI to
    scan into an authenticator app. Admin routes require a distinct **admin-audience** JWT
    (`aud: "admin"`, checked explicitly by a separate `AdminJwtStrategy`/`"admin-jwt"` Passport
    strategy) — same signing secret as user tokens, but a user's regular access token is
    rejected on every admin route (verified live: "Not an admin token"), and vice versa. Admin
    tokens are longer-lived (12h) with no refresh-rotation chain yet — not required by this
    phase's acceptance criteria, noted as a gap below.
    - **Dependency note**: `otplib`'s current major (13.x) defaults to `@scure/base`/`@noble`
      plugins that are ESM-only with no CJS build at all (`@scure/base`'s `package.json` has no
      `require` export condition whatsoever) — this breaks under Jest *and* under this project's
      own CommonJS build, not just tests. Pinned to `otplib@^12.0.1`, the last version using the
      classic `authenticator` singleton over plain-CJS `@otplib/plugin-crypto` (Node's built-in
      `crypto`) and the long-established `thirty-two` package for Base32 — no ESM anywhere in
      the chain.
  - **Password-recovery link** (Q1): `POST /v1/auth/recovery-request {identifier}` always
    returns the same generic response whether or not the account exists (no account
    enumeration) and creates a `recovery_requests` row for a real one. An admin reviews pending
    rows (`GET /v1/admin/recovery-requests`) and approves (`POST .../approve`) or denies
    (`POST .../deny`) — approval mints a 10-character Crockford-Base32 opaque token (no
    0/O/1/I/L ambiguity — safe to read aloud or retype), returned **once**, for the admin to
    copy and send out of band; only its SHA-256 hash is ever persisted (`recovery_tokens`,
    same pattern as `Session.refreshTokenHash`). `GET /v1/auth/recovery/:token` checks validity;
    `POST /v1/auth/recovery/:token {newPassword}` resets the password, bumps `tokenVersion`, and
    revokes every session — logs the user out everywhere, single-use. Verified live end-to-end:
    request → admin list → approve → validate (`{valid:true}`) → reset → the same token
    re-validated as `{valid:false}` → login with the new password succeeds.
  - **Account deletion: re-auth + cleanup job** (`src/account/`, a dedicated
    `AccountDeletionService` rather than folding into `UserService` — this needs direct model
    access across five modules' schemas for one wide, one-shot operation, and those services'
    own methods carry ownership checks that don't apply here). `DELETE /v1/auth/account
    {password}` re-verifies the current password, then: deletes every `ChatMembers` row (leaves
    every chat/group/channel), deletes `Block` rows in both directions, deletes owned
    `Clip`/`StickerPack`+`Sticker`/`Wallpaper` rows and releases their `MediaAsset` reference
    counts ("orphan media refcount"), and anonymises the profile
    (`firstName/lastName → "Deleted"/"User"`, `username`/`email` replaced with a stable unique
    placeholder, `bio`/`phoneNumber`/`image` cleared) before soft-deleting and revoking every
    session. **"Anonymise authored messages" needed zero message-collection writes**: every
    message read already `.populate("senderId", "username firstName lastName image")` live off
    the `User` document (see `message.service.ts`), so scrubbing those fields on the one User
    doc makes every message they ever sent display as "Deleted User" retroactively, for free.
    Verified live: wrong password rejected with the account untouched; correct password deletes,
    and the old access token is immediately rejected afterward ("User no longer exists or is
    inactive"). The pre-existing, more limited `DELETE /users/:id` (no re-auth, no cleanup) is
    left as-is — legacy, not removed this phase (that's B12).
  - **Not done**: admin sessions have no refresh-token rotation chain (a single 12h token, no
    family/reuse-detection the way user sessions get) — not required by this phase's acceptance
    criteria, but a real gap if admin sessions need revocation before natural expiry. No admin
    UI — `src/admin/` is API-only; a support admin currently needs `curl`/Postman/an admin panel
    that doesn't exist yet in this repo. No per-account lockout on the *admin* login endpoint
    specifically (TOTP already makes pure password-guessing insufficient, judged adequate).
- **B5**: `message_reactions` collection (`src/message/schema/message-reaction.schema.ts`)
  replaces the `message.reactions` Map — a toggle is a delete-or-insert against it instead of a
  read-modify-write of the whole message, reaction counts come from one batched `$group` per
  page (`MessageDto.reactions = [{emoji,count,me}]`), and there's a 20-distinct-emoji cap per
  message. The separate quick-reaction endpoint is gone — the client sends its own
  `quickReaction` value to the same `POST /messages/:id/reaction`. The `emoji_usage` collection
  and module are removed entirely (recents move client-side). `replySnapshot`
  `{id,senderName,snippet,messageType}` is captured once at send time, so reads never
  `.populate("replyTo")` again; `forwardFrom` is now `{name, avatarUrl}` (was silently dropping
  `avatarUrl` — the schema declared `image`, the service wrote `avatarUrl`, Mongoose stripped
  the unknown field). Voice `durationSec`/`waveform` and file `originalFilename` are now
  actually persisted (the DTO accepted `duration` since B0 but no schema field existed, so it
  was always discarded). `message.readBy` is gone — read receipts are the `chatmembers`
  `lastReadMessageId`/`lastReadAt` pointer only (already existed since before B5), now also
  broadcasting `read:updated` over the REST path (previously WS-only), and a new
  `GET /v1/messages/:id/reads` returns "seen by" **only to the message's author**, and only for
  DMs/groups (empty for channels). `ChatMembers.hiddenAt` replaces bulk-writing `deletedFor` onto
  every historical message when a user leaves a private chat (was
  `messageModel.updateMany({channelId}, ...)` — O(channel history) per leave); message reads now
  additionally filter on `createdAt > hiddenAt` when it's set. Message content is sanitized
  (C0 control chars stripped, tab/newline/CR kept) on create and edit; an edit that's empty after
  sanitizing is rejected. **Not done**: `create()`'s 3 independent pre-checks are now
  parallelised (one round trip instead of three sequential ones) but still 3 separate queries —
  hitting the plan's literal "≤3 queries/send" would need denormalizing chat type onto
  `ChatMembers` to drop the `Chat` lookup entirely, which touches every membership-creation call
  site and was judged too wide a blast radius for this pass. `attachments` are still
  `string[]` (not `MediaRef[]`). `clearedBeforeMessageId` (an explicit "clear chat history"
  action) isn't implemented — no such endpoint exists yet to attach it to.
- **B6**: the address book, folders, and unified search.
  - `POST /v1/contacts` adds a contact by exactly one of `userId` (the "Add contact" button —
    the frontend already knows exactly who, e.g. a chat member, so it sends their id directly,
    no lookup needed), `phone` (the primary discovery path — like WhatsApp/Telegram, matching a
    number from your own phone contacts; you can only add this way if you already know it),
    `username`, or `email` (exact match only, no fuzzy matching; rate-limited 10/min).
    `GET /v1/contacts` returns each contact's public profile, live presence, and existing DM
    (`channelId`/`lastMessageAt`/`lastMessagePreview`, all `null` if none) in one pass — no N+1
    per contact. `PATCH`/`DELETE /v1/contacts/:id`.
  - **Mutual contacts reveal phone/email on the profile page**: `GET /users/by-id/:userId` and
    `GET /users/:username` now return a `ProfileViewDto` — `PublicUserDto` (never touches
    phone/email) plus optional `phoneNumber`/`email`, present only when the viewer and the
    target have **each** added the other as a contact (`UserService.areMutualContacts`; one-sided
    doesn't count) or it's the viewer's own profile. Deliberately a separate DTO/function from
    `toPublicUserDto` — nothing else in the app can accidentally start leaking contact info by
    reusing the public mapper.
  - `chat_folders {ownerId,name,order,filters}` + `GET/POST/PATCH/DELETE /v1/folders`.
    `GET /v1/channels/mine?folder=<id>` applies `includeTypes`/`includeTags`/
    `includeChannelIds`/`excludeChannelIds`/`onlyUnread` server-side, inside the same
    aggregation — never a second query. `POST /chats/:channelId/tags` (which folders read via
    `includeTags`) is now **admin/owner only** — was any member, letting anyone silently move a
    chat in or out of someone else's folders.
  - `GET /v1/search?q=&scope=people|channels|messages` — all three backed by real `$text`
    indexes (`explain()`-verifiable `IXSCAN`/text-index usage) rather than regex. `people`
    matches username/name only — the text index doesn't even include `email`/`phoneNumber`, so
    there's no query shape that can leak them. `channels` matches group/channel name+description
    only. `messages` is scoped to the caller's own channels only. `GET
    /v1/channels/:channelId/messages/search` — snippet + cursor windows for one channel,
    replacing the legacy `GET /messages/channel/:channelId/search`'s bare 500-id array (kept,
    unchanged, for existing callers).
  - **Found and fixed while building this**: the legacy `GET /chats/search` and `GET /chats`
    had no `type` filter at all — a private 1:1 chat's `link` embeds both members' user ids
    (`private-<id1>-<id2>`), so a regex search anyone could call was theoretically able to
    confirm a DM's existence between two known user ids. Scoped to `group`/`channel` types only.
- **B9**: personal clips, the Giphy-backed global GIF/sticker tab, real sticker-pack uploads
  with maintained usage counts, and wallpaper upsert/membership-guard/nightly-GC — full B9
  acceptance criteria met (see the dedicated sub-sections below the Giphy tab).
  - Tenor is dead, not just renamed — Google froze new API signups 2026-01-14 and fully shut the
    service down 2026-06-30 (already past by the time this was built). Switched to **Giphy**.
  - New `src/giphy/` module: `GiphyClientService` (thin Giphy REST wrapper — `search`/
    `trending`/`getById`/`fetchBytes`, via `axios`, already a dependency) and `GiphyService`
    (the cache-on-first-use orchestration). `GET /gifs/giphy/search`, `GET /gifs/giphy/trending`,
    `POST /gifs/giphy/:giphyId/use` (same three routes under `/stickers/giphy/...` for stickers).
  - **Cache-on-first-use**: the first time any user "uses" a given Giphy id, the asset is
    downloaded and run through the existing B2 `MediaService.ingestImage` (same SHA-256 dedupe,
    same GIF-safe no-re-encode path already built for uploads — no `MediaService` changes
    needed), and a `giphy_media {giphyId, kind, mediaAssetId, usageCount, lastUsedAt}` row
    records the mapping. Every later use of that same id — by anyone — is served entirely from
    our own storage, no Giphy call: verified live (first use ~7.7s real download, second use
    ~0.03s from cache, `media_assets` count unchanged). This is deliberate, not just a perf
    optimization — it means already-used GIFs/stickers keep working even if Giphy becomes
    unreachable or shuts down the way Tenor did.
  - `giphyId`/`kind` is a unique key — a gif and a sticker that happen to share a Giphy id (rare
    but possible, since Giphy's stickers are ordinary GIF objects with `is_sticker` set) get
    separate cache rows, since `MessageType.GIF` and `MessageType.STICKER` are distinct message
    types on our side.
  - **Found and fixed while building this**: Giphy has **no** `/v1/stickers/{id}` endpoint —
    stickers and gifs share one object/id namespace, and the single-item lookup only ever exists
    under `/v1/gifs/{id}` (confirmed against the real API: fetching a sticker id from that path
    returns `{"type":"sticker", ...}`). Only `search`/`trending` actually differ by kind;
    `getById` always hits `/v1/gifs/{id}` regardless. First surfaced as a live 500 during manual
    testing (unit tests didn't catch it — they mock the Giphy client entirely).
  - **Not done**: the `GIPHY_API_KEY` free "beta" tier is capped at ~100 req/hr, 1,000/day — fine
    at this app's scale, no code changes made for it.
- **Personal clips** (`src/clips/`) — replaces the old `user_gifs`/`src/gif/` personal-library
  code, which had its own hash-dedupe/disk-storage pipeline running in parallel to the real
  `MediaService`. A clip is now just `{ownerId, mediaId, title?, lastUsedAt, usageCount}` —
  `POST /v1/clips` (multipart video) converts the clip to a GIF with the same ffmpeg
  palette/fps/scale pipeline as before (`GifConversionService`, moved into this module — its
  only remaining consumer), then saves the result via `MediaService.ingestImage` (so GIF
  dedupe/size-capping is the one real pipeline, not a second copy of it). `GET /v1/clips`,
  `POST /v1/clips/:id/use`, `DELETE /v1/clips/:id` (releases the underlying `MediaAsset`
  reference count). The old cross-user "trending" aggregation over `user_gifs` is gone —
  clips are personal-only now; "what's popular" is Giphy's global tab. Verified live with a
  real ffmpeg-generated test video: uploaded → converted → GIF servable over HTTP → used →
  deleted, with the `MediaAsset` refCount going 1→0 on delete.
  - **`app_settings` (the `trendingGifs` toggle) is removed entirely** — it only ever gated that
    now-deleted cross-user trending list.
  - **Breaking for the old personal-GIF endpoints**: `GET /gifs` (browse/mine), `POST
    /gifs/upload`, `POST /gifs` (publish), `POST /gifs/mine`, `DELETE /gifs/mine/:id` are all
    gone — `/gifs/giphy/...` (the global tab) is unaffected. A client using the old personal
    library needs to move to `/v1/clips`.
- **Sticker packs** (`src/sticker/`) — real upload via `MediaService` instead of a raw
  `stickers: string[]` array of externally-hosted URLs, and usage counts that are actually
  maintained (the field existed on the old schema but nothing ever incremented it).
  - New `stickers` collection (`{packId, mediaId, usageCount, lastUsedAt}`) — each sticker image
    now has its own stable id, which is what `POST /v1/stickers/:id/use` increments (the old
    schema's raw URL strings had no identity to hang a per-sticker count off of).
    `StickerPack.totalUsageCount` is a denormalized sum, updated alongside the per-sticker
    counter — avoids an aggregation on every pack list. `POST /v1/sticker-packs` creates an
    empty pack; `POST /v1/sticker-packs/:packId/stickers` (multipart, owner-only) uploads the
    actual images. `creatorId` renamed to `ownerId` for consistency with every other schema in
    this codebase (`MediaAsset.ownerId`, `Wallpaper.ownerId`, `Clip.ownerId`).
  - **Deleted the dead `POST /stickers/bot/create-from-message`** — it always threw
    `BadRequestException` telling the caller to use the real endpoint instead; confirmed 404
    live after removal.
  - Verified live: created a pack, uploaded a real image via multipart, used the resulting
    sticker 3 times, confirmed both the sticker's own `usageCount` and the pack's
    `totalUsageCount` read back as 3.
  - **Breaking**: `sticker_packs.creatorId`/`stickers: string[]` are gone (see the migration
    script note below); `POST /stickers/packs` no longer accepts a `stickers` array at creation.
  - **Not done**: no starter/seed public packs — the plan's "Work" section suggests seeding a
    few, but it isn't in the phase's acceptance criteria, and there was no real sticker art on
    the old system worth scripting a migration around. Pack search is still `$regex` over
    name/description/tags (fine at this app's scale) rather than a real `$text` index like B6's
    global search.
- **Wallpaper** (`src/wallpaper/`) — upserts one doc per `(ownerId, channelId)` scope instead of
  creating a new one on every apply, media goes through the real `MediaService` instead of a
  second dedupe/storage pipeline, reads are membership-guarded, `decline` is removed, and a
  nightly job GCs wallpapers no scope points at anymore.
  - **Upsert, not create-per-apply**: `Wallpaper` now has a unique `{ownerId, channelId}` index;
    `applyGlobal`/`applyChat` `findOneAndUpdate(..., {upsert: true})` the one doc for that scope
    instead of inserting a new one every time — verified live by applying a global wallpaper
    twice and confirming the same `_id` came back both times. **Behavior note**: because it's
    the same document mutated in place, if someone else `acceptShared`-ed this scope's wallpaper
    (their `chatMembers.chatWallpaperId` points at the same `_id`), a later re-apply changes what
    they see too — there's no longer an old, frozen copy left behind for them. This is the
    direct, deliberate consequence of no longer leaving an unbounded trail of orphaned docs.
  - **Media via `MediaService`**: `uploadImage`/`uploadVideo` now ingest through the real
    pipeline (dedupe, size caps, and for video, real compression + poster-frame extraction) —
    replaces `WallpaperMediaService`'s own hash-dedupe/`upload_records` bookkeeping. The
    wallpaper-specific 5-second-max-duration probe/trim (browser-trim overshoot up to +1.25s
    auto-clipped) is kept — that part is genuinely wallpaper-specific — but now reuses the
    shared `probeVideoDurationSec` util instead of a second ffmpeg-probing implementation.
    `Wallpaper` gained a `mediaId` field (the `MediaAsset` it came from) so the GC job below has
    something to release; the apply DTO carries it back from the upload response.
  - **Membership-guarded reads**: `GET .../chat/:channelId` and `GET .../:id` now enforce chat
    membership (previously only the *write* paths — `applyChat`/`resetChat` — did; a read
    silently returned `null`/data instead of 403ing a non-member). `getById` on a global
    wallpaper is owner-only — there's no channel to check membership against, and a global
    wallpaper is personal, not something a stranger should be able to fetch by guessing an id.
  - **`decline` removed** — the endpoint (`POST /:id/decline`) and service method were already a
    documented no-op (declining never persisted anything); deleted rather than kept as dead code.
  - **Nightly GC** (`WallpaperGcService`, `@nestjs/schedule`'s `@Cron` at midnight): a wallpaper
    becomes unreferenced when `resetGlobal`/`resetChat` clears the pointer but can't safely
    delete the doc outright (another member may still be pointing at the same one via
    `acceptShared`). The nightly sweep computes every currently-referenced wallpaper id (every
    `user.globalWallpaperId` + `chatMembers.chatWallpaperId`), deletes any `Wallpaper` doc not in
    that set, and releases its `MediaAsset` reference count — never deletes the underlying media
    file/row itself, which stays an explicit B11 concern. Verified with 4 unit tests (referenced
    docs survive, orphans are deleted + refCount released, refCount never goes negative);
    `@Cron`-based jobs aren't practical to verify by waiting for midnight, so `runGc()` is called
    directly in tests, same as the actual cron handler does.
  - Added `@nestjs/schedule` — pinned to `^6.1.3`, not the current major (`12.x`): v12 ships
    ESM-only (`"type": "module"`, no CJS build), which breaks both Jest (ts-jest, no ESM
    transform configured) and this project's own CommonJS build output. `6.1.3` is the last
    version before that switch and is compatible with Nest 11.
  - **Breaking**: `POST /v2/wallpapers/:id/decline` is gone. Upload responses
    (`upload/image`/`upload/video`) gain a `mediaId` field — additive, not breaking, but a client
    that wants the GC to track its uploads correctly should start passing it back in `mediaId` on
    the apply call.
- **`scripts/migrate-legacy-data.ts` updated for B9's schema changes**: `user_gifs`,
  `sticker_packs`, and `app_settings` are no longer copied 1:1 — `user_gifs`/`app_settings` are
  retired features with no equivalent new shape to backfill into (a `MediaAsset` can't be
  reconstructed from an old `user_gifs` row without re-ingesting its file, which the script
  doesn't attempt), and `sticker_packs` changed shape (`creatorId`→`ownerId`,
  `stickers: string[]`→a `stickers` sub-collection). `wallpapers` gets a new dedupe step —
  the old system created a new doc per apply with no cleanup, so copying every legacy doc as-is
  would violate the new unique `(ownerId, channelId)` index; each scope's group is collapsed to
  its most-recently-updated doc (same "latest wins" approach as the existing `chatmembers`
  dedupe), and `mediaId` is set to `null` on every migrated row (the old system never tracked a
  `MediaAsset` reference).
- **Media compression + upload limits** (follow-up requested alongside B9): every media upload
  now has a real, per-content-type ceiling, enforced inside `MediaService` itself (not just a
  controller's multer limit) so it applies uniformly regardless of entry point — including
  B9's Giphy mirror-on-first-use, which calls `ingestImage` directly with a fetched buffer.
  - **Images** (`POST /upload/image`): 10MB → **20MB**.
  - **Animated GIFs**: **8MB** — enforced inside `ingestImage` after magic-byte sniffing
    determines the format (multer's own limit is per-*endpoint*, not per-detected-type, so this
    can only be checked once the content is actually inspected). GIFs are still stored
    un-re-encoded (real GIF recompression would mean re-running the same palette/fps/scale
    ffmpeg pipeline `gif-conversion.service.ts` already uses for video→GIF — not done this pass).
  - **Videos**: new `POST /upload/video` + `MediaService.ingestVideo` — **200MB** input cap, and
    (this is the actual "make sure media are compressing" gap) **real compression**: transcodes
    to H.264/AAC mp4 via `ffmpeg-static` (already a dependency), scaling down to fit 1280px on
    the long side (never upscaling — `src/media/video-processing.util.ts`), plus a JPEG poster
    frame. Fills in two previously-declared-but-dead `MediaAsset` fields for the first time:
    `variants.poster` and `durationSec` (parsed from ffmpeg's own `-i` stderr — no `ffprobe`
    binary needed). Dedupe still keys on the *original* upload's hash so a re-upload of the same
    source file isn't re-encoded twice; `sizeBytes` reflects the *compressed* size actually
    stored. Previously, a chat video attachment went through the generic `POST /upload` (250MB,
    zero compression, zero type checking) — verified live: a 1920×1080 test clip came out
    1280×720 H.264, 124KB→49KB, with a working poster JPEG.
  - New `src/media/video-sniff.util.ts` (magic-byte detection for mp4/mov/webm/mkv/avi,
    mirroring the existing image sniffer) — never trusts the client's claimed extension/mimetype,
    same rule as images.
  - **Not done**: the generic `POST /upload` (arbitrary files — PDFs, docs) is unchanged, still
    250MB with no compression — that's by design for non-media attachments, not an oversight, but
    it also means an old client that keeps sending video through it still gets no compression;
    only clients that switch to the new `/upload/video` endpoint benefit. No width/height
    extraction for the video's own frame size (only the poster's), and no audio-only
    (voice-message) compression pass — voice messages have their own separate flow already
    (`durationSec` on the *message*, not the media asset).
- **B7**: notifications fan-out — **Android/Flutter only, no APNs/iOS** (explicitly not wanted
  for this app; web stays foreground-only per the plan, driven by the socket events it already
  gets — that's frontend work, not built here).
  - New `src/notifications/` module. `POST /v1/push/tokens` registers a device's FCM token
    (upsert keyed on the token itself, so a token refresh just re-registers); `DELETE
    /v1/push/tokens` unregisters (call on logout). `PATCH /users/notifications` sets the caller's
    own level: `all` (default) / `mentions` (only when @mentioned) / `none` (never push — still
    delivered live over the socket if the app is open).
  - `NotificationService` listens for `message.created` (now carrying `senderId`/`messageId`/
    `mentions` — extended for this) and decides who to push to: every joined, non-banned,
    non-muted member except the sender, filtered by their `notificationLevel`, and — the "skip if
    the recipient has the channel open" rule — a new `ChatGateway.isUserInChannelRoom(userId,
    channelId)` checks the Socket.IO adapter's own room membership directly. That check is
    single-node (this app's actual deployment shape); a true multi-node version would need a
    shared store, not attempted here.
  - `FcmService` wraps `firebase-admin`'s **modular** `firebase-admin/app` + `firebase-admin/
    messaging` entry points (v14 dropped the old `admin.initializeApp()`/`admin.messaging()`
    namespace API those replace — first hit as a typecheck failure, fixed before it ever ran).
    Reads the service-account key from `FCM_SERVICE_ACCOUNT_PATH` or
    `backend/secrets/fcm-service-account.json` (git-ignored); if neither exists, every send is a
    silent no-op (one warning at boot) rather than breaking the rest of the app.
  - A dead/uninstalled token is deleted automatically the first time FCM reports it as no longer
    registered, rather than retried forever. Verified live against the real Firebase project (the
    key already in `secrets/`): registered a token, sent a message with the recipient not in the
    channel's socket room, confirmed a real FCM call was attempted, and confirmed FCM's
    "not registered" response for a fake test token correctly deleted it from `push_tokens`
    — the actual delivery-to-a-device leg can't be verified without a real Android app, but every
    other part of the pipeline (recipient resolution → level/mute/presence filtering → real FCM
    call → invalid-token cleanup) was exercised against the live API, not mocked.
  - **Not done**: no BullMQ job queue — the plan's ideal is enqueue-then-worker-sends (durability,
    retry, per-user cooldown, collapse-by-channel); this sends directly and synchronously inside
    the (already off-hot-path, `{async:true}`) event listener instead, judged adequate at this
    app's scale and a meaningfully smaller amount of new infrastructure. No quiet hours (marked
    optional in the plan). No `call.ringing` subscription — B8 (calls) doesn't exist yet, so
    there's no event to subscribe to.
- **B8**: calls moved from an in-memory, mesh-WebRTC signaling relay to a **self-hosted LiveKit
  SFU + self-hosted coturn TURN relay**, both running as containers on the same server as the app
  (`docker-compose.yml`'s new `livekit`/`coturn` services) — a cloud LiveKit subscription was
  explicitly ruled out; the API key/secret pair is generated locally (`openssl rand -hex ...`),
  never obtained from an external service, and must match between `.env` and `livekit.yaml`
  (`livekit.yaml.example` documents this and is the tracked template; the real `livekit.yaml`,
  like `.env`, is git-ignored).
  - New `src/calls/` module: `CallStateService` (call state in Redis, 6h TTL, replacing the old
    process-`Map` — a call now survives an API restart) and `LiveKitTokenService` (signs a
    scoped, 10-minute room-join JWT per participant via `livekit-server-sdk`). `CallsService`
    holds all the application logic; `CallsController` exposes it as `POST /v1/calls` (create +
    ring), `POST /v1/calls/:id/join`, `/leave`, `/decline`.
  - The gateway's role shrank from 10 `call_*` WebSocket handlers plus all mesh peer-connection
    bookkeeping down to 3 one-way *notification* events only (`call:ringing`, `call:ended`,
    `call:missed`) — matches the plan's "≤3 call-related gateway handlers" acceptance criterion
    exactly. Everything else (media negotiation, per-participant connections) is now LiveKit's
    client SDK's job, not this backend's.
  - **Exactly one call-log message per call** (plan acceptance criterion): written only at
    finalization (`CallsService.finalizeCall`), never per lifecycle event — `kind: "missed" |
    "declined" | "ended"`, with `durationMinutes` only for `"ended"` (measured from when a 2nd
    distinct participant actually joined, i.e. "answered," not from call creation). Replaces the
    old mesh system's 4 separate message-creation call sites.
  - Group calls are capped at 16 participants (`MAX_GROUP_CALL_PARTICIPANTS`); a private call
    always ends the moment either side leaves, a group call only once everyone has. Block checks
    (either direction) apply to starting a private call, same as the old system.
  - **Found and fixed while building this**: an early draft applied `ParseObjectIdPipe` to the
    `:callId` route param — but `callId` is a `crypto.randomUUID()`, not a Mongo `ObjectId`, so
    every real call would have 400'd. Caught on review before it ever ran, not from a test.
  - Verified live against the real, self-hosted containers (not mocked): registered two users,
    created a private chat, `POST /v1/calls` → `POST /v1/calls/:id/join` for both sides → the
    returned room token was independently validated by hitting **LiveKit's own**
    `/rtc/validate` endpoint (200 — proves the locally-generated key/secret pair actually works
    end-to-end, not just that our code thinks it does); confirmed `kind:"ended"` +
    `durationMinutes` after both joined and one left, `kind:"missed"` when only the callee never
    joined, `kind:"declined"` on explicit decline, a concurrent 2nd private call rejected with
    "A call is already in progress," and the Redis call-state keys gone after finalization. Real
    audio/video media flow through LiveKit itself can't be verified without an actual WebRTC
    client app — out of reach here.
  - **Not done**: no LiveKit webhook receiver — cleanup relies on the client explicitly calling
    `POST /v1/calls/:id/leave`; a crashed client instead relies on the call state's 6h Redis TTL
    to eventually expire, not immediate webhook-driven cleanup. `NotificationService` (B7) still
    does not subscribe to `call:ringing` — an incoming call while the app is backgrounded doesn't
    yet trigger an FCM push, only the in-app socket event. LiveKit is stood up with its own TURN
    integration explicitly disabled (`turn.enabled: false`) in favor of the separate coturn
    container, but `livekit.yaml`'s `rtc.ice_servers` (the setting that would actually hand
    coturn's address to clients) is left commented-out/unset — it needs the deployment's real
    public IP/domain, which local dev doesn't have; coturn itself is running and reachable
    (verified with a UDP STUN handshake to port 3478) but not yet wired into the ICE candidate
    list LiveKit gives out. Single-node-only presence semantics carry over unchanged from B3/B7
    (same caveat, not re-litigated here).
- **B10**: reporting & moderation API (`src/moderation/`) — report → queue → action, with an
  append-only audit log and suspended-user enforcement everywhere a suspended user could
  otherwise still act.
  - `POST /v1/reports` (any user, 10/min) — `{targetType: message|user|channel, targetId,
    reason, note?}`; a unique `(reporterId, targetType, targetId)` index dedupes repeat reports
    of the same target by the same reporter (verified live: a second report of the same target
    by the same reporter 400s "You've already reported this"; a different reporter can still
    report it).
  - Admin queue: `GET /v1/admin/reports?status=&type=`, `PATCH /v1/admin/reports/:id`
    (`{status, action?}` — sets `handledBy`/`handledAt`). Deliberately decoupled from the actual
    moderation actions below — resolving a report describes what was done, it doesn't do it.
  - **Moderation actions**, every one logged to the append-only `moderation_log`
    (`{actorId, action, targetType, targetId, meta, at}` — nothing ever updates or deletes a row
    there): `POST /v1/admin/users/:id/suspend {until?, reason}` (`until` omitted = indefinite —
    a far-future sentinel date, since `suspendedUntil` is a plain `Date` field, not an extra
    boolean) / `.../unsuspend`; `POST /v1/admin/users/:id/warn {message}` — delivered as a real
    DM from a lazily-created "Moderation" system account (get-or-created on first use; a fixed
    `private-mod-<userId>` chat link means repeat warnings reuse the same DM rather than
    spawning a new one each time — verified live: two warnings to the same user landed as two
    messages in one DM, with exactly one `moderation` user account created); `DELETE
    /v1/admin/messages/:id` — hard-hides a message by scrubbing `content` to a placeholder (not
    just flagging `isDeleted`, which the user's own soft-delete already does — a moderator
    removal shouldn't leave the original text sitting in the database for anyone with raw
    access); `POST /v1/admin/channels/:id/lock` (blocks new messages, enforced in
    `MessageService.create` against the existing chat lookup — no extra query) — `.../unlock`
    added too (not in the plan's literal endpoint list, which names only "lock" — a lock with no
    way back would make the action a one-way door); `POST
    /v1/admin/channels/:id/members/:userId/remove` — a platform-level removal that bypasses the
    normal chat-owner/admin permission check (a platform admin acts regardless of their own
    membership in that chat).
  - **Suspended-user enforcement** in three places, not just login: `AuthService.validateUser`
    (blocks a fresh login — checked the same way as the B4 lockout, before the password
    comparison), `JwtStrategy` (blocks every already-authenticated request — `suspendedUntil`
    added to the same Redis-cached user-state as `isDeleted`/`tokenVersion`; suspending calls
    `tokenCache.invalidate()` so it takes effect on the very next request instead of waiting out
    the cache's 5-minute TTL), and `ChatGateway.handleConnection` (blocks a new WS connection,
    same `select()` + check as the existing `isDeleted` gate). Verified live: suspending a user
    mid-session immediately 403'd their still-valid access token on the next API call *and*
    rejected a fresh login attempt with the correct password; unsuspending restored both.
  - **Not a repeat of the removed config-bot pattern**: the "Moderation" system account is never
    reachable as a login target (no admin-promotion path leads to it, its password hash is a
    random value nobody knows) and only ever gets created from an already-admin-authenticated
    action — unlike config-bot, which was auto-created by an unauthenticated public route.
  - **Not done**: no admin UI for the report queue (API-only, same gap as B4's admin auth); a
    locked channel blocks new messages but doesn't retroactively hide existing ones (that's what
    hard-hide/hard-hide-per-message is for); no bulk moderation actions (one report/user/
    message/channel at a time).
- **B11**: storage tiering, performance, a11y support. This is the widest-scoped phase in the
  plan — object storage, lifecycle tiering, an orphan sweep, perf budgets, structured logging,
  and a consistent error envelope, all in one — so more than any other phase, several pieces
  here are honestly scoped down rather than built to the plan's full ideal; each says exactly
  where.
  - **S3-compatible object storage**: `MediaService`'s `MediaStorage` interface (already
    abstracted since B2 for exactly this) gains an `S3MediaStorageService` alongside the
    existing disk one, selected by `MEDIA_STORAGE_DRIVER=disk|s3`. The bucket is a **self-hosted
    MinIO container** in `docker-compose.yml` — not a cloud S3 account — same self-hosted-over-
    external preference already applied to B8's LiveKit/coturn. `scripts/migrate-media-to-s3.ts`
    background-copies everything under `uploads/media/` into the bucket (idempotent — skips any
    key that already exists); no URL rewrite is needed since relative paths are identical either
    way, only `MEDIA_STORAGE_DRIVER` needs to flip once migrated.
    - **New `MediaServeController`** (`GET /uploads/media/*path`) actually serves the content —
      Express's static file server (what served `/uploads` before B11) can't reach into an S3
      bucket, so it's now excluded for this one subpath. Includes real HTTP byte-range support
      (`Range: bytes=...` → `206 Partial Content` with a correct `Content-Range`) since video
      seeking worked for free under the old static server and would otherwise silently regress;
      `Cache-Control: public, max-age=31536000, immutable` is a genuinely correct directive here
      (not just an optimistic one) since content is addressed by its own hash and can never
      change once written. "Serve from `media.<domain>` + CDN" (the plan's literal wording) is a
      deployment-time reverse-proxy/CDN configuration placed in front of this same route — a CDN
      caching an immutable, hash-addressed URL needs no code change, so it isn't attempted here.
    - **Found and fixed live, not by a test**: the storage-driver provider was originally a
      module-level `process.env.MEDIA_STORAGE_DRIVER === "s3" ? ... : ...` ternary — evaluated
      once when `media.module.ts` is `require()`'d, which happens (via `main.ts`'s import of
      `AppModule`) *before* `NestFactory.create()` ever runs `ConfigModule.forRoot()`'s dotenv
      loading. With the driver only set in `.env` (not the shell), every upload kept silently
      landing on local disk regardless of the setting. Fixed with a `useFactory` provider, which
      Nest doesn't evaluate until DI actually instantiates it — well after dotenv has run.
      Confirmed via a from-scratch upload: no file appears under `uploads/media/<hash>/` locally,
      the object is verifiable in MinIO directly (`mc ls`), and it serves back byte-identical
      over HTTP, range requests included (verified against a real transcoded video, not just a
      tiny fixture).
  - **Lifecycle tiering**: `MediaAsset` gains `tier` (`hot`/`cold`) and `lastAccessedAt`
    (bumped, best-effort, on every real read through `MediaServeController`). A nightly
    `MediaMaintenanceService.runTiering()` (`@Cron`, `@nestjs/schedule`) tags anything untouched
    for `MEDIA_COLD_TIER_DAYS` days (default 90) `cold`; reading a cold asset flips it back to
    `hot` immediately rather than waiting for the next sweep. **Honestly scoped**: on self-hosted
    MinIO there is no distinct cold storage class to actually move data into (unlike R2/B2/
    Glacier-IR) — `tier` today only records the *intent*; it changes nothing about how or how
    fast an asset is served. Wiring a real cloud backend's storage-class API is future work if
    this ever runs against one.
  - **Orphan sweep**: a second nightly job, `runOrphanReport()`, finds every `MediaAsset` at
    `refCount` 0 and logs a summary — **archives, never auto-deletes** (Q7). `GET
    /v1/admin/media/orphans` surfaces the same list for a human to review; `DELETE
    /v1/admin/media/:id` is the one and only place anything in `MediaService` actually gets
    deleted — it re-checks `refCount === 0` server-side (rejects otherwise) and removes every
    variant file via a new `MediaStorage.deleteAll()`. Verified live against a real orphan left
    over from earlier manual testing: listed, hard-deleted, confirmed gone from the active
    backend (MinIO) and from the orphan list.
    - **Known gap inherited from B5**: message `attachments` are still `string[]` URLs, not
      `MediaRef[]` (B5 judged that migration too wide a blast radius at the time) — so a
      message's attachments never increment/decrement a `MediaAsset.refCount` the way clips/
      stickers/wallpaper already do. The orphan sweep is accurate for everything that *does*
      track refCount; message-attached media doesn't yet participate at all, in either
      direction — not something B11 could fix without also doing that deferred B5 work.
  - **Perf budgets**: extended the existing B0 `QueryCounter` test harness (which patches
    `Query.prototype.exec` to count Mongoose round trips) with two new budget tests — `GET
    /v1/channels/mine` stays at exactly 1 query regardless of channel count, and
    `MessageService.create` stays at exactly 3 (B5's documented, deliberately-not-lower number).
    **Found and fixed while adding the first one**: `QueryCounter` only ever patched
    `Query.prototype.exec` — `.aggregate()` (which `channels/mine` uses, and the whole reason B2
    called it "one aggregation instead of N+1") goes through the separate
    `Aggregate.prototype.exec`, so the counter had silently read 0 for every aggregation call
    since it was written. Fixed by patching both. Index `explain()`/`IXSCAN` assertions already
    existed from B0 (`chatmembers`/`messages`) — not duplicated here. **Not done**: no payload-
    size budget assertions; the query-count budget only covers these two hot paths, not an
    audit of every endpoint.
  - **k6 load test** (`k6/load-test.js`, wired into CI as a new `k6-smoke` job): registers one
    account and one chat once in `setup()`, then every VU repeatedly sends a message and lists
    channels — deliberately *not* one registration per VU/iteration. **Found running this
    locally**: past roughly 20 concurrent VUs on one machine, almost every request starts
    failing — not a capacity problem. Every k6 VU here shares this machine's one source IP, and
    B0's global throttler (100 req/60s/IP) correctly rate-limits what looks like one very
    aggressive client; confirmed directly by sending 105 rapid requests from one IP against the
    running app and getting a 429 on the 105th, exactly at the configured limit. The plan's
    literal "1000 concurrent" acceptance bar needs either the throttle raised/the runner's IP
    allowlisted for that window (an ops decision for the target environment) or a load generator
    that actually originates from many distinct IPs — neither of which this session could safely
    fabricate. The script and CI job are real and pass (20 VUs/15s, 0% failure, p95 ≈ 80ms
    verified live) — this is a genuine smoke test, not the full 1000-VU validation. No
    Socket.IO load scenario either — k6 has no built-in Socket.IO client (its experimental
    websockets module speaks raw WebSocket framing, not Engine.IO/Socket.IO's own protocol on
    top of it), so only the REST half of the plan's "REST + socket.io" criterion is covered.
  - **Structured logging (pino)**: `nestjs-pino` replaces Nest's default logger app-wide
    (`app.useLogger`, with `bufferLogs: true` so nothing logged during bootstrap is lost). Every
    HTTP request/response is logged as JSON with a correlation id (`x-request-id`, generated if
    the client didn't send one) — `Authorization`/`Cookie` headers and password fields are
    `redact`-ed so they never appear in logs even though pino-http would otherwise capture
    request headers/bodies. Verified live: a real request's log line showed
    `"authorization":"[Redacted]"`, not the actual bearer token. **Correlation ids threaded to
    WS**: `ChatGateway` gets its own per-connection correlation id (generated at connect, since a
    socket isn't tied to any one HTTP request) and an injected pino `Logger`; connect/disconnect
    are now structured log lines tagged with it, replacing the two `console.error` calls that
    existed before. **Not done**: only connect/disconnect/error paths were converted to
    structured pino logging — the rest of `ChatGateway`'s existing behavior (dozens of handlers)
    wasn't individually retrofitted with its own correlation-id-tagged log lines; a full audit
    of every gateway code path was out of scope for this pass.
  - **Consistent error codes**: `AllExceptionsFilter` (the `{error:{code,message}}` envelope,
    already used by 6 `/v1` controllers since B2) is now applied to every remaining `/v1`
    controller that was missing it — account deletion, admin auth, admin moderation, admin
    media, clips, reports, sticker packs/use. Legacy (unversioned) routes are deliberately left
    with Nest's original error shape, same established rule as every prior phase — changing
    that would be a real behavioral change for whatever already depends on it. Verified live
    against two of the newly-covered routes.
- **B12**: cleanup — the plan's last phase, and the one where its literal instructions turned out
  not to match this codebase's actual current state. Read as "clean up what's genuinely safe to
  clean up, and audit the rest against `../docs/ARCHITECTURE_RULES.md`," not "execute every
  sentence literally regardless of what's actually there" — same kind of scoping call as B0's own
  "clean schema" ambition.
  - **Deviation from the plan, documented rather than silently skipped**: the plan says "delete
    legacy `/chats*` routes... the OpenAPI + `REALTIME.md` are the living contract." That premise
    doesn't hold here. `ChatController` (unversioned, `@Controller("chats")`) has 24 routes
    covering essentially all chat/channel CRUD — create, update, membership, ban/mute, pin, tags,
    search, delete, etc. The v1 `ChannelsController` has exactly 2 routes
    (`GET /v1/channels/mine`, `GET /v1/channels/:channelId/messages/search`). No v1 replacement
    was ever built across B0-B11 for the other 22+ routes. Deleting `ChatController` would delete
    the app's core chat functionality, not dead weight — so **nothing was deleted here**. Checked
    two specific candidates that looked plausibly redundant on their own and confirmed neither
    actually is: `GET /chats/:channelId/display` (no v1 route returns just a display name) and
    `GET /chats/search` (the v1 `GET /v1/search?scope=channels` requires a >=2-char query and
    only text-indexes `name`/`description` — narrower than the legacy endpoint's keyword-optional
    "browse all public channels" mode and link-substring match, so it's not a superset). Full
    reasoning in `../docs/THINGS_TO_REMOVE.md`'s new "Backend refactor status" section.
  - **Architecture Rule #16, fixed**: "one write path per resource... today only the WS path
    broadcasts; REST `POST /messages` is silent." True and reproduced: the WS `send_message`
    handler manually re-broadcasts to the channel room after calling `MessageService.create`, but
    `MessageController.create` (the plain REST path) just returned the created message with no
    socket broadcast at all — a client connected only over Socket.IO (not the one that sent the
    message) never saw a REST-created message until their next fetch. Fixed by having the REST
    controller call the same `ChatGateway.broadcastNewMessage` that `calls`/`wallpaper`/
    `moderation` system messages already use (that helper's own docstring already said "REST-
    created messages" — it just had no caller). **Live-verified**: a script registered two users,
    added both to a group, connected the second user's socket only (it never calls
    `send_message`), had the first user POST a message via plain REST, and confirmed the second
    user's socket received the `new_message` event with the matching content within the same
    request. Covered by a new `message.controller.spec.ts` unit test too. **Not attempted**: the
    fully "correct" shape per Rules #13/#14 (no controller ever calls the gateway directly; only
    an event-listener in a `realtime` module does) would mean moving *every* existing
    controller->gateway call (message update/reaction/read/delete notifications, wallpaper,
    calls, moderation, account, sticker — a dozen-plus call sites across many modules already
    built this way since B2-B11) onto an event-emitter pattern. That's a real architectural
    rewrite, not a cleanup-phase fix, and out of scope here; this fix intentionally matches the
    codebase's existing convention rather than introducing a second one.
  - **Architecture Rule #12, fixed**: "the membership+ban+deleted block appears 5x verbatim in
    `MessageService`." Confirmed still true in exactly 5 read methods (`findAll`,
    `getFirstMessageOfDate`, `getFirstMessageFromDate`, `getOldestMessageInChannel`,
    `searchInChannel`) — extracted into one `assertChannelReadAccess()` private helper. Pure
    behavior-preserving refactor (same checks, same exceptions, same order); the other,
    differently-shaped membership checks elsewhere in the file (`toggleReaction`, `pinMessage`,
    `findOne`, etc.) were left alone since they're not the same duplicated block. All existing
    tests pass unchanged.
  - **"Drop legacy columns/collections after soak"**: `chat.banned[]`, `message.readBy`,
    `user.isOnline`, `emoji_usage`, `app_settings` are already gone — resolved in B0/B2/B3/B5/B9,
    confirmed by grep (zero references, or only a historical doc-comment). `chat.admins[]` is
    **deliberately kept**: `chatmembers.role` is already the only server-side source of truth
    (`admins[]` is a derived, read-only mirror recomputed on every role change — see B2's
    write-up above), but the frontend still reads `chat.admins[]` directly, so dropping the field
    needs a frontend migration + soak period this backend-only phase can't do alone. This was
    already the documented decision from B2, not a new B12 call — restated here since B12's own
    plan text asks for exactly this confirmation.
  - **Consistency audit against `../docs/ARCHITECTURE_RULES.md`'s 36 rules**: beyond #12/#16
    above, checked and found already-satisfied: #20 (global `JwtAuthGuard` + `@Public()`, since
    B0), #21 (every route already rate-limited — global default throttler plus per-endpoint
    overrides on the abuse-prone ones), #11 (roles/bans/presence already single-sourced, since
    B0/B2/B3). Found real but explicitly **not** fixed this phase, each for the reason given:
    Rule #3 (keyset pagination) — 7 services still use `.skip(offset)`
    (`clips`/`chat`/`message`/`user`/`sticker` x2/`report`); converting all of them changes every
    affected response shape and needs client coordination, not a mechanical cleanup. Rule #18
    (side-effect-free reads) — `GET /chats/direct/:userId` creates a private chat and calls the
    gateway directly from the controller on first access; this is `legacy-chat`'s original,
    intentional "get-or-create" contract, not a new regression, and turning it into a `POST` is
    an API-shape change needing frontend coordination. Both are recorded in
    `../docs/THINGS_TO_REMOVE.md`'s new status section rather than silently dropped.

## Packs & bots (B13 — a post-plan feature, not part of the original `BACKEND_PLAN.md`)

Two additions, requested together: Telegram-style sticker/animated-emoji packs with real
ownership (create your own, add other people's to your own collection, remove them again), and a
generic bot framework — GUI menu screens, not `/command` text — with the first bot built on it.

- **Unified `Pack`/`PackItem`/`PackSubscription` model** (`src/packs/`), replacing B9's
  `sticker_packs`/`Sticker` collections outright (deleted, not kept alongside — nothing external
  depended on their shape yet; `frontend/`'s own status doc confirms stickers were never wired
  up). A `Pack` is either `type: "sticker"` or `type: "emoji"` — identical ownership, item-CRUD,
  subscription, and keyword-search machinery either way; only a client's rendering (sticker tray
  vs. an animated-emoji tab in the regular emoji picker) differs. "Animated" needed **no new media
  pipeline** — `MediaService.ingestImage` already sniffs and stores animated GIF unre-encoded
  (its own size cap, since B9); a video/WEBM pipeline (closer to Telegram's actual sticker format)
  is explicitly out of scope for this pass, noted below.
  - **The concept that was completely missing before**: "this pack is in my own collection,"
    distinct from ownership. The old sticker system only had owner-or-public access — there was no
    per-user save list at all. `PackSubscription` fixes that; a pack's owner is auto-subscribed on
    creation, so "my packs" is always exactly "my subscriptions," never a union of two queries.
  - **`isPublic` now means discoverable via search, not accessible at all** — a deliberate
    behavior change from the old sticker packs (which 403'd a non-owner on a private pack). A
    private pack is still fully viewable and addable by anyone holding its `slug` (an
    auto-generated, deduped, immutable invite-link segment — `GET /v1/packs/by-slug/:slug`) — this
    is what makes "add a pack via link" possible at all, and matches Telegram's own "private
    sticker set, shareable by link" behavior. Live-verified: a private pack never appears in
    another user's search results but resolves and is fully viewable/subscribable via its slug.
  - **Per-item `keywords: string[]`** (distinct from a pack's own `tags`) — the Telegram-style
    "tag a sticker/emoji with a few emoji or words so typing one finds it" search unit.
    `GET /v1/packs/search-items?q=` searches only the *caller's own* subscribed packs' items
    (same as Telegram: typing an emoji only searches packs you've actually added, not the whole
    public catalog) — live-verified with a real keyword match after subscribing.
  - **Owner-only item/pack CRUD**, enforced service-side (`requireOwnedPack`) exactly like B9's
    sticker packs were, extended to cover the new edit-pack/delete-pack/edit-item-keywords/
    remove-item operations B9 never had at all (there was no delete or edit for sticker packs
    before this). Deleting a pack releases every item's `MediaAsset` ref and removes every
    subscriber's copy (archive-not-delete for the media itself, same B11 orphan-sweep philosophy).
  - **`AccountDeletionService`** (B4) updated to release/delete owned `Pack`/`PackItem` rows and
    the deleted user's own `PackSubscription` rows instead of the old sticker schemas — same
    cleanup guarantee, new model.
- **A generic bot framework** (`src/bots/`) — explicitly **not** Telegram's `/command` text UX
  (asked for by name to avoid): a bot is a server-driven **menu tree**. `GET /v1/bots/:key/menu`
  returns a `BotMenuScreen` (title, rows, buttons) as data; `POST /v1/bots/:key/action[/upload]`
  invokes whichever button/row was tapped and returns the next screen. The client renders any bot
  generically from that shape — no bot-specific frontend code needed beyond a generic
  screen-renderer. Adding bot #2 means implementing `BotHandler` (`bot.interface.ts`) and adding
  one line to `BotsModule`'s factory array; the controller and registry never change.
  - **`PackManagerBot`** (`src/bots/handlers/pack-manager.bot.ts`) — the first bot, built entirely
    on `PacksService`: browse "My Sticker Packs"/"My Animated Emoji Packs," create a pack (a form
    screen), open a pack (owner sees add-items/edit/copy-link/delete; a non-owner sees
    add-to-mine/remove-from-mine), add items with keywords (a multipart form action), remove an
    item, add a pack by pasting a link or bare slug. Every one of those is a GUI action through
    the generic framework — confirmed live end-to-end via `POST /v1/bots/pack-manager/action` and
    `.../action/upload`, not by reading the code.
  - **Deliberately thin**: this file contains no business logic of its own — every screen is just
    `PacksService` calls reshaped into `BotMenuScreen`/`BotAction` data. That's intentional: a bot
    is a *view* over an existing service, never a parallel API with its own rules.
- **Verified**: `src/packs/packs.service.spec.ts` (ownership/subscription/visibility/keyword-
  search/deletion-cascade), `src/bots/handlers/pack-manager.bot.spec.ts` (the full create → add
  items → edit → delete flow, and the owner-vs-non-owner action-set difference, entirely through
  `getScreen`/`invokeAction` — the same contract the controller uses), plus a full live run against
  a running instance covering both the plain Packs API and the bot GUI actions (multipart upload
  included) end to end.
- **Not done / honestly out of scope for this pass**: no video/WEBM item format (GIF-only, see
  above) — Lottie/TGS (Telegram's actual animated-sticker format) was never attempted. No
  reordering endpoint for `PackSubscription.order` yet (the field exists and is sorted on, but
  nothing writes a custom order beyond creation order). No admin-side pack moderation (a
  public pack full of abusive content today only reaches the existing generic `POST /v1/reports`
  flow with `targetType: "channel"`-shaped semantics not really fitting a pack — a dedicated
  report target type is future work, not attempted here). The bot framework's `GET .../menu`
  accepts arbitrary query params as context but does no schema validation on them beyond what each
  handler does itself — a malformed `packId` surfaces as that handler's own `NotFoundException`,
  not a framework-level 400. Only one bot exists; the framework is proven by that one real,
  working vertical slice, not by a second bot (deliberately — the ask was "implement the structure
  clean," not "build every future bot now").

## Setup

```bash
cp .env.example .env   # fill in JWT_SECRET, CORS_ORIGIN, etc.
cp livekit.yaml.example livekit.yaml   # fill in a locally-generated LiveKit key/secret pair,
                                        # matching LIVEKIT_API_KEY/LIVEKIT_API_SECRET in .env
npm install
docker compose up -d   # mongo (replica set) + redis + livekit + coturn + minio
npm run start:dev
```

MinIO/S3 storage is opt-in — `MEDIA_STORAGE_DRIVER` defaults to `disk`; set it to `s3` (with the
`S3_*` vars) once `docker compose up` has brought MinIO up and its bucket-creation step
(`minio-init`) has run.

## Migrating data from the old `legacy-chat` backend

`scripts/migrate-legacy-data.ts` copies every collection from the old backend's database into this
one, preserving `_id`s. It de-dupes `chatmembers` rows (required by the new unique index) and drops
the removed `config-bot` user + its `configs` channel. Read-only against the source DB; safe to
re-run (upserts by `_id`).

```bash
# 1. Point DATABASE_URL_LEGACY at the OLD backend's DB and DATABASE_URL at this one (see .env.example)
# 2. Dry run first — prints a summary, writes nothing:
npm run migrate:legacy -- --dry-run
# 3. Then for real:
npm run migrate:legacy
```

## Creating an admin identity

There is no public "register admin" endpoint by design (B4) — `scripts/seed-admin.ts` is the
only way to create one, meant to be run once by an operator with direct database access.

```bash
npm run seed:admin -- --email=admin@example.com --password=... [--role=superadmin|support|moderator]
```

Prints an `otpauth://` URI (and the raw secret as a fallback) to add to an authenticator app —
MFA is required on every admin login, so there's no way to sign in without doing this first.
Re-running with the same `--email` rotates the password/MFA secret rather than erroring.

## Tests

- `npm test` — unit tests (`src/**/*.spec.ts`) against an in-memory MongoDB
  (`mongodb-memory-server`): B0 index/query-count tests, B2 role/ban-migration and add-members
  tests (`src/chat/chat.service.b2.spec.ts`), the DTO leak test
  (`src/common/dto/user-view.dto.spec.ts`), `MediaService`'s ingest/dedupe/EXIF-strip/quota tests
  (`src/media/media.service.spec.ts`, `src/media/file-sniff.util.spec.ts`), the `chat_state`
  event-listener tests (`src/chat/chat-state.listener.spec.ts`), the channels aggregation
  tests (`src/channels/channels.service.spec.ts`), B4's rotating-refresh-token/reuse-detection/
  session-management tests (`src/auth/auth.service.spec.ts`), B5's reaction-toggle/cap,
  author-only "seen by", `hiddenAt` filtering, and content-sanitization tests
  (`src/message/message.service.b5.spec.ts`, `src/message/message-sanitize.util.spec.ts`), and
  B6's contact-resolution/listing (`src/contacts/contacts.service.spec.ts`), folder CRUD +
  ownership (`src/folders/folders.service.spec.ts`), folder-filtered channel listing
  (`src/channels/channels.service.spec.ts`), tags-role-restriction/private-chat-search-exclusion
  (`src/chat/chat.service.b6.spec.ts`), unified-search-never-leaks-phone/email/private-chats
  tests (`src/search/search.service.spec.ts`), mutual-contact profile-reveal tests
  (`src/user/user.service.spec.ts`), and B9's Giphy cache-on-first-use tests
  (`src/giphy/giphy.service.spec.ts` — mocks the Giphy client; the "no `/v1/stickers/{id}`"
  bug was only caught by live testing against the real API, not these), video magic-byte
  sniffing (`src/media/video-sniff.util.spec.ts`), and video ingest — real ffmpeg compression,
  poster extraction, duration parsing, dedupe, and the 200MB cap, using a synthetic clip
  generated by ffmpeg's own `testsrc`/`sine` filters rather than a checked-in fixture file
  (`src/media/media.service.video.spec.ts`), and B7's notification recipient-resolution tests —
  sender exclusion, mute/level/presence-room filtering, private-vs-group title/body shaping, and
  invalid-token cleanup, all against a mocked `ChatGateway`/`FcmService`
  (`src/notifications/notification.service.spec.ts`). B9's remaining pieces: personal clips —
  real ffmpeg video→GIF conversion, dedupe, ownership checks, refCount release on delete
  (`src/clips/clips.service.spec.ts`); sticker packs — real image upload via `MediaService`,
  per-sticker + pack-total usage counts, public/private access control
  (`src/sticker/sticker.service.spec.ts`); wallpaper upsert-not-create, `MediaAsset`
  reference release on replace, and the membership guard on reads
  (`src/wallpaper/wallpaper.service.spec.ts`); and the nightly GC job, exercised by calling its
  `@Cron` handler directly rather than waiting for midnight
  (`src/wallpaper/wallpaper-gc.service.spec.ts`). B4's remaining pieces: per-account login
  lockout and the full password-recovery flow — request/approve/deny/validate/reset,
  single-use enforcement, session revocation on reset
  (`src/auth/auth.service.spec.ts`); admin login requiring both password and a valid TOTP code,
  rejecting a wrong/missing code, a disabled admin, and an unknown email
  (`src/admin/admin-auth.service.spec.ts`); and account deletion's re-auth gate plus its
  cleanup — memberships, blocks, owned clips/sticker-packs/wallpaper with their `MediaAsset`
  reference counts released, and profile anonymisation
  (`src/account/account-deletion.service.spec.ts`). B10: report creation, dedupe, filtered
  listing, and resolve (`src/moderation/report.service.spec.ts`); every moderation action —
  suspend (dated and indefinite)/unsuspend, warn (including the lazy Moderation-account/DM
  reuse), hard-hide, lock/unlock, and channel-member removal, each asserting its
  `moderation_log` entry (`src/moderation/moderation.service.spec.ts`); and locked-channel
  message rejection (`src/message/message.service.b10.spec.ts`). B11: lifecycle tiering
  (age-based cold-tagging, already-cold no-op) and the orphan report (refCount-0 detection,
  never deletes) (`src/media/media-maintenance.service.spec.ts`); byte-range parsing edge cases
  and content-type inference for the new media-serve route
  (`src/media/media-serve.controller.spec.ts`); and the two new query-count perf budgets —
  `channels/mine` stays at 1 query regardless of channel count, message send stays at 3
  (`src/channels/channels.service.perf.spec.ts`, `src/message/message.service.b11.spec.ts`). B12:
  `POST /messages` broadcasting the created message over the gateway
  (`src/message/message.controller.spec.ts` — the regression test for Architecture Rule #16). B13:
  pack ownership/subscription/visibility/keyword-search/deletion-cascade
  (`src/packs/packs.service.spec.ts`), and the pack-manager bot's full create → add-items → edit →
  delete flow plus the owner-vs-non-owner action set, driven entirely through the bot framework's
  own `getScreen`/`invokeAction` contract (`src/bots/handlers/pack-manager.bot.spec.ts`).
- `npm run test:e2e` — boots the full app against an in-memory MongoDB.
- `BASE_URL=http://127.0.0.1:3001 k6 run k6/load-test.js` — a real, runnable load test (see B11
  above for what it does and doesn't validate); also runs in CI as `k6-smoke`.
- CI (`.github/workflows/ci.yml`) also runs `npm run typecheck`, `npm run lint`, a `gitleaks`
  secret scan, and (B11) the k6 smoke job — written and validated against the same shape locally
  (build → boot → curl-wait → k6 run), not yet executed against real GitHub Actions
  infrastructure this session.
