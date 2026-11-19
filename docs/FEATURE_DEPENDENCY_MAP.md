# Feature Dependency Map

Derived from module imports, injected models/services, and frontend call graphs.

## Core chain

```
Auth (JWT + tokenVersion)
  └─> User (profile, presence, block, prefs)
        └─> Channel  (chat + chatmembers: private / group / channel / saved)
              ├─> Membership (role, pin, mute, read pointer, per-chat wallpaper)
              └─> Message (text/media/voice/gif/sticker/system/call-log)
                    ├─> Attachments  ─> Upload (dedupe)  [+ Gif conversion, Wallpaper media]
                    ├─> Reactions ─> EmojiUsage
                    ├─> Mentions ─> Membership (filter) ─> Notifications (client)
                    ├─> Reply / Forward ─> Message (self-ref)
                    └─> Read receipts ─> Membership + Message.readBy
Realtime Gateway  ⇄  (Message, User, Channel, Auth, Wallpaper)   ← hub
Calls (in-memory)  ─> Gateway + Message (call-log) + external call-room page (UNKNOWN)
Wallpaper  ─> User + Membership + Message(system) + Upload + Gateway
GIF / Sticker  ─> Upload + AppSettings(gif) ; otherwise standalone
ConfigLog  ─> Channel + Message + User + Gateway   (unauthenticated entry)
```

## Coupling classification

### Strongly coupled (change one → change the other)
- **Channel ⇄ Membership** — every feature reads `chatmembers`; `chat.admins[]` mirrors `chatmembers.role`.
- **Message ⇄ Gateway** — `MessageController` and `MessageService`-adjacent code call `ChatGateway` directly; gateway calls `MessageService.create` for call logs and `markAsRead`.
- **Gateway ⇄ Auth ⇄ User** — connection auth re-implements `JwtStrategy` logic.
- **Wallpaper ⇄ Membership ⇄ Message(system)** — applying a wallpaper writes membership columns AND posts a system message AND emits WS.
- **Presence ⇄ User doc** — `isOnline`/`lastSeen` persisted; gateway owns it.
- **Read receipts ⇄ Message.readBy ⇄ Membership.lastReadMessageId** — two stores for one fact.

### Weakly coupled (safe to change/remove in isolation)
- **GIF**, **Sticker**, **EmojiUsage**, **AppSettings**, **Wallpaper** (feature-flag-able).
- **Calls** — bolted onto the gateway; removable without touching messaging (leaves call-log message type unused).
- **ConfigLog** — entirely removable.

### Duplicated logic (same behaviour, multiple implementations)
| Logic | Copies |
|---|---|
| membership + ban + not-deleted guard | `MessageService` ×5 full + ×2 partial |
| SHA-256 dedupe upload | `UploadController`, `GifService`, `WallpaperService` |
| absolute `buildUrl(req, filename)` | ×3 |
| ffmpeg path resolution | ×2 |
| admin/owner role check | chat, message, sticker services |
| "resolve display name for private chat" | `chat.service.findUserJoinedChatsWithDisplay`, `getChatDisplayName`, `findChatByIdForPreview` |
| mute-map / notification decision | `app-shell.tsx`, `chat-list.tsx` |
| upload-with-progress XHR | `api.ts` ×3 |

### Hidden dependencies
- `GET /chats/my-chats` **creates** a Saved Messages chat as a side effect (`findOrCreateSavedMessages`).
- `GET /chats/direct/:id` **emits WS** `new_chat` to both users.
- `POST /messages` (private) **auto-rejoins** the other member if they'd left.
- `message.service.create` **writes `emoji_usage`** for every emoji in the text.
- `JwtStrategy.validate` **reads the DB** on every request.
- `AppSettingsService.onModuleInit` **upserts** a doc on boot.
- `ConfigLogService` **creates a user and a channel** on first call.

### Circular dependencies (resolved with `forwardRef`)
- `Auth ↔ User`
- `Gateway ↔ Auth`, `Gateway ↔ User`, `Gateway ↔ Chat`, `Gateway ↔ Message`, `Gateway ↔ Wallpaper`
- `Message ↔ Gateway`

The gateway participates in **6** cycles. This is the #1 structural smell — it is imported by
the domain and imports the domain.

### Unnecessary dependencies
- `ChatModule` imports `Message` model only for `delete()` cascade and `my-chats` aggregation — could be an event.
- `WallpaperModule` imports `UploadRecord`, `Chat`, `Message`, `User`, `ChatMembers` — 5 models for a cosmetic feature.
- `ConfigLogModule` imports 4 models + gateway.
- `StickerModule` imports `ChatMembers` only for the dead `createFromMessage`.

## Recommended decoupling

1. **Gateway becomes transport-only.** Domain services emit `EventEmitter2` events
   (`message.created`, `message.updated`, `reaction.changed`, `read.updated`, `presence.changed`,
   `channel.roles.changed`, `wallpaper.updated`). A single `realtime` module subscribes and fans out.
   Removes all 6 gateway cycles.
2. **`chatmembers.role` is the only role store.** Delete `chat.admins[]`.
3. **One `MembershipGuard` / `ChannelContext`** replaces the copy-pasted guard.
4. **One `MediaService`** (dedupe + resize + thumbnail + blurhash + relative URLs) replaces 3 copies.
5. **Read state = per-membership pointer only**; ticks derived from `lastReadAt` timestamps.
6. **Calls, GIFs, Stickers, Wallpaper, ConfigLog behind feature flags** so they can be disabled or removed without touching core.
