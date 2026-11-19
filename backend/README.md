# Chat backend

The API and realtime server for **Chat**, a messaging app with direct chats, groups, channels,
Saved Messages, media, sticker and emoji packs, voice and video calls, and an admin and moderation
surface. It is a modular NestJS monolith: a REST API (Swagger at `/docs`) plus one Socket.IO
gateway, backed by MongoDB for data, Redis for presence, call state, rate limits and cross-node
socket fan-out, and S3-compatible storage (MinIO) or local disk for media.

## Tech stack

| Area | What we use |
|---|---|
| Framework | NestJS 11 (Express), TypeScript 5 |
| Database | MongoDB 7 via Mongoose 8 (single-node replica set `rs0` in Docker) |
| Realtime | Socket.IO 4 with `@socket.io/redis-adapter` |
| Cache and coordination | Redis 7 (ioredis): throttler storage, auth state cache, presence, call state, socket adapter |
| Auth | Passport JWT (15 min access tokens) + rotating refresh tokens; separate admin JWT with TOTP MFA (otplib) |
| Media | sharp (images, blurhash), ffmpeg via `ffmpeg-static` (video), AWS SDK v3 S3 client (MinIO) |
| Calls | Self-hosted LiveKit SFU (`livekit-server-sdk` for tokens) + coturn |
| Push | Firebase Admin (FCM) |
| Third-party content | Giphy API (global GIF and sticker search) |
| Logging | `nestjs-pino` (JSON, request ids) |
| Scheduling and events | `@nestjs/schedule` (nightly jobs), `@nestjs/event-emitter` (in-process domain events) |
| Tests | Jest + ts-jest, `mongodb-memory-server`, supertest, k6 |

## Quick start

### Prerequisites

- **Node.js 20** (the Dockerfile and CI both use Node 20).
- **Docker** with Compose, for MongoDB, Redis, MinIO, LiveKit and coturn.
- **ffmpeg**: nothing to install for local dev. The path is resolved as `FFMPEG_PATH` → the
  bundled `ffmpeg-static` binary → `ffmpeg` on `PATH` (`src/media/ffmpeg-path.util.ts`). The
  production image installs ffmpeg with `apk`.

### Steps

```bash
cd backend
cp .env.example .env                    # then set JWT_SECRET, CORS_ORIGIN, etc.
cp livekit.yaml.example livekit.yaml    # only needed for calls; see "Calls" below
npm install

# Dependencies only (the compose file also defines `app` and `frontend`; leave those out in dev)
docker compose up -d mongodb mongo-init redis minio minio-init livekit coturn

npm run start:dev                       # nest start --watch
```

Check it is up: `GET /` is a public health check, and Swagger is at `http://localhost:<PORT>/docs`.

Things to know:

- **CORS_ORIGIN is required.** The app refuses to boot without it; there is no wildcard fallback.
  Add the origin your frontend runs on.
- **Ports.** Compose publishes MongoDB on **27018**, MinIO on **9010** (console 9011) and Redis on
  **6380**; `.env.example` already points `DATABASE_URL`, `S3_ENDPOINT` and `REDIS_URL` at those.
- **Media storage.** `MEDIA_STORAGE_DRIVER` defaults to `disk` (`uploads/media/`). Set it to `s3`
  to use MinIO; then `/uploads/media/*` returns 500 whenever the MinIO container is down.
- **Redis.** The throttler and auth cache fail open when Redis is down, but presence, call state and
  the Socket.IO adapter need it.

### Seed development data

With the backend running:

```bash
node scripts/dev-seed/seed-dev.mjs                              # API at http://localhost:3001
API_URL=http://localhost:3097 node scripts/dev-seed/seed-dev.mjs   # any other port
```

It talks to the running API (no direct DB access) and is safe to re-run. It creates:

- three test accounts, `uid_maya`, `uid_omid` and `uid_sara` (logins and the shared dev password are
  in [`../docs/DEV_TEST_ACCOUNTS.md`](../docs/DEV_TEST_ACCOUNTS.md); override with `DEV_SEED_PASSWORD`);
- a Maya ↔ Omid direct chat and a private group, "Weekend trip", with all three;
- two public chats Maya is not in: channel "Family Recipes" (Sara) and group "Book Club" (Omid);
- four public packs owned by Maya, built from `scripts/dev-seed/packs/`: "Family Moments" and
  "Celebrations" (stickers), "Animated Faces" and "Quick Reactions" (animated emoji), added to every
  account's collection.

Never run it against production; the accounts share a published password.

### Create an admin

There is no HTTP endpoint for creating admins. Run the script with direct database access:

```bash
npm run seed:admin -- --email=admin@example.com --password='at-least-12-chars' --role=superadmin
```

Roles: `superadmin`, `support` or `moderator`. It prints an `otpauth://` URI to add to an
authenticator app; a TOTP code is required on every admin login. Re-running with the same email
updates the password and role and rotates the MFA secret.

### Other scripts

| Command | What it does |
|---|---|
| `npm run build` / `npm run start:prod` | Compile to `dist/` and run `node dist/main` |
| `npm run start:debug` | Watch mode with the inspector |
| `npm run docs:openapi` | Boot the app on an in-memory MongoDB and write `openapi.json` (needs Redis reachable) |
| `npm run migrate:media-to-s3 [-- --dry-run]` | Copy `uploads/media/` into the S3 bucket; skips existing keys. Then switch `MEDIA_STORAGE_DRIVER=s3` |
| `npm run migrate:legacy [-- --dry-run]` | One-off copy of the old backend's database (`DATABASE_URL_LEGACY`, read-only) into `DATABASE_URL` |
| `test-harness/index.html` | A bare-bones page for manually exercising auth and socket events (open it in a browser) |

## Configuration

Everything is read from the environment (`.env` is loaded by `dotenv/config` at the very top of
`main.ts`, before any module is imported). Never commit real values; `.env.example` holds placeholders.

| Variable | Purpose | Default if unset |
|---|---|---|
| `PORT` | HTTP and Socket.IO port | `3000` (`.env.example`: 3001) |
| `NODE_ENV` | `production` turns off pretty log output | (pretty logs) |
| `CORS_ORIGIN` | Comma-separated allowed origins for HTTP, Socket.IO and `/uploads` | **required**, boot fails |
| `DATABASE_URL` | MongoDB connection string | `mongodb://127.0.0.1:27017/chat` |
| `DATABASE_URL_LEGACY` | Read-only source for `migrate:legacy` only | none |
| `REDIS_URL` | Redis for throttling, auth cache, presence, calls, socket adapter | `redis://127.0.0.1:6380` in `.env.example` |
| `JWT_SECRET` | Signs user and admin JWTs | **required**, auth fails |
| `GIPHY_API_KEY` | Giphy GIF and sticker search | none; the Giphy routes return an error |
| `LIVEKIT_URL` | LiveKit signalling URL returned to clients | none; calls unavailable |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Sign LiveKit room tokens; must match `keys:` in `livekit.yaml` | none; calls unavailable |
| `TURN_SECRET` | coturn user password (used by `docker-compose.yml`, not by app code) | none |
| `MEDIA_STORAGE_DRIVER` | `disk` or `s3` | `disk` |
| `MEDIA_STORAGE_ROOT` | Disk driver root folder | `<cwd>/uploads/media` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3/MinIO settings, all required when the driver is `s3` | none |
| `S3_REGION` | S3 region (MinIO ignores it) | `us-east-1` |
| `MEDIA_COLD_TIER_DAYS` | Days unread before the nightly job tags an asset `cold` | `90` |
| `FFMPEG_PATH` | Override the ffmpeg binary | bundled `ffmpeg-static` |
| `FCM_SERVICE_ACCOUNT_PATH` | Firebase service-account JSON for push | `secrets/fcm-service-account.json`; push is off if missing |

Used only by the dev seed: `API_URL` (default `http://localhost:3001`) and `DEV_SEED_PASSWORD`.

`livekit.yaml` (copied from `livekit.yaml.example`, git-ignored) holds the LiveKit key pair and RTC
port range; `docker-compose.yml` mounts it into the LiveKit container.

## Architecture

### Module map

All modules live in `src/` and are wired in `src/app.module.ts`.

| Module | Responsibility |
|---|---|
| `auth` | Register, login, refresh-token rotation, sessions, password change and recovery, the global `JwtAuthGuard`, Redis token-state cache |
| `account` | Account deletion (re-auth, then cleanup of memberships, blocks and media refs) |
| `user` | Profile, user search, blocking, profile photos and videos, quick reaction, notification level |
| `contacts` | Address book: add by username, exact phone or exact email |
| `chat` | Chats of every type: create, join, leave, members, admins, rights and permissions, invites, bans, pins, mutes, delete |
| `channels` | `/v1` chat list (one aggregation, cursor-paginated) and in-chat message search |
| `folders` | Telegram-style chat folders |
| `message` | Send, history, edit, delete, reactions, pins, read state, unread counts |
| `gateway` | The single Socket.IO gateway and the Redis adapter |
| `presence` | Online state in Redis (`presence:<userId>`, 30 s TTL kept alive by a heartbeat) |
| `events` | Domain event names (`message.created`, `message.deleted`, `membership.changed`) |
| `notifications` | FCM device tokens and push fan-out on `message.created` |
| `search` | Unified search across people, public chats and messages |
| `media` | `MediaService` ingest pipeline, disk/S3 storage drivers, `/uploads/media` serving, nightly maintenance, admin orphan tools |
| `upload` | Upload endpoints for chat files, images, videos and profile videos |
| `wallpaper` | Global and per-chat wallpapers (image or looping video), sharing, nightly GC |
| `clips` | Personal GIF library (video converted to a looping GIF with ffmpeg) |
| `giphy` | Giphy client plus a mirror-on-first-use cache |
| `gif`, `sticker` | Giphy search, trending and "use" routes for GIFs and stickers |
| `packs` | User-made sticker and animated-emoji packs: items, variants, subscriptions, usage |
| `bots` | Server-side menu bots (currently `pack-manager`) |
| `calls` | Call lifecycle, Redis call state, LiveKit token minting |
| `admin` | Admin identities, admin login with MFA, account-recovery approvals |
| `moderation` | User reports, and admin actions: suspend, warn, hide message, lock channel, remove member |
| `common` | `@Public()`, the error-envelope filter, `ParseObjectIdPipe`, the resilient throttler guard, CORS allowlist |

### Request lifecycle

1. **Helmet** sets security headers. `/uploads` gets `Cross-Origin-Resource-Policy: cross-origin`
   so the web app can embed media from another origin.
2. **CORS** uses the `CORS_ORIGIN` allowlist with credentials.
3. **Logging**: pino-http logs every request as JSON with a request id (the client's `x-request-id`
   or a new UUID). The `authorization` and `cookie` headers and password fields are redacted.
4. **Global guards** (`APP_GUARD`):
   - `JwtAuthGuard`: every route needs a Bearer access token unless marked `@Public()`. The JWT
     strategy checks `tokenVersion`, deletion and suspension against a 5-minute Redis cache
     (falling back to MongoDB), so a password change or "log out everywhere" takes effect at once.
   - `ResilientThrottlerGuard`: 100 requests per 60 s per client by default, stored in Redis. Hot
     or sensitive routes override it (register 3 per hour; login 5 per minute; refresh 20 per minute;
     search 30 or 90 per minute; uploads 10 to 20 per 10 minutes). If Redis fails, the guard lets
     requests through instead of returning 500. `GET /` and `/uploads/media/*` skip throttling.
5. **Validation**: a global `ValidationPipe` with `whitelist`, `forbidNonWhitelisted` and
   `transform`. Unknown body fields are a 400, not silently dropped.
6. **Errors**: `/v1` controllers use `AllExceptionsFilter`, which returns
   `{ "error": { "code", "message" } }`. Older unversioned routes, `/v2/wallpapers` and the `/v1`
   auth routes still return Nest's default `{ statusCode, message, error }`.

**Tokens.** Login and register return `access_token` (15 min JWT) and `refresh_token`. Refresh
tokens are random strings stored only as SHA-256 hashes in the `sessions` collection, grouped
into a *family* per login. `POST /auth/refresh` is single-use: it rotates the token, and replaying
an already-rotated token revokes the whole family ("reuse detected"). Sessions have no fixed expiry;
they last until rotated or revoked. Changing a password, `logout-all` and a recovery reset bump the
user's `tokenVersion`, which invalidates every outstanding access token. After 5 failed logins an
account is locked for 15 minutes.

**Admin auth** is separate: `admin_users` accounts, login with password plus TOTP code, and a 12 h
admin JWT checked by `AdminJwtAuthGuard`. Admin controllers are `@Public()` at the class level only
to skip the *user* guard.

### Realtime (Socket.IO)

- One gateway (`src/gateway/chat.gateway.ts`) on the default namespace `/`, same CORS allowlist.
- **Handshake auth**: send the access token as `auth: { token }` or an `Authorization: Bearer`
  header. Invalid, deleted, suspended or stale-`tokenVersion` users are disconnected with no error event.
- **Rooms**: each socket joins `user:<userId>` and `channel:<channelId>` for every membership.
- **Multi-node**: the Redis adapter mirrors emits across API processes.
- Clients get a reply through the Socket.IO **ack** (`{ success, ... }` or `{ error }`).

Client → server:

| Event | Payload | Effect |
|---|---|---|
| `join_channel` / `leave_channel` | `{ channelId }` | Join or leave a chat room (join requires membership) |
| `send_message` | `CreateMessageDto` (+ optional `tempId`) | Persist through `MessageService.create` and broadcast `new_message`; 20 per 10 s per socket |
| `typing_start` / `typing_stop` | `{ channelId }` | Typing indicator (auto-stops after 5 s) |
| `uploading_start` / `uploading_stop` | `{ channelId }` | "Uploading…" indicator |
| `mark_read` | `{ channelId, lastReadMessageId }` | Move the read pointer and broadcast `read:updated` |
| `resync` | `{ since: { [channelId]: lastMessageId } }` | Ack returns what each chat missed while disconnected |
| `update_status` | `{ status }` | Set a presence status and broadcast it |

Server → client:

| Event | Sent to | When |
|---|---|---|
| `new_message` | chat room | A message was created (REST, socket, system, call log, moderation warning) |
| `message_updated` / `message_deleted` | chat room | A message was edited, or deleted for everyone |
| `reaction_changed` | chat room | A reaction was toggled (small delta, not the whole message) |
| `read:updated` | chat room | Someone's read pointer moved |
| `user_typing` | chat room (not the sender) | Typing or uploading state changed |
| `user_status_changed` | rooms of chats the user is in | Online, offline (with `lastSeen`) or a status update |
| `new_chat` | user | A direct chat or membership was created for this user |
| `chat_updated` | chat room | Name, description, photo, visibility or link changed |
| `chat_deleted` | each member | The owner deleted the group or channel |
| `channel_roles_updated` | chat room | The admin list changed |
| `chat_permissions_updated` | chat room | Admin rights, default permissions or a member's exceptions changed (refetch `GET /chats/:id/permissions`) |
| `chat_banned` | user | You were banned from a chat |
| `user_muted` | user | An admin muted or unmuted you in a group |
| `user_unblocked_you` | user | Someone unblocked you |
| `wallpaper_updated` | user | Your wallpaper changed |
| `call:ringing` | user | Incoming call |
| `call:ended` | chat room | Call ended, declined or missed |
| `call:missed` | user | You missed a call |

Domain services also emit in-process events (`src/events/domain-events.ts`); `ChatStateListener`
keeps the `chat_state` collection (used by the chat list) in sync, and `NotificationService` sends pushes,
both off the request path. Push is skipped when the recipient has that chat open.

### Media pipeline

Most media goes through `MediaService` (`src/media/media.service.ts`):

1. **Sniff** the real type from magic bytes; the client's extension and MIME type are ignored.
2. **Dedupe** by SHA-256 of the content (videos and loop videos key on hash plus output settings).
   A repeat upload just increments `refCount` on the existing `media_assets` row.
3. **Process** new content:
   - images: re-encoded with EXIF stripped, `web` and `thumb` variants, a blurhash, width and height.
     Size caps: 20 MB for images, 8 MB for GIFs.
   - videos: H.264 transcode with ffmpeg, plus a poster frame (200 MB cap).
   - **loop videos** (silent, looping): profile videos (square, 640 px, at most 10 s, 30 fps,
     `POST /upload/avatar-video`) and video wallpapers (1280 px, 24 fps, cut to the first 10 s).
   - pack items: 128 px `packThumb` and `packStill` variants, made lazily in the background
     (animated ones re-timed to about 17 fps).
4. **Store** through the `MediaStorage` interface (disk or S3/MinIO; the relative paths are identical).
5. **Serve** from `GET /uploads/media/<hash>/<variant>` (`MediaServeController`): range requests,
   `Cache-Control: immutable` for a year, no throttling. Reading an asset updates `lastAccessedAt`.

Media is **never deleted automatically**. Releasing a reference only decrements `refCount`. Nightly
jobs tag assets unread for `MEDIA_COLD_TIER_DAYS` as `cold` (metadata only) at 01:00 and log a
report of `refCount: 0` orphans at 02:00. Only an admin can hard-delete one orphan
(`DELETE /v1/admin/media/:id`). A separate midnight job removes unreferenced *wallpaper* records
and releases their media references.

The generic `POST /upload` endpoint is separate: it writes to local `uploads/`, dedupes
by hash in an `upload_records` collection, and is served as static files under `/uploads`.

### Permissions model

Defined in `src/chat/permissions.ts`; `effectivePermissions(chat, membership)` is the single source.

- **Direct chats and Saved Messages** have no rights model; both people can do everything.
- **Owner**: everything, including deleting the group or channel and appointing admins.
- **Admins** have per-admin rights chosen when promoted: `changeInfo`, `deleteMessages`, `banUsers`,
  `inviteUsers`, `pinMessages`, `addAdmins`, and for channels `postMessages` and `editMessages`.
  The default is everything except `addAdmins`. An admin with `addAdmins` can only grant rights
  they hold.
- **Members of groups** get the chat's `defaultPermissions` (`sendMessages`, `sendMedia`,
  `sendStickers`, `sendVoice`, `addMembers`, `pinMessages`, `changeInfo`; by default all `true`
  except pin and change info), overridden per person by **exceptions** in `ChatMembers.permissions`.
  Without `sendMessages`, nothing can be sent. The older "muted by admin" flag still blocks sending.
- **Members of channels** cannot post.
- Each message type maps to a required permission (`permissionForMessageType`): media → `sendMedia`,
  stickers and GIFs → `sendStickers`, voice and round videos → `sendVoice`.

Groups and channels are either **public** (searchable, previewable, joinable) or **private**
(invite link only).

### Calls

Calls use a self-hosted **LiveKit** SFU with **coturn** for TURN (both in `docker-compose.yml`).
The backend only coordinates them: `POST /v1/calls` and `/:callId/join` return
`{ callId, roomName, roomToken, livekitUrl }`. Call state lives in Redis (6 h TTL), and ringing,
ended and missed are signalled through the socket events above. Media, participants and mute
state come from the LiveKit client SDK. The LiveKit key pair must match in `.env` and
`livekit.yaml`. There is no LiveKit webhook receiver yet, so a client that crashes mid-call is
only cleaned up by the TTL.

## API overview

Swagger UI is at **`/docs`** and the raw spec at **`/docs-json`**. `npm run docs:openapi` writes
`openapi.json` (the copy checked into this folder can be out of date; regenerate it).

Versioning uses URI prefixes. Older controllers are unversioned; newer ones are under `/v1`;
wallpapers are under a literal `/v2/wallpapers` prefix. A few auth and message routes are `/v1`
at the method level, so check the path carefully. All routes need a user access token unless
marked *public* or *admin*.

### Health and media

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Health check (*public*) |
| GET | `/uploads/media/*path` | Serve a stored media variant (*public*) |
| GET | `/uploads/*` | Static files from the generic upload endpoint (*public*) |

### Auth and account

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | Register (*public*) |
| POST | `/auth/login` | Log in with email or phone number plus password (*public*) |
| POST | `/auth/refresh` | Rotate a refresh token (*public*) |
| GET | `/v1/auth/me` | Current user's profile |
| POST | `/auth/profile` | Current user's profile (older version of `GET /v1/auth/me`) |
| GET | `/v1/auth/sessions` | List active sessions |
| DELETE | `/v1/auth/sessions/:id` | Revoke one session |
| POST | `/auth/logout-all` | Revoke every other session; returns new tokens for this client |
| POST | `/auth/change-password` | Change password |
| POST | `/v1/auth/recovery-request` | Ask an admin for account recovery (*public*) |
| GET / POST | `/v1/auth/recovery/:token` | Check a recovery link, or reset the password with it (*public*) |
| DELETE | `/v1/auth/account` | Delete your account (re-auth required) |

### Users and contacts

| Method | Path | Purpose |
|---|---|---|
| POST | `/users` | Update the current user |
| GET | `/users/search` | Search users |
| GET | `/users/by-id/:userId` | User by id |
| GET | `/users/:username` | User by username |
| GET | `/users/:userId/status` | Online status |
| GET | `/users/:userId/photos` | Profile photos and videos, main first |
| POST | `/users/me/photos` | Add a profile photo or video |
| POST | `/users/me/photos/:photoId/main` | Make a photo the main one |
| DELETE | `/users/me/photos/:photoId` | Delete a profile photo |
| GET | `/users/blocked` | Blocked user ids |
| GET | `/users/block/check/:userId` | Has this user blocked you? |
| POST / DELETE | `/users/block/:userId` | Block or unblock |
| PATCH | `/users/quick-reaction` | Set your quick reaction |
| PATCH | `/users/notifications` | Set your push notification level |
| DELETE | `/users/:id` | Delete the current user (older route; prefer `DELETE /v1/auth/account`) |
| POST / GET | `/v1/contacts` | Add a contact, or list contacts with presence |
| PATCH / DELETE | `/v1/contacts/:id` | Rename or remove a contact |

### Chats

| Method | Path | Purpose |
|---|---|---|
| POST | `/chats/create` | Create a group or channel |
| POST | `/chats/update/:channelId` | Update chat details |
| POST | `/chats/subscribe` / `/chats/unsubscribe` | Join or leave a chat |
| DELETE | `/chats/delete/:channelId` | Delete a group or channel (owner only) |
| GET | `/chats/my-chats` | Your chats with pin and mute state (older list) |
| GET | `/v1/channels/mine` | Your chats, one aggregation, cursor-paginated |
| GET | `/chats/saved-messages` | Get or create Saved Messages |
| GET | `/chats/direct/:userId` | Get or create a direct chat |
| GET | `/chats`, `/chats/search` | List or search chats |
| GET | `/chats/link?link=` | Resolve a chat by its link |
| GET | `/chats/preview/:channelId` | Preview a chat before joining |
| GET | `/chats/:channelId/display` | A chat's display name |
| POST / DELETE | `/chats/:channelId/pin` | Pin or unpin a chat in your list |
| POST / DELETE | `/chats/:channelId/mute` | Mute or unmute a chat |
| POST | `/chats/:channelId/tags` | Set chat tags |
| POST / GET | `/chats/:channelId/members` | Add members, or list members for management |
| GET | `/chats/:channelId/participants` | Members for mention autocomplete |
| GET / PUT | `/chats/:channelId/permissions` | Your effective rights, or set default member permissions |
| PUT / DELETE | `/chats/:channelId/members/:userId/permissions` | Set or clear a member's exceptions |
| PUT | `/chats/:channelId/admins/:userId` | Promote with specific rights, or change rights |
| POST / DELETE | `/chats/:channelId/admins/:userId` | Promote with default rights, or demote |
| GET | `/chats/:channelId/invite` | Get the invite code |
| POST | `/chats/:channelId/invite/reset` | Replace the invite code |
| GET | `/chats/invite/:inviteCode` | Preview a chat from its invite |
| POST | `/chats/invite/:inviteCode/join` | Join through an invite |
| GET | `/chats/:channelId/banned` | Banned users |
| POST / DELETE | `/chats/:channelId/ban/:userId` | Ban or unban |
| POST / DELETE | `/chats/:channelId/mute-member/:userId` | Mute or unmute a group member |
| POST / GET | `/v1/folders` | Create or list chat folders |
| PATCH / DELETE | `/v1/folders/:id` | Update or delete a folder |

### Messages and search

| Method | Path | Purpose |
|---|---|---|
| POST | `/messages` | Send a message |
| GET | `/messages/channel/:channelId` | Message history |
| GET | `/messages/channel/:channelId/first-of-date`, `/first-from-date`, `/oldest` | Jump to a date, or to the start |
| GET | `/messages/channel/:channelId/search` | Search within a chat (older) |
| GET | `/v1/channels/:channelId/messages/search` | Search within a chat (snippets, cursor) |
| GET | `/messages/channel/:channelId/pinned` | Pinned messages |
| GET | `/messages/channel/:channelId/unread`, `/unread-reactions`, `/unread-mentions` | Unread counts and jump lists |
| POST | `/messages/channel/:channelId/read` | Mark as read |
| GET / PUT / DELETE | `/messages/:messageId` | Get, edit, or delete for everyone |
| POST | `/messages/:messageId/delete-for-me` | Delete for yourself only |
| POST | `/messages/:messageId/reaction` | Toggle a reaction |
| POST / DELETE | `/messages/:messageId/pin` | Pin or unpin a message |
| GET | `/v1/messages/:messageId/reads` | Who has read it (author only) |
| GET | `/v1/search` | Unified search: people, public chats or messages |

### Uploads, wallpapers, GIFs, stickers and packs

| Method | Path | Purpose |
|---|---|---|
| POST | `/upload` | Upload any file (image, video, audio); stored on local disk |
| POST | `/upload/image` | Upload an image through `MediaService` |
| POST | `/upload/video` | Upload a video (compressed, with a poster) |
| POST | `/upload/avatar-video` | Upload a profile video (square loop, at most 10 s, silent) |
| POST | `/v2/wallpapers/upload/image`, `/v2/wallpapers/upload/video` | Upload a wallpaper image or video |
| GET / PATCH / DELETE | `/v2/wallpapers/global` | Get, apply or reset your global wallpaper |
| GET / PATCH / DELETE | `/v2/wallpapers/chat/:channelId` | Get, apply (posts a system message) or reset a chat wallpaper |
| GET | `/v2/wallpapers/effective/:channelId` | Resolved wallpaper (chat, then global, then default) |
| GET | `/v2/wallpapers/:id` | Wallpaper by id |
| POST | `/v2/wallpapers/:id/accept` | Accept a wallpaper shared in a chat |
| PATCH | `/v2/wallpapers/:id/settings` | Update visual settings |
| GET | `/gifs/giphy/search`, `/gifs/giphy/trending` | Giphy GIFs |
| POST | `/gifs/giphy/:giphyId/use` | Use a Giphy GIF (mirrored into our storage on first use) |
| GET | `/stickers/giphy/search`, `/stickers/giphy/trending` | Giphy stickers |
| POST | `/stickers/giphy/:giphyId/use` | Use a Giphy sticker |
| GET / POST | `/v1/clips` | List your GIF clips, or upload a video to convert |
| POST | `/v1/clips/:clipId/use` | Record a clip use |
| DELETE | `/v1/clips/:clipId` | Remove a clip |
| POST | `/v1/packs` | Create a sticker or emoji pack |
| GET | `/v1/packs/mine` | Packs in your collection |
| GET | `/v1/packs/search`, `/v1/packs/search-items` | Search public packs, or items in your packs |
| GET | `/v1/packs/by-slug/:slug` | Resolve a pack link |
| GET / PATCH / DELETE | `/v1/packs/:packId` | Get, edit or delete a pack |
| POST | `/v1/packs/:packId/items` | Upload items |
| PATCH / DELETE | `/v1/packs/:packId/items/:itemId` | Edit keywords or remove an item |
| POST / DELETE | `/v1/packs/:packId/subscribe` | Add to or remove from your collection |
| POST | `/v1/packs/:packId/items/:itemId/use` | Record a use |
| GET | `/v1/bots` | List bots |
| GET | `/v1/bots/:key/menu` | A bot menu screen |
| POST | `/v1/bots/:key/action`, `/v1/bots/:key/action/upload` | Invoke a bot action (with or without files) |

### Calls, push and reports

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/calls` | Start a call in a chat |
| POST | `/v1/calls/:callId/join`, `/leave`, `/decline` | Join, leave, or decline a ringing direct call |
| POST / DELETE | `/v1/push/tokens` | Register or unregister an FCM device token |
| POST | `/v1/reports` | Report a message, user or chat |

### Admin (admin JWT)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/admin/auth/login` | Admin login with password and TOTP (*public*) |
| GET | `/v1/admin/recovery-requests` | Pending account-recovery requests |
| POST | `/v1/admin/recovery-requests/:id/approve`, `/deny` | Approve (issues a reset link) or deny |
| GET | `/v1/admin/reports` | List reports |
| PATCH | `/v1/admin/reports/:id` | Assign or resolve a report |
| POST | `/v1/admin/users/:id/suspend`, `/unsuspend` | Suspend or reinstate a user |
| POST | `/v1/admin/users/:id/warn` | Warn a user (DM from the "Moderation" account) |
| DELETE | `/v1/admin/messages/:id` | Hide a message (content removed) |
| POST | `/v1/admin/channels/:id/lock`, `/unlock` | Lock or unlock a channel |
| POST | `/v1/admin/channels/:id/members/:userId/remove` | Remove a member |
| GET | `/v1/admin/media/orphans` | Media assets at `refCount` 0 |
| DELETE | `/v1/admin/media/:id` | Hard-delete one orphaned asset |

## Testing

```bash
npx jest --runInBand        # same as `npm test`
npm run test:e2e            # test/app.e2e-spec.ts: boots the whole app on an in-memory MongoDB
npm run typecheck           # tsc --noEmit
npm run lint                # eslint with --fix (it changes files)
```

- Unit tests are `src/**/*.spec.ts` (about 44 files) and run against `mongodb-memory-server`.
  **Always run them in band.** Parallel in-memory MongoDB instances fail spuriously.
- The e2e test and `docs:openapi` need a reachable Redis (`REDIS_URL`).
- The video tests run real ffmpeg (the bundled binary) on synthetic clips.
- Load test: `BASE_URL=http://127.0.0.1:3001 k6 run k6/load-test.js` (REST only; raise `VUS` and
  `DURATION` for a bigger run). Everything from one IP hits the 100-per-minute throttle after about
  20 VUs; that is the throttler doing its job, not a capacity limit.

## Deployment

- `Dockerfile`: a two-stage Node 20 Alpine build, with ffmpeg installed and a non-root user;
  it runs `node dist/main.js` on port 3000.
- `docker-compose.yml` runs the whole stack: `app` (this backend; host port `${PORT:-3001}`),
  `frontend` (built from `../frontend`), `mongodb` + `mongo-init` (replica set `rs0`), `redis`,
  `minio` + `minio-init` (creates the bucket), `livekit` and `coturn`. Inside compose the app
  reaches its dependencies by service name. Uploaded files go in the `uploads_data` volume.
- CI/CD is in the repo-root `.github/workflows/ci-cd.yml`: the backend job runs typecheck,
  eslint and `npm test`. The frontend job runs typecheck, lint, test and build. On a push to
  `main`, a deploy job SSHes to the server, resets to `origin/main` and runs
  `docker compose up -d --build app frontend`.
- `backend/.github/workflows/ci.yml` is an older backend-only workflow (lint, typecheck, unit
  and e2e tests, OpenAPI export, k6 smoke test, gitleaks). It only runs if `backend/` is its own
  repository.
- One-time server setup, secrets and the reverse proxy are covered in
  [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md). Bringing the local Docker services and Firebase
  back up is in [`../docs/plans/INFRA_SETUP.md`](../docs/plans/INFRA_SETUP.md).

## Conventions

The full list is [`../docs/ARCHITECTURE_RULES.md`](../docs/ARCHITECTURE_RULES.md). These are target
rules: new code should follow them, though some older code does not yet. The main backend ones:

- Return purpose-built DTOs, never whole documents; never leak `password`, `tokenVersion`, email or phone.
- New list endpoints use keyset (`cursor`) pagination, not skip and offset.
- No N+1 queries in a handler; every hot query has an index.
- Store media URLs relative (`/uploads/...`); never bake in the request host.
- New routes go under `/v1` and use the `{ error: { code, message } }` envelope.
- Read state is one pointer per membership (`lastReadMessageId`); reactions and reads go out as small deltas.
- One source of truth per fact: roles live in `chatmembers`, presence in Redis.
- One write path per resource (for example, `MessageService.create` for REST and socket sends).
- Keep controllers thin, and have domain code emit events rather than call the gateway.
- Shell out with `execFile` and an argument array, never a command string.
- No unauthenticated writes: rely on the global guard and mark exceptions with `@Public()`.
  Rate-limit anything public or abuse-prone.
- Never commit secrets. Update docs and the OpenAPI spec together with the code.

## Further reading

All paths are relative to this folder.

| Document | What it covers |
|---|---|
| [`../docs/DEV_TEST_ACCOUNTS.md`](../docs/DEV_TEST_ACCOUNTS.md) | Seeded local accounts and demo data |
| [`../docs/ARCHITECTURE_RULES.md`](../docs/ARCHITECTURE_RULES.md) | Project rules |
| [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) | Server and CI/CD setup |
| [`../docs/plans/INFRA_SETUP.md`](../docs/plans/INFRA_SETUP.md) | Runbook for the Docker services and Firebase setup |
| [`../docs/plans/BACKEND_PLAN.md`](../docs/plans/BACKEND_PLAN.md) | Backend phases B0–B12; code comments refer to these phase ids |
| [`../docs/plans/ADMIN_PANEL_PLAN.md`](../docs/plans/ADMIN_PANEL_PLAN.md) | Admin panel plan (the client for the `/v1/admin` routes) |
| [`../docs/DECISIONS.md`](../docs/DECISIONS.md) | Product decisions behind the design (media kept forever, LiveKit, and so on) |
| [`../docs/DESIGN_SYSTEM.md`](../docs/DESIGN_SYSTEM.md) | Frontend design system, including groups, photos and wallpapers behaviour |
| [`../docs/SECURITY_PENTEST_2026-09-26.md`](../docs/SECURITY_PENTEST_2026-09-26.md) | Most recent security review |
| [`../docs/history/BACKEND_BUILD_LOG.md`](../docs/history/BACKEND_BUILD_LOG.md) | The old phase-by-phase build log (historical; partly out of date) |
| [`docs/REALTIME.md`](docs/REALTIME.md) | Older detailed socket contract. **Out of date**: it still describes the removed mesh-call events; the gateway source and the tables above are current |
| [`../docs/BACKEND_ARCHITECTURE.md`](../docs/BACKEND_ARCHITECTURE.md), [`../docs/REALTIME_ARCHITECTURE.md`](../docs/REALTIME_ARCHITECTURE.md), [`../docs/api/API_INVENTORY.md`](../docs/api/API_INVENTORY.md) | Earlier audit and refactor notes; see the code for the current API |
