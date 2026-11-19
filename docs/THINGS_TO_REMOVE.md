# Things We Should Remove

Nothing here is removed on preference alone — each has evidence, a reason, a risk, and a
replacement. `REQUIRES PRODUCT DECISION` marks items where the owner must confirm intent first.

---

## Backend refactor status (chat-app/backend, B0–B12, as of 2026-09-08)

This document predates the `chat-app/backend` rewrite and originally audited the old
`legacy-chat`/`legacy-frontend` repos (still untouched — out of scope for the backend
refactor). The items below are now resolved on the **backend** side; the frontend-only items are
unaffected since no frontend work has been done under this plan.

**Resolved (backend):**
- `POST /stickers/bot/create-from-message` dead stub — gone; `sticker` module fully rewritten (B9).
- `sticker.usageCount` never incremented — real per-sticker `totalUsageCount` now (B9).
- `WallpaperService.declineShared` no-op — removed along with the whole decline flow (B9).
- `chat.banned[]` — gone; `chatmembers.isBanned` (indexed) is the only source (B0/B2).
- `message.readBy: Map` — gone; `lastReadMessageId`/`lastReadAt` per membership (B5).
- `user.isOnline` — gone; presence lives in `PresenceService` only (B3).
- `emoji_usage` collection — gone, zero references (B9 cleanup).
- `app_settings` module — deleted entirely (B9); `GIPHY_API_KEY` env var replaces the one
  `trendingGifs` boolean it held.
- `config-log` feature — never carried over into `chat-app/backend` at all (B0); confirmed via
  e2e test that `/config-logs` 404s.
- Duplicate SHA-256 dedupe / `buildUrl` / ffmpeg path resolution — unified under one
  `MediaService` (B2, extended through B11's S3 backend).
- 5 verbatim copies of the membership+ban+deleted guard in `MessageService` — extracted into one
  `assertChannelReadAccess()` helper (B12, Architecture Rule #12).
- `POST /messages` (REST) never broadcasting over WebSocket while the WS `send_message` path did
  — fixed; the REST controller now calls the same `ChatGateway.broadcastNewMessage` used by
  calls/wallpaper/moderation system messages (B12, Architecture Rule #16). Live-verified: a
  socket-only client receives a REST-created message in real time.

**Deliberately kept, not yet safe to remove (documented, not overlooked):**
- `chat.admins[]` — `ChatMembers.role` is already the single source of truth server-side
  (`recomputeChatAdmins` derives `admins[]` from it, never the reverse), but the array is kept
  because the frontend still reads `chat.admins[]` directly off the chat object. Dropping it
  needs a frontend migration + a soak period, which is out of scope for a backend-only refactor.
- `GET /chats` vs `GET /chats/search` — still two near-duplicate endpoints (both call
  `ChatService.findChat`). Not consolidated: no v1 replacement exists yet, and `/chats/search`'s
  keyword-optional "browse all public channels" mode and link-substring match aren't
  reproduced by the v1 `GET /v1/search?scope=channels` endpoint (which requires a ≥2-char query
  and only matches `name`/`description` via the text index) — that's a narrower search, not a
  superset. Consolidating would need a product decision on which behavior wins.
- `GET /chats/:channelId/display` — same reasoning; no v1 equivalent returns just the display
  name, and no v1 replacement for the rest of `ChatController`'s 24 routes exists to fold it into
  (see B12 finding below).
- `GET /chats/direct/:userId` creating a chat as a side effect of a GET, and calling
  `ChatGateway.notifyNewChat` directly from the controller — pre-existing behavior carried over
  from `legacy-chat`, not a new regression. Fixing both (Architecture Rules #13/#18) means an
  API-shape change (GET → POST) that needs frontend coordination; deferred.

**B12 finding — the plan's literal "delete legacy `/chats*` routes" instruction was not
executed:** `ChatController` (unversioned, `@Controller("chats")`) has 24 routes covering all
core chat/channel CRUD (create, update, membership, ban/mute, pin, tags, search, etc.). The v1
`ChannelsController` only has 2 routes (`GET /v1/channels/mine`,
`GET /v1/channels/:channelId/messages/search`). No v1 replacement exists for the other 22+
routes across B0–B11 — deleting the legacy controller would delete the app's core functionality.
This is a case where the plan's premise (a complete parallel v1 surface already exists) doesn't
hold for this codebase's actual incremental history. See `backend/README.md`'s B12 section for
the full write-up.

**Still open / frontend-only (unaffected — `legacy-frontend` untouched):** everything else
in this document below this section — `globals.css` cleanup, the `chats:invalidate` event bus,
hand-written frontend DTOs, the contacts/search UI consolidation, `/chats/new` step 3, the
`logoutAllSessions` UI, console noise, the committed `legacy-chat/dist/`, `API_SUMMARY.md` /
`FLUTTER_INTEGRATION.md` (confirmed absent from `chat-app/backend` — those were `legacy-chat`-only
docs to begin with), and every item in "Features pending product decision" below (calls, chat
tags, multi-avatar, video wallpapers, `bigEmojis`/`quickReaction` as server fields, Saved Messages
as a GET side effect) — none of these were in scope for `BACKEND_PLAN.md` and none were touched.

---

## Dead / stub code (safe to delete now)

### `POST /stickers/bot/create-from-message`
- **What:** endpoint + `StickerService.createFromMessage`.
- **Evidence:** the service method checks admin role then unconditionally `throw new BadRequestException(...)`. It never succeeds.
- **Why unnecessary:** does nothing; the message it throws points at the real endpoint.
- **Risk of removal:** none (no working callers).
- **Replacement:** none; `POST /stickers/packs` already covers it.

### `WallpaperService.declineShared` / `POST /v2/wallpapers/:id/decline`
- **Evidence:** method body is `/* no-op — declining does not persist state */`.
- **Why:** decline is purely client-side (just don't apply).
- **Risk:** frontend calls it (`wallpapersApi.decline`, 2 sites) → remove those calls too.
- **Replacement:** client closes the share prompt; no server call.

### `auth-context.logoutAllSessions` wiring without UI
- **Evidence:** `useAuth().logoutAllSessions` exists; no button in `profile/page.tsx` (only "Change password" + "Log out").
- **Why:** dead from the UI.
- **Risk:** none.
- **Replacement:** proper **Devices / Sessions** screen (Phase 4) with per-session + "sign out all".

### `/chats/new` step 3 "Add members"
- **Evidence:** `handleCreate` loops `selectedUsers` calling `chatsApi.getOrCreateDirect(u._id)` — creates **DM chats**, does not add anyone to the new group/channel. No backend endpoint to add members exists.
- **Why:** broken; misleads the creator into thinking members were added.
- **Risk:** removing the step without a replacement leaves groups with no way to add members (currently only self-join by link).
- **Replacement:** implement `POST /channels/:id/members` (admin) + invite links, then rebuild the step (Phase 7). **Do not just delete.**

### `resolveApiUrl` `/api` prefix branch
- **Evidence:** `REST_API_PREFIX = ''`; the `if (p === '/api' ...)` branch can never differ from the fallthrough.
- **Risk:** none.

### `console.log("url", url)` in `lib/socket.ts`; scattered `console.*`
- Debug noise; remove.

### Committed `legacy-chat/dist/`
- Build artifact in the repo. Delete + `.gitignore`.

### `legacy-chat/API_SUMMARY.md`, `legacy-frontend/FLUTTER_INTEGRATION.md`
- **Evidence:** both say the WS namespace is `/chat`; code uses `/`. `FLUTTER_INTEGRATION.md`'s DTO tables predate `forwardFrom`, `duration`, wallpaper v2, calls, blocks, quick-reaction.
- **Risk:** low — they're docs; but they actively mislead.
- **Replacement:** generated OpenAPI docs + `REALTIME_ARCHITECTURE.md` as the living contract.

---

## Redundant endpoints / data

### `GET /chats` vs `GET /chats/search`
- Both call `ChatService.findChat`. Keep one (`GET /channels/discover?q=`).

### `GET /chats/:channelId/display`
- Returns `{ displayName }` — a strict subset of what `/channels/mine` and `/channels/:id` already return. Remove; consumers read the field off the channel object.

### 3 date-navigation endpoints (`/first-of-date`, `/first-from-date`, `/oldest`)
- Merge into `GET /channels/:id/messages/locate?date=&mode=onDate|fromDate|oldest`.

### 3 unread endpoints (`/unread`, `/unread-mentions`, `/unread-reactions`)
- Fold counts into `/channels/mine` and a single `GET /channels/:id/attention` for the lists.

### `chat.admins[]` (duplicates `chatmembers.role`)
- **Evidence:** `ChatService.update` runs a loop to keep them in sync; they can drift.
- **Replacement:** `chatmembers.role` is the only role store. Migrate + drop the array + the sync loop + `channel_roles_updated` payload keeps only the derived id list.

### `chat.banned[]` (linear-scanned in ~8 hot paths)
- **Replacement:** `chatmembers.isBanned` (already a field!) with an index, or a `channel_bans` collection.

### `message.readBy: Map<userId, Date>`
- **Evidence:** written across history on every `markAsRead`; shipped in full to every client; forces `$expr` scans for "has reactions"-style queries; grows O(members) per message.
- **Replacement:** per-membership `lastReadMessageId` + `lastReadAt`; derive "read by N"; delta events. Add a privacy toggle (`REQUIRES PRODUCT DECISION` on whether per-user read visibility stays).

### `user.isOnline` column
- **Evidence:** mutated on every connect/disconnect; stale forever on crash.
- **Replacement:** in-memory / Redis presence.

### `emoji_usage` collection
- **Evidence:** whole collection + a write on every message per emoji + every reaction, to order a picker.
- **Replacement:** client `localStorage` recents (or one `user_prefs.recentEmojis` array synced occasionally). `REQUIRES PRODUCT DECISION` only if cross-device recents are considered important.

### `app_settings` module + schema + `OnModuleInit`
- One boolean (`trendingGifs`), no admin UI, Compass-only edit.
- **Replacement:** env var / typed config. Delete the module.

### Duplicate SHA-256 dedupe (`UploadController`, `GifService`, `WallpaperService`) and `buildUrl` (×3) and ffmpeg path resolution (×2)
- **Replacement:** one `MediaService`.

### 5 verbatim copies of the "chat exists + not deleted + banned + membership" guard in `MessageService`
- **Replacement:** one `ChannelMemberGuard` / `ChannelContext`.

### `contacts` route + `/chats/search` route + chat-list "add contact" modal + `/chats/new` step 3 user search
- Four UIs for "find a person / channel".
- **Replacement:** one global search (Messages · People · Discover) + `/app/new` sheet.

### `/chats/gifs/new`, `/chats/stickers/new` routes
- Full routes for modal-sized tasks.
- **Replacement:** sheets inside the respective pickers.

### Frontend hand-written `src/types/*` backend DTOs
- Already drifting (`ChatType` missing `saved_messages`; `avatarUrl` vs `image`).
- **Replacement:** generated from OpenAPI.

### `window.dispatchEvent(new CustomEvent('chats:invalidate'))` bus
- **Replacement:** TanStack Query invalidation.

### Bespoke `globals.css` component classes (`.chat-list-*`, `.fc-message-*`, `.profile-*`, `.glass`, …)
- ~1000+ of 1568 lines.
- **Replacement:** design-system primitives; keep only tokens + resets + keyframes.

---

## Features pending product decision (do not remove without an answer — see OPEN_QUESTIONS)

| Feature | Evidence it may be low-value | If "no" → remove |
|---|---|---|
| **Voice/video calls** | usage `UNKNOWN`; ~2000 LoC; in-memory state; no TURN; external `CALL_HOST` | gateway `call_*` handlers, `use-call-webrtc`, `call-*` components, `simple-peer`, `voice_call` message type, `NEXT_PUBLIC_CALL_HOST`, `lib/call-room.ts` |
| **Stickers** | `usageCount` never incremented; no upload; tiny UI; dead stub endpoint | `sticker` module, `sticker_packs`, `sticker-picker`, `/chats/stickers/new` |
| **GIFs (as "clips")** | no Giphy code despite docs; "trending" costly; really just personal uploaded clips | trim to "attach GIF from library" or drop trending; keep upload |
| **Chat tags** | no tag-filter UI in reviewed pages; any member can set | `chat.tags`, `POST /chats/:id/tags`, tag index |
| **Multiple avatar images per user** (`avatarUrl: string[]`) | product value unclear; adds lightbox/remove complexity everywhere | collapse to a single avatar |
| **Video wallpapers / per-chat wallpapers** | large complexity budget for cosmetics; unbounded growth | keep image-only global wallpaper; drop video + per-chat |
| **`bigEmojis` / `quickReaction` as server fields** | client preferences | move to client prefs |
| **Saved Messages as a chat type** | works, but is a GET side-effect; frontend enum doesn't know the type | keep the feature, change the mechanism (explicit create, add to enum) |
| **`config-log` feature** | niche (deploy log → chat channel); security hazard | remove unless a concrete owner + use case exists |

---

## Removal method

For every "yes, remove":
1. Feature-flag it off in one release; watch metrics/logs for real usage.
2. Snapshot any data (`mongodump` the collection) before dropping.
3. Remove code + routes + types + tests in one PR referencing this doc.
4. Drop the collection / columns in a follow-up migration after a soak period.
5. Update OpenAPI + `REALTIME_ARCHITECTURE.md` + this doc.
