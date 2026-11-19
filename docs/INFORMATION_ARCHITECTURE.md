# Information Architecture

Goal: *"Can the user tell where they are and what they can do within a few seconds?"*

## Current IA (as-is)

```
Bottom nav (mobile) / sidebar nav (desktop):
  Chats      → list → conversation
  Contacts   → user search + DM list          ← overlaps Chats
  Profile    → account / appearance / notifications / security / logout
              ├ Edit profile
              ├ Change password
              └ Chat background (global wallpaper)

Inside a conversation (no nav): header menu → info / edit / members / admins /
  banned / search / wallpaper / leave / delete ; pinned bar ; composer with
  emoji/gif/sticker/media/voice ; call button.

Orphan routes: /chats/new, /chats/search, /chats/gifs/new, /chats/stickers/new
```

### Problems
- **3 top-level destinations, 2 of which ("Contacts", parts of "Profile") overlap "Chats".**
- "Contacts" is not a mental model users of a family chat hold — they think in *conversations*.
- Discovery (`/chats/search`) is hidden; creating a group/channel is a separate route reached from a FAB.
- Settings is one long scroll with no map.
- No global search (people + messages + chats in one place).
- Per-chat vs global wallpaper live in different places with no connection.

## Target IA

```
Primary navigation (2 items, mobile bottom bar / desktop rail):
  1. Chats        the conversation list  (DMs + groups + channels + Saved Messages, unified)
  2. Settings     grouped preferences

  (+ a persistent "New" affordance and a global Search field at the top of Chats)

Chats (list)
  ├ Search field           → people, channels to discover, and messages (scoped tabs)
  ├ Filter chips           All · Unread · Groups · Channels · (Pinned float to top)
  ├ New ▾                  Direct · Group · Channel · Discover
  └ rows → Conversation

Conversation
  ├ Header                 avatar + title + presence/"last seen" or member count
  │   └ ⋯ menu             View info · Search in chat · Media · Mute · Wallpaper ·
  │                        Manage members (admin) · Leave · Delete (owner)
  ├ Pinned strip           (collapsible)
  ├ Message feed
  ├ Right panel (desktop) / bottom sheet (mobile):
  │   Info · Members & roles · Shared media · Search results
  └ Composer               text · @mention · emoji · GIF · sticker · attach · voice
      └ Call                (audio) — global overlay

Settings
  ├ Profile                name, username, bio, photos
  ├ Appearance             theme, big emojis, quick reaction, message text size
  ├ Notifications          push, sounds, per-type toggles, install prompt (iOS)
  ├ Privacy                blocked users, who can see my last seen, read receipts
  ├ Wallpaper              global chat background (shares editor with per-chat)
  ├ Security               password, active sessions/devices
  └ About / Log out
```

### Rationale
- **Two destinations.** Everything a user does daily is "open a conversation". Settings is the
  only other place you *go*. Contacts/discovery/creation become actions, not destinations.
- **Unified list.** DMs, groups, channels, and Saved Messages in one ordered list with filter
  chips. No "Contacts" tab — a DM *is* a conversation.
- **Global search at the top of Chats** with tabs (Messages · People · Discover) replaces
  `/contacts`, `/chats/search`, and the add-contact modal.
- **Conversation is self-contained.** Every chat-scoped action is in the header menu → panel/sheet,
  never a separate route (except `?m=` deep links).
- **Settings has a visible map** (7 labelled groups), each a short page.

### Navigation model by breakpoint
| | Mobile (<768) | Tablet (768–1024) | Desktop (>1024) |
|---|---|---|---|
| Nav | bottom bar (Chats, Settings) | bottom bar OR left rail | left rail (64px icons) |
| List ↔ Conversation | stacked; conversation is a full screen; back button | list rail (280px) + conversation | list rail (320px) + conversation + optional right panel (320px) |
| Panels (info/members/search/media) | bottom sheet | bottom sheet or right drawer | right panel (persistent toggle) |
| New / Discover | full-screen page | sheet | centered dialog |
| Call | full-screen overlay, minimisable to a pill | overlay | overlay / pip |

### Wayfinding rules
- The header always answers "which conversation" (avatar + name + status line).
- The list row always answers "who / what / when / how many unread".
- One back gesture always goes list ← conversation ← panel.
- Filter/search state is reflected in the URL where it aids return (`?filter=unread`, `?q=`).
- No more than **one** modal layer at a time (the overlay context already tracks depth — enforce max 1 for dialogs, sheets can stack to 2).
