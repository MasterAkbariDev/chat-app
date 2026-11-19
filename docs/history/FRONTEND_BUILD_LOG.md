# Chat — frontend

Next.js 16 (App Router) + Tailwind v4 + TanStack Query. Built fresh in
`chat-app/frontend/`, following the redesign explored in
`../frontend-design/` and the phasing in `../docs/plans/FRONTEND_PLAN.md`.
Not the same codebase as the sibling `legacy-frontend` repo.

**Wired exclusively to `chat-app/backend`** (the refactored NestJS backend,
`/v1` routes where they exist) — **not** the original `legacy-chat` repo,
which is stopped and no longer used by this app. Auth, the chat list,
conversation history, sending, reactions, edit/delete/pin, and read
receipts are all live against a running instance, verified end to end with
two real logged-in sessions (register → chat list → open a conversation →
send over the socket → react/edit/pin from one side and watch it update
live on the other → delete for me vs. for everyone → read-receipt tick
updates when the other side reads → log out → log back in and see it
persisted).

## Run it

You need the backend running too:

```bash
# in ../backend (sibling repo)
npm run start:dev   # needs MongoDB + Redis reachable at the URLs in its .env

# in this repo
npm run dev
```

`.env.local` points `NEXT_PUBLIC_API_URL` at `http://localhost:3001` — the
backend's own `.env` has `PORT=3001`. Open http://localhost:3000 (or
whatever port `autoPort` in `.claude/launch.json` lands on if 3000 is
taken), register an account, and go.

**CORS is a strict allowlist** (`CORS_ORIGIN` in `backend/.env`, no
wildcard, shared by HTTP + the socket gateway) — if requests start failing
with an opaque `ERR_FAILED` after the dev server picks a new port, add that
origin to `CORS_ORIGIN` and restart the backend (`.env` is only read at
process start).

## What's wired to the real backend

- **Auth**: register, login, session restore, logout, all against the
  backend's **access + rotating refresh token** model (15-minute access
  token; a refresh token that's already been rotated away revokes the
  whole session family). `src/lib/api/client.ts` refreshes transparently
  on a 401 through a single in-flight promise, so two concurrent 401s
  can't each independently call refresh and trigger the reuse-detection.
  Both tokens live in `localStorage` (see `token-store.ts` for the
  tradeoff and what cookie sessions would take).
- **Chat list**: `GET /v1/channels/mine` (cursor-paginated), filtered by
  folder tabs (All / Direct / Groups / Channels — real chat `type`s, not
  the backend's actual folder feature, which exists at `/v1/folders` but
  isn't wired into this UI). Real last-message preview and pin/mute state
  per row; swipe actions call `POST`/`DELETE /chats/:id/pin` and `/mute`
  and patch the cache optimistically.
- **Conversation**: title/member-count come from the same
  `/v1/channels/mine` cache (shared query key, see `CHANNELS_QUERY_KEY` in
  `lib/api/chats.ts`) rather than a separate per-channel fetch — there's
  no `GET /v1/channels/:id` today. `GET /messages/channel/:id` for history
  (offset/limit, not cursor-based), rendered per real `type` (text/image/
  file/video/sticker/gif/voice — voice plays via a native `<audio>`
  element).
- **Sending**: over the socket (`send_message`), not REST — see
  `src/lib/socket.ts` for the full verified event contract (read from
  `chat.gateway.ts` directly, not guessed).
- **Realtime**: `new_message`, `message_deleted`, `message_updated`
  (edits + pin/unpin), `reaction_changed` (a delta, replayed locally
  against the cached reactions array — no full message in that payload),
  and `read:updated` (drives the sender's live read tick) all patch the
  TanStack Query cache for the open conversation.
- **Reactions**: tap an existing reaction to toggle your own, or the `+`
  picker. `POST /messages/:id/reaction` returns
  `{channelId, messageId, emoji, userId, action, reactions}` — the
  authoritative `reactions` array is used to patch the actor's own view;
  everyone else gets it via the smaller `reaction_changed` broadcast.
- **Message actions**: edit (own text messages), delete for me, delete for
  everyone (own messages, or any member in a private chat / admin+owner in
  a group or channel), pin/unpin (same permission rule) — a hover-reveal
  "⋯" menu on each bubble. A slim pinned-messages bar shows above the feed.
- **Read receipts**: `markRead` fires once per (channel, newest message)
  pair as messages load; the newest **own** message gets a live read tick
  via `GET /v1/messages/:id/reads` (author-only, per-message — too
  expensive to call for every own message, so only the latest one shows
  it), refreshed on `read:updated`.
- **Important**: edit/react(own toggle)/pin/delete all patch the query
  cache from the mutation's own HTTP response — they do **not** rely
  solely on the `message_updated`/`reaction_changed` broadcast, because
  that broadcast doesn't reliably reach the *acting* user's own socket for
  pin/unpin (confirmed: a second connected client sees the change
  instantly, the actor doesn't until they refetch). The broadcast still
  updates everyone else; see the quirk below before changing this.
- **Starting a conversation** (`/app/new`): real `GET /users/search`
  (username/first/last name only — never email/phone, by design), real
  `GET /chats/direct/:userId` for 1:1s, real `POST /chats/create` for
  groups/channels — both still legacy endpoints with no `/v1` replacement,
  see quirks below.
- **Chat info panel** (`/app/c/[id]/info`): real participants
  (`GET /chats/:id/participants`), real pinned count, a working mute
  toggle. Title and member count come from the shared channels-mine cache.
- **Command palette / theme system / swipe gestures** from the earlier
  design pass — all still present, see the git history if this file's now
  out of date on specifics.

## Known backend quirks this frontend works around (see src/lib/api/types.ts)

These are real, confirmed properties of `chat-app/backend`, not bugs in
this frontend — read the doc comments in `types.ts`/`chats.ts`/
`messages.ts`/`socket.ts` before "fixing" any of them here:

- The checked-in `openapi.json` is **stale** — it documents zero `/v1`
  paths despite ~20 being live. Every type here was verified by reading
  the backend's DTO/service/schema source plus direct `curl` testing, not
  generated from that file.
- `POST /auth/register` is throttled to **3/hour per IP**, Redis-backed
  (survives a backend restart) — easy to exhaust while manually testing
  signup repeatedly; the fix is to wait out the window or clear the
  specific Redis throttle key on a local dev instance, not to lower the
  limit.
- `GET /v1/messages/:id/reads` ("seen by") is author-only and per-message
  — there's no cheap way to show a read tick on every own message, only
  the newest one.
- Reactions return a delta (`ReactionToggleResult`), not a full message,
  from the HTTP call; the `reaction_changed` socket event is an even
  smaller delta with no `reactions` array at all — replayed locally.
- `GET /chats/direct/:userId` and `POST /chats/create` are legacy
  endpoints with no `/v1` replacement — they return the raw `Chat`
  document (`RawChat` in `types.ts`), not a `ChannelSummary`.
- **`message_updated`'s broadcast doesn't reliably reach the acting user's
  own socket** for pin/unpin (confirmed by direct testing: a second
  connected client updates live, the actor's own browser doesn't until it
  refetches). This is why edit/react/pin/delete patch the cache from the
  mutation's own response instead of trusting the broadcast alone — see
  "What's wired" above. A single isolated case of the broadcast also
  missing a *different*, non-acting client for one pin action was
  observed during testing and did not reproduce on retry (that same
  client received the very next edit's broadcast fine) — worth knowing as
  a possible flake class, not fully root-caused.
- Auth guards are per-route, not global — a new backend endpoint that
  forgets `@UseGuards(JwtAuthGuard)` is silently public.

## Deliberately not done yet

- No typing indicators or presence UI (the socket events exist —
  `user_typing`, `user_status_changed` — just not wired into any
  component).
- No reconnect-gap backfill (`resync` socket event exists server-side,
  unused client-side).
- `/app/new`'s "Discover" tab (public channel search/join) isn't wired —
  shows a "not wired up yet" placeholder.
- No folders UI, even though the backend has a real `/v1/folders` feature
  now — the list's "Direct/Groups/Channels" tabs are just chat `type`.
- No real "Leave group/channel" action (the button is still a no-op).
- Settings is one page, not the per-page split the plan proposes; no
  settings mutations (profile edit, password change) wired up.
- No file/image/voice upload — composer only sends text.
- No avatar photos — every avatar is a generated color + initial, even
  though the backend now has a real `avatarUrl: string[]` field on
  `PublicUser`/`Me`.
- A11y pass (focus traps, `aria-live` on the feed) hasn't been done.
