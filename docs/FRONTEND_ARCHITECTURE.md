# Frontend Architecture Audit (`legacy-frontend`)

Next.js 15.3 App Router, React 19, Tailwind v4. **Effectively a client-only SPA** rendered
through Next — every `page.tsx` is `"use client"`, there is no server component, no server data
fetching, no route handler, no middleware. `output: "standalone"`.

## Route tree

```
app/
├── layout.tsx                RootLayout → <Providers> → <PwaRegistry> + children
├── page.tsx                  "/"  → redirect to /chats or /login (client effect)
├── manifest.ts               PWA manifest (placeholder icons)
├── login/page.tsx            public
├── register/page.tsx         public
├── chats/
│   ├── layout.tsx            <ProtectedRoute><AppShell>   (sidebar ChatList on desktop, bottom nav on mobile)
│   ├── page.tsx              "/chats"  mobile: <ChatList> ; desktop: empty state
│   ├── [channelId]/page.tsx  "/chats/:id"  3706 LoC — the whole chat room
│   ├── [channelId]/ForwardChatPickerModal.tsx
│   ├── new/page.tsx          3-step wizard (channel/group) — step 3 "add members" is broken
│   ├── search/page.tsx       "Discover" channels
│   ├── gifs/new/page.tsx     upload video → GIF
│   └── stickers/new/page.tsx create sticker pack
├── contacts/
│   ├── layout.tsx            <ProtectedRoute><AppShell>
│   └── page.tsx              search users + DM list
└── profile/
    ├── layout.tsx            <ProtectedRoute><AppShell>
    ├── page.tsx              663 LoC — identity, appearance, notifications, security, logout
    ├── edit/page.tsx         name/bio/username
    ├── change-password/page.tsx
    └── chat-background/page.tsx  global wallpaper picker/editor
```

`ProtectedRoute` is a client effect that redirects when `!token && !public`. Auth gating is
**entirely client-side** (no middleware) — the HTML for `/chats/:id` is served to anyone; data
calls 401.

## Provider stack (`components/providers.tsx`)

```
AuthProvider
 └ ThemeProvider
   └ OverlayProvider
     └ CurrentVoiceProvider        (renders a hidden <audio> that survives navigation)
       └ CallProvider
         ├ CallSocketListener      (global call event subscription)
         ├ <div h-dvh> CallBarSpacer + children
         ├ CallModal / CallBar / CallIncomingModal / OutgoingCallModal
         └ Toaster (sonner)
```

## State management

| Concern | Where | Notes |
|---|---|---|
| Auth (`user`, `token`) | `AuthContext` + `localStorage` (`legacy_chat_token`, `legacy_chat_user`) | trusts cached `user`, only calls `/auth/profile` when no cached user |
| Theme | `ThemeContext` + `localStorage` + `.dark` class | solid |
| Overlay lock | `OverlayContext` (count + `push()`) | hides FABs / locks body scroll while a modal is open |
| Global voice player | `CurrentVoiceContext` | ref-heavy; RAF loop; `onVoiceEndedRef` / `getNextVoiceInChannelRef` wired **from the chat page** |
| Calls | `CallContext` | `callId, participants, localMuted, minimized, connectionStatus, incomingCall, outgoingCallRequest, activeCallToRejoin` + `registerLeaveHandler` |
| Socket | `lib/socket.ts` module singleton + `useSocket(token)` | listener registry re-attached on reconnect |
| Everything else | **local `useState`/`useRef` in the page/component** | `chats/[channelId]/page.tsx` alone declares ~60 `useState` + ~25 `useRef` |
| Server cache | ad-hoc `Map` refs (`messageCacheRef`), module-level wallpaper cache, no library | no invalidation strategy; `window.dispatchEvent('chats:invalidate')` custom event bus |

**No React Query / SWR / Zustand / Redux.** Data fetching is imperative `useEffect` + `lib/api.ts`.

## `lib/api.ts` (711 LoC)

- One `request<T>()` axios wrapper: injects `Bearer`, normalises errors, shows a sonner toast
  unless `silent`, calls `onUnauthorized` on 401.
- Namespaced objects: `authApi`, `usersApi`, `chatsApi`, `messagesApi`, `emojiUsageApi`,
  `uploadApi`, `gifsApi`, `stickersApi`, `wallpapersApi`.
- Three bespoke `XMLHttpRequest` uploaders with progress (`uploadWithProgress`, `uploadGifVideo`,
  `uploadWallpaperFile`) — near-duplicate.
- `getMediaUrl()` re-resolves relative vs absolute URLs because the backend stores absolute ones.
- `resolveApiUrl()` has dead `/api` prefix handling (`REST_API_PREFIX = ''`).
- Types are **hand-duplicated** from the backend in `src/types/*` and already drift
  (`ChatType` missing `saved_messages`; `avatarUrl` vs backend `image`; `UpdateChatDto` differs).

## `lib/socket.ts` (322 LoC)

- `useSocket(token)` returns `{ socket, connected, emit, on, joinChannel, leaveChannel,
  sendMessage, typingStart/Stop, uploadingStart/Stop, updateStatus, markRead, call* ×10 }`.
- Every component that needs the socket calls `useSocket(token)` again → multiple hook instances
  share the module singleton but each maintains its own listener registry. `AppShell`, chat page,
  `CallSocketListener`, `use-call-webrtc`, `profile`, `chat-list` all call it.
- `console.log("url", url)` left in.

## Component hot spots

| File | LoC | Role | Problem |
|---|---|---|---|
| `app/chats/[channelId]/page.tsx` | **3706** | the entire chat room | God component: fetching, pagination, socket wiring, wallpaper, search, date-jump, members, admins, bans, mute, block, presence, mention/reaction queues, optimistic messages, group calls, pinned bar, ~15 modals |
| `components/message-bubble.tsx` | **3397** | one message | text/image/video/voice/gif/sticker/file/system/call-log rendering, reactions, menu, lightbox, forward, reply, RTL, big-emoji, width estimation heuristics, wallpaper system card |
| `components/message-composer.tsx` | **2433** | input bar | text, mentions autocomplete, emoji, gif, sticker pickers, media pick/crop/trim/export, voice record + waveform, reply/edit/forward bars, optimistic media |
| `components/chat-list.tsx` | **1411** | sidebar/list | list + search + add-contact modal + pin/mute + unread + live updates + per-chat unread fetch |
| `components/emoji-picker.tsx` | **1225** | picker | full emoji dataset + categories + recents + search |
| `components/video-lightbox.tsx` | 817 | video viewer | |
| `hooks/use-call-webrtc.ts` | 772 | mesh WebRTC | per-peer audio graph, device switching, speaking detection, health |

Six files account for ~13,000 of ~31,600 LoC.

## Rendering / performance issues

1. **Everything is a client component** — no RSC, no streaming, no server data. Initial `/chats/:id`
   ships the full JS for bubbles/composer/pickers/calls before any message renders.
2. **No route-level code splitting of the heavy pieces** — `emoji-picker`, `media-edit/*`,
   `call-*`, `video-lightbox` are imported eagerly by components that mount on chat open. (Some
   `import('sonner')` dynamic imports exist but the big ones don't.)
3. **`message-bubble` re-renders on any parent state change** — the chat page holds messages in
   `useState`, merges optimistic + dateJump every render (`useMemo` on 3 deps), and passes many
   inline callbacks; bubbles aren't `React.memo`'d with stable props. A reaction on message #400
   re-renders the list.
4. **Full message re-render on `message_updated`** (every reaction) — server sends whole message,
   client replaces the object → bubble subtree re-renders.
5. **`chat-list` fetches unread count per chat** (N requests) + re-sorts on every `new_message`.
6. **`my-chats` refetched** on many triggers (`chats:invalidate` custom event, `new_chat`,
   focus) — no dedupe/stale-time.
7. **Manual pagination loop** in the chat page ("load more until target message visible, then
   scroll") — `pendingScrollToMessageIdRef` + `offsetRef` + `noMorePagesRef` + timeouts; fragile,
   can double-fetch.
8. **Two hidden media elements always mounted** (`CurrentVoiceContext` `<audio>`, remote call
   `<audio>` appended to `document.body`).
9. **No virtualization** of the message list — `message-list.tsx` maps all loaded messages
   (up to 100/page, unbounded as you scroll) into DOM.
10. **Blurhash libs imported** but there's no server blurhash → dead weight, or client-computed
    (couldn't confirm a source).
11. **1568-line `globals.css`** with dozens of bespoke component classes (`.chat-list-*`,
    `.fc-message-*`, `.profile-*`) — Tailwind + a parallel hand-rolled CSS design system.

## State/prop problems

- **Prop drilling** through `message-list` → `message-bubble` (~25 props each), many optional
  callbacks.
- **Refs used as an event bus**: `CurrentVoiceContext.scrollToMessageIdRef`,
  `onVoiceEndedRef`, `getNextVoiceInChannelRef` are `useRef` holes filled by the chat page.
- **`window.dispatchEvent(new CustomEvent('chats:invalidate'))`** — a global event bus bolted on
  because there's no query cache.
- **`localStorage` flags** (`legacy_chat_notify_enabled`, `legacy_chat_sound_enabled`) read in
  hot paths (`app-shell` `new_message` handler reads them synchronously per message).
- Local state that should be shared: `muteMap` computed in `app-shell` **and** in `chat-list`
  **and** implied in chat page.
- Shared state that should be local: `CallContext` holds `minimized`, a pure UI concern.

## Accessibility (quick scan)

- Buttons mostly have `aria-label`; icons `aria-hidden`.
- **No focus management** on modal open/close (couldn't find focus traps in `app-modal.tsx`
  scope reviewed).
- **No `prefers-reduced-motion`** handling in `globals.css` keyframes (lots of `animate-*`).
- Contrast: `--muted` (#7b8299 on #f3f4f8) is ~3.6:1 — borderline for small text.
- Touch targets: `--touch-min` variable used inconsistently.
- No skip-link; no landmark roles beyond `<main>`/`<nav>`.
- Message list is a `div` soup — not a `log`/`feed` with proper semantics.

## Target frontend architecture

```
app/
├── (auth)/login, register, forgot-password
├── (app)/layout.tsx           server component: session check via cookie → redirect; renders <AppShell>
│   ├── chats/page.tsx          server: list shell; client <ChatList> hydrates from RQ
│   ├── chats/[channelId]/      split into:
│   │     page.tsx              orchestrator (<200 LoC): layout + <ChatHeader> + <MessageFeed> + <Composer> + <RightPanel>
│   │     _components/          message-feed, message-item (memo), composer/* (text|media|voice|pickers lazy), chat-header, panels/*
│   │     _hooks/               use-messages (RQ infinite + socket merge), use-chat-realtime, use-read-tracking, use-mentions
│   ├── contacts/, profile/*
features/
├── auth/ (context stays; add refresh)
├── realtime/ (one socket provider; typed event map; per-feature subscribe hooks)
├── api/ (generated client from OpenAPI; RQ query/mutation hooks; no hand-typed DTOs)
└── design-system/ (tokens + primitives: Button, Field, Sheet, Dialog, Menu, Avatar, Bubble)
```

Adopt **TanStack Query** for all server state (kills the custom cache refs, the
`chats:invalidate` bus, the per-chat unread loop → one keyed query with `select`). Keep contexts
only for auth, theme, socket, and active-call. `next build` should show the chat route JS well
under budget with the pickers/media-editor/call UI code-split. Generate types + a typed client
from the backend's OpenAPI so drift is impossible.
