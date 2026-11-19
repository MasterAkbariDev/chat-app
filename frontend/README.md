# Chat — web frontend

The web client for **Chat**, a private messenger (DMs, groups and channels, voice and round video messages,
stickers, calls). It talks to the NestJS API in `../backend` over REST and Socket.IO.

| | |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS v4, the "Hearth" design system ([`../docs/DESIGN_SYSTEM.md`](../docs/DESIGN_SYSTEM.md)) |
| Server state | TanStack Query v5 (+ `@tanstack/react-virtual` for the message feed) |
| Realtime | `socket.io-client` |
| Calls | LiveKit (`livekit-client`, `@livekit/components-react`) |
| Push | Firebase Cloud Messaging (optional, loaded lazily) |
| Icons | `lucide-react` |
| Tests | Vitest + Testing Library (jsdom), Playwright (e2e smoke) |

It is a client-heavy SPA: every screen under `/app` renders on the client, and there is no server-side session.
The access token lives in memory and the refresh token in an HttpOnly cookie that only the backend reads. Page files under `src/app` mostly
unwrap route params and render a client component.

> **This is not the Next.js you know.** Next 16 has breaking changes from older versions (async `params`,
> generated `PageProps<"/route">` / `LayoutProps<"/route">` types, and more). Read [`AGENTS.md`](AGENTS.md) and
> the bundled docs in `node_modules/next/dist/docs/` before you write framework-level code.

## Quick start

Requirements: Node.js **20.9 or newer** (Next 16's minimum; the Docker image uses Node 20) and npm.

```bash
cd frontend
npm install
```

Create `frontend/.env.local`:

```bash
# The backend's origin (REST, Socket.IO and /uploads/media all live here).
NEXT_PUBLIC_API_URL=http://localhost:3097
```

Then start the dev server:

```bash
npm run dev          # http://localhost:3000
npm run dev -- -p 8080   # or pick a port
```

About the API port:

- The code falls back to `http://localhost:3001` when `NEXT_PUBLIC_API_URL` is unset. That is the backend's
  default `PORT` (see `backend/.env.example`).
- `NEXT_PUBLIC_*` values are inlined at build/dev-start time. Restart `npm run dev` after changing `.env.local`.

**CORS:** the backend refuses every origin that isn't in its `CORS_ORIGIN` allowlist. There is no wildcard
fallback, even in dev. Add the frontend's exact origin (for example `http://localhost:3000` or
`http://localhost:8080`) to the backend's `CORS_ORIGIN`, or every request and the socket handshake will fail.

**Media:** uploads are served by the backend from MinIO. If MinIO (Docker) isn't running, every
`/uploads/media/*` request fails and images, avatars and stickers break.

**Test accounts:** seeded local accounts, chats and sticker packs are listed in
[`../docs/DEV_TEST_ACCOUNTS.md`](../docs/DEV_TEST_ACCOUNTS.md), along with how to re-seed. To try a conversation
from both sides, sign in as two people in two browser profiles.

## Configuration

Everything below is read at build time. In Docker, these must be passed as build `ARG`s, not runtime env (see
`Dockerfile`).

| Variable | Read in | Purpose | Default |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | `lib/api/client.ts`, `lib/api/{media,wallpaper,bots}.ts`, `lib/socket.ts`, `lib/media-url.ts`, `components/ui/Avatar.tsx`, `next.config.ts` | Backend origin for REST, Socket.IO and media. `next.config.ts` also adds it to `next/image`'s `remotePatterns` (`/uploads/media/**`), and allows local IPs only when this host is `localhost`/`127.0.0.1`/`::1`. | `http://localhost:3001` |
| `NEXT_PUBLIC_LEGACY_MEDIA_ORIGINS` | `lib/media-src.ts` | Comma-separated previous origins whose upload links should be mapped to the current API. Set before building the frontend. | unset |
| `NEXT_PUBLIC_LEGACY_STORAGE_PREFIX` | `lib/themes.ts` | Previous browser storage key prefix to migrate to the current prefix. Set before building the frontend. | unset |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | `components/SuspendedNotice.tsx` | Contact address shown on the "account suspended" screen. Optional; when unset, no address is shown. | empty |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | `lib/push.ts` | Firebase web config for browser push. Push is enabled only when this key and the VAPID key are both set. | unset (push off) |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `lib/push.ts` | Firebase web config. | unset |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `lib/push.ts` | Firebase web config. | unset |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | `lib/push.ts` | Firebase web config. | unset |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `lib/push.ts` | Firebase web config. | unset |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | `lib/push.ts` | Firebase web config. | unset |
| `NEXT_PUBLIC_FIREBASE_VAPID_KEY` | `lib/push.ts` | Web push VAPID key. | unset (push off) |
| `ANALYZE` | `next.config.ts` | `true` turns on `@next/bundle-analyzer` (used by `npm run analyze`). | off |

Tooling-only variables: `CI` (Playwright retries and `forbidOnly`), plus `CHROME_PATH`, `LH_BASE_URL`,
`LH_ACCESS_TOKEN`, `LH_REFRESH_TOKEN` and `LH_DEBUG_PORT` for `scripts/lighthouse-audit.mjs`.

The Firebase values are public web config, not secrets. The background service worker
(`public/firebase-messaging-sw.js`) can't read env vars. To enable background push, add your
own project's matching public web configuration to that file before building the frontend.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next dev server (port 3000 unless you pass `-p`). |
| `npm run build` / `npm start` | Production build (`output: "standalone"`) and serve. |
| `npm run lint` | ESLint (`eslint-config-next` core-web-vitals + TypeScript). |
| `npm test` | Vitest, one run (sets `NODE_OPTIONS=--experimental-require-module`; see `vitest.config.mts`). |
| `npm run test:e2e` | Playwright smoke tests in `e2e/` (starts its own dev server on :3000). |
| `npm run analyze` | Production build plus an interactive bundle treemap. |

## Project structure

```text
frontend/
├── AGENTS.md                 Next 16 agent rules (read first)
├── Dockerfile                Two-stage standalone image; NEXT_PUBLIC_* are build ARGs
├── next.config.ts            standalone output, next/image remote pattern, bundle analyzer
├── vitest.config.mts         Vitest + jsdom (jsdom pinned to 27.0.0, see comments)
├── playwright.config.ts      e2e config (Chromium, baseURL :3000)
├── openapi.json              Old OpenAPI snapshot (stale, not used at runtime)
├── e2e/smoke.spec.ts         Backend-independent routing/login smoke tests
├── public/
│   ├── firebase-messaging-sw.js   FCM background service worker
│   └── wallpapers/*.svg           Bundled wallpaper presets
├── scripts/lighthouse-audit.mjs   Lighthouse over public + signed-in routes
└── src/
    ├── app/                  Routes (see below); layout.tsx, providers.tsx, globals.css (tokens)
    ├── components/
    │   ├── ui/               Design-system primitives (Button, Dialog, Menu, Field, Avatar, …)
    │   ├── chat/             Chat list, conversation, composer, message bubble, info/members panels, dialogs
    │   ├── media/            LoopVideo, voice and video-note recorders/players, RecordButton
    │   ├── packs/            Sticker/emoji picker, PackImage, pack preview, bot screen renderer
    │   ├── profile/          ProfileHero, photo viewer, profile photos manager
    │   ├── calls/            Call overlay, LiveKit call view, incoming-call banner
    │   ├── search/           Global search list, highlighting, recent searches
    │   ├── settings/         Settings dialogs (profile, password, notifications, performance, …)
    │   ├── auth/             AuthShell (sign-in layout)
    │   └── *.tsx             App shell: AppShell, NavRail, BottomNav, CommandPalette,
    │                         NotificationsHost, ResyncHost, SuspendedNotice, ThemeSwitcher, …
    ├── contexts/             auth, theme, performance, presence, call providers
    ├── hooks/                use-app-router, use-realtime-event, use-chat-meta-events,
    │                         use-chat-permissions, use-global-search, use-debounced-value, use-drag-x
    └── lib/
        ├── api/              REST client (client.ts, token-store.ts) + one module per backend area
        ├── socket.ts         Typed Socket.IO client and event map
        ├── themes.ts         Theme list + no-flash bootstrap script
        ├── performance.ts    Motion/lite/animated-media prefs + bootstrap script
        ├── push.ts           Optional FCM web push
        └── …                 media-url, message-preview, system-message, recording, call-log, ringtone, …
```

## Routes

All routes under `/app` are wrapped by `src/app/app/layout.tsx` → `AppShell`, which redirects to `/login` when
signed out.

| Route | Shows |
|---|---|
| `/` | Waits for the session check, then redirects to `/app` or `/login`. |
| `/login` | Email sign-in, including lockout (too many attempts) and suspended-account states. |
| `/register` | Create an account. |
| `/forgot-password` | Request a reset email. |
| `/reset-password` | Set a new password from a reset link. |
| `/app` | Chat list (phone) / empty reading pane next to the list (desktop). |
| `/app/c/[channelId]` | A conversation: virtualized feed, composer, header. A public chat you haven't joined opens as a read-only preview with a Join bar. `?message=<id>` jumps to a message. |
| `/app/c/[channelId]/info` | Chat info: photo, description, quick actions (call, mute, …), invite link, wallpaper, edit, report, leave/delete. |
| `/app/c/[channelId]/members` | Members list with roles, admin rights, member exceptions and bans. |
| `/app/c/[channelId]/permissions` | Group-wide default member permissions (needs the right to change them). |
| `/app/user/[userId]` | A person's profile (ProfileHero photo gallery, actions). |
| `/app/new` | New conversation: Direct, Group or Channel (name, photo, public/private). |
| `/app/join/[code]` | Invite-link landing: preview and join. Signed-out visitors return here after signing in. |
| `/app/contacts` | Address book: add by username, phone or email; rename; remove. |
| `/app/settings` | Profile, chats (folders, quick reaction, bots), notifications, preferences, sessions/devices, account, danger zone. |
| `/app/settings/appearance` | Theme picker, motion & performance settings, link to wallpaper. |
| `/app/settings/wallpaper` | Global wallpaper; `?chat=<id>` edits one chat's wallpaper. |
| `/app/settings/folders` | Create and edit chat folders. |
| `/app/settings/blocked` | Blocked users. |
| `/app/settings/bots` | Bot directory (currently the pack manager). |
| `/app/settings/bots/[key]` | One bot's server-described screen (e.g. manage sticker packs). |

`src/app/app/loading.tsx` is the shared skeleton. Navigation lives in `components/nav-items.ts` (Chats, Contacts,
Settings). Ctrl/⌘ K opens the command palette / search from anywhere.

## Architecture

### Providers

`src/app/providers.tsx` nests: `QueryClientProvider` → `ThemeProvider` → `PerformanceProvider` → `AuthProvider` →
`PresenceProvider` → `CallProvider`. `AppShell` then mounts the shared chat list once (desktop rail and phone
list share one mount), `NotificationsHost`, `ResyncHost`, `CallOverlay`, `SuspendedNotice` and
`useChatMetaEvents()`.

### Data fetching

- All server state goes through TanStack Query. Defaults: `staleTime` 30 s; queries retry up to 2 times but
  never on a 4xx; mutations don't retry.
- REST calls use `apiFetch()` in `lib/api/client.ts`. Each backend area has its own module (`chats.ts`,
  `messages.ts`, `media.ts`, `folders.ts`, `contacts.ts`, `search.ts`, `packs.ts`, `bots.ts`, `calls.ts`,
  `wallpaper.ts`, …). Shared response types are hand-written in `lib/api/types.ts`. They were checked against
  the backend source; `schema.d.ts` (generated by openapi-typescript) is not imported anywhere.
- Query keys are exported next to the code that owns them. Reuse them, don't retype them:

  | Key | Defined in |
  |---|---|
  | `["channels", "mine"]` (`CHANNELS_QUERY_KEY`) | `lib/api/chats.ts` |
  | `["chats", id, "permissions"]` | `lib/api/chats.ts` |
  | `["chats", id, "preview" \| "management" \| "participants"]` | `hooks/use-chat-meta-events.ts` |
  | `["messages", id]` (`messagesKey`), pinned, seen-by | `components/chat/ConversationView.tsx` |
  | `["folders"]` | `lib/api/folders.ts` |
  | `["users", "blocked"]`, `["users", id, "photos"]` | `lib/api/users.ts`, `lib/api/user.ts` |
  | `["wallpaper", "global"]`, `["wallpaper", "effective", id]` | `lib/api/wallpaper.ts` |

- **Optimistic updates:** messages are sent over the socket (`send_message`) with a client `tempId`. A temporary
  bubble shows at once, and the ack or `new_message` broadcast swaps in the real message. Pin and mute in the chat
  list, and permission toggles, patch the cache in `onMutate`. Edits, reactions, pins and deletes patch the cache
  from the mutation's response rather than waiting for the broadcast.
- The feed loads 50 messages at a time and pages back with `beforeDate`.

### Auth

- The refresh token is an **HttpOnly cookie** (`chat_refresh`) set by the backend, so page scripts can't read it.
  Every `/auth/*` call sends `credentials: "include"` and `X-Auth-Transport: cookie`, which makes the backend set or
  read the cookie instead of using the response body (the Flutter app omits the header and keeps bearer tokens).
- `lib/api/token-store.ts` keeps the access token **in memory only**, plus a non-secret `chat:session` hint in
  `localStorage` so a signed-out visitor doesn't try a refresh on every load. A reload gets a new access token from
  the cookie via `refreshSession()`. A refresh token an older version left in `localStorage` is swapped for the cookie
  on the first refresh and deleted.
- Access tokens last about 15 minutes, and the refresh token rotates. On a 401, `apiFetch` calls
  `refreshSession()` once and retries. Concurrent 401s share one in-flight refresh, and a Web Lock serialises refreshes across tabs, because presenting an
  already-rotated refresh token revokes the whole session on the backend. If the refresh fails, tokens are cleared
  and the user goes to `/login`.
- A 403 whose message mentions "suspended" triggers `SuspendedNotice` (a blocking screen), even mid-session.
- `AuthProvider` restores the session on load. Logout also unregisters the browser's push token.

**Storage:** theme and performance preferences are saved in browser storage. Session navigation hints use `sessionStorage`.

### Realtime

- `lib/socket.ts` exposes one shared, typed socket (`getSocket()`), with `ServerToClientEvents` /
  `ClientToServerEvents` as the event contract. The handshake token comes from a callback, so automatic reconnects
  present the current (refreshed) token.
- `useRealtimeEvent(event, handler)` subscribes for a component's lifetime without resubscribing on every render.
  Prefer it over raw `socket.on`.
- `useChatMetaEvents()` (mounted once in `AppShell`) handles `chat_updated`, `chat_permissions_updated`,
  `channel_roles_updated`, `user_muted` and `chat_deleted`. It patches or invalidates the list, preview, info and
  permissions caches, and leaves a deleted chat with a short notice.
- `ResyncHost` listens for the socket manager's `reconnect`. It refetches the chat list, then emits `resync` with the
  last seen message id of every cached conversation and merges the missed messages into the cache. `resync` only
  returns *new* messages. Edits, reactions and deletes that happened during the gap appear on the next refetch.
- Presence (`user_status_changed`) is tracked in `PresenceProvider`; typing (`user_typing`) is handled in
  `ConversationView` and shown in the chat header.

### Permissions

`useChatPermissions(channelId)` returns your effective rights (`EffectivePermissions`). It reads them from the chat
list summary, then from a cached preview, then from `GET /chats/:id/permissions`, and they stay current through
the socket events above. `undefined` means "unknown" and should be treated as **no**. Hide or disable actions
based on it; the server enforces the same rules. Owner/admin rights and member exceptions are edited in
`AdminRightsDialog`, `MemberPermissionsDialog` and `/permissions` (`ChatPermissionsPanel`).

### Media

- Uploads (`lib/api/media.ts`): `uploadImage`, `uploadVideo`, `uploadVoice`, `uploadAvatarVideo`. Images return a
  `mediaId`, which is sent as `attachmentMediaIds` so the server can attach blurhash and dimensions. Use
  `resolveMediaUrl()` / `videoPosterUrl()` (`lib/media-url.ts`) for backend paths.
- **`LoopVideo`** (`components/media/LoopVideo.tsx`) is the only way to show a looping avatar video. It plays only
  while at least half on screen and the tab is visible, decodes at most 2 at once, and respects the motion prefs.
- **`ChatWallpaper`** renders image or video wallpapers. A video pauses when hidden, off screen or after 30 s
  unfocused, and only the poster shows in Lite mode, Reduce motion, Save-Data or low battery.
- **Voice and round video messages:** `RecordButton` (tap to switch mode, hold to record), `VoiceRecorder` /
  `VideoNoteRecorder` (`video_note` type, 480×480, 60 s cap), and `VoicePlayer` / `VideoNotePlayer`. They need a
  secure context with `MediaRecorder`.
- Sticker and emoji pack media goes through `PackImage`, which picks the animated or still variant.

Details: the "Voice and video messages", "Photos", "Wallpapers" and "Media performance" sections of
[`DESIGN_SYSTEM.md`](../docs/DESIGN_SYSTEM.md).

### Performance and motion prefs

`lib/performance.ts` + `contexts/performance-context.tsx` (`usePerformance()`) store per-device prefs in
`chat:performance`:

- `lite`: one switch for old devices. It reduces motion, turns animated media off and skips blur.
- `motion`: `system` | `reduce` | `full`.
- `animatedMedia`: `auto` | `interact` | `off`.

`PERFORMANCE_BOOTSTRAP_SCRIPT` sets `data-motion` and `data-lite` on `<html>` before first paint. Use
`effectiveReduceMotion()`, `effectiveAnimatedMedia()` and `smoothScroll()` instead of reading the media query
yourself. Settings UI: `components/settings/PerformanceSettings.tsx` (Settings → Appearance).

### Theming

Five themes (Daybreak, Aurora, Meadow, Rose, Mono) × light/dark, selected by `data-theme` / `data-mode` on
`<html>`. Tokens live in `src/app/globals.css`, and the swatch list in `lib/themes.ts`. The defaults are Daybreak
with dark mode, or light if the OS prefers it. `THEME_BOOTSTRAP_SCRIPT` (inlined in `app/layout.tsx`'s `<head>`
with the performance script) applies the stored choice before paint, so there's no flash. `ThemeProvider` /
`ThemeSwitcher` handle changes.

### Notifications

- **In-app (always on):** `NotificationsHost` shows a toast and a short synthesized sound for a `new_message` in a
  chat you're not viewing, and updates the tab title. This uses the open socket only, so it works only while the tab
  is open.
- **Browser push (optional):** if the Firebase env vars are set, Settings → Notifications offers a "Push
  notifications" toggle. `lib/push.ts` lazy-loads Firebase, registers `public/firebase-messaging-sw.js`, and sends
  the FCM token to `/v1/push/tokens`. The per-account level (all / mentions / none) is set in
  `NotificationSettingsDialog`.

### Calls

`CallProvider` (`contexts/call-context.tsx`) owns call state. A call is started from the chat header or Chat info
(`startCall`). `lib/api/calls.ts` creates, joins, leaves and declines calls; the backend returns LiveKit
credentials. Incoming calls arrive as `call:ringing` and show in `IncomingCallBanner` with a ringtone
(`lib/ringtone.ts`). `CallOverlay` / `CallView` render the LiveKit room: microphone audio, plus any camera or
screen-share tracks participants publish. Missed and ended calls appear in the feed as `voice_call` messages
(`lib/call-log.ts`).

## Features

- **Chats:** DMs, Saved messages, groups and channels; pin and mute chats; unread badges; typing and online status.
- **Messages:** text with replies, edit, delete (for me / for everyone), pin, copy, multi-select, reactions
  (including a configurable quick reaction), read receipts ("seen by" for your own messages), report.
- **Groups and channels:** public (an @link, searchable, preview then Join) or private (invite link with
  copy/share/reset). Channels let only the owner and admins post.
- **Admin rights and member permissions:** Telegram-style per-admin rights, group-wide member defaults with
  per-person exceptions, bans, owner-only delete.
- **Search:** one box (chat list and Ctrl/⌘ K) over your chats, people, public groups/channels and messages, with
  recent searches; in-chat search via `ChatSearchBar`.
- **Stickers and animated emoji:** pack-based picker (Emoji / Animated / Stickers tabs). Animated emoji go inline
  in text (`RichMessageInput`). Packs are managed through the pack-manager bot. Incoming GIF messages are rendered,
  but there is no GIF picker in this client.
- **Profiles:** several profile photos/videos per person with "set as main", video avatars, a Telegram-style
  expanding profile header and a full-screen viewer.
- **Wallpapers:** bundled presets or your own image/video, globally or per chat, with "Use this wallpaper" to share
  one.
- **Folders:** custom chat folders shown as tabs above the chat list.
- **Contacts:** add by username, phone or email; custom names.
- **Voice messages and round video messages.**
- **Voice calls** (LiveKit), 1:1 and group.
- **Account:** edit profile, change password, sessions/devices with revoke, blocked users, delete account.

## Conventions

- **Routing:** always `import { useRouter } from "@/hooks/use-app-router"`, never from `next/navigation`. The
  wrapper starts the global navigation progress bar. `usePathname` and friends still come from `next/navigation`.
- **UI:** build from `src/components/ui` (`Button`, `IconButton`, `Field`/`Input`, `Dialog`/`ConfirmDialog`, `Menu`,
  `ListGroup`/`ListItem`, `PageHeader`/`PageBody`, `Avatar`, `Skeleton`, …). Every modal uses `Dialog`. Every
  secondary screen uses `PageHeader` + `PageBody`.
- **Styling:** use the token utilities (`bg-canvas`, `bg-panel`, `bg-raised`, `text-fg`, `text-muted`, `bg-accent`,
  …), not raw colours. Base styles stay in `@layer base`; don't add unlayered global CSS. Use `cn()` (`lib/cn.ts`)
  to merge classes.
- **Accessibility:** `IconButton` needs an `aria-label` (it doubles as the tooltip). Labels and errors are wired
  through `Field`. Touch targets are at least 40px (44px preferred). Use the global `:focus-visible` ring (or
  `focus-inset` on full-bleed rows). Destructive actions confirm, with the action named on the button. Use `aria-live`
  for transient notices. Honour reduced motion.
- **Copy:** plain, sentence-case English. The app name is "Chat".
- **Shapes:** circles are people; rounded squares are groups and channels. Per-person colour comes from
  `personColor()` (`lib/avatar-color.ts`).
- **Heavy code:** dynamically import heavy, rarely used SDKs, as `lib/push.ts` does for Firebase.
- **Realtime:** subscribe with `useRealtimeEvent`. Update the TanStack cache through the exported query keys.
- **Permissions:** gate UI with `useChatPermissions`, and treat `undefined` as "not allowed".
- **Next 16:** route params are async (`await props.params`). Follow `AGENTS.md`.

## Testing and quality

Run these before you push:

```bash
npx tsc --noEmit     # typecheck
npx eslint .         # lint (same as npm run lint)
npm test             # Vitest unit/component tests
npm run build        # production build
```

- **Unit/component tests** sit next to the code as `src/**/*.test.ts(x)`. Examples: `MessageBubble.test.tsx`,
  `RichMessageInput.test.tsx`, `ui/Field.test.tsx`, `ui/Media.test.tsx`, and `lib/{call-log,message-preview,
  recording,system-message}.test.ts`. `jsdom` is pinned to 27.0.0 on purpose; read the comment in
  `vitest.config.mts` before bumping it.
- **e2e:** `npm run test:e2e` runs `e2e/smoke.spec.ts`. It is a small, backend-independent smoke suite (signed-out
  redirects, login page rendering). Run `npx playwright install chromium` once first.
- **Lighthouse:** `scripts/lighthouse-audit.mjs` audits the public routes and, given real tokens, `/app`,
  `/app/contacts` and `/app/settings`. Reports go to `.lighthouse/`. It needs a Chrome binary:

  ```bash
  CHROME_PATH=/path/to/chrome LH_BASE_URL=http://localhost:3000 \
  LH_ACCESS_TOKEN=… LH_REFRESH_TOKEN=… node scripts/lighthouse-audit.mjs
  ```

  The backend throttles login, so reuse a token pair rather than signing in on every run.
- **Bundle size:** `npm run analyze`.

## Deployment

`Dockerfile` builds a standalone Next server (`node server.js` on port 3000, non-root user). Pass every
`NEXT_PUBLIC_*` value as a `--build-arg`. CI/CD and the compose setup are described in
[`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).

## Further reading

| Doc | What's in it |
|---|---|
| [`../docs/DESIGN_SYSTEM.md`](../docs/DESIGN_SYSTEM.md) | Hearth tokens, primitives, layout, and behaviour for media, groups, search and stickers. **Start here for UI work.** |
| [`../docs/DEV_TEST_ACCOUNTS.md`](../docs/DEV_TEST_ACCOUNTS.md) | Local seeded accounts and data. |
| [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) | CI/CD, Docker, environment for production. |
| [`../docs/ARCHITECTURE_RULES.md`](../docs/ARCHITECTURE_RULES.md) | Project-wide rules derived from the original audit. |
| [`../docs/PACKS_AND_BOTS_FRONTEND_BRIEF.md`](../docs/PACKS_AND_BOTS_FRONTEND_BRIEF.md) | Packs, inline animated emoji and the bot screen protocol. |
| [`../docs/plans/FRONTEND_PLAN.md`](../docs/plans/FRONTEND_PLAN.md) | The phased frontend plan (F0–F12) and its status notes. |
| [`../docs/README.md`](../docs/README.md) | Index of the architecture and refactor docs. |
| [`../docs/history/FRONTEND_BUILD_LOG.md`](../docs/history/FRONTEND_BUILD_LOG.md) | The original build log for this frontend (historical; parts are out of date). |

