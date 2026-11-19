# Backend Architecture Audit (`legacy-chat`)

## Module graph

```
AppModule
├── ConfigModule (global)
├── MongooseModule.forRootAsync
├── ServeStaticModule  → uploads/ at /uploads  (adds CORS * headers, Accept-Ranges for video)
├── AuthModule          (JwtModule 7d, PassportModule, forwardRef→UserModule)
│   └── AuthController, AuthService, JwtStrategy
├── UserModule          (forwardRef→GatewayModule)   exports UserService, MongooseModule
│   └── UserController, UserService  [User, Block]
├── ChatModule          (forwardRef→GatewayModule)   [Chat, ChatMembers, User, Message]
│   └── ChatController, ChatService   (injects ChatGateway)
├── MessageModule       (forwardRef→GatewayModule, EmojiUsageModule)  [Message, ChatMembers, Chat, User]
│   └── MessageController (injects ChatGateway), MessageService
├── GatewayModule       (MessageModule, forwardRef→AuthModule, forwardRef→UserModule)  [ChatMembers, Chat, User]
│   └── ChatGateway     exports ChatGateway
├── GifModule           (AppSettingsModule)  [UserGif]
│   └── GifController, GifService, GifConversionService
├── StickerModule       [StickerPack, ChatMembers]
├── UploadModule        [UploadRecord]
├── EmojiUsageModule    [EmojiUsage]   exports EmojiUsageService
├── ConfigLogModule     (GatewayModule)  [Chat, ChatMembers, Message, User]   ← unauthenticated controller
├── WallpaperModule     (forwardRef→GatewayModule)  [Wallpaper, User, ChatMembers, Chat, Message, UploadRecord]
│   └── WallpaperController, WallpaperService, WallpaperMediaService
└── AppSettingsModule   [AppSettings]   exports AppSettingsService
```

### `forwardRef` web
`Auth ↔ User`, `Gateway ↔ (Auth, User, Chat, Message, Wallpaper)`. The gateway is a hub that
almost every feature module depends on (directly injecting `ChatGateway` into services). This is
the central coupling problem: **the gateway is both a transport and a dependency of the domain
layer.**

---

## Layering (as-is)

```
HTTP request
  → Controller (thin; a few have real logic: ChatController.getOrCreateDirect, MessageController edit/reaction/delete call the gateway)
    → Service (FAT — validation, authz, data access, mapping, and WS emit all mixed)
      → Mongoose Model (injected directly into services; no repository layer)
        → MongoDB
  ← manual .lean() + hand-written mapping → response (no DTO/serializer layer)

WebSocket event
  → ChatGateway handler (auth on connect; per-handler membership checks; in-memory maps)
    → MessageService / UserService / models
      → MongoDB
  → this.server.to(room).emit(...)
```

### What's missing
- **No repository / data-access layer** — models injected straight into services; queries duplicated.
- **No domain layer** — business rules (who can post, ban semantics, private-chat rejoin) live inline in service methods, often duplicated.
- **No response DTO / serializer** — every method hand-builds objects; shapes drift (`login` vs `register` vs `profile`).
- **No shared guard for "chat membership"** — the guard block is copy-pasted ~8× in `MessageService`.
- **No global exception filter / error envelope** — Nest defaults; error `message` shapes vary.
- **No global `JwtAuthGuard`** — security relies on remembering `@UseGuards` on every handler; `ConfigLogController` is unauthenticated by design and dangerous.
- **No interceptors** (no logging, no timing, no transform).
- **No pipes beyond global `ValidationPipe`** — no `ParseObjectIdPipe`; ids validated ad-hoc with `Types.ObjectId.isValid`.

---

## Problem inventory

### Fat services
| Service | LoC | Responsibilities crammed in |
|---|---|---|
| `MessageService` | ~1080 | membership guard ×8, ban scan ×6, mention resolution, reply linkage, private rejoin, forward copy, emoji tracking, reactions Map mutation, read-receipt bulk write, 5 date-navigation methods, search |
| `ChatService` | ~980 | CRUD, membership, roles+admin sync, ban list, pin/mute, private/saved/direct find-or-create, display-name computation, `my-chats` mega-method with inline N+1, preview |
| `ChatGateway` | ~980 | connection auth, presence, rooms, typing×2, read receipts, **13 call handlers with in-memory call state**, message send + per-socket block filter, ~10 `notify*` helpers used by other modules |
| `WallpaperService` | ~510 | upload dedupe, rate-limit map, global+chat apply, accept/decline, effective resolution, settings, system-message posting |

### Duplicated logic
- "chat exists + not deleted + banned check + membership (private)" block — `MessageService.findAll`, `getFirstMessageOfDate`, `getFirstMessageFromDate`, `getOldestMessageInChannel`, `searchInChannel` (5 verbatim copies) + partial copies in `create`, `findOne`.
- SHA-256 `hashFile` + `dedupeOrStore` implemented **3×**: `UploadController`, `GifService`, `WallpaperService`.
- `buildUrl(req, filename)` (absolute URL from headers) implemented **3×**.
- `getBundledFfmpegPath()` + `resolveFfmpegPath()` **2×** (`GifConversionService`, `WallpaperMediaService`).
- Role check `role !== ADMIN && role !== OWNER` scattered across chat + message + sticker services.

### Excessive / N+1 database calls
- `my-chats`: 1 + 1 + 2 aggregations + 2×(private count) queries.
- `message.service.create`: 6–10 sequential awaits.
- Every authenticated request: +1 `user` read in `JwtStrategy.validate` for `tokenVersion`.
- `addReaction`/`addQuickReaction`: 3–4 queries per toggle.
- `chat.service.update` admin sync: per-member `save()` in a loop.
- Ban check: `chat.banned.some()` in memory after loading the array.

### Over-fetching / under-projecting
- `.populate("replyTo")` (whole message), `.populate("senderId", "...email")` (email not needed by UI), `my-chats` returns unused fields.
- Several `findOne()` with no `.select()` (`chat.service.update`, `pinMessage` chat lookup).

### Redundant endpoints
- `GET /chats` and `GET /chats/search` → same `findChat`.
- `GET /chats/:id/display` → subset of `my-chats`.
- 3 date-navigation endpoints → 1 parametrised.
- 3 unread endpoints → could be 1.

### Inconsistent DTOs / responses
- `AuthService.login` returns `_doc`; `register` returns the mongoose doc; `profile` returns `findByEmail` result. Three shapes for "the user".
- `unsubscribe` returns `boolean`; `delete` returns `true`; `updateSettings` returns a response object; `resetChat` returns `void`.
- `messagesApi.unreadCount` frontend has to normalise `number | { count }`.

### Validation gaps
- `UpdateMessageDto.content` `@MinLength(0)` → empty edits allowed.
- `CreateChatDto.type` is `@IsEnum(ChatType)` but typed `string`; `SAVED_MESSAGES` creatable via API.
- `link` not constrained to a slug pattern server-side (frontend does `[a-z0-9_-]`).
- No max length on `content`, `bio`, `description`, `name`.
- File `fileFilter` for `/upload` accepts everything.

### Serialization
- `toJSON` transforms strip `password`/`isDeleted` on `user`, `isDeleted` on `chat`/`message` — but many reads use `.lean()` which **bypasses `toJSON`**, so `isDeleted` leaks on lean reads (e.g. `findChatByIdForPreview` selects it, `getMembersForManagement` etc.). `password` is protected because reads project it out, not because of `toJSON`.

### WebSocket inefficiency
- See REALTIME_ARCHITECTURE §4. Global presence broadcast, full-message reaction events, in-memory call state, no Redis adapter.

### Config / ops
- `JWT_SECRET` required (throws if missing — good) but `.env` in repo has `JWT_SECRET` present (secret committed — check git history).
- `CONFIG_BOT_PASSWORD` documented, `CONFIG_LOG_PASSWORD` used → default password live.
- CORS `*` + `credentials:true` when unset.
- `console.*` logging; no structured logs, no request ids, no correlation with WS.
- No health/readiness endpoint beyond `GET /` (no DB ping).
- `dist/` committed to the repo.
- Zero unit tests; one placeholder e2e.

---

## Target backend architecture

```
apps/api
 ├── main.ts                     global: helmet, throttler, versioned prefix /v1, ValidationPipe, exception filter, logging interceptor, global JwtAuthGuard + @Public()
 ├── common/
 │   ├── guards/ (JwtAuthGuard global, ChannelMemberGuard, ChannelAdminGuard)
 │   ├── pipes/  (ParseObjectIdPipe)
 │   ├── interceptors/ (ResponseEnvelope, Timing)
 │   ├── filters/ (AllExceptionsFilter → { error: { code, message } })
 │   └── decorators/ (@CurrentUser(), @Public(), @ChannelId())
 ├── modules/
 │   ├── auth/        (access 15m + refresh cookie; login/register/refresh/logout/logout-all/change-password)
 │   ├── users/       (profile, prefs, search[narrowed], block)  → PublicUserDto mapper
 │   ├── channels/    (was "chats": create/update/list/my/preview/join/leave/roles/ban/tags/direct/saved)
 │   │   └── membership.repository, channel.repository
 │   ├── messages/    (send/list[cursor]/edit/delete/react/pin/read/search[text-index])
 │   │   └── message.repository ; MessageCreatedEvent → EventEmitter2
 │   ├── media/       (single upload service: dedupe + resize + thumbnail + blurhash; relative URLs)
 │   ├── presence/    (Redis-backed; scoped emits)
 │   ├── realtime/    (gateway: transport only; subscribes to domain events; Redis adapter)
 │   ├── calls/       (Redis-backed signalling; SFU adapter) — OR removed (OPEN_QUESTIONS)
 │   ├── gifs/ stickers/ wallpapers/  (kept or trimmed per product decision)
 │   └── notifications/ (Web Push: push_subscriptions, VAPID)
 └── config/          (typed config schema; no in-repo secrets)
```

Principles: controllers thin → application services (use-cases) → domain rules → repositories →
Mongo. The gateway **never** calls services that call the gateway back — domain services emit
in-process events; the realtime module is the only WS emitter. One `PublicUserDto` / `MessageDto`
/ `ChannelSummaryDto`. Every list endpoint is cursor-paginated. Every hot query has an index
(enforced by an integration test that runs `explain`).
