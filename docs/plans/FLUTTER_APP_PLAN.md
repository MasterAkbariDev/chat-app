# App Plan — `chat-mobile` (Flutter, iOS + Android)

New repo, built from scratch against the refactored `/v1` API + realtime contract. Mobile-native
UX (not a web port). **Full background push** (FCM/APNs) per Q9. Offline read + a send outbox.

Stack: Flutter (stable), **Riverpod** (`flutter_riverpod` + `riverpod_generator`), **Dio**,
**socket_io_client**, **Drift** (SQLite) for offline cache + outbox, **just_audio** / **record**
for voice, **cached_network_image** + **flutter_blurhash**, **firebase_messaging** (+ APNs),
**livekit_client** for calls, **app_links** for deep links, **flutter_secure_storage**.

Each phase needs the matching backend contract merged (`Bn`). Size S/M/L as elsewhere.

---

## A0 — Repo & foundations · Size S · parallel with B0/B1

- New repo `chat-mobile`; Flutter project (iOS + Android); flavors `dev` / `prod` via
  `--dart-define` (`API_BASE`, `MEDIA_BASE`, `WS_URL`, `LIVEKIT_URL`).
- CI: `flutter analyze`, `flutter test`, build both platforms, golden-test job.
- Folder skeleton (see bottom); DI bootstrap; `Result<T,E>` / failure types.
- Design tokens mirroring `../DESIGN_SYSTEM.md` (Material 3 + Cupertino-aware); light/dark follows
  system; bundle Vazirmatn; RTL support baseline.

---

## A1 — Contract models + core infra · Size M · needs B1

- **Codegen models + API client** from `openapi.json` (`openapi_generator` or `swagger_parser` +
  `dio`). Single source with web/admin — no hand-written DTOs.
- `Dio` client: auth interceptor (attach access token; on 401 → one refresh via
  `/v1/auth/refresh`, refresh token in secure storage, queue + replay in-flight).
- Typed realtime layer: `socket_io_client` to namespace `/`, `auth:{token}`; a `RealtimeEvent`
  sealed class + a single `Stream<RealtimeEvent>`; reconnect + `{since}` resync hook.
- `Drift` DB: tables for `channels`, `messages`, `drafts`, `outbox`, `contacts`, `media_cache`.
- Error mapping → localised, announceable messages.

---

## A2 — Auth · Size M · needs B4

- Screens: splash/session, login (email/phone toggle), register, forgot-password (calls
  `recovery-request`, shows the neutral message), reset (deep link `app://reset?token=` **and**
  `https://app.../reset#token` universal link → in-app handler).
- `authProvider` (keepAlive) + secure storage; router redirects off it.
- Lockout message; loading states; keyboard handling.

**Acceptance:** login/register/refresh work; a recovery link opens the reset screen and completes.

---

## A3 — Conversation list + realtime · Size M · needs B2, B3

- `conversationsProvider` (`AsyncNotifier`) → `/v1/channels/mine`, cursor-paginated; **Drift
  read-through cache** (show cached list instantly, then refresh).
- Realtime patches: `message:new`, `channel:updated`, `presence:changed`, `read:updated`.
- Screen: AppBar (title + search + "New") → filter chips → `SliverList` of tiles; pinned section;
  FAB "New"; pull-to-refresh (forces resync); swipe actions (mute/pin); long-press menu.
- Empty / loading (skeletons) / error (keep cached + banner) / **offline** ("Offline" chip, cached
  list).
- Connection status handling; heartbeat while foregrounded.

---

## A4 — Conversation (read + text send) · Size L · needs B5

- `messagesProvider(channelId)` — infinite keyset + socket merge into Drift; reversed `ListView`
  (newest at bottom); load-older on scroll-up.
- `<MessageBubble>` per type (text / system / call-log first; media/voice next phase) — stateless,
  keyed by id + render signature; grouped corners; sender name in groups/channels; reply strip;
  RTL per message.
- Composer: text, `@mention` autocomplete (popover), reply/edit context bar, send.
- **Outbox:** send writes an `outbox` row (`pending`) → optimistic bubble → a worker flushes on
  connectivity → `sent` / `failed` (tap to retry). Composer text never lost.
- Header: back, avatar + title + status line (presence / last seen / "N members"), ⋯ menu.
- Deep link `?m=` via `locate`; "scroll to bottom" FAB with unread count.

**Acceptance:** open a chat offline → cached messages + working composer that queues; reconnect →
outbox flushes + gap resync; text send P50 optimistic-instant.

---

## A5 — Media, voice, reactions, reads · Size L · needs B5, B2(media)

- **Media:** `image_picker` / `camera` → client compress (`flutter_image_compress`,
  `video_compress`) → `POST /v1/media` with progress → store `MediaRef`. Display:
  `cached_network_image` + `flutter_blurhash` placeholder; `<MediaBubble>` grid for 2–6;
  full-screen viewer (pinch/zoom/swipe); video via `video_player` + server poster.
- **Voice:** `record` to capture (waveform), preview, send; playback via `just_audio`; render the
  **server** waveform + `durationSec`; a persistent bottom mini-player (Overlay) that survives
  navigation + auto-advances to the next voice in the channel.
- **Reactions:** long-press bubble → reaction bar + emoji sheet; double-tap → quick reaction; pills
  under the bubble; patch from `reaction:changed` deltas; recents in Drift.
- **Read receipts (Q8):** DM ticks from the peer pointer; on **your own** DM/group message a
  "Seen by N" row → tap → lazy list (author-only). Channels: nothing. `use-read-tracking` via a
  `VisibilityDetector` on the last visible message → debounced `read` call.
- Files: pick → upload → card with icon + real name + size + open/share.

---

## A6 — Contacts, folders, search · Size M · needs B6

- **Contacts:** add by username / exact phone / exact email; custom name; contacts list with
  presence; start-DM. Optional: read device contacts (with permission) to suggest matches by
  phone/email (privacy-gated; explicit opt-in).
- **Folders:** editor in Settings; folder tabs above the list; `conversationsProvider(folder)`.
- **Search:** segmented control Messages / People / Discover; debounced; message hits grouped →
  `locate`. In-chat search in the header.

---

## A7 — Push notifications (FCM/APNs) · Size M · needs B7

- `firebase_messaging` (Android) + APNs (iOS). On enabling push in Settings → request permission →
  get token → `POST /v1/push/tokens {platform, token}`; unregister on logout / disable.
- Handlers: foreground (in-app banner via the realtime path, not the push), background &
  **terminated** (system notification → tap → `app_links` deep link `/app/c/:id?m=:messageId`).
- Settings → Notifications: master toggle, level (All / Mentions & calls / Off), sound, quiet
  hours, per-folder & per-chat overrides.
- iOS: request notification permission at the right moment (after first meaningful use).

**Acceptance:** message from another user while the app is **force-quit** → a notification arrives
(honouring mute/level/quiet-hours/"channel open") → tapping it opens the message.

---

## A8 — Calls (LiveKit) · Size M · needs B8

- `livekit_client`: `POST /v1/calls` / `/join` → room token → connect.
- Incoming call: full-screen ringing UI (works from a notification when the app is
  backgrounded/quit — CallKit on iOS, a full-screen intent + `flutter_callkit_incoming` on
  Android); accept/decline.
- Active call: participant grid, speaking rings, mute, speaker/earpiece/BT toggle, minimise to a
  pill, "rejoin" for group calls.
- `call:ringing` / `call:ended` from realtime; call-log message rendered inline.
- Mic permission handling; background audio session config.

**Acceptance:** 1:1 + group audio calls; incoming call rings even when the app is closed; CallKit
integration on iOS.

---

## A9 — GIF (mine + global), stickers, wallpaper · Size M · needs B9

- GIF sheet: **Mine** (record/upload) + **Global** (backend Tenor/Giphy proxy, infinite scroll,
  attribution). Sticker sheet: packs + "New pack" (upload) + recents.
- Wallpaper: match the web UX — global in Settings, per-chat from the chat menu, share/accept, the
  editor (blur/dim/brightness/parallax, image + video). Uses the fixed `/v1` endpoints.
- Emoji recents in Drift.

---

## A10 — Reporting · Size S · needs B10

- "Report" in message / user / channel menus → sheet (reason + note) → `POST /v1/reports`.
- Suspended-account screen (reason + appeal path).
- "Warning from Moderation" system DM rendered inline.

---

## A11 — Offline hardening, performance, a11y · Size M · needs B11

- Drift: cap cached messages per channel (e.g. last 500) + LRU media cache with a size budget;
  eviction.
- Outbox: retry/backoff, `failed` UI, reconcile on reconnect, dedupe.
- Reversed-list perf: `const` tiles, keyed rebuilds only on real change, image decode budget.
- a11y: semantics labels on every actionable widget; feed as a `liveRegion`; 48dp targets;
  `MediaQuery.disableAnimations` / reduce-motion respected; large-text scaling; RTL layouts.
- Golden tests for key screens (light/dark/RTL); integration test for the critical flow.

---

## A12 — Store readiness & cleanup · Size S

- App icons, splash, store listings, privacy nutrition labels (data collected: messages, media,
  contacts-if-opted-in, push token), App Store / Play review prep.
- Crash reporting (Sentry / Crashlytics); analytics events for the critical funnel.
- Final pass against the `FLUTTER_PLAN.md` architecture + `../ARCHITECTURE_RULES.md`.

---

## Deferred — A13 Config section (see `CONFIG_BOT_PLAN.md`)

Read-only "Config" tab: list of VPN configs, copy / QR / "import to <client>" deep links,
categories, freshness. Built last, optional.

---

## Structure (from `../flutter/FLUTTER_PLAN.md`)

```
lib/
  main.dart
  app/                  App widget, router (go_router), theme, DI
  core/                 config, network (Dio), result, utils
  design_system/        tokens + primitives (AppButton, AppField, AppSheet, ListRow, Avatar, Bubble, Chip, EmptyState, Skeleton)
  data/
    api/                generated client + DTOs
    models/             domain models
    repositories/       Auth, Channel, Message, Media, Contacts, Presence, Calls
    local/              Drift DB (channels, messages, drafts, outbox, contacts, media_cache)
  realtime/             socket client, typed event stream, reconnect + resync
  features/
    auth/ conversations/ chat/ contacts/ folders/ search/ calls/ profile_settings/ moderation/
  services/
    notifications/ (FCM/APNs) media/ audio/ deep_links/
```

## Parity note

Web-only for now: nothing (web has no offline). App-only: **offline read + send outbox**,
**background push**, **CallKit**. Everything else reaches parity (`../flutter/FLUTTER_PLAN.md#11`).
