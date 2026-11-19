# Backend Features & Data — reference for AI-assisted frontend design

Source of truth: `chat-app/backend` (NestJS/MongoDB/Socket.IO), phases B0–B12, **complete**. This
document translates that backend into product-language features and the data each screen has
available, for handing to a design tool (Figma AI, v0, a generative UI tool, or Claude itself) —
it is deliberately not an API reference. For exact routes/DTOs see `chat-app/backend/README.md`
and `chat-app/backend/docs/REALTIME.md`; for the frontend's own verified notes on quirks and what's
already wired up, see `docs/plans/FRONTEND_PLAN.md`.

**Already have a design pass:** `chat-app/frontend-design/` has 9 design-canvas artboards (Login,
desktop Main, MobileList, MobileChat, NewConversation sheet, Settings, Primitives, ChatInfo,
CommandPalette) covering the core conversation-first flows, and `chat-app/frontend/` is a real
Next.js app already wired to this backend for auth/chat-list/conversation/reactions/edit/delete/
pin/read-receipts. This document (and its companion, `FRONTEND_PAGES_AND_NAVIGATION.md`) exists to
brief a **new or extended** design pass — most usefully for the areas the canvas doesn't cover yet:
calls, GIFs/stickers/wallpaper, contacts/folders, notifications, reporting, and the separate admin
panel.

---

## 1. Identity, accounts & sessions

**Register** — username, email, password, optional first/last name, optional phone number. Returns
an access token (15 min) + refresh token immediately (no email verification step exists).

**Login** — email *or* phone number + password. 5 wrong passwords locks the account for 15 minutes
(shown as a distinct error from "wrong password"). A suspended account (see Moderation) is blocked
here with a specific reason.

**Session model** — short-lived access token + a rotating refresh token; refreshing invalidates the
old refresh token, and presenting an already-used one revokes every session sharing its lineage
(a real "someone's replaying a stolen token" signal). A user can list their own active sessions
(rough device label, IP, last-used time) and revoke one or all of them ("log out everywhere").

**Password change** — while logged in: current password + new password.

**Password recovery (no self-service reset)** — a user submits an identifier (email/phone/
username); this creates a pending request an **admin** must approve. Approval mints a one-time
link (expires in 45 minutes) the admin sends the user out-of-band (email/SMS/support chat — the
app doesn't send it). Opening the link lets them set a new password once; it's dead after use or
expiry. Design implication: the "Forgot password" screen can only ever say "request sent," never
promise an emailed reset link.

**Account deletion** — self-service, requires re-entering the current password. Deletes the
person's group/channel memberships, blocks, and owned clips/sticker-packs/wallpapers; anonymizes
their profile (name/username become "Deleted User") rather than deleting message history (so old
conversations don't leave holes). Every session is revoked immediately.

**Data available for "my profile" / "account" screens:** username, first name, last name, avatar
(array of image URLs — the UI picks one, e.g. most-recent-first), bio, email, phone number, "big
emojis" toggle (render emoji-only messages larger), quick-reaction emoji (the one-tap reaction
default), notification level (`all` / `mentions` / `none`), last-seen timestamp.

---

## 2. Admin identities (separate from regular users)

A completely separate account type, never reachable by promoting a regular user. Created only via
a server-side script (no self-registration, no UI signup). **Every admin login requires a
password AND a TOTP code** (Google Authenticator-style) — no exceptions, no "remember this
device." Roles exist (`AdminRole`) for future differentiation but the panel today doesn't yet
branch UI by role. This implies a **separate login screen** (email + password + 6-digit code) and
a **completely separate app shell** from the regular user app — should not share nav chrome, and
should probably live at a distinct path/subdomain.

---

## 3. Contacts (address book)

Add a contact one of four ways: by user id (from an existing profile view — "Add contact" button,
no lookup needed), by exact phone number, by exact username, or by exact email (rate-limited,
10/min — this is the "someone could brute-force emails" guard, so the UI shouldn't retry silently
on failure). No fuzzy/partial matching on phone or email, by design — you must already know the
exact value.

Each contact can have a custom display name (overrides their real name in your view only).

**Contact list data:** the contact's public profile (avatar, name, username, bio), your custom
name for them if set, their live online/offline presence, whether you already have a DM with them
and its last message/timestamp (so the contacts screen can double as "start or resume chatting"),
and when you added them.

**Mutual-contact reveal:** a user's phone number and email are hidden on their profile *unless*
you've added each other as contacts (one-sided doesn't count). Design implication: a profile view
needs two states — "contact info hidden" vs. "contact info visible" — and this can't be predicted
client-side, it comes from the API response shape (the fields are simply absent when hidden).

---

## 4. Chats, channels & groups

Four chat types: **private** (1:1 DM), **group**, **channel** (broadcast-style — only admins/owner
can post; regular members are read-only), **saved messages** (a personal notes-to-self chat, one
per user, auto-created on first visit).

**Roles within a chat:** owner, admin, member (owner/admin can manage membership, ban, mute,
lock/tag; plain members cannot). A channel additionally restricts *posting* to admins/owner only,
regardless of ban status.

**Per-chat, per-member state:** pinned (shown at top of your own chat list), muted (no
notifications), banned (removed access, group/channel only — never applies to a private chat),
admin-muted (silenced by a moderator specifically, distinct from your own mute), joined/left,
last-read message pointer + timestamp (drives unread counts and read receipts), a hidden-after
timestamp (if you "cleared" the chat, old messages before that point don't reappear), and optional
per-chat wallpaper overrides (blur/dim/brightness on top of whatever wallpaper is applied).

**Chat-level fields:** invite link/slug, type, name, description, up to several image URLs
(gallery, not just one avatar), tags (free-form labels an admin sets, used by folder filters — see
below), locked (admin-only, blocks all new messages platform-wide for that channel), and a derived
admins list.

**A denormalized summary per chat** (what the chat-list screen actually renders, one row per
chat, no extra fetches needed): chat id, type, name, images, invite link, your role, your
pinned/muted state, your last-read pointer, the most recent message's timestamp + a short text
preview, member count (group/channel only), and — for private chats only — the other person's
public profile inline (so a DM row can show their live name/avatar without a second lookup).

**Actions available:** create (DM/group/channel), rename/re-describe/re-image, add members, list
members, ban/unban a member, mute/unmute a member (admin action) vs. mute the chat for yourself,
pin/unpin for yourself, set tags, list banned users, preview a chat before joining (via its invite
link, without exposing the full member/ban list), leave, delete (owner only).

**Folders** (Telegram-style saved filters, not literal chat categories): a folder has a name, a
display order, and a filter spec — include specific chat types, include/exclude specific tags,
include/exclude specific chat ids by hand, and an "only show chats with unread messages" toggle.
The chat list applies whichever folder is selected as a server-side filter (not client-side, so it
scales). Design implication: folders render as tabs/chips above the chat list; a settings screen
manages the folder definitions themselves.

---

## 5. Messages

**Types:** text, image, file, voice (with duration + a waveform array of 0–1 samples for
rendering), video, gif, sticker, system (join/leave/rename notices, call log lines), voice_call
(a special system message logging a completed/missed/declined call).

**Per-message data:** sender (public profile), content (text, or a caption/URL depending on type),
attachments (array of media URLs), reply-to (a lightweight snapshot captured at send time — sender
name, a short preview snippet, message type — so rendering a reply never needs a second fetch),
forward-from (a display-only snapshot of the original sender, no link back to their account),
edited flag, pinned flag, mentions (array of user ids), reactions (see below), and standard
timestamps.

**Sending constraints the UI should reflect:** content is required unless attachments are present;
content is capped (a few thousand characters); control characters are stripped server-side; a
message can't be sent into a locked channel, by a muted-by-admin member, or by a non-admin into a
channel (channels are broadcast-only for regular members).

**Editing/deleting:** only your own messages can be edited; an edit that becomes empty after
sanitizing is rejected. Delete has two distinct actions — "delete for me only" (just disappears
from your view) vs. "delete for everyone" (allowed for the author, or any member of a private
chat, or an admin/owner in a group/channel).

**Reactions:** an emoji reaction toggles on tap (add if you hadn't reacted with that emoji, remove
if you had); a message caps at 20 distinct emojis to keep the reaction bar from growing unbounded.
Reaction data per message: a list of `{emoji, count, didIViewerReactWithThis}`.

**Read receipts:** every member has a single "last read message" pointer per chat (not a per-
message read map) — read state is derived from comparing message timestamps against that pointer.
"Seen by" (who specifically has read a given message) is available **only to the message's own
author**, and only in DMs/groups — never in channels (member lists can be too large for it to be
meaningful there).

**Mentions:** `@username` in message text is parsed server-side into a resolved user-id list
(only users who are actual members of that chat can be mentioned); replying to someone also
counts as mentioning them for unread-mention purposes.

**History & navigation data available:** paginated message history (newest-first), "jump to first
message on a given date" / "jump to nearest message from a given date onward" / "jump to the
oldest message in the chat" (three distinct date-navigation queries — useful for a calendar/
scrubber jump feature), pinned-messages list, unread count, unread-mentions list + count, and
unread-messages-with-reactions list + count (three separate "things needing my attention" signals
a chat-list or chat-header badge system could surface independently).

**Search inside one chat:** free-text `content` match, or literally `@` to mean "just my
mentions" — returns matching message ids + a total count, for a search-results strip with
prev/next navigation.

---

## 6. Realtime behavior (Socket.IO)

The app maintains one live socket connection per session. Everything below is instant, no polling.

- **New message delivery**, **message edited**, **message deleted**, **reaction added/removed**
  (as a small delta, not the whole message — efficient for a busy reaction bar), **read-receipt
  tick updates** (so a sender's checkmarks update live when the recipient reads).
- **Typing indicator** — "X is typing…" with automatic timeout if the other side goes quiet
  without explicitly stopping.
- **Uploading indicator** — a distinct "attaching a file…" state, separate from typing.
- **Presence** — online/offline, broadcast to people who share a chat with you (not
  everyone platform-wide).
- **New-chat notification** — when someone starts a DM with you, it appears live without a
  refresh.
- **Moderation pushes** — you were banned from a chat, you were muted in a chat, a channel's
  admin list changed — all live, so UI (e.g., a disabled composer) updates without a reload.
- **Call signaling** — you're being rung, a call ended, you missed a call (see §7).
- **Reconnect gap recovery** — a client can ask "what did I miss since message X in this chat" on
  reconnect instead of refetching full history.

---

## 7. Calls (audio, LiveKit-backed)

Start a call in any chat you're a member of. **Private chat** → rings just the other person.
**Group/channel** → rings every other currently-joined member (capped at 16 concurrent
participants). Only one call can be active per chat at a time. Joining returns everything a
client-side call SDK needs (room name, a scoped short-lived join token, the media-server URL).

Ending semantics: a private call ends the instant *either* side leaves; a group call ends once
*everyone* has left (so one person leaving a group call doesn't kill it for the rest). A ringing
private call can be explicitly declined before ever joining. Every call, once finished, leaves
exactly one system message in the chat's history summarizing the outcome (missed / declined /
ended, with duration for a completed call) — this is what a "call log" UI element renders from,
no separate call-history endpoint exists.

**Design implication:** needs an incoming-call modal/banner (with accept/decline), an active-call
view (participant tiles), and a "minimize while browsing the rest of the app" affordance, since
calls aren't tied to staying on one screen.

---

## 8. Media pipeline (shared by everything below)

Every image/video that gets uploaded — chat attachments, avatars, GIFs, stickers, wallpapers —
goes through one pipeline: content-type is verified by inspecting the actual file bytes (never
trusts a filename extension), duplicate uploads dedupe by content hash (upload the same file
twice, get the same stored asset back), images get web-sized + thumbnail variants plus a blurhash
placeholder (for a blur-up loading state), and location/EXIF metadata is stripped from everything
stored, including "the original." Video gets transcoded/compressed server-side with a duration
limit and a size cap. Byte-range requests are supported (so video seeking / scrubbing works
without downloading the whole file).

**Design implication:** any image-displaying component should support a blurhash placeholder →
thumbnail → full-size progressive-load pattern; video players can seek freely.

---

## 9. GIFs & personal clips

Two distinct concepts, worth designing as two tabs in one picker:

- **"Mine"** — a personal library of GIF-like clips you've saved (`title`, `usageCount`,
  `lastUsedAt`), sourced by uploading a short video (server converts it to a GIF) or reusing a
  Giphy result. List, use (bumps usage stats — powers a "recently used" sort), delete.
- **"Global"** — search or browse trending GIFs from Giphy directly (third-party content;
  attribution to Giphy is a ToS requirement, not optional). First use of any given Giphy GIF
  caches it into the app's own storage; subsequent uses are instant.

---

## 10. Stickers

**Sticker packs** — a pack has a name, optional description, tags, an owner, and a public/private
flag. A pack contains individual stickers (each just an image asset with its own usage count).
Anyone can create a pack and upload stickers to it (real image upload, not a URL paste); public
packs are discoverable by other users via search; private packs are yours only.

Separately, a **"Global" Giphy stickers tab** (same trending/search/first-use-caches-it pattern as
GIFs above) exists alongside personal packs — same two-tab picker shape as the GIF picker.

**Design implication:** the sticker picker needs "your packs," "public packs" (search), and
"Global" (Giphy) as distinct sections/tabs, plus a "create a pack" flow with drag-and-drop/multi-
image upload.

---

## 11. Wallpaper

Two independent scopes: a **global** wallpaper (your default background across every chat that
doesn't override it) and a **per-chat** wallpaper (overrides the global one for just that
conversation). Either can be an image or a video, with adjustable blur, dim, brightness, a fit
mode (cover/contain/etc.), parallax on/off, and — for video — a start offset and whether it loops
for a set duration. A per-chat wallpaper set by one member can be **shared**: the other member(s)
see it as a pending wallpaper they can accept (applying it to their own view) or ignore.

**Resolution order the UI should mirror:** per-chat override → global default → app's built-in
default. There's a dedicated endpoint that returns exactly this already-resolved wallpaper, so a
conversation screen never has to compute the fallback chain itself.

---

## 12. Notifications

**Push (mobile/Android only — no iOS support by design):** a device registers/unregisters an FCM
token. The server decides whether to actually push: skips it if you already have that chat open
(live socket presence check), respects your per-chat mute and your global notification level
(`all` / `mentions` / `none`).

**Web is foreground-only** — no browser push notifications, no service worker. While a tab is
open, new messages/mentions/incoming calls should surface as an in-app toast (respecting the same
mute/level rules) plus an unread counter in the tab title when the tab isn't focused. This is a
deliberate product decision, not a gap — the web settings screen should say so explicitly rather
than offering a "enable notifications" permission prompt that doesn't do anything.

---

## 13. Search

One unified search with three scopes, each with different privacy rules the UI should trust
blindly (never second-guess or try to "helpfully" show more):

- **People** — matches username/first/last name only. Never matches or returns email/phone.
- **Channels** — matches group/channel name + description. Never returns private DMs or your
  Saved Messages.
- **Messages** — scoped to chats you're actually a member of; returns a short snippet + which chat
  it's in, for a "jump to this message" result.

Minimum 2-character query. Separate from this: a **per-chat** search (see §5) for searching inside
one specific conversation's history.

---

## 14. Reporting & moderation (user-facing side)

Any user can report a message, another user, or a channel, with a reason and optional free-text
note. Duplicate reports (same reporter, same target) are rejected with a friendly "you already
reported this" rather than silently no-op'ing.

**What a reported/moderated user experiences, client-side:**
- **Suspended** — blocked at login with a specific message, and (if already logged in) their very
  next API call also fails — the UI needs a dedicated "your account is suspended" screen/state,
  not a generic error toast, since it can appear mid-session.
- **Warned** — receives what looks like a completely normal DM (from a "Moderation" system
  account) — no special UI needed beyond rendering it like any other message.
- **A message hard-hidden by a moderator** — the message simply stops appearing in history for
  everyone (content is scrubbed, not just flagged), same as if it were never sent.
- **A channel locked** — composer should disable with a specific "this channel is locked" reason,
  distinct from "you're muted" or "you're banned."

---

## 15. Admin panel data (separate surface, MFA-gated — see §2)

- **Recovery-request queue** — list pending password-recovery requests; approve (generates the
  one-time reset link to hand the user) or deny.
- **Report queue** — list/filter by status and target type; assign/resolve with a short
  action note.
- **Moderation actions**, each logged to a permanent audit trail (who did what, to what, when):
  suspend a user (optionally time-boxed, or indefinite) / unsuspend, send a warning DM, hard-hide
  a message, lock/unlock a channel, remove a member from a channel (bypasses normal permission
  checks — a platform-level action).
- **Media housekeeping** — a list of orphaned media (nothing references it anymore, kept as an
  archive, never auto-deleted) with a manual hard-delete action per item.

This is a small, function-first internal tool, not a consumer-grade admin dashboard — a table +
filters + a detail/action panel pattern is appropriate; it does not need the visual polish of the
main app.

---

## Roles & permission summary (for gating UI affordances)

| Action | Who |
|---|---|
| Post in a channel | admin/owner only; any member in a group/DM |
| Ban/mute a member, set tags, view banned list | admin/owner |
| Rename/re-describe/delete a chat | owner (delete); admin/owner (rename/describe) |
| Delete "for everyone" | message author; any member (private chat); admin/owner (group/channel) |
| Edit a message | author only |
| See "seen by" on a message | that message's author only |
| Lock/unlock a channel, suspend/warn a user, resolve reports, hard-delete media | admin panel only (separate MFA-gated identity, not a regular user role) |

---

## Explicitly not built (don't design for these)

- iOS push notifications, browser push notifications/service workers.
- Self-service password reset (always admin-mediated).
- Video calls (audio only today — the call data model is video-ready, but no video UI exists to
  design against yet).
- Per-endpoint keyset pagination on several list endpoints (clips, chat search, message search
  results, sticker search, reports) — they're offset-based; a "load more" button is safer to
  design than infinite-scroll-with-a-cursor for those specific lists.
- A live "who's typing across the whole app" or cross-device notification badge sync beyond what's
  listed above.
