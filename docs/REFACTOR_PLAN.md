# Global Refactor Plan

Phased, dependency-ordered. Each phase lists goal · scope · risks · tests · acceptance ·
complexity (LOW/MED/HIGH). Migration stance per feature is in the per-feature specs
(`refactors/*.md`). The order is derived from `FEATURE_DEPENDENCY_MAP.md`: **foundations
(indexes, auth, contract) → data layer → realtime → features → UI → polish.**

Guiding constraint (init-prompt §44): the target is *less* — less data, fewer requests, less UI,
less state — not more features.

---

## Phase 0 — Safety & discovery lock-in  ·  complexity LOW  ·  ~1 week

**Goal:** stop the bleeding; make the codebase safe to change.

- Rotate `JWT_SECRET`, purge `.env` from git history, move secrets to a manager, add a secret
  scanner to CI. *(SECURITY A1)*
- Remove or hard-lock `POST /config-logs` (strong secret + IP allowlist, or delete). *(SECURITY Z2)*
- Add a global `JwtAuthGuard` + `@Public()`; audit every handler. *(SECURITY Z1)*
- Add `@nestjs/throttler` with baseline limits on auth/search/upload/message. *(SECURITY R1)*
- Add `helmet` + explicit CORS allowlist (HTTP + gateway). *(SECURITY T1/T2)*
- Serve `/uploads` from a separate origin/subdomain with `Content-Disposition: attachment` and a
  type allowlist; stop `Access-Control-Allow-Origin: *` on active types. *(SECURITY I4)*
- Add `chatmembers` indexes: `{channelId,userId}` unique, `{userId,isJoined}`, `{channelId,role}`.
  **De-dupe existing membership rows first** (migration script). *(PERF C2)*
- Delete committed `dist/`; add to `.gitignore`.
- Stand up CI: lint + typecheck + (new) test runner + bundle-size report + secret scan.

**Risks:** the unique membership index fails to create if duplicates exist → run the de-dupe
migration and verify count before adding `unique`. Locking `/config-logs` breaks whatever posts
to it (identify the caller first — likely a deploy script).
**Tests:** guard coverage test (every route is `@Public()` or guarded); throttler integration
test; index `explain()` test for membership lookup.
**Acceptance:** no secret in repo/history; every write route authenticated; membership lookup
uses an index; CI green.

---

## Phase 1 — API contract & shared types  ·  complexity MED  ·  ~2 weeks

**Goal:** one machine-readable contract; kill type drift.

- Author an **OpenAPI 3.1 spec** (Nest Swagger already 80% there) as the source of truth.
- Generate the frontend client + types from it; delete hand-written `src/types/*` DTOs (keep only
  view models). *(FRONTEND: type drift)*
- Introduce one **response envelope** + a global exception filter. *(API cross-cutting #1/#7)*
- Introduce **DTO mappers**: `PublicUserDto`, `MessageDto`, `ChannelSummaryDto`, `ChannelDto`.
  `login`/`register`/`profile` all return `PublicUserDto`. *(BACKEND: 3 user shapes)*
- Add `ParseObjectIdPipe`; standardise 404/403 behaviour. *(SECURITY I5)*
- Add length limits + `forbidNonWhitelisted: true` to validation. *(SECURITY I3/I6)*

**Risks:** frontend churn touching every call site — do it behind the generated client so the
diff is mechanical. Envelope change is breaking → version the API (`/v1`) and ship both briefly.
**Tests:** contract test (spec ↔ runtime) in CI; mapper unit tests (no `password`, no `isDeleted`,
no `email` in `PublicUserDto`).
**Acceptance:** `npm run generate:api` produces the client; zero hand-typed backend DTOs in the
frontend; every endpoint returns the envelope; Swagger matches runtime.

---

## Phase 2 — Data layer & backend structure  ·  complexity HIGH  ·  ~3–4 weeks

**Goal:** repositories, thin controllers, no gateway cycles, denormalised list data.

- Introduce a **repository layer** per aggregate (`channel`, `membership`, `message`, `user`,
  `media`). Services stop injecting models directly. *(BACKEND: no data layer)*
- Extract the **membership/ban/admin guards**; delete the 5 copies. *(BACKEND: dup logic)*
- Make the **gateway transport-only**: domain services raise `EventEmitter2` events; a `realtime`
  module subscribes and fans out. Remove all 6 `forwardRef` cycles. *(DEP MAP #1)*
- **One `MediaService`** (dedupe + `sharp` resize + thumbnail + blurhash + **relative URLs**);
  delete the 3 `dedupeOrStore`/`buildUrl` copies; one ffmpeg helper. *(BACKEND/PERF/SECURITY)*
- **Denormalise chat list data:** `chat_state` doc (or fields on `chats`): `lastMessageAt`,
  `lastMessagePreview`, `memberCount`; maintained on message create/delete + membership change.
- Rebuild `GET /channels/mine` as **one aggregation**, cursor-paginated, `ChannelSummaryDto`,
  with `unreadCount` computed from `lastReadMessageId` + denormalised counts. *(PERF C1/H2)*
- **Roles:** single source `chatmembers.role`; drop `chat.admins[]`; migration to reconcile.
- **Bans:** `chatmembers.isBanned` (indexed) or `channel_bans`; drop `chat.banned[]` scans. *(PERF H7)*
- **Keyset pagination** for messages + all search; add message indexes. *(PERF C6)*
- **Search:** switch chat/user/message search to `$text` (chat text index exists) or a proper
  search field; escape/aggregate to kill ReDoS. *(SECURITY I2)*
- Consolidate the 3 date-nav + 3 unread endpoints. *(API redundancy)*

**Risks:** the biggest phase; do it feature-slice by feature-slice behind the `/v1` prefix with
the old handlers still live. Denormalisation needs a backfill migration + a consistency checker
(cron comparing denormalised vs computed). Role/ban migrations are one-way — snapshot first.
**Tests:** repository unit tests; query-count integration tests (`/channels/mine` ≤ 3 queries
for any chat count); pagination correctness (no dupes/gaps across pages); event-emission tests
(one `message.created` per persisted message).
**Acceptance:** no service injects a Mongoose model; gateway imports nothing from `modules/*`
domain; `/channels/mine` p95 query count ≤ 3 and payload < 40 KB for 50 chats; all lists cursor-based.

---

## Phase 3 — Realtime & presence  ·  complexity HIGH  ·  ~2–3 weeks

**Goal:** scalable, scoped, delta-based realtime; one message write path.

- Add `@socket.io/redis-adapter`; move presence + typing + (if kept) call state to **Redis**.
- **Presence scoped to shared rooms**, debounced; stop persisting `isOnline`/`lastSeen` per
  connect (write `lastSeen` at most every N minutes or on disconnect only). *(PERF C5/M5)*
- **One message write path:** `POST /messages` persists + emits `message.created`; WS
  `send_message` calls the same service. Every persisted message → exactly one `message:new`
  fan-out (fixes silent REST create). *(REALTIME #1)*
- **Delta events:** `reaction:changed`, `read:updated`, `message:updated` (edit only). Never
  rebroadcast the full message on a reaction. *(PERF H1)*
- **Reconnect resync:** client sends `since` per open channel; server streams the gap.
- Per-socket rate limits on `send_message` / `typing` / `call_signal`. *(SECURITY R3/W1)*
- Gateway `@MessageBody()` runtime validation for every event. *(SECURITY W3)*
- Clean typing/uploading/call maps on disconnect. *(REALTIME #4)*

**Risks:** presence scoping can miss edge cases (new membership mid-session) → recompute rooms on
membership change events. Redis becomes a hard dependency (add to compose + health check).
**Tests:** two-client harness (send/receive latency, ordering, reconnect gap-fill); presence-leak
test (user A can't see user B's status with no shared chat); reaction event size < 300 B.
**Acceptance:** app runs with 2+ API replicas; presence events only reach shared rooms; reaction
toggle ships a delta; killing a node drops no messages (calls may drop — acceptable pre-Phase 7).

---

## Phase 4 — Auth hardening & account lifecycle  ·  complexity MED  ·  ~2 weeks

**Goal:** safe sessions, recovery, real device management.

- Short-lived access token (15 min) + refresh token in httpOnly `Secure` `SameSite=Lax` cookie;
  rotation + reuse detection; `sessions` collection. *(SECURITY A2/A3)*
- Move the web app to cookie auth (Next middleware for the redirect; `/app` becomes a server
  layout that checks the session). *(FRONTEND: client-only gating)*
- Login lockout / backoff. *(SECURITY A4)*
- **Password reset** (email or, if no email infra, admin-issued reset link — see OPEN_QUESTIONS).
- Cache `tokenVersion` (Redis) so `JwtStrategy` stops hitting Mongo per request. *(PERF H3)*
- Real **/settings/security** devices list with per-session revoke.
- Account deletion: re-auth + a cleanup job (memberships, blocks, orphan uploads, anonymise
  authored messages). *(SECURITY D7)*

**Risks:** cookie migration + CSRF considerations (SameSite + a CSRF token for cookie-auth
mutations). Email dependency — decide in OPEN_QUESTIONS before starting reset.
**Tests:** refresh rotation + reuse-detection tests; lockout test; "logout-all invalidates every
device" test; middleware redirect tests.
**Acceptance:** access tokens expire in 15 min; refresh rotates; a stolen access token is dead in
≤15 min; users can recover a forgotten password; `JwtStrategy` does 0 DB reads on the hot path.

---

## Phase 5 — Design system & shell  ·  complexity MED  ·  ~2–3 weeks (parallel with 3–4)

**Goal:** one primitive set; the new IA/route shell.

- Build the primitives from `DESIGN_SYSTEM.md` (`Button`, `Field`, `Sheet`/`Dialog`/`Menu`,
  `ListRow`, `Avatar`, `Bubble`, `Chip`, `EmptyState`, `Skeleton`, `Toast`).
- Tokenise: semantic state colors, type scale, spacing scale, elevation levels, motion tokens,
  `prefers-reduced-motion`. Fix `--muted` contrast.
- Slim `globals.css` (~1568 → target < 400 lines: tokens + resets + keyframes only).
- New shell: `/app` server layout, 2-item nav, unified conversation list, global search field,
  `/app/new` sheet, `/app/settings/*` grouping. *(ROUTES.md / IA)*
- Adopt **TanStack Query**; delete the custom cache refs + `chats:invalidate` bus. *(FRONTEND #23)*

**Risks:** big visual diff — ship behind a flag / on a branch, screenshot-test key screens.
**Tests:** component tests for primitives (a11y: focus trap, keyboard, labels); visual regression
on list row / bubble / composer / auth.
**Acceptance:** zero bespoke `.chat-list-*`/`.fc-*` classes remain; one `<Button>` implementation;
`globals.css` < 400 lines; nav has 2 items; all server state via RQ.

---

## Phase 6 — Conversations & messaging UI  ·  complexity HIGH  ·  ~4 weeks

**Goal:** decompose the god components; fast, virtualized, memoized feed.

- Split `chats/[channelId]/page.tsx` (3706) into an orchestrator (<200) + `_components/*` +
  `_hooks/*` (`use-messages` RQ-infinite + socket merge, `use-chat-realtime`, `use-read-tracking`,
  `use-mentions`). *(FRONTEND H4/M8, RULES 24–25)*
- Split `message-bubble.tsx` (3397) into `<MessageItem>` + per-type renderers
  (`TextMessage`, `MediaMessage`, `VoiceMessage`, `GifMessage`, `StickerMessage`, `FileMessage`,
  `SystemMessage`, `CallLogMessage`). `React.memo`, stable props.
- Split `message-composer.tsx` (2433): `<Composer>` core + lazy `MediaTray`, `VoiceRecorder`,
  `EmojiPicker`, `GifPicker`, `StickerPicker`.
- **Virtualize** the feed. Keyset pagination client-side.
- Consume **delta events** (reactions/reads) — patch RQ cache, don't replace messages.
- Deep-link `?m=` + panel state in URL.
- Fix confirmed bugs: voice `duration` persisted + shown; file `originalFilename` persisted;
  `forwardFrom` avatar; `avatarUrl`/`image` unification.

**Risks:** behavioural regressions in scroll/jump/pagination (the current logic is intricate) —
write the scroll/jump tests *first* against current behaviour, then refactor to green.
**Tests:** feed virtualization + scroll-to-message + "load older" + "new message while scrolled
up" + optimistic send/fail/retry; per-type renderer snapshots; reaction delta patch test.
**Acceptance:** chat route JS (gzip) < 180 KB; no component > 500 LoC in the chat feature;
message-list renders < 60 DOM nodes for a 500-message session; reaction toggle re-renders only
that item.

---

## Phase 7 — Feature decisions & trims  ·  complexity MED  ·  ~2–3 weeks

**Goal:** act on the product decisions (OPEN_QUESTIONS). Do the trims; fix or drop the partials.

- **Groups add-member:** implement `POST /channels/:id/members` (admin) + invite links; fix the
  broken `/chats/new` step 3. *(FEATURE_INVENTORY: groups)* — **not optional; it's a broken core flow.**
- **Calls:** per the product decision — (a) keep → SFU (LiveKit/mediasoup) + TURN + Redis call
  state; (b) rare → move to on-demand external room; (c) drop → remove ~2000 LoC, `simple-peer`,
  the call gateway handlers, `voice_call` message type, `NEXT_PUBLIC_CALL_HOST`.
- **GIFs:** decide Giphy integration or rename to "Clips"; materialise trending or drop it.
- **Stickers:** keep (add real upload + usage tracking + `POST .../use`) or remove the module +
  the dead `create-from-message` stub.
- **Wallpaper:** keep full / images-only / global-only / drop. If kept: upsert (stop per-apply
  doc growth), add `getById` auth, remove `decline` no-op, cleanup job.
- **emoji_usage:** replace the collection + per-message write with client-side recents.
- **app_settings:** fold into env/config.
- **Notifications:** implement Web Push (VAPID + `push_subscriptions` + SW handler) if push
  matters; otherwise document "foreground only".
- **Read receipts:** per-membership pointer model (from Phase 2/3) fully replaces `readBy` map;
  add a privacy toggle. *(SECURITY D4)*

**Risks:** removals are one-way — snapshot data, feature-flag first, remove after a soak.
**Tests:** member-add flow e2e; whichever features survive get critical-path tests.
**Acceptance:** no dead/stub endpoints; every remaining feature has an owner decision recorded;
LoC down materially; `emoji_usage` collection dropped.

---

## Phase 8 — Media pipeline & storage  ·  complexity MED  ·  ~2 weeks

- `sharp` pipeline: original + web-size + thumbnail + blurhash; `<img srcset>` on the client.
- Video: poster + optional transcode to a web profile; enforce sane max (250 MB → ~50 MB).
- EXIF strip; content-type sniffing; per-user storage quota.
- Orphan-upload GC (reverse index of file → references).
- Consider object storage (S3-compatible) behind the `MediaService` interface.
- Retention/archival job for `isDeleted` messages + very old media (per product retention decision).

**Acceptance:** largest image a viewer downloads ≤ 400 KB; uploads served from an isolated origin;
orphaned files GC'd; storage growth is bounded/observable.

---

## Phase 9 — Performance pass & budgets  ·  complexity MED  ·  ~1–2 weeks

- Wire the budgets from `PERFORMANCE_AUDIT.md` into CI (bundle size, query counts, payload sizes).
- Load test: k6 REST + socket.io-client fan-out (2,000 concurrent messaging users on one node).
- Fix whatever the load test surfaces (indexes, connection pool, event batching).
- Frontend: verify code-split budgets, add `next/image` or a media component, RUM marks.

**Acceptance:** all budgets green in CI; load test passes target; RUM dashboard live.

---

## Phase 10 — Accessibility & polish  ·  complexity LOW–MED  ·  ~1–2 weeks

- Focus management (traps, restore), `role="log"` feed, color-not-sole-signal, `prefers-reduced-
  motion`, 44px targets, RTL for composer + layout, error announcements, skip link.
- Motion cleanup (kill decorative animations; ≤300ms everywhere).
- Empty/loading/error states audited per screen (`ROUTES.md`).
- axe / Lighthouse a11y ≥ 95 on every route.

---

## Phase 11 — Flutter client  ·  complexity HIGH  ·  parallel from Phase 2

See `flutter/FLUTTER_PLAN.md`. Starts once the API contract (Phase 1) and the message/channel
DTOs (Phase 2) are stable. Shares the OpenAPI-generated models and the realtime event contract.

---

## Phase 12 — Final cleanup & docs  ·  complexity LOW

- Delete dead code (see `THINGS_TO_REMOVE.md`), the old `/chats*` routes, `API_SUMMARY.md`,
  stale `FLUTTER_INTEGRATION.md` (replace with generated docs).
- Ensure `REALTIME_ARCHITECTURE.md` + OpenAPI are the living contract, updated per PR.
- Post-refactor consistency audit against `ARCHITECTURE_RULES.md`.

---

## Sequencing summary

```
0 Safety ──► 1 Contract ──► 2 Data layer ──┬─► 3 Realtime ──► 4 Auth ──► 7 Feature decisions ─┐
                                           ├─► 5 Design system ──► 6 Messaging UI ─────────────┤
                                           └─► 11 Flutter (parallel) ───────────────────────────┤
                                                                                                ▼
                                                        8 Media ─► 9 Perf ─► 10 A11y ─► 12 Cleanup
```

Phases 3/5 run in parallel (backend vs frontend teams). 6 depends on 5. 7 depends on 2+3+
product answers. 11 depends on 1+2.

## Test strategy (applies to every phase)

| Layer | What | Tooling |
|---|---|---|
| Backend unit | services, mappers, guards, repositories | Jest |
| Backend integration | endpoints incl. **query-count + `explain` + payload-size** assertions; auth; pagination correctness | Jest + `mongodb-memory-server` |
| Realtime | two-client harness: latency, ordering, reconnect gap-fill, presence scoping, event size | Jest + `socket.io-client` |
| Contract | OpenAPI ↔ runtime | schemathesis / dredd |
| Web component | primitives (a11y), per-type message renderers, composer states | Vitest + Testing Library |
| Web integration | send/receive/optimistic/fail, scroll-to-message, load-older, unread | Testing Library + MSW |
| Web e2e | login, start DM, create group + add member, send text/media/voice, react, reconnect, search, notifications | Playwright |
| Flutter | unit (models, repos), widget (bubble, composer, list), integration (auth→chat→send) | flutter_test / integration_test |
| Perf | bundle size, load test | bundle-analyzer, k6 |
| Critical flows (must never regress) | login · start conversation · send · receive · reconnect · attachments · search · permissions | e2e gate on every deploy |
