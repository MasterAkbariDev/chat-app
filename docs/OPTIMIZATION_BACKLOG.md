# Optimization Backlog

Each item: **impact** (H/M/L) · **effort** (S/M/L) · phase. Cross-refs to
`PERFORMANCE_AUDIT.md` (C/H/M/L ids) and `SECURITY_AUDIT.md`.

## Quick wins (small change, large impact)

| # | Item | Impact | Effort | Phase | Ref |
|---|---|---|---|---|---|
| Q1 | `chatmembers` indexes `{channelId,userId}` unique, `{userId,isJoined}`, `{channelId,role}` (+ de-dupe migration) | H | S | 0 | C2 |
| Q2 | `messages` indexes `{channelId,isDeleted,createdAt:-1}`, `{channelId,type,createdAt:-1}` | H | S | 2 | C6 |
| Q3 | Stop persisting `user.isOnline` on every connect/disconnect; write `lastSeen` on disconnect only | M | S | 3 | C5/M5 |
| Q4 | Reaction/read events → deltas, not full message | H | M | 3 | H1 |
| Q5 | Drop `email` from `populate("senderId", ...)` and from `/users/:id/status` | M | S | 1 | M3/D2 |
| Q6 | `next/dynamic` for emoji/gif/sticker pickers, media editor, call UI, lightboxes, `simple-peer` | H | M | 5–6 | H5 |
| Q7 | Remove `console.log`/`console.error` from hot paths (gateway, socket lib, chat controller) | L | S | 0 | L1 |
| Q8 | `forbidNonWhitelisted: true` + `maxLength` on content/bio/description/name | M | S | 1 | I3/I6 |
| Q9 | Escape user input before `$regex`, or switch to `$text` (indexes exist for chats) | H | M | 2 | I2 |
| Q10 | `emoji_usage` → client-side recents (delete collection + per-message write) | M | M | 7 | M4 |
| Q11 | Collapse `addReaction` 4 queries → 1 `findByIdAndUpdate` + build response | M | S | 2 | M1 |
| Q12 | Merge 3 date-nav endpoints → 1; merge 3 unread endpoints → 1 | M | M | 2 | M6 |
| Q13 | Include `unreadCount` in `/channels/mine`; stop per-chat `/unread` calls | H | M | 2 | H2 |
| Q14 | `bulkWrite` for admin-role sync instead of per-member `save()` | L | S | 2 | M9 |

## Architectural (restructuring)

| # | Item | Impact | Effort | Phase |
|---|---|---|---|---|
| A1 | Repository layer per aggregate | H | L | 2 |
| A2 | Gateway → transport-only + EventEmitter2 domain events (removes 6 cycles) | H | L | 2–3 |
| A3 | One `MediaService` (dedupe + resize + thumbnail + blurhash + relative URLs); delete 3 copies | H | M | 2/8 |
| A4 | Denormalise `lastMessageAt`/`lastMessagePreview`/`memberCount` (`chat_state`) | H | M | 2 |
| A5 | `/channels/mine` single aggregation, cursor-paginated | H | M | 2 |
| A6 | Roles single-source (`chatmembers.role`); drop `chat.admins[]` | M | M | 2 |
| A7 | Bans → `chatmembers.isBanned` (indexed); drop `chat.banned[]` scans | M | M | 2 |
| A8 | Keyset pagination everywhere | H | M | 2 |
| A9 | One message write path (REST+WS → same service → one event) | H | M | 3 |
| A10 | Membership/admin guards; delete 5 copies of the guard block | M | M | 2 |
| A11 | OpenAPI-generated client + types (kill drift) | H | M | 1 |
| A12 | TanStack Query; delete custom cache refs + `chats:invalidate` bus | H | L | 5 |
| A13 | Split the 3 god components (page 3706 / bubble 3397 / composer 2433) | H | L | 6 |
| A14 | Redis: adapter + presence + typing + call state | H | M | 3 |
| A15 | Cookie auth + refresh tokens + `sessions` | H | L | 4 |

## Performance (network / DB / render)

| # | Item | Impact | Effort | Phase | Ref |
|---|---|---|---|---|---|
| P1 | Virtualize message list | H | M | 6 | H4 |
| P2 | `React.memo` message items, stable props, no inline list callbacks | H | M | 6 | H4 |
| P3 | Cache `tokenVersion` (Redis) → 0 DB reads per authed request | H | M | 4 | H3 |
| P4 | `sharp` media pipeline + `srcset` + blurhash placeholders | H | M | 8 | H8 |
| P5 | Materialise / cron the GIF "trending" aggregation, or drop | M | S | 7 | H6 |
| P6 | Presence scoped to shared rooms + debounced | H | M | 3 | C5 |
| P7 | Parallelise independent reads in `message.create`; drop re-`findById().populate()` | H | M | 2/3 | C3 |
| P8 | Reply snapshot instead of `populate("replyTo")` full doc | M | M | 2 | M2 |
| P9 | Object storage + CDN + cache headers for `/uploads` | M | M | 8 | M12 |
| P10 | `@socket.io/redis-adapter` for horizontal scale | H | M | 3 | W? |
| P11 | Connection-pool + Mongo read-preference tuning; load test | M | M | 9 | — |
| P12 | Drop always-mounted hidden `<audio>` when nothing is playing | L | S | 6 | L6 |

## UX (interaction / usability)

| # | Item | Impact | Effort | Phase |
|---|---|---|---|---|
| U1 | Unify the 4 "find/start conversation" surfaces → one `/app/new` + global search | H | M | 5 |
| U2 | Fix broken group member-add (`POST /channels/:id/members`) | H | M | 7 |
| U3 | Deep-linkable messages (`?m=`) + panel state in URL | M | M | 6 |
| U4 | Optimistic reactions/pins/edits with rollback | M | M | 6 |
| U5 | Reconnect gap-fill so reopening a chat isn't the only resync | M | M | 3 |
| U6 | Composer disabled states with clear reasons (channel/mute/block) | M | S | 6 |
| U7 | Consistent error surface (no `alert()` in `/chats/search`) | L | S | 5 |
| U8 | Settings grouped with a visible map | M | M | 5 |
| U9 | Password reset flow | H | M | 4 |
| U10 | Devices/sessions screen | M | M | 4 |
| U11 | Skeletons matched to content; kill spinner flashes on redirect | L | S | 5 |

## Visual

| # | Item | Impact | Effort | Phase |
|---|---|---|---|---|
| V1 | Primitive set replacing bespoke classes; `globals.css` < 400 lines | M | L | 5 |
| V2 | Semantic state color tokens (replace `text-red-500`/`bg-emerald-500` literals) | M | S | 5 |
| V3 | Type scale + spacing scale + elevation levels (ban arbitrary `text-[Npx]`) | M | M | 5 |
| V4 | `prefers-reduced-motion`; trim decorative animation; ≤300ms | M | S | 5/10 |
| V5 | Fix `--muted` contrast to WCAG AA | M | S | 5 |
| V6 | Reserve glassmorphism for the call overlay only | L | S | 5 |

## Technical debt

| # | Item | Impact | Effort | Phase |
|---|---|---|---|---|
| T1 | Remove committed `dist/`; `.gitignore` | L | S | 0 |
| T2 | Rotate + purge committed secrets; secret scanner | H | S | 0 |
| T3 | First tests (currently ~0) — critical-path e2e + unit | H | L | ongoing |
| T4 | Fix `image` vs `avatarUrl`, `forwardFrom.image` vs `.avatarUrl`, voice `duration`, file `originalFilename` | M | M | 6 |
| T5 | Remove dead code (THINGS_TO_REMOVE) | M | M | 7/12 |
| T6 | `createdAt/updatedAt` double-declared on `Message` | L | S | 2 |
| T7 | `lastSeen` default `new Date()` evaluated once at load | L | S | 2 |
| T8 | Structured logging + request/correlation ids | M | M | 9 |
| T9 | Replace `API_SUMMARY.md` / `FLUTTER_INTEGRATION.md` with generated docs | L | S | 12 |

## Optional (useful, not necessary)

| # | Item |
|---|---|
| O1 | Server-side link previews (unfurl) for message URLs |
| O2 | Message threads |
| O3 | Full-text message search service (if `$text` isn't enough) |
| O4 | Scheduled messages / drafts sync |
| O5 | Web Push digest emails (needs email infra) |
| O6 | Admin/moderation console |
| O7 | Voice message transcription |
