# Database Audit (MongoDB / Mongoose)

Connection: `MongooseModule.forRootAsync` → `DATABASE_URL` (default `mongodb://127.0.0.1:27017/legacy-chat`).
No transactions, no change streams, no migrations framework. Schema evolution is implicit
(`markAsRead` contains a legacy-data guard for `readBy` stored as array vs object → past churn).

## Collections

| Collection | Schema file | Docs grow with |
|---|---|---|
| `user` | `user/schema/user.schema.ts` | users |
| `blocks` | `user/schema/block.schema.ts` | block relations |
| `chats` | `chat/schema/chat.schema.ts` | chats (incl. 1 per user for Saved Messages, 1 per DM pair) |
| `chatmembers` (`ChatMembers`, default collection name `chatmembers`) | `chat/schema/chat-members.schema.ts` | memberships |
| `messages` | `message/schema/message.schema.ts` | **messages — unbounded, never purged** |
| `user_gifs` | `gif/schema/user-gif.schema.ts` | GIF uploads (1 row per user per gif) |
| `sticker_packs` | `sticker/schema/sticker-pack.schema.ts` | sticker packs |
| `emoji_usage` | `emoji-usage/schema/emoji-usage.schema.ts` | (userId, kind, emoji) tuples — **write on every message** |
| `upload_records` | `upload/schema/upload-record.schema.ts` | unique file hashes |
| `wallpapers` | `wallpaper/schema/wallpaper.schema.ts` | **1 new doc per "apply" — unbounded** |
| `app_settings` | `app-settings/schema/app-settings.schema.ts` | 1 doc, ever |

---

## `user`

```
firstName, lastName, username (lc/trim), email (lc/trim), password (bcrypt),
lastSeen: Date, image: string[], phoneNumber: string, bio: string,
isDeleted: bool, bigEmojis: bool (default true), quickReaction: string (default 👍),
isOnline: bool, tokenVersion: number, globalWallpaperId: ObjectId|null
timestamps
```
Indexes: `email` unique sparse, `username` unique sparse, `phoneNumber` sparse, `isDeleted`.

Problems:
- **`image` vs `avatarUrl`**: schema field is `image`; `UpdateUserDto` sends `image`; frontend
  `UserPublic` + several backend `.select("... avatarUrl ...")` use `avatarUrl`. `chat.service`
  reads `otherUser.avatarUrl?.[0]` from a projection that selected `avatarUrl` — **always
  `undefined`** because the stored field is `image`. Rename to one name.
- **`isOnline` in the DB** — mutated on every socket connect/disconnect; belongs in memory/Redis.
- **`lastSeen` default `new Date()`** is evaluated **once at schema load** (`default: new Date()`),
  not per-doc — every user created in the same process boot gets the same default `lastSeen`.
- `email`/`username`/`phoneNumber` all queryable by substring via `/users/search` → enumeration.
- No `role` (global), no `createdAt`-based retention, no `deletedAt`.
- `quickReaction` `required: true` with a default — fine, but stored per user for a client preference.

Derivable / removable:
- `isOnline` → derive from presence service.
- `bigEmojis`, `quickReaction` → client preferences; could live in a `user_prefs` doc or `localStorage` synced.

---

## `blocks`

`blockerId`, `blockedId`, timestamps. Indexes: `{blockerId,blockedId}` unique, `{blockedId}`.
Fine. Only consumed by the WS `new_message` filter + profile-read guard (under-enforced — see FEATURE_INVENTORY).

---

## `chats`

```
link, type (channel|group|private|saved_messages), name,
admins: ObjectId[]  ← duplicates chatmembers.role
isDeleted, description, image: string[], tags: string[],
banned: ObjectId[]  ← scanned linearly on nearly every message/history/preview call
timestamps, versionKey:false, toJSON strips isDeleted
```
Indexes: `link` unique sparse, `type`, text `{name, description}`, `tags`, `isDeleted`.

Problems:
- **`admins` array duplicates `chatmembers.role`** — two sources of truth, sync loop in `update()`.
- **`banned` array** — unbounded, `O(n)` `.some()` scan in ~8 code paths; no index benefit. Should be
  a flag on `chatmembers` (`isBanned` already exists!) or a `chat_bans` collection with `{channelId,userId}` index.
- Text index on `{name, description}` exists but **search uses `$regex`, not `$text`** → index unused.
- No `lastMessageAt` / `lastMessagePreview` denormalised → `my-chats` recomputes via aggregation + N+1.
- No `memberCount` denormalised → recomputed via aggregation.
- `name` for private chats is the literal `"Private"`; `name` for Saved Messages `"Saved Messages"` — display name recomputed per request.
- `image: string[]` — array for a single chat avatar.

---

## `chatmembers`

```
channelId: string  ← string, not ObjectId ref (mismatch with chats._id)
userId: string     ← string, not ObjectId ref
role: UserRole
lastReadMessageId: string|null, lastReadAt: Date|null,
isPinned, isMuted, isBanned, mutedByAdmin, isJoined (default true),
chatWallpaperId: ObjectId|null, wallpaperBlur|Dim|Brightness: number|null
timestamps
```
Indexes: **NONE declared.** Mongoose adds `_id` only.

Problems:
- **No index on `(channelId, userId)`** — this is the single most-queried pattern in the whole app
  (`chatMembers.findOne({channelId, userId})` appears dozens of times). Every membership check is a
  **collection scan**.
- **No unique constraint on `(channelId, userId)`** — many `findOne`-then-`create` paths → duplicate
  memberships under concurrency (member count inflation, double role rows).
- `channelId` / `userId` stored as **strings**, not `ObjectId` refs → no `populate`, manual `new Types.ObjectId(id)` casts everywhere, and joins done in application code.
- Wallpaper visual overrides (`wallpaperBlur/Dim/Brightness`) duplicate the `Wallpaper` doc's fields.
- `isBanned` field exists but ban logic uses `chat.banned[]` instead — dead-ish field.

Required indexes (P0):
```js
ChatMembersSchema.index({ channelId: 1, userId: 1 }, { unique: true });
ChatMembersSchema.index({ userId: 1, isJoined: 1 });        // my-chats
ChatMembersSchema.index({ channelId: 1, role: 1 });          // admin lists
```

---

## `messages`

```
channelId: string, senderId: ObjectId ref User,
content: string (required unless attachments non-empty),
forwardFrom: { userId, name, image? } | null   ← service writes `.avatarUrl`, schema has `.image` → lost
type: MessageType (default text),
attachments: string[], replyTo: ObjectId ref Message | null,
isEdited, isDeleted,
reactions: Map<emoji, string[]>   ← unindexable; needs $objectToArray for "has reactions"
isPinned,
readBy: Map<userId, Date>         ← grows to O(members) per message; shipped in full to clients
mentions: string[],
deletedFor: ObjectId[]            ← grows unbounded on private-chat unsubscribe
metadata: object | null           ← system-message payload (wallpaper share)
createdAt, updatedAt (also @Prop'd AND timestamps:true → double)
```
Indexes: `{channelId, createdAt:-1}`, `{senderId}`, `{isDeleted}`, `{channelId, isPinned}`, `{channelId, mentions, createdAt}`.

Problems:
- **`duration` (voice) is in the DTO but not the schema** → dropped.
- **`readBy` as a Map** — O(members) sub-keys per message; every `markAsRead` writes N of these across history; returned to every client in full (privacy + payload).
- **`reactions` as a Map** — cannot index "messages with any reaction"; `getUnreadReactions` uses an `$expr` collection scan.
- **`deletedFor` unbounded** — private-chat `unsubscribe` does `updateMany($addToSet deletedFor)` over the entire channel history.
- **No purge / retention** — `isDeleted` soft-deletes accumulate forever; deleting a chat only flips flags.
- `content` `required` function checks `this.attachments` — but `system`/`voice_call` messages sometimes have neither (call logs put JSON in `content`, ok).
- `createdAt`/`updatedAt` declared as `@Prop` **and** via `timestamps: true` — redundant; the `@Prop({default: Date.now})` can fight the timestamp plugin.
- `channelId` string (not ref) — consistent with `chatmembers` but blocks populate-based joins.
- No index for `deletedFor` exclusion or `type` filtering (channels exclude `system`).

Recommended:
- Move `readBy` → a `message_reads` collection **or** collapse to a per-membership `lastReadMessageId` + a lightweight `deliveredCount/readCount` on the message; compute per-user tick from `lastReadAt` timestamps.
- Move `reactions` → `message_reactions` `{messageId, emoji, userId}` with `{messageId}` and `{messageId, userId}` indexes; or keep the Map but add a boolean `hasReactions` for querying.
- Add `duration`, `originalFilename`, and a normalised `attachments: {url, kind, w?, h?, size?, blurhash?, durationSec?}[]`.
- TTL / archival job for `isDeleted` + very old messages (`REQUIRES PRODUCT DECISION` on retention).

---

## `user_gifs`

```
userId: ObjectId, url, preview?, title?, filename?, isPublic (default true),
inLibrary (default true), usageCount, lastUsedAt
```
Indexes: `{userId, inLibrary, lastUsedAt:-1, createdAt:-1}`, `{isPublic, lastUsedAt:-1, usageCount:-1}`.
Problems: one **row per user per gif file** (dedupe only by `filename` within a user); `recordUse` `updateMany({filename, isPublic})` touches every user's copy; "trending" is an aggregation `$group` by `filename|url` on every browse.

---

## `sticker_packs`

`name, description, creatorId, stickers: string[], tags: string[], isPublic, usageCount, isDeleted`.
Indexes: `{creatorId}`, `{isPublic, isDeleted}`.
Problems: `usageCount` never incremented; search uses `$regex` not `$text`; no sticker-file storage.

---

## `emoji_usage`

`userId: ObjectId, emoji: string, kind: "emoji"|"reaction", count, lastUsedAt, createdAt, updatedAt`.
Indexes: `{userId, kind, emoji}` unique, `{userId, kind, count:-1, lastUsedAt:-1}`.
Problems: written (upsert) on **every message** for each detected emoji + every reaction add; whole collection exists to sort a picker. Candidate for `localStorage` or a single `user_prefs.recentEmojis` array.

---

## `upload_records`

`hash: string (unique), filename: string`. Fine. Content-addressed dedupe.
Missing: no reverse index (which messages/users reference a file) → cannot garbage-collect orphaned uploads.

---

## `wallpapers`

```
ownerId: ObjectId (index), channelId: string|null (index),
type (image|video), mediaUrl, thumbnailUrl,
blur, dim, brightness, fitMode, parallax, duration, videoStartSec, originalFilename
timestamps
```
Index: `{ownerId, createdAt:-1}`.
Problems: **a new document per `applyGlobal` / `applyChat`** — no update-in-place, no cleanup → grows forever, plus orphaned disk files. `getById` has no auth check.

---

## `app_settings`

`key: "default" (unique), trendingGifs: bool`. One doc. Over-modelled for one boolean.

---

## Data minimization findings

| What is fetched/stored/sent | Actually needed | Fix |
|---|---|---|
| `my-chats` returns `bio`, `tags`, `admins[]`, `image[]`, `link`, both users' full name parts per DM | id, kind, title, avatar, lastMessage summary, unread, flags, myRole | new projection / aggregation |
| `populate("replyTo")` → whole original message (content, attachments, reactions, readBy) | `{id, senderName, snippet, type}` | store a reply snapshot or project |
| `message.readBy` full map to every client | your own tick state + aggregate counts | per-membership read pointers |
| `message.reactions` full map re-sent on every toggle | delta `{emoji, +/-userId}` | delta events |
| `GET /users/search` returns `email`, `phoneNumber`, `isOnline`, `lastSeen` | `{id, displayName, username, avatar}` | narrow projection |
| `GET /users/:id/status` returns `email` | `{ lastSeen, isOnline }` | narrow |
| `emoji_usage` collection + write per message | client-side recents | drop collection |
| `isOnline` persisted per connect/disconnect | in-memory presence | drop column |
| `wallpapers` new doc per apply | update in place, 1 per (owner) + 1 per (owner,chat) | upsert |
| Absolute media URLs stored in `message.attachments` | store **relative** `/uploads/...`, resolve client-side | strip host on write |

## Missing indexes (priority order)

1. `chatmembers { channelId:1, userId:1 }` **unique** — P0 (hottest query, and prevents dupes)
2. `chatmembers { userId:1, isJoined:1 }` — P0 (`my-chats`)
3. `messages { channelId:1, isDeleted:1, createdAt:-1 }` — P1 (history with soft-delete filter)
4. `messages { channelId:1, type:1, createdAt:-1 }` — P1 (channel system-message exclusion, media galleries)
5. Replace `$regex` chat/user/message search with `$text` (indexes already exist for chats) — P1
6. `chatmembers { channelId:1, role:1 }` — P2
7. A `chat_state` (or denormalised `chats.lastMessageAt`) index for list ordering — P1
