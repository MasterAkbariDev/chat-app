# Project Blueprint — Chat

Executive source of truth. The **existing app** is the source of truth for what exists today; this
blueprint is the source of truth for what it should become. Details live in the linked docs.

---

## Part 1 — The current application

### Architecture
- **Backend** (`legacy-chat`): NestJS 11, MongoDB 7 / Mongoose 8, Socket.IO 4 (one gateway,
  namespace `/`), JWT (7-day, `tokenVersion` invalidation). Local-disk uploads served at
  `/uploads`. ffmpeg for GIF/wallpaper video. No Redis, no queues, no email, no server push.
  ~30 REST endpoints, ~13 client→server WS events, ~20 server→client WS events. **0 unit tests.**
- **Frontend** (`legacy-frontend`): Next.js 15 App Router but effectively a **client-only
  SPA** (every page `"use client"`, no server data). React Context + heavy local state, no query
  library, hand-rolled axios wrapper, hand-duplicated backend types. `socket.io-client` singleton.
  Tailwind v4 + a 1568-line bespoke CSS system. ~31,600 LoC, **13,000 of it in 6 files**
  (chat page 3706, message-bubble 3397, composer 2433, chat-list 1411, emoji-picker 1225).
  **0 tests.**
- **Calls:** WebRTC mesh (`simple-peer`), signalling + all call state in the single API process's
  memory; an external `NEXT_PUBLIC_CALL_HOST` domain whose code is not in these repos.

### Technologies
See `FEATURE_INVENTORY.md#technology-inventory` for exact versions.

### Features (confirmed)
Auth (register, login by email/phone, change password, logout-all [no UI]) · profiles + multi-
avatar + presence + block · DMs, groups, channels, Saved Messages · text/image/video/voice/file/
GIF/sticker/system messages · replies, edit, delete (everyone / me), forward, pin, mentions,
reactions + quick reaction · read receipts, unread counts/mentions/reactions · typing +
"uploading" indicators · in-chat search + date jump · channel/user discovery search · roles
(owner/admin/member), ban, admin-mute · per-user + per-chat wallpaper (image/video) · GIF library
+ "trending" · sticker packs · emoji-usage tracking · voice calls (1:1 + group) · web
notifications (foreground only) · theme, PWA shell.
Full list + evidence: `FEATURE_INVENTORY.md`.

### Routes
`/login`, `/register`, `/chats`, `/chats/[channelId]`, `/chats/new`, `/chats/search`,
`/chats/gifs/new`, `/chats/stickers/new`, `/contacts`, `/profile`(+edit, change-password,
chat-background). See `ROUTES.md`.

### APIs
`API_INVENTORY.md` — every endpoint, consumer, and problem.

### Data
11 collections. `messages` and `wallpapers` grow unbounded; nothing is ever purged.
`chatmembers` (the hottest collection) **has no indexes**. Roles live in two stores
(`chat.admins[]` + `chatmembers.role`); bans in a linearly-scanned array. `readBy` and
`reactions` as Mongo Maps cause write amplification and unindexable queries. Media URLs are stored
absolute (host-baked). See `DATABASE_AUDIT.md`.

### Real-time
Global presence broadcast on every connect/disconnect; full-message rebroadcast on every reaction;
in-memory call state; no Redis adapter (single-node only); REST-created messages are never
broadcast. See `REALTIME_ARCHITECTURE.md`.

### UX (as-is)
Conversation-capable and reasonably attractive, but: 3 top-level nav items that overlap; 4
different "find/start a conversation" surfaces; broken group member-add; settings is one long
scroll; no message deep-links; inconsistent error surfacing (`alert()` in one place, toast
elsewhere); no reduced-motion; borderline muted-text contrast; no focus management.

---

## Part 2 — Problems

### Architecture
- Frontend: 6 god components; no server state library; type drift; refs used as an event bus.
- Backend: fat services, no repository/domain/DTO layers, 5 verbatim copies of the membership
  guard, 3 copies of upload dedupe, the **gateway participates in 6 dependency cycles** (it's
  both transport and a domain dependency).
- One process holds all call + presence + typing state → cannot scale horizontally or survive a
  restart.

### Performance (see `performance/PERFORMANCE_AUDIT.md`)
- `GET /chats/my-chats` = O(N) queries (N+1 per DM) and runs constantly.
- `chatmembers` membership checks are collection scans (no index).
- `message.create` = 6–10 sequential queries.
- `markAsRead` write-amplifies across message history.
- Global presence broadcast is O(connections²) aggregate.
- Deep pagination via `skip`; regex search with no text index (also a ReDoS vector).
- No media resizing/thumbnails/CDN; full-res originals to every viewer.
- Chat route ships emoji/media-editor/call code eagerly; no message-list virtualization.

### Security (see `SECURITY_AUDIT.md`)
- **`JWT_SECRET` committed to the repo.**
- **`POST /config-logs`** — unauthenticated write with a hardcoded default password.
- No global auth guard; no rate limiting; no helmet/CSP; CORS `*` + credentials.
- Token + full user in `localStorage`; 7-day JWT, no refresh, no per-device revoke.
- No brute-force protection; no password reset.
- User search leaks email + phone (enumeration).
- Uploads: any type, 250 MB, served same-origin with `ACAO: *` (stored-XSS/polyglot risk).
- Block enforced only in the realtime path; several authz gaps (wallpaper IDOR, members list).

### Data
Unbounded growth, no retention, missing indexes, two sources of truth for roles/bans/reads,
confirmed field-name bugs (`image`/`avatarUrl`, `forwardFrom.image`/`.avatarUrl`, voice
`duration` dropped, file `originalFilename` dropped).

### Technical debt
0 tests, committed `dist/`, stale docs (`API_SUMMARY.md`, `FLUTTER_INTEGRATION.md` — wrong WS
namespace), dead code (sticker stub, `declineShared`, logout-all UI, `/chats/new` step 3), a
1568-line parallel CSS system.

---

## Part 3 — The target application

**Design principle (init-prompt §44):** the smallest amount of technology, data, UI, network
traffic, state, and interaction that delivers an excellent chat experience. Fewer features is not
the goal; less *incidental complexity* is.

### Architecture
- **Backend:** thin controllers → application services → domain rules → **repositories** → Mongo.
  One OpenAPI contract; generated frontend + Flutter clients. Global `JwtAuthGuard` + `@Public()`.
  The **gateway is transport-only**; domain services emit events; one `realtime` module fans out.
  Redis for presence/typing/call-state + the Socket.IO adapter → horizontal scale. One
  `MediaService` (dedupe + resize + thumbnail + blurhash + **relative URLs** + GC). Feature
  modules (calls, gifs/clips, stickers, wallpaper, push, configLog) are independently flag-able.
- **Frontend:** `/app` **server** layout (cookie session), route orchestrators < 200 LoC,
  feature `_components` + `_hooks`, **TanStack Query** for all server state (kills the custom
  cache refs + the `chats:invalidate` bus + the per-chat unread loop), virtualized memoized
  message feed, `next/dynamic` for pickers/editor/call UI. A ~10-primitive design system replaces
  the bespoke CSS.
- **Flutter:** same OpenAPI models, Riverpod, Drift offline cache + send outbox, FCM/APNs push.
  Mobile-native UX, not a web copy. See `flutter/FLUTTER_PLAN.md`.

### Routes / IA
Two destinations: **Chats** (unified DM + group + channel + Saved list, global search on top) and
**Settings** (7 focused pages). Everything chat-scoped is a panel/sheet inside the conversation.
`/app/new` sheet (Direct/Group/Channel/Discover) replaces `/contacts` + `/chats/search` + the
add-contact modal + the broken wizard. Deep-linkable messages (`?m=`). See `ROUTES.md` +
`INFORMATION_ARCHITECTURE.md`.

### API
~14 endpoints (from ~30). Cursor pagination everywhere. One response envelope. Purpose-built DTOs
that carry only what a screen renders (no `readBy` map, no email in user results, no `bio`/`tags`
in the list). `/channels/mine` = one aggregation, ≤ 3 queries for any chat count, < 40 KB / 50
chats.

### Backend data model
`chatmembers` indexed + unique on `(channelId, userId)`. One role store (`chatmembers.role`),
indexed ban flag, per-membership read pointer, `message_reactions` collection, normalised
`media[]` with variants + blurhash, denormalised `lastMessageAt`/`lastMessagePreview`/
`memberCount`. `emoji_usage`, `app_settings`, `user.isOnline`, `message.readBy`,
`chat.admins[]`, `chat.banned[]` all removed. Retention/purge job. See `DATABASE_AUDIT.md`.

### Real-time
One message write path (REST + WS → same service → exactly one `message:new`). Delta events for
reactions/reads (< 300 B). Presence scoped to shared rooms, debounced, Redis-backed. Reconnect
gap-fill via `since` cursors. Redis adapter → multi-node. See `REALTIME_ARCHITECTURE.md` §5 +
`refactors/realtime-gateway.md`.

### Flutter
Core parity (auth, list, chat, media, voice, reactions, read state, presence, search, push,
moderation) + mobile-only offline resilience. Calls/wallpaper/GIF/stickers follow the web product
decisions. Full matrix in `flutter/FLUTTER_PLAN.md#11`.

---

## Part 4 — Implementation

### Phases (see `REFACTOR_PLAN.md` for the full spec of each)
0. **Safety** — rotate/purge secrets, lock `/config-logs`, global guard, throttler, helmet,
   isolate `/uploads`, `chatmembers` indexes, CI. *(LOW)*
1. **API contract** — OpenAPI + generated clients, response envelope, DTO mappers. *(MED)*
2. **Data layer** — repositories, gateway decoupling, `MediaService`, denormalised list,
   `/channels/mine` aggregation, keyset pagination, `$text` search, single role/ban store. *(HIGH)*
3. **Realtime** — Redis adapter + presence + delta events + one write path + reconnect resync. *(HIGH)*
4. **Auth** — access+refresh cookies, lockout, password reset, devices, cached `tokenVersion`. *(MED)*
5. **Design system + shell** — primitives, tokens, new IA/routes, TanStack Query. *(MED, parallel with 3–4)*
6. **Messaging UI** — decompose the 3 god components, virtualize, delta patches, fix the bugs. *(HIGH)*
7. **Feature decisions** — fix group member-add; act on OPEN_QUESTIONS (calls, wallpaper, GIF,
   stickers, push, emoji_usage, app_settings); read-receipt privacy. *(MED)*
8. **Media pipeline & storage** — sharp variants, EXIF strip, quotas, GC, object storage/CDN,
   retention job. *(MED)*
9. **Performance pass** — wire budgets into CI, load test, fix findings. *(MED)*
10. **Accessibility & polish** — focus management, reduced motion, states, RTL, contrast. *(LOW–MED)*
11. **Flutter** — parallel from Phase 2. *(HIGH)*
12. **Cleanup** — delete dead code + old routes + stale docs; consistency audit. *(LOW)*

### Dependencies
`0 → 1 → 2 → {3, 5} → {4, 6} → 7 → {8 → 9 → 10} → 12`. 11 parallels from 2. 5∥3, 6 needs 5.

### Risks (top)
| Risk | Mitigation |
|---|---|
| `chatmembers` unique index fails on existing duplicates | de-dupe migration + count check before adding `unique` |
| Denormalised list data drifts | consistency cron comparing denormalised vs computed for 2 weeks; self-heal |
| Role/ban migration is one-way | snapshot collections; reconciliation tests |
| Big-bang API/UI changes break the app | `/v1` prefix + old handlers live in parallel; feature flags; strong e2e on critical flows |
| Redis becomes a hard dependency | health check + single-node degraded fallback |
| Calls decision unknown | instrument usage first; the fork is spec'd for all 3 outcomes |
| External `CALL_HOST` is undocumented | identify the owner/contents before Phase 7 |
| 0 existing tests | write critical-flow tests against current behaviour *before* refactoring each area |

### Acceptance criteria (program-level)
- No secret in the repo/history; every write endpoint authenticated + rate-limited.
- `chatmembers` indexed; no duplicate memberships possible.
- `/channels/mine` ≤ 3 queries, cursor-paginated, < 40 KB / 50 chats; no per-chat `/unread` calls.
- One message write path → exactly one `message:new` per persisted message.
- Reactions/reads are delta events < 300 B; `readBy` map removed.
- Presence scoped to shared rooms; `user.isOnline` removed; app runs on ≥ 2 replicas.
- Media URLs relative; every image has web+thumb+blurhash; largest viewer download ≤ 400 KB; uploads isolated.
- Access token TTL ≤ 15 min + rotating refresh; password reset exists; devices screen.
- No frontend component > 500 LoC in the chat feature; chat route JS < 180 KB gzip; feed virtualized.
- Two nav destinations; one "start conversation" surface; group member-add works; deep-linkable messages.
- Design system: one `<Button>`, tokenised, `globals.css` < 400 lines, reduced-motion, AA contrast.
- Every feature has critical-path tests; perf budgets enforced in CI.
- Flutter: core parity shipped; offline read + outbox send; push works app-closed.
- No dead/stub endpoints; roles/bans single-source; nothing grows unbounded (retention job).

---

## Part 5 — Open questions

15 items requiring product/team answers before their phase — see **`OPEN_QUESTIONS.md`**. The
load-bearing ones: **Q3** (calls: keep/externalise/drop + what is `CALL_HOST`), **Q1** (password
reset infra), **Q7** (retention), **Q13** (target scale / Redis availability), **Q9** (push
importance), **Q4–Q6** (wallpaper / GIF / stickers scope).
