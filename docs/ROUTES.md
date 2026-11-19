# Route & Screen Architecture

## Current routes (web) — evidence: `src/app/**`

| Route | File | Auth | Purpose | Notes / problems |
|---|---|---|---|---|
| `/` | `app/page.tsx` | — | redirect → `/chats` or `/login` | client-effect redirect; blank spinner flash |
| `/login` | `app/login/page.tsx` | public | email/phone + password | no forgot-password link |
| `/register` | `app/register/page.tsx` | public | create account | one long form, no verification |
| `/chats` | `app/chats/page.tsx` | JWT | chat list (mobile) / empty state (desktop) | desktop list lives in `AppShell` sidebar → list rendered twice in code |
| `/chats/[channelId]` | `app/chats/[channelId]/page.tsx` | JWT | **the entire chat room** (3706 LoC) | header, messages, composer, pinned bar, ~15 modals, wallpaper, search, members, calls |
| `/chats/new?type=group\|channel` | `app/chats/new/page.tsx` | JWT | 3-step create wizard | step 3 "add members" is broken (creates DMs); no "new group" vs "new channel" entry differentiation in UI beyond the query param |
| `/chats/search` | `app/chats/search/page.tsx` | JWT | discover/join public channels | duplicate of contacts' "find people" pattern; uses `window.location.href` to navigate |
| `/chats/gifs/new` | `app/chats/gifs/new/page.tsx` | JWT | upload video → GIF | deep route for a modal-sized task |
| `/chats/stickers/new` | `app/chats/stickers/new/page.tsx` | JWT | create sticker pack from URLs | rarely reachable; no sticker upload |
| `/contacts` | `app/contacts/page.tsx` | JWT | search users + list DMs | overlaps `/chats` list + `/chats/new` step 3 + `/chats/search` |
| `/profile` | `app/profile/page.tsx` | JWT | account, appearance, notifications, security, logout | 663 LoC single screen |
| `/profile/edit` | `app/profile/edit/page.tsx` | JWT | name / bio / username | |
| `/profile/change-password` | `app/profile/change-password/page.tsx` | JWT | change password | |
| `/profile/chat-background` | `app/profile/chat-background/page.tsx` | JWT | **global** wallpaper picker + editor | per-chat wallpaper is set from inside the chat room instead |

Navigation: `AppShell` — desktop 300px sidebar (ChatList + nav row) on `/chats*`; bottom nav
(Chats / Contacts / Profile) on mobile everywhere and on desktop for `/contacts` + `/profile`.
Bottom nav hidden inside a chat room.

### Structural problems with current routes
1. **Four overlapping "find/start a conversation" surfaces:** `/contacts` (find people + DM list),
   `/chats/new` step 3 (add members), `/chats/search` (find channels), chat-list "add contact"
   modal. Same job, four UIs, inconsistent (`alert()` here, toast there, `window.location` here).
2. **`/chats/gifs/new` and `/chats/stickers/new` are full routes for modal tasks.**
3. **`/chats/new` is a route** but is a wizard that would work as a sheet.
4. **Global vs per-chat wallpaper split across a route and an in-chat flow** with no shared entry.
5. **`/contacts` as a top-level nav item** — for a family chat app the DM list belongs *in* the
   chat list, not a separate tab. It duplicates chat-list content (private chats).
6. **No deep-linkable "message" URL** (`/chats/:id?m=:messageId`) — jump-to-message is all
   in-memory; a shared link to a message can't work.
7. **No settings sub-structure** — `/profile` is a wall of sections.

---

## Proposed route architecture

Principle: **conversation-first.** The list and the room are the app. Everything else is a
panel, sheet, or dialog unless it genuinely needs its own URL (deep-linkable, shareable, or a
distinct task the user navigates *to*).

```
/                         → redirect (server: cookie check)
/login                    public
/register                 public
/forgot-password          public   [NEW]
/reset-password           public   [NEW, token]

/app                      authenticated shell (server layout: session → redirect)
  /app                    chat list ; desktop: list + empty state ; mobile: list
  /app/c/:channelId       conversation
       ?m=:messageId      deep-link + highlight a message   [NEW]
       ?panel=info|members|search|media|wallpaper           panel state in URL   [NEW]
  /app/new                start conversation (sheet on desktop, page on mobile)
       ?tab=dm|group|channel|discover                       one surface, tabbed
  /app/settings           settings home
  /app/settings/profile
  /app/settings/appearance
  /app/settings/notifications
  /app/settings/privacy   [NEW: blocked users, presence visibility]
  /app/settings/security  [password, devices/sessions — NEW devices list]
  /app/settings/wallpaper  global wallpaper
  /app/settings/storage   [NEW: media/download management] (optional)
```

### Removed / demoted routes
| Was | Now |
|---|---|
| `/contacts` | folded into `/app` list (a filter) + `/app/new?tab=dm` |
| `/chats/search` | `/app/new?tab=discover` |
| `/chats/gifs/new` | sheet inside the GIF picker (`+ New GIF`) |
| `/chats/stickers/new` | sheet inside the sticker picker (kept only if stickers survive — see OPEN_QUESTIONS) |
| `/chats/new` (route) | `/app/new` sheet (still URL-addressable for deep links) |
| `/profile/*` (4 flat routes) | `/app/settings/*` (grouped) |

### Per-route spec (key routes)

#### `/app` — Conversation list
- **Primary user:** every user, every session start.
- **Entry points:** app launch, bottom nav, back from a conversation, notification (falls back here if channel gone).
- **Required data:** `GET /channels/mine` → `{ id, kind, title, avatar, lastMessage:{preview,at,type,senderName}, unreadCount, unreadMentions, isPinned, isMuted, myRole }[]`, cursor-paginated, **one request**.
- **API:** `GET /channels/mine?cursor=`. Realtime: `message:new`, `channel:updated`, `presence:changed` (scoped), `read:updated`.
- **Realtime need:** yes — list must reorder + bump unread live.
- **Components:** `<ConversationList>` (virtualized) → `<ConversationRow>` (memo), `<ListSearch>`, `<StartButton>`.
- **Loading:** skeleton rows (6). **Empty:** "No conversations yet — start one." **Error:** inline retry banner (keep last-good list).
- **Mobile:** full screen. **Desktop:** 320px rail + reading pane (empty state or last conversation).
- **Permissions:** authenticated.
- **Perf:** RQ `staleTime` 30s; socket events patch the cache; no per-row unread fetch.

#### `/app/c/:channelId` — Conversation
- **Primary user:** anyone in the chat.
- **Entry points:** list row, notification, mention jump, deep link (`?m=`), new-DM redirect.
- **Required data:**
  - `GET /channels/:id` → `{ id, kind, title, avatar, description?, myRole, memberCount?, otherUser?, isMuted, wallpaper: effective, permissions:{canPost,canPin} }` (one request; replaces `display` + `preview` + membership flags + wallpaper `effective`).
  - `GET /channels/:id/messages?cursor=` keyset, 30–50/page, `{ items, nextCursor }`. Message shape: `{ id, senderId, senderName, senderAvatar, type, text?, media:[{url,kind,w,h,blurhash,durationSec?}], reply?:{id,senderName,snippet,type}, forwardFrom?, edited, pinned, reactions:[{emoji,count,me}], createdAt }` — **no `readBy` map, no full reply doc**.
  - `GET /channels/:id/state` → `{ pinnedMessageIds, myLastReadMessageId, unreadMentionIds }`.
- **API:** above + `POST /channels/:id/messages`, `PATCH/DELETE /messages/:id`, `POST /messages/:id/reactions`, `POST /channels/:id/read`.
- **Realtime:** `message:new|updated|deleted`, `reaction:changed`, `read:updated`, `typing`, `presence:changed`, `channel:roles`, `wallpaper:updated`.
- **Components:** `<ChatHeader>`, `<PinnedStrip>`, `<MessageFeed>` (virtualized) → `<MessageItem>` (per-type sub-components), `<Composer>` (text | media | voice | pickers lazy), `<RightPanel>` (info | members | search | media — sheet on mobile).
- **Loading:** header skeleton + 8 bubble skeletons. **Empty:** kind-specific ("Say hi 👋" / "No messages in this channel yet"). **Error:** full-pane retry.
- **Mobile:** full screen, panels as bottom sheets, composer pinned above keyboard (visualViewport). **Desktop:** reading pane + optional right panel.
- **Keyboard:** `↑` edit last own message, `Esc` cancel reply/edit, `Ctrl/Cmd+K` search, `r` reply on hovered message.
- **Permissions:** membership; channel non-admins get a read-only composer with a clear reason.
- **Perf:** virtualized feed; keyset pagination; memoized items; delta socket patches; media `srcset` + blurhash placeholder.

#### `/app/new` — Start a conversation (sheet)
- Tabs: **Direct** (user search → start DM), **Group** (name, photo, members), **Channel** (name, @handle, photo, description, members), **Discover** (public channel search → preview/join).
- One user-search component shared across tabs.
- **API:** `GET /users/search` (narrowed), `POST /channels`, `POST /channels/:id/members` **[NEW endpoint]**, `GET /channels/discover?q=`, `POST /channels/:id/join`.
- **Fixes the broken group member-add.**

#### `/app/settings/security` — Security & devices
- Change password; **Active sessions list** (device, last active, this device) with per-session revoke + "sign out all". Needs a `sessions` collection or refresh-token store.

---

## Panels vs routes decision table

| Functionality | Route? | Surface |
|---|---|---|
| Conversation list | yes | `/app` |
| Conversation | yes | `/app/c/:id` |
| Start conversation | yes (deep-link) | `/app/new` sheet |
| Settings pages | yes | `/app/settings/*` |
| Message deep-link | query param | `/app/c/:id?m=` |
| Chat info / description | no | right panel / sheet |
| Members & roles management | no | right panel / sheet |
| In-chat search + date jump | no | overlay in header |
| Media gallery | no | right panel tab |
| Wallpaper (per-chat) | no | sheet from chat menu → shares editor with global |
| Emoji / GIF / sticker picker | no | composer popover / sheet |
| New GIF / new sticker pack | no | sheet within the picker |
| Forward picker | no | dialog |
| Call UI | no | global overlay (already is) |
| Blocked users | yes | `/app/settings/privacy` |

**Rule:** create a page only when the user needs to *navigate to* it, *link to* it, or *return to*
it. Otherwise it's contextual UI within the conversation or list.
