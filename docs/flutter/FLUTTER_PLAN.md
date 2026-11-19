# Flutter Application Plan

Same product, same backend (post-refactor `/v1` API + realtime contract), **not** a pixel copy of
the web UI. Mobile-native patterns; the same data-minimisation and UX philosophy.

> Depends on: Refactor Phase 1 (OpenAPI contract) + Phase 2 (Channel/Message DTOs) being stable.
> The Flutter models are generated from the **same OpenAPI spec** as the web client.

---

## 1. Product scope (v1)

Ship the **core**: auth, conversation list, conversation (text/media/voice/reactions/replies/
mentions/read state), presence, typing, notifications (FCM/APNs), search, block, group/channel
membership + basic moderation. Defer: calls (per Q3), wallpaper (per Q4), stickers (per Q6),
GIF/clips (per Q5) — add once the web decisions land.

## 2. Architecture

```
lib/
├── main.dart
├── app/                     App widget, router, theme, DI bootstrap
├── core/
│   ├── config/              env (API base, media base, WS url) via --dart-define
│   ├── network/             Dio client, auth interceptor, refresh, error mapping
│   ├── result/              Result<T,E> / failures
│   └── utils/
├── design_system/           tokens (colors, type, spacing, radii, motion), primitives
│                            (AppButton, AppField, AppSheet, ListRow, Avatar, Bubble, Chip, EmptyState)
├── data/
│   ├── api/                 generated client + DTOs (from OpenAPI)  ← single source with web
│   ├── models/              domain models (mapped from DTOs)
│   ├── repositories/        AuthRepo, ChannelRepo, MessageRepo, MediaRepo, PresenceRepo
│   └── local/               Drift (SQLite) for offline cache: channels, messages, drafts, outbox
├── realtime/                socket_client (socket_io_client), typed event stream, reconnect + resync
├── features/
│   ├── auth/                login, register, forgot/reset, splash/session
│   ├── conversations/       list (list_controller, list_view, conversation_tile)
│   ├── chat/                room: message_feed, message_item/*, composer/*, chat_header, panels/*
│   ├── profile_settings/    profile, appearance, notifications, privacy, security
│   ├── search/              global + in-chat
│   └── moderation/          members, roles, bans
└── services/
    ├── notifications/       FCM/APNs token registration → /v1/push/subscribe ; tap → deep link
    ├── media/               pick/capture, compress, upload with progress, cache
    ├── audio/               record (flutter_sound / record) + playback (just_audio) + waveform
    └── deep_links/          app_links → /app/c/:id?m=
```

### Layer responsibilities & forbidden deps
| Layer | May depend on | May NOT depend on |
|---|---|---|
| `design_system` | Flutter SDK only | data, features, realtime |
| `data/api` (generated) | core/network | features, realtime, design_system |
| `data/repositories` | api, models, local, realtime | features, design_system |
| `realtime` | core, api models | features, repositories (it emits events; repos subscribe) |
| `features/*` | repositories, design_system, core | other features (share via `core`/repos), api directly |
| `services/*` | core, repositories | features, design_system |

## 3. State management

**Riverpod** (`flutter_riverpod` + `riverpod_generator`). Rationale: the app is
server-state-heavy with realtime deltas; Riverpod's `AsyncNotifier` + family providers +
`ref.listen` map cleanly onto "query + socket patch", with compile-safe DI and easy testing. No
`setState` sprawl (the web's core mistake).

| State kind | Mechanism |
|---|---|
| Server state (channels, messages, profile) | `AsyncNotifier` providers backed by repositories; realtime events call `ref.invalidate` / targeted `state = ...` patches |
| Realtime connection | a `socketProvider` (keepAlive) exposing a `Stream<RealtimeEvent>` |
| Local/feature UI state | `NotifierProvider` or widget-local `useState` (flutter_hooks) — kept small |
| Auth/session | `authProvider` (keepAlive) + secure storage; router redirects off it |
| Persistent | Drift DB (offline cache + outbox); providers read-through |
| Ephemeral (composer draft, scroll pos) | local, persisted to Drift per channel |

**Rule (mirrors ARCHITECTURE_RULES 24):** no controller/notifier over ~300 lines; a screen
orchestrates, repositories fetch, widgets render.

## 4. Networking & realtime

- **Dio** with an auth interceptor: attach access token; on 401 → single refresh via
  `/v1/auth/refresh` (refresh token in secure storage / httpOnly not applicable → rotating
  refresh in `flutter_secure_storage`); queue + replay in-flight requests.
- **socket_io_client** to namespace `/`, `auth: { token }`. Typed event layer:
  `RealtimeEvent` sealed class; a single stream; feature providers filter.
- **Reconnect resync:** on reconnect, for each open/cached channel send `{ since: lastMessageId }`;
  apply the gap into Drift + provider state.
- **Offline:** Drift caches the last N messages per channel + the channel list. Reads are
  read-through (cache first, then network). Sends go to an **outbox** table with status
  `pending|sent|failed`; a worker flushes on connectivity; the composer shows the state.

## 5. Design system (mobile)

- Tokens mirror `DESIGN_SYSTEM.md` (same palette, semantic state colors, type scale, spacing,
  radii, motion) but Material 3 / Cupertino-aware.
- Light/dark via `ThemeMode`, follows system by default, override in Settings.
- Persian/Arabic: bundle Vazirmatn; `Directionality` per message + RTL-aware layouts.
- Primitives: `AppButton`, `AppTextField`, `AppSheet` (draggable bottom sheet),
  `AppListTile`, `AppAvatar` (with presence), `MessageBubble`, `AppChip`, `EmptyState`,
  `AppSkeleton`, `AppSnackbar`.
- Motion: implicit animations ≤ 250ms; respect `MediaQuery.disableAnimations` /
  reduce-motion; hero on avatar → profile; no decorative animation.
- Touch targets ≥ 48dp; semantics labels on every actionable widget.

## 6. Screens (mobile UX)

### Splash / session
Purpose: decide route. Layout: logo + spinner. Nav: → login or → conversations. Loading: <300ms.
Error: "Couldn't reach the server — Retry". Offline: go to cached list if a session exists.

### Login / Register / Forgot
One-column forms; large fields; show/hide password; inline + snackbar errors; loading button;
lockout message. Keyboard: `TextInputAction.next/done`; scroll to focused field.

### Conversations (home)
- **Layout:** `AppBar` (title + search icon + "New") → filter chips (All/Unread/Groups/Channels)
  → list (`ListView` / `SliverList`), pinned section on top; FAB "New" on mobile.
- **Primary action:** open a conversation. **Secondary:** long-press → mute/pin/hide/delete;
  swipe → mute (left) / pin (right).
- **Nav:** tap → chat; search icon → search screen; "New" → new-conversation sheet.
- **Gestures:** pull-to-refresh (forces a resync), swipe actions.
- **Loading:** 6 skeleton tiles. **Empty:** "No conversations — start one". **Error:** keep
  cached list + a banner. **Offline:** cached list, "Offline" chip.
- **Perf:** `SliverList` with `itemExtent`-ish tiles; tiles are `const` where possible;
  provider gives an already-sorted, already-counted list (from `/channels/mine`).

### Conversation (chat room)
- **Layout:** custom `AppBar` (back, avatar+title+status, ⋯) → pinned strip (collapsible) →
  **reversed `ListView`** message feed (newest at bottom) → composer pinned above the keyboard
  (`MediaQuery.viewInsets`). Panels (Info/Members/Search/Media) = draggable bottom sheets.
- **Primary action:** send a message. **Secondary:** long-press bubble → action sheet (reply,
  react, copy, forward, pin, edit, delete); tap reply strip → jump.
- **Gestures:** swipe-right a bubble → reply; double-tap → quick reaction; long-press → menu;
  pull down at top → load older (or infinite scroll up).
- **Keyboard:** composer avoids the keyboard; "scroll to bottom" FAB when scrolled up + unread.
- **Loading:** header skeleton + 8 bubble skeletons. **Empty:** kind-specific.
  **Error:** full-pane retry. **Offline:** cached messages + outbox pending bubbles; composer
  works, sends queue.
- **Animations:** new message slides up subtly; reactions pop (≤150ms); sheet transitions 200ms.
- **A11y:** feed is a semantics `liveRegion`; each bubble labelled "sender, time, content".
- **Perf:** reversed list = O(visible) rendering; `MessageItem` is a `StatelessWidget` keyed by
  id + a small "render signature" (reactions count, edited, pinned) so it rebuilds only on real
  change; media uses `cached_network_image` with the blurhash placeholder.

### New conversation (sheet)
Tabs: Direct / Group / Channel / Discover. Shared user-search widget. Group/Channel: name, photo
(image picker + crop), description, add members (real endpoint).

### Search
Segmented control: Messages / People / Discover. Debounced. Message hits grouped by channel →
tap → open chat via `locate`.

### Settings
List → Profile / Appearance / Notifications / Privacy / Security / About. Each a short page.
Notifications: master toggle → registers the FCM/APNs token; level (All/Mentions/Off); sound;
quiet hours.

### Members & moderation
Members list with role, mute, ban, kick (admin); banned list; role dropdown (owner); transfer
ownership (typed confirm).

## 7. Media

- Pick/capture via `image_picker` / `camera`; compress (`flutter_image_compress`,
  `video_compress`) client-side before upload.
- Upload through `MediaRepo` → `POST /v1/media` with progress; store the returned `MediaRef`.
- Display: `cached_network_image` + blurhash; video via `video_player` with the server poster;
  full-screen viewer with pinch/zoom/swipe.
- Voice: `record` to capture, `just_audio` to play; render the server waveform; a global
  mini-player (`Overlay` / a bottom persistent widget) that survives navigation, like the web.

## 8. Notifications

- `firebase_messaging` (Android + iOS) / APNs. On enable → get token → `POST /v1/push/subscribe`
  with `platform`. Handle foreground (in-app banner), background, and terminated (tap → deep link
  `/app/c/:id?m=`). Server fan-out honours mute + preferences (same `NotificationService` as web).

## 9. Offline & error behaviour

| Situation | Behaviour |
|---|---|
| Cold start, no network, valid session | Show cached conversation list + last messages; "Offline" indicator; composer queues sends |
| Send while offline | Outbox `pending` bubble; flush on reconnect; `failed` after retries → tap to retry |
| Reconnect | Resync gap per open channel; reconcile outbox |
| 401 | Silent refresh once; on failure → login, keep the intended route for after-login |
| Media upload fails | Bubble shows retry; original file kept until success |
| Server 5xx | Snackbar + retry; never lose the composer text |

## 10. Testing

| Level | What | Tooling |
|---|---|---|
| Unit | repositories, mappers, outbox worker, realtime event parsing | `flutter_test`, `mocktail` |
| Widget | `MessageBubble` per type, `Composer` states, `ConversationTile`, empty/loading/error | `flutter_test` + golden tests |
| Integration | login → list → open chat → send text/media/voice → react → reconnect resync → offline send/flush | `integration_test` + a mock server (or the real `/v1` in CI) |
| Contract | generated models compile against the live OpenAPI spec | CI codegen check |
| Golden | key screens light/dark + RTL | `golden_toolkit` |

Critical flows gated on every build: login · open conversation · send · receive (push +
in-app) · reconnect · attachment · search.

## 11. Web ↔ Flutter feature parity matrix

Classification: **FULL** (same capability), **ADAPTED** (mobile-native form), **WEB ONLY**,
**MOBILE ONLY**, **FUTURE**.

| Feature | Web | Flutter v1 | Shared backend | Notes |
|---|---|---|---|---|
| Register / login / refresh | FULL | FULL | ✓ | refresh token in secure storage on mobile |
| Password reset | FUTURE | FUTURE | ✓ (same) | gated on Q1 |
| Devices / sessions | FULL | FULL | ✓ | |
| Profile / avatar / bio | FULL | FULL | ✓ | |
| Preferences (theme, big emoji, quick reaction, text size) | FULL | FULL | ✓ | theme follows system by default on mobile |
| Presence (online / last seen) | FULL | FULL | ✓ | heartbeat while foregrounded |
| Conversation list | FULL | FULL | ✓ | offline cache on mobile |
| Filters / global search | FULL | FULL | ✓ | segmented control on mobile |
| DM | FULL | FULL | ✓ | |
| Saved Messages | FULL | FULL | ✓ | |
| Groups + add members + invites | FULL | FULL | ✓ | |
| Channels (broadcast) | FULL | FULL | ✓ | |
| Roles / bans / kick / transfer | FULL | ADAPTED | ✓ | mobile uses sheets |
| Text / reply / edit / delete / forward / pin | FULL | FULL | ✓ | |
| Mentions + autocomplete | FULL | FULL | ✓ | |
| Reactions + quick reaction | FULL | FULL | ✓ | double-tap on both |
| Read state / unread / "seen by" | FULL | FULL | ✓ | pointer model |
| Typing / "uploading" | FULL | ADAPTED | ✓ | single "typing" on mobile (drop separate "uploading") |
| Images (crop) | FULL | ADAPTED | ✓ | native picker + crop |
| Video (trim / crop) | FULL | ADAPTED | ✓ | native trim; crop optional v1 |
| Voice messages + global player | FULL | FULL | ✓ | |
| Files | FULL | FULL | ✓ | |
| GIF / Clips | FULL | FUTURE | ✓ | gated on Q5 |
| Stickers | PARTIAL | FUTURE | ✓ | gated on Q6 |
| In-chat search + date jump | FULL | FULL | ✓ | `locate` endpoint |
| Notifications | ADAPTED (Web Push) | FULL (FCM/APNs) | ✓ | same `push_subscriptions` + fan-out |
| Voice/video calls | PARTIAL | FUTURE / per Q3 | per Q3 | if kept → LiveKit Flutter SDK |
| Wallpaper (global) | FULL | ADAPTED / per Q4 | per Q4 | image-only on mobile |
| Wallpaper (per-chat / video) | FULL | FUTURE / per Q4 | per Q4 | |
| Offline read + outbox send | — | **MOBILE ONLY** | ✓ | mobile-native resilience |
| Deep links to a message | FULL (`?m=`) | FULL (`app_links`) | ✓ | |
| Block | FULL | FULL | ✓ | domain-enforced |
| Theme (light/dark) | FULL | FULL | — | system default on mobile |

## 12. Rollout

1. Contract + core models (after Refactor Phase 1–2).
2. Auth + list + chat (read + text send) → internal alpha.
3. Media + voice + reactions + read state + push → beta.
4. Search + moderation + offline outbox → RC.
5. Calls/wallpaper/GIF/stickers as the web decisions land.
