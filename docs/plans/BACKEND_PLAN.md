# Backend Plan — `legacy-chat` (NestJS API + Realtime + Workers)

Target: modular monolith, 100–1000 users, single region, structured to scale later.
Stack additions: **Redis** (adapter + presence + call state + queues), **BullMQ** (jobs),
**object storage** (S3-compatible: MinIO self-host or Cloudflare R2 / Backblaze B2) + **CDN**,
**LiveKit** (SFU) + **coturn** (TURN), **sharp** (images), **web-push not needed** (Flutter push
only). Keep Mongo (add a replica set).

Legend: **Size** S (≤1wk) / M (1–2wk) / L (3–4wk). **Blocks** = downstream plan phases.

---

## B0 — Safety & foundations · Size M · blocks everything

**Goal:** secure, index the hot path, delete the landmines, set up CI. No feature work.

**Work**
- Rotate `JWT_SECRET`; **purge `.env` + any secret from git history** (BFG / filter-repo); move to
  a secrets manager / env-only; add `gitleaks` to CI. Delete committed `dist/`.
- **Remove `POST /config-logs`** and the `config-bot` auto-create (replaced later by the Config
  Bot plan). Identify + notify whatever calls it.
- Global `JwtAuthGuard` + `@Public()`; audit every route.
- `@nestjs/throttler` (Redis store): login 5/min/IP + lockout, register 3/hr/IP, search 30/min,
  upload 20/10min, message-send 20/10s/socket.
- `helmet`; explicit CORS allowlist (HTTP **and** gateway); stop `ACAO:*` on `/uploads`.
- **`chatmembers` migration:** de-dupe `(channelId,userId)` rows → add
  `unique {channelId,userId}`, `{userId,isJoined}`, `{channelId,role}`, `{channelId,isBanned}`.
- `messages` indexes: `{channelId,isDeleted,createdAt:-1}`, `{channelId,type,createdAt:-1}`.
- CI: lint + typecheck + Jest + `mongodb-memory-server` + gitleaks + a **query-count test harness**
  (mongoose hook asserting queries/endpoint) + an `explain()` index test.
- Docker Compose: add `redis`, `mongo` as a 1-node replica set; healthchecks.

**Risks:** unique index fails on existing dupes → the de-dupe step runs first with a count gate;
removing `/config-logs` breaks a deploy script → grep infra first.
**Acceptance:** no secret in repo/history; every write route guarded + throttled; membership
lookup uses an index (`explain`); CI green; `redis` up.

---

## B1 — API & realtime contract · Size M · blocks F1, A1, D1

**Goal:** one machine-readable contract; kill cross-repo type drift.

**Work**
- Finish Nest Swagger coverage → export **OpenAPI 3.1** at build; publish as an artifact + a
  `@legacy-chat/api-types` package (or a spec file the clients codegen from).
- **AsyncAPI-style `REALTIME.md`** generated/maintained for every WS event (name, direction,
  payload schema, consumer).
- Global **response envelope** (`{ data }` / `{ items, nextCursor }` / `{ error: {code,message} }`)
  + `AllExceptionsFilter`.
- DTO mappers: `PublicUserDto`, `MessageDto`, `ChannelSummaryDto`, `ChannelDto`,
  `SessionDto` — **never** leak `password`, `email`, `phone`, `isDeleted`, `tokenVersion`, `readBy`.
- `ParseObjectIdPipe`; `forbidNonWhitelisted: true`; `@MaxLength` on `content`(4000), `bio`,
  `name`, `description`.
- Introduce `/v1` prefix; keep legacy routes alive in parallel during migration.
  - **Update (2026-09-18):** `MeDto`/`toMeDto` didn't expose `notificationLevel` at all, even
    though `PATCH /users/notifications` (setting it) was fully live and actually enforced
    downstream (`notifications/notification.service.ts` reads it per-recipient before deciding
    whether to push) — found while wiring a frontend Settings UI for it, which needed to read the
    current value to pre-select it. Added `notificationLevel: "all"|"mentions"|"none"` to `MeDto`
    and `toMeDto()` (defaulting to `"all"`, matching the schema default). Confirmed safe before
    adding: every `toMeDto` call site's Mongoose query (`auth.service.ts` login/register/refresh,
    `user.service.ts`'s own profile paths) already returns the field, since all of them use
    exclusion-style `.select()` projections (e.g. `-password -__v -isDeleted -tokenVersion`), not
    a whitelist — so no query needed changing, only the DTO shape.

**Acceptance:** `openapi.json` in CI artifacts; contract test (spec ↔ runtime) passes; every
user-returning endpoint emits `PublicUserDto` (leak test).

---

## B2 — Data layer, channels, media core · Size L · blocks F2, A2

**Goal:** repositories, thin controllers, no gateway cycles, one media service, denormalised list.

**Work**
- **Repository layer** per aggregate (`user`, `channel`, `membership`, `message`, `media`).
  Services stop injecting Mongoose models.
- **`MediaService`** (delete the 3 dedupe/`buildUrl` copies, unify the 2 ffmpeg helpers):
  SHA-256 dedupe → `media_assets {hash, kind, variants, w, h, blurhash, durationSec?, refCount}`;
  images via `sharp` → `{original, web≤1600, thumb≤320}` + blurhash; video → poster + probe;
  **relative URLs**; strip EXIF; magic-byte sniffing + type allowlist; per-user quota.
  **Storage backend behind an interface** — start on disk, switch to S3 in B11 with no call-site change.
  - **Update (2026-09-29):** `width`/`height`/`blurhash` were already computed by `ingestImage` on
    every upload and stored on the `MediaAsset` row — `POST /upload/image` just discarded all
    three, returning only `{url}`. Now returns `{url, mediaId, width, height, blurhash}` (found
    while building the frontend's F11 `<Media>` component, which needed real data to blur-up/size
    against, not guesses). `Message.attachmentMeta` (new, optional field on the `Message` schema,
    additive — no migration of existing documents) is built server-side in
    `MessageService.create` from the real `MediaAsset` row the client's new
    `CreateMessageDto.attachmentMediaIds` points at, keyed by attachment URL — width/height/blurhash
    always come from that row, never trusted from whatever the client claims. 5 new tests
    (`message.service.attachments.spec.ts`).
  - **Update (2026-09-29): per-quality media, for the frontend's HD/Compressed image toggle and
    480/720/1080 video picker.** `POST /upload/image`'s response now also carries a
    `variants: {original: {url, sizeBytes}, web: {url, sizeBytes}}` object — both variants were
    already produced and stored for every upload, just never exposed with a real size; captured
    from the actual encoded buffer at ingest time into a new, additive `MediaAsset.variantSizes`
    field (null on pre-existing rows). Video was a real gap, not just an unexposed field:
    `compressVideo`/`ingestVideo` had one hardcoded 1280px/CRF26 target with no caller-facing
    parameter at all. Added an optional `targetMaxDimension`, threaded through both, and
    `POST /upload/video` now accepts `targetResolution` (`"480"|"720"|"1080"`, validated,
    mapped to a long-edge pixel cap — 480→854, 720→1280, 1080→1920, matching the pipeline's own
    "cap the longer side" convention rather than the height a resolution label usually names).
    **Found and fixed a real bug while building this**: dedupe was keyed on the source file's
    content hash alone, so re-uploading the identical video at a different resolution would have
    silently returned the *first* upload's already-compressed file regardless of the new request
    — fixed by folding the target resolution into the dedupe/storage key for video specifically
    (`${hash}:r${dim}`), verified live (the same real synthetic clip uploaded at 480 then 1080
    produced two distinct `MediaAsset` rows). Video's `width`/`height` are now also populated
    (previously always null) — read from the source via a new `probeVideoResolution` (a second,
    additive ffmpeg `-i` probe, kept separate from the existing `probeVideoDurationSec` so that
    function's other caller, the wallpaper pipeline, is untouched) and the output size computed
    deterministically via the same aspect-preserving math the scale filter itself uses, rather
    than a second probe of the compressed file. All verified with real `fetch` calls against the
    running dev backend: a real synthetic image upload returned real, distinct
    `variants.original.sizeBytes`/`variants.web.sizeBytes`; a real synthetic video uploaded at
    480 vs. 1080 produced different `mediaId`s and correct `:r854`/`:r1920` storage keys; an
    invalid `targetResolution` correctly 400s.
  - **Update (2026-09-29): `GET /upload/usage`, for the frontend's "Storage & data" screen.**
    A user asked "why is Storage & data a dead click" — nothing existed to show real usage at
    all. Added a public `MediaService.getUsage(ownerId)` returning `{usedBytes, quotaBytes}`,
    refactored out of the same aggregation `assertQuota` already runs on every upload (via a new
    shared `sumOwnedBytes()`) so the two can never silently disagree with each other. **Live-verified**:
    a fresh account showed `usedBytes: 0`; uploading one real test image immediately moved it to
    the image's real encoded byte count, confirmed via a direct `fetch` and again through the
    frontend's own Storage page after a rebuild.
  - **Reversed later the same day: "users have infinite storage to upload."** Removed
    `GET /upload/usage`, `MediaService.getUsage`/`sumOwnedBytes`, and — since a screen showing
    unlimited usage would be pointless — the 2 GiB-per-user quota enforcement itself
    (`assertQuota`, the `MEDIA_QUOTA_BYTES_PER_USER` env var, its `.env.example` entry). Uploads
    are no longer capped by total account storage at all. The per-file size ceilings
    (`IMAGE_MAX_BYTES`/`VIDEO_MAX_BYTES`/`GIF_MAX_BYTES`, 20/200/8 MB) are a separate concern —
    still enforced, untouched. `MediaAsset.ownerId` stays (attribution/audit metadata, has its
    own DB index used elsewhere) — its doc comment updated to stop describing a quota check that
    no longer exists. Re-verified: `GET /upload/usage` now 404s; a real image upload still
    succeeds normally with no quota check in the path.
- **Channels module** (rename "chats"): `ChannelService` + repos.
  - `chat_state {channelId, lastMessageAt, lastMessagePreview, memberCount}` maintained by an
    event subscriber (`message.created|deleted`, `membership.changed`).
  - `GET /v1/channels/mine` = **one aggregation** (`$lookup` DM peer, `$facet` counts),
    cursor-paginated, `ChannelSummaryDto`, `unreadCount` from `lastReadMessageId`.
  - `GET /v1/channels/:id` → `ChannelDto` (replaces `/display` + `/preview` + membership flags +
    wallpaper `effective` + `permissions`).
  - `POST /v1/channels` explicit; `POST /v1/channels/:id/members` (admin add) **[NEW — fixes the
    broken flow]**; `POST /v1/channels/:id/invites` (link/code); `POST /v1/channels/:id/join`.
  - `POST /v1/channels/direct {userId}` (explicit, block-aware, opaque link); `POST /v1/channels/saved`.
  - Roles: **`chatmembers.role` only** — migrate + drop `chat.admins[]` + the sync loop.
    - **Update (2026-09-09):** `ChatService.unsubscribe` (leave chat) let the owner leave a
      group/channel like any other member — a bare `deleteOne({channelId,userId})` with no
      role check — orphaning the channel with no owner (found while wiring the frontend "Leave"
      action in `ChatInfoPanel.tsx`, which now warns the owner about it). Fixed by promoting a
      successor before removing the owner's membership: longest-tenured (`createdAt` ascending)
      non-banned admin, falling back to longest-tenured non-banned member if there's no admin,
      then `recomputeChatAdmins` + `notifyChannelRolesUpdated` same as `update()`'s role-change
      path. If no other members remain, the leave proceeds and the channel is simply left without
      an owner (same as any chat emptying out) — an explicit "transfer ownership first" block was
      considered but rejected as unnecessary friction for the common empty-channel case. Also
      removed the bare `try { ... } catch { return false }` wrapping the whole method — it
      swallowed `unsubscribe`'s own `BadRequestException("User not joined")` into a 2xx `{false}`
      response, inconsistent with error handling everywhere else in this codebase; it now
      propagates as a real 4xx like `subscribe`/`update`/`delete` do. See
      `chat.service.ts`'s `unsubscribe`.
    - **Update (2026-09-09):** investigated a report that `GET /v1/channels/mine` returned the
      *caller's own* account as `otherUser` for a specific DM (channel
      `6a9ebe42e5ec0bd22a95d5df`, participants `b5tester`/`contact1`). Reproduced directly:
      inspected the real `chatmembers` rows for that channel in the dev Mongo (exactly one clean
      row per participant, no duplicates/stale rows), replayed `listMine`'s exact aggregation
      pipeline against them, and called the live `GET /v1/channels/mine` endpoint as both
      participants. All three returned the correct `otherUser` in both directions — could not
      reproduce the bug against current code + current data. `channels.service.ts`'s
      `otherMembership` `$lookup` (`$expr: { $eq: [channelId,...], $ne: [userId,...] }`) is
      logically correct and both `channelId`/`userId` are plain `String` fields end-to-end, so no
      type-mismatch footgun either. Left as unresolved/unreproduced rather than papering over it
      with an unmotivated guard; added a regression test (`channels.service.spec.ts`: "resolves
      the other DM member correctly for both participants, never the caller's own account") that
      locks in the correct symmetric behavior so a real regression here would be caught. If this
      resurfaces, capture the exact request/response pair (and check for duplicate/stale
      `chatmembers` rows for that channel at that moment) rather than assuming the query logic.
    - **Update (2026-09-09):** `ChannelSummaryDto`/`GET /v1/channels/mine` didn't expose a chat's
      `tags` at all — found while wiring a frontend chat-tag editor (`ChatInfoPanel.tsx`) to feed
      folder `includeTags` filters (see B6). The `listMine` aggregation already `$lookup`s the
      full `chats` document (needed to `$match` on `chat.tags` for folder filtering), so `tags`
      was sitting right there in the pipeline result and just never got read out — added
      `tags: string[]` to `ChannelSummaryDto` and `RawChannelRow.chat`, and `tags: row.chat.tags ??
      []` to `toChannelSummaryDto`. No new query, no schema change — `Chat.tags` already existed
      (`chat.schema.ts`, indexed, default `[]`). `POST /chats/:channelId/tags` (legacy, admin/owner
      only, full-replace semantics) was already live and unchanged.
    - **Update (2026-09-10):** same story again, for `unread`. F2's plan assumed a per-row unread
      indicator would need `GET /messages/channel/:id/unread` called once per row (real N+1) —
      but `listMine`'s own `onlyUnread` folder filter (just above in this same file) already
      computes exactly that boolean per row, from data already on it (`row.lastReadAt` vs.
      `chat_state.lastMessageAt`, both already present on the aggregation row for that filter to
      work at all) — it just filtered on the boolean instead of returning it. Added
      `unread: boolean` to `ChannelSummaryDto`, computed with the identical comparison in
      `toChannelSummaryDto` (`!lastReadAt || lastReadAt < state.lastMessageAt`, guarded on
      `state.lastMessageAt` existing) so the two can never quietly diverge. No new query, no N+1 —
      the exact same aggregation row this endpoint was already producing.
  - Bans: **`chatmembers.isBanned`** (indexed) + `channel_bans {channelId,userId,reason?,until?,by}` —
    migrate + drop `chat.banned[]` scans.
- **Gateway → transport-only:** domain services emit `EventEmitter2` events; a `realtime` module
  subscribes. Remove `ChatGateway` from `ChatService`/`MessageController`/`WallpaperService`.
  (Full realtime work in B3; this phase just breaks the cycles.)
- **Keyset pagination** for messages + search; `$text` search for channels/users (indexes exist).
- Merge the 3 date-nav endpoints → `GET /v1/channels/:id/messages/locate?anchor=`.
- Migrations (idempotent, dry-run first, snapshot collections): membership de-dup already in B0;
  `admins→role`; `banned→isBanned`; backfill `chat_state`; opaque DM links (keep id-resolver fallback).
- **Consistency cron** comparing `chat_state` vs computed for 2 weeks + self-heal.

**Risks:** biggest phase — do it channel-slice by slice behind `/v1` with legacy live;
denormalisation drift → cron; role/ban migration one-way → snapshots + reconciliation tests.
**Acceptance:** no service injects a model; gateway imports no domain module; `/v1/channels/mine`
≤ 3 queries for any N, < 40 KB / 50 chats, cursor-based; group member-add works; one role store,
one ban model; media URLs relative.

---

## B3 — Realtime & presence · Size M · blocks F3, A3

**Goal:** scoped, delta-based, Redis-backed realtime; one message write path.

**Work**
- `@socket.io/redis-adapter`; **`realtime` module** is the only `server.emit` caller.
- **Presence** in Redis (`presence:<uid>` EX 30s + heartbeat); emit `presence:changed` **only into
  shared rooms**; recompute rooms on `membership.changed`; `lastSeen` → Mongo on offline only.
  Drop `user.isOnline`, `update_status`, `UserStatus.AWAY/TYPING`.
- **One message write path:** `POST /v1/channels/:id/messages` persists + emits `message.created`;
  WS `send_message` is a thin wrapper over the same service → exactly one `message:new` fan-out
  (fixes silent REST create).
- **Delta events:** `reaction:changed {messageId,emoji,delta,byUserId}`, `read:updated
  {channelId,byUserId,lastReadMessageId}`, `message:updated` (edit only), `message:deleted`.
- **Reconnect resync:** client sends `{since:{channelId:lastMessageId}}` → server streams the gap.
- Per-socket rate limits (`send_message`, `typing`, later `call_signal`); runtime schema
  validation on every inbound event; clean typing/uploading maps on disconnect.
- Typing: keep one `typing` event (drop the separate "uploading" — send `typing` with a `kind`).

**Acceptance:** runs on 2 API nodes (cross-node delivery works); presence only in shared rooms;
reaction event < 300 B; killing a node loses no messages; one `message:new` per persisted message.

---

## B4 — Auth, sessions, admin auth · Size M · blocks F4, A4, D2

**Goal:** safe sessions + admin identities + the password-recovery link mechanism.

**Work**
- Access token 15 min + **rotating refresh** (`sessions {id,userId,device,ip,createdAt,lastUsedAt,
  revokedAt?}`); reuse detection revokes the family. Web/Admin: httpOnly `Secure` `SameSite=Lax`
  cookie + a CSRF double-submit token for cookie mutations. Flutter: refresh in secure storage.
- Redis-cached `tokenVersion` / revocation set → `JwtStrategy` does **0 Mongo reads** on the hot path.
- Login lockout / progressive backoff (B0 has the throttler; add per-account lockout).
- `GET /v1/auth/me` (replaces `POST /auth/profile`); `GET /v1/auth/sessions` + `DELETE /:id`.
- **Admin identities:** `admin_users` (or a `role` on `user` — decision: **separate `admin_users`
  collection** with `{email, passwordHash, role: superadmin|support|moderator, mfaSecret}`),
  `POST /v1/admin/auth/login` (+ **TOTP MFA required**), admin JWT audience separate from user JWT.
- **Password-recovery link flow (Q1):**
  - User: `POST /v1/auth/recovery-request {username|email}` → creates a `recovery_requests` row
    (status `pending`) → surfaces in the Admin Panel. (Rate-limited; no user-visible confirmation
    of whether the account exists.)
  - Admin: approves → server generates a **short opaque token** (e.g. 10 chars base32),
    `recovery_tokens {token, userId, expiresAt (e.g. 30–60 min), usedAt?}`; returns the link
    `https://app.../reset#<token>` for the admin to copy and send out of band.
  - User: `GET /v1/auth/recovery/:token` (validate) → `POST /v1/auth/recovery/:token {newPassword}`
    → set password, bump `tokenVersion`, invalidate the token, revoke all sessions.
- Account deletion: re-auth + a cleanup job (memberships, blocks, orphan media refcount, anonymise
  authored messages to "Deleted user").

**Acceptance:** access TTL ≤ 15 min; refresh rotates + reuse-detects; `JwtStrategy` 0 DB reads;
admin login requires MFA; a support admin can approve a recovery request and get a short,
time-boxed link; using it resets the password and logs the user out everywhere.

---

## B5 — Messaging, reactions, read receipts · Size M · blocks F5, A5

**Goal:** minimal message DTO, delta reactions, author-only read receipts, fixed bugs.

**Work**
- `MessageDto` carries only render data (no `readBy`, no full reactions map, no email); `media[]`
  as `MediaRef[]`; `reply` as a **stored snapshot** `{id,senderName,snippet,type}` (no runtime
  `populate`); `forwardFrom {name, avatarUrl}` (**fix the field name**); persist voice `durationSec`
  + waveform; persist file `originalFilename`.
- Parallelise independent reads in `send`; drop the post-create re-`findById().populate()`;
  move emoji enrichment + forward-snapshot to the `message.created` subscriber → **≤ 3 queries/send**.
- Sanitise `content` server-side (strip control chars; define allowed formatting); reject empty edits.
- **Reactions** → `message_reactions {messageId,channelId,emoji,userId}` (indexes
  `{messageId,userId,emoji} unique`, `{messageId}`, `{channelId,createdAt}`); toggle = 1 op + delta
  event; `MessageDto.reactions = [{emoji,count,me}]` (batched `$group` per page); server cap on
  distinct emojis; **drop `message.reactions` Map + `emoji_usage` collection** (recents move client-side).
  - **Update (2026-09-09):** a reaction can now also be a sticker/animated-emoji **pack item**, not
    just a plain unicode emoji. `message_reactions` gained nullable `packItemId`/
    `packItemRelativePath`/`packId` (mutually exclusive with `emoji` — enforced in
    `MessageService.toggleReaction`, not at the schema level); the unique index became
    `{messageId,userId,emoji,packItemId}` (the old 3-field index would've capped a user to one
    sticker reaction per message, since `emoji` is null for all of them). `PacksService
    .resolveItemForUse` enforces the same owner-or-subscriber gate as sending an item (`useItem`)
    and bumps its usage the same way. `packItemRelativePath`/`packId` are denormalized onto the
    reaction row at write time (not `$lookup`ed at read time) for the same reason the batched
    `$group` above exists — a per-row join back to `pack_items`/`media_assets` on every page load
    would defeat it. See `message-reaction.schema.ts` and `packs.service.ts`.
  - **Update (2026-09-09, later the same day):** a sent sticker/animated-emoji **message** can now
    carry a `packId`/`packItemId` too, not just a reaction — `CreateMessageDto.packItemId`
    (optional), resolved + authorized through the same `PacksService.resolveItemForUse` (renamed
    from `resolveItemForReaction` once it had two callers), and persisted onto the new `Message`
    schema fields `packId`/`packItemId` (both nullable, plain strings). This closes the
    long-standing "encountering a pack via a received message" gap noted in
    `../PACKS_AND_BOTS_FRONTEND_BRIEF.md` — a received sticker can now be traced back to its pack
    and tapped to open/add it, which a bare `attachments` URL never could. A forward copies the
    original message's already-resolved `packId`/`packItemId` directly rather than re-authorizing
    the forwarder for it (same as it already does for `content`/`attachments`/etc.) — matches the
    existing forward semantics of copying the original's payload as-is.
- Quick reaction folded into `POST /reactions` (client sends `user.quickReaction`); drop the
  separate endpoint.
- **Read receipts (Q8):**
  - `POST /v1/channels/:id/read {lastReadMessageId}` → **1 write** on `chatmembers` pointer + emit
    `read:updated`. **Drop `message.readBy` map.**
  - "Seen by" is **author-only**: `GET /v1/messages/:id/reads` returns the list **only if the
    requester is the message author** and the channel is a DM or **group** (403 otherwise). It's
    computed from members whose `lastReadAt >= message.createdAt` (index `{channelId,lastReadAt}`).
  - **Channels: no read data** — endpoint returns 404/empty; ticks not shown.
  - DM ticks: derived on the client from the single peer pointer.
- `hiddenAt` / `clearedBeforeMessageId` membership pointers replace the O(history) `deletedFor`
  writes on leave/clear.
- Purge job: **none** (Q7 — keep forever). Instead an archival tagger for B11 tiering.

**Acceptance:** send ≤ 3 queries, P95 < 400 ms; `MessageDto` has no `readBy`/full-reactions;
reaction toggle = 1 op + delta < 300 B; "seen by" visible only to the author, DM/group only, never
in channels; `emoji_usage` collection dropped; voice duration + file name persist.

---

## B6 — Contacts, folders, search · Size M · blocks F6, A6

**Goal:** the address book (Q14), Telegram-style folders (Q12), unified search.

**Work**
- **Contacts:** `contacts {ownerId, userId, customName?, savedAt}` + indexes.
  - `POST /v1/contacts` — add by `username` (public) **or** by `phone`/`email` (exact match only,
    rate-limited, no fuzzy) → resolves to a user → saves the contact.
  - `GET /v1/contacts` (with the contact's presence + last DM), `PATCH` (custom name), `DELETE`.
  - Contacts feed `POST /channels/direct`.
- **Folders:** `chat_folders {ownerId, name, order, filters:{includeTypes[], includeTags[],
  includeChannelIds[], excludeChannelIds[], onlyUnread?}}`.
  - `GET/POST/PATCH/DELETE /v1/folders`; `GET /v1/channels/mine?folder=<id>` applies the filter
    server-side (still one aggregation).
  - `chat.tags` stays as a lightweight label input (any member set → **change to admin/owner
    only**); folders reference tags.
- **Search:** `GET /v1/search?q=&scope=people|channels|messages` — `$text` (people: username +
  name **only**, never email/phone; channels: name + description; messages: across the user's
  channels). Escape `q`, min length 2, rate-limited. `GET /v1/channels/:id/messages/search` returns
  snippet + cursor windows (not 500 bare ids). In-chat navigation uses `locate`.

**Acceptance:** add-contact by exact phone/email works and is rate-limited; public search never
returns phone/email; folders filter server-side in one query; message/user/channel search use
`$text` (`explain`); ReDoS test passes.

---

## B7 — Notifications fan-out · Size M · blocks F7, A7

**Goal:** server decides "should notify" + pushes to Flutter (FCM/APNs). Web is foreground-only.

**Work**
- `push_tokens {userId, platform: ios|android, token, ua, createdAt, lastSeenAt}`.
- `POST /v1/push/tokens` / `DELETE` (Flutter registers/unregisters; on logout too).
- `NotificationService` subscribes to `message.created`, `mention.created`, `call.ringing`:
  - resolve recipients (members − sender), for each check: `chatmembers.isMuted`,
    `preferences.notificationLevel` (all | mentions_and_calls | none), per-folder/per-chat
    overrides, **and skip if the user has that channel open** (presence room membership).
  - enqueue a **BullMQ** job → send FCM/APNs (collapse by `channelId` tag; per-user cooldown).
  - build the body server-side ("<sender> in <chat>: <preview>" / "🎤 Voice message" /
    "📞 Incoming call") + `data:{channelId,messageId}` for the deep link.
- Quiet hours (per user), optional.
- **Web:** no push token, no service worker. The realtime `message:new` / `call:ringing` events
  the web already receives drive an in-app toast + optional sound **only while a tab is open and
  the chat isn't muted** — this is entirely frontend (F7); backend just provides the mute/level
  flags on `ChannelDto` + preferences.

**Acceptance:** a Flutter client receives a push for a new message/mention/call **with the app
closed**, honouring mute + level + quiet hours + "channel open"; fan-out runs off the send hot
path; no push when the recipient has the channel open.

---

## B8 — Calls (SFU + TURN) · Size L · blocks F8, A8

**Goal:** real audio calls (video-capable), scalable, restart-safe.

**Work**
- **LiveKit** (self-hosted or cloud) as the SFU; **coturn** for TURN. (mediasoup is the
  alternative if self-hosting everything — more work.)
- `CallsModule` (feature-flagged): `POST /v1/calls {channelId}` → creates a call, returns
  `{callId, roomToken}` (LiveKit JWT scoped to the room); `POST /v1/calls/:id/join` → token for a
  joiner; call state (room, participants, mute) in **Redis**, not process memory.
- Gateway keeps only **notification** events: `call:ringing` (to `user:<callee>`),
  `call:ended`/`call:missed` (to channel/user). All media + participant events come from the
  LiveKit SDK on the client.
- Call-log messages (`type: call`, JSON payload: incoming/outgoing/missed/declined/ended+duration)
  emitted by `CallsModule` on end — **exactly one** per call.
- **Remove** the mesh gateway handlers, `activeCalls`/`privateCallByChannel` maps, and the
  external `NEXT_PUBLIC_CALL_HOST` dependency.
- Block enforcement on `call` creation (can't call someone who blocked you).

**Risks:** infra (LiveKit + coturn); LiveKit cost if cloud. Group call size — SFU handles far more
than mesh but set a sane cap (e.g. 16).
**Acceptance:** no call state in process memory; calls survive an API restart; 1:1 + group audio
works across NATs (TURN); gateway has ≤ 3 call-related notification handlers; one call-log message
per call; `CALL_HOST` removed.

**Status (2026-09-26):** built as specified, but two real bugs only surfaced once F8's Calls UI
was built and live-tested end to end against this module for the first time — this module's own
test suite (mocked `CallStateService`) never exercised either:
1. `createCall` initialized `participantIds: []`, never counting the caller. The frontend's caller
   never separately calls `/join` (they already have a token from `/create`'s own response), so a
   private call's `participantIds` could only ever reach 1 (from the callee's join) — the
   "answered" check (`length >= 2`, in `joinCall`) could never pass, and *every* real, fully
   answered private call still finalized as `kind: "missed"`. Fixed by seeding
   `participantIds: [callerId]` at creation; a new regression test asserts the real frontend flow
   (only the callee ever calls `/join`) still marks a call started.
2. `livekit.yaml` had no `rtc.node_ip` set. LiveKit running inside `docker-compose.yml`'s container
   was advertising its own container-internal bridge IP as ICE candidates — unreachable from any
   client outside Docker's network — so a call's signaling connected fine but WebRTC media
   negotiation timed out every time. Set to `127.0.0.1`, matching how the RTC UDP/TCP port ranges
   are already published straight through to the host; confirmed fixed by a real two-party LiveKit
   room connection immediately after.

---

## B9 — GIFs (personal + 3rd-party global), stickers, wallpaper internals · Size M · blocks F9, A9

**Goal:** finish the rich-media features per Q5/Q6/Q4.

**Work**
- **GIFs:**
  - Personal: `clips {ownerId, mediaId, title?, lastUsedAt, usageCount}` via `MediaService`
    (record/upload short video → looping gif/mp4). `GET/POST/DELETE /v1/clips`, `POST /:id/use`.
  - **Global tab:** proxy a third-party (`Tenor` recommended — free, generous, good API; Giphy as
    the alt). `GET /v1/gifs/search?q=&pos=` and `GET /v1/gifs/trending` → **server-side proxy** to
    Tenor (API key server-only, content filter = `high`/`off`? use `contentfilter=medium`,
    `media_filter=minimal`), normalised to `{id, previewUrl, url, dims}`, short-cache in Redis.
    Attribution surfaced by the client.
  - Drop `app_settings` (the `trendingGifs` toggle) + the local "trending" aggregation.
- **Stickers:** `sticker_packs {ownerId, name, isPublic, stickerMediaIds[]}` + real upload via
  `MediaService`; `POST /v1/sticker-packs`, `POST /:id/stickers`, `GET` (mine + public + search),
  `POST /v1/stickers/:id/use` (maintains `usageCount`); **delete the dead
  `bot/create-from-message` stub**. Add starter public packs (seed).
- **Wallpaper (keep the flow, fix internals):** **upsert** by `(ownerId, channelId|null)` (stop
  doc-per-apply); `GET /v1/.../wallpaper` requires membership; **remove `decline`**; media via
  `MediaService`; nightly GC of unreferenced wallpaper media. Video path stays.

**Acceptance:** personal clips + a global GIF tab backed by Tenor (key server-side, filtered,
attributed); stickers uploadable with maintained usage counts; no dead sticker endpoint; one
wallpaper doc per scope; wallpaper reads are membership-guarded.

---

## B10 — Reporting & moderation API · Size M · blocks D3, F10, A10

**Goal:** report → queue → action (Q15).

**Work**
- `reports {reporterId, targetType: message|user|channel, targetId, reason, note?, status:
  open|reviewing|actioned|dismissed, handledBy?, handledAt?, action?}`.
- `POST /v1/reports` (any user; rate-limited; dedupe per reporter+target).
- Admin API: `GET /v1/admin/reports?status=&type=`, `PATCH /v1/admin/reports/:id`
  (assign / resolve), and moderation actions:
  - `POST /v1/admin/users/:id/suspend {until?, reason}` (blocks login; `user.suspendedUntil`),
    `.../unsuspend`, `.../warn {message}` (delivered as a system DM from a "Moderation" account).
  - `DELETE /v1/admin/messages/:id` (hard-hide + audit).
  - `POST /v1/admin/channels/:id/lock` / member removal.
- `moderation_log {actorId (admin), action, targetType, targetId, meta, at}` — append-only, every
  admin action.
- Suspended-user enforcement in the auth guard + gateway connect.

**Acceptance:** a user can report a message/user/channel; it lands in the admin queue; an admin
can dismiss or take an action; every action is logged; a suspended user can't log in or connect.

---

## B11 — Storage tiering, performance, a11y support · Size M · blocks F11, A11

**Goal:** solve "keep forever" storage (Q7), lock in perf budgets.

**Work**
- **Object storage:** switch `MediaService`'s storage interface to **S3-compatible** (R2/B2/MinIO)
  + a **CDN** in front; migrate existing `uploads/` (background copy + URL rewrite; keep the
  disk-path resolver as a fallback). Immutable cache headers; serve from `media.<domain>`.
- **Lifecycle tiering:** a job tags media by age/last-access; move media untouched for N months to
  a cold storage class (Glacier-IR / R2 infrequent-access); **never delete**. `media_assets` keeps
  a `tier` field; cold objects are still served (higher latency, transparent).
- **Orphan sweep:** `refCount` maintained on message create/delete/edit; nightly report of
  refCount-0 assets — **archive, don't delete** (per Q7); an admin can hard-delete from the panel.
- Perf budgets in CI (query counts, payload sizes, index `explain`); k6 load test to 1000
  concurrent (REST + socket.io) on 1 node → tune pool sizes / batching.
- Structured logging (pino) + request/correlation ids threaded to WS.
- Backend a11y support: consistent error `code`s + messages the clients can localise/announce.

**Acceptance:** media served from S3 + CDN, relative URLs unchanged for clients; a tiering job
runs and cold media still loads; nothing is auto-deleted; all perf budgets green in CI; 1000-user
load test passes on 1 node.

---

## B12 — Cleanup · Size S

- Delete legacy `/chats*` routes, `API_SUMMARY.md`, stale `FLUTTER_INTEGRATION.md`; the OpenAPI +
  `REALTIME.md` are the living contract, PR-gated.
- Remove remaining dead code (`THINGS_TO_REMOVE.md`); drop legacy columns/collections after soak
  (`readBy`, `admins`, `banned`, `emoji_usage`, `app_settings`, `isOnline`).
- Consistency audit against `../ARCHITECTURE_RULES.md`.

---

## Deferred — Config Bot (see `CONFIG_BOT_PLAN.md`)

`POST /config-logs` is **already removed in B0**. The replacement (a curated in-app Config section
fed by a foreign crawler over a DNS-VPN) is a **separate, optional, last** initiative — not built
until B0–B12 ship. A `TODO(config-bot)` marker is left where the old endpoint was.

---

## Backend module target

```
src/
  common/        guards, pipes, interceptors, filters, decorators, envelope
  config/        typed config schema
  events/        EventEmitter2 domain events (contracts)
  modules/
    auth/        user + admin auth, sessions, recovery
    users/       profile, avatars, preferences, contacts
    channels/    channels, membership, folders, roles, bans, invites
    messages/    send/edit/delete/forward/pin/react/read/search/locate
    media/       MediaService (storage interface: disk → S3), sharp, ffmpeg
    presence/    Redis
    realtime/    the ONLY server.emit caller; Redis adapter
    calls/       LiveKit tokens, Redis state, call-log
    gifs/        clips + Tenor proxy
    stickers/
    wallpaper/
    notifications/ BullMQ + FCM/APNs
    reports/     reporting + moderation actions + moderation_log
    admin/       admin-only controllers (thin wrappers over the modules above)
  workers/       BullMQ processors (push, media-variants, tiering, consistency-cron)
```
