# Security Audit

Actual mechanisms and gaps. No claim of "secure". Severity: **CRITICAL / HIGH / MEDIUM / LOW**.

---

## Authentication

**Mechanism:** JWT (HS256), `expiresIn: 7d`, secret from `JWT_SECRET` (server throws if missing).
Payload `{ userId, email, tokenVersion }`. `JwtStrategy.validate` re-reads the user and rejects on
`isDeleted` or `tokenVersion` mismatch. Gateway repeats this on connect. Passwords bcrypt cost 10.

| # | Finding | Severity |
|---|---|---|
| A1 | **`JWT_SECRET` committed** — `legacy-chat/.env` is in the repo and contains a real-looking `JWT_SECRET` (and `CONFIG_BOT_PASSWORD=123456`). Anyone with repo access can forge tokens for any user. Rotate immediately; purge from git history; use a secret manager. | CRITICAL |
| A2 | **7-day token, no refresh, no per-device revoke.** Stolen token is valid for a week; the only kill switch (`tokenVersion` bump) logs out every device. | HIGH |
| A3 | **Token + full user object in `localStorage`** — XSS = full account takeover + PII exfiltration. Should be an httpOnly, `SameSite=Lax`, `Secure` cookie (access) + refresh rotation. | HIGH |
| A4 | **No brute-force protection** on `/auth/login` — no lockout, no throttle, no captcha, no exponential backoff. Password-spray friendly. | HIGH |
| A5 | **No password reset** → users share passwords / reuse / never rotate. Also no way to lock a compromised account except `DELETE /users/:id` (self only). | MEDIUM |
| A6 | **min password length 6**, no complexity, no breach-list check. | MEDIUM |
| A7 | `/auth/register` returns the raw user doc (pre-`toJSON` in one path) — verify `password` never leaves. `login` returns `_doc` (Mongoose internal). Fragile; audit the exact bytes. | MEDIUM |
| A8 | No email/phone verification → `email` is unverified identity; account enumeration via distinct error messages is **avoided** (generic "Invalid credentials") — good. | LOW (good) |
| A9 | Gateway auth = `jwtService.verify` + DB check; token can be passed as `handshake.auth.token` (fine) or `Authorization` header. No token in query string — good. | LOW (good) |

---

## Authorization

**Mechanism:** per-handler `@UseGuards(JwtAuthGuard)`; role/ownership checks inline in services
(`chatmembers.role`, `chat.admins[]`, sender id, `chat.banned[]`).

| # | Finding | Severity |
|---|---|---|
| Z1 | **No global guard.** Every handler without `@UseGuards` is public. Today only `GET /`, `POST /auth/register`, `POST /auth/login`, and **`POST /config-logs`** are unguarded — the last is a real write path (see C-series). One forgotten decorator on a new endpoint = open. Use a global `JwtAuthGuard` + `@Public()`. | HIGH |
| Z2 | **`POST /config-logs` unauthenticated write.** Password compared to `process.env.CONFIG_LOG_PASSWORD ?? "change-this-config-password"`. `.env.example` documents `CONFIG_BOT_PASSWORD` (a *different* variable) → the fallback string is the live password in any deployment that followed the docs. Anyone can create the `config-bot` user + `configs` channel and post messages that broadcast to subscribers. **Remove the endpoint or require a strong secret + IP allowlist.** | CRITICAL |
| Z3 | **`GET /v2/wallpapers/:id` has no ownership/membership check** — any authenticated user can read any wallpaper document (media URLs, owner id). IDOR. | MEDIUM |
| Z4 | **`GET /chats/:channelId/members`** doc says "admin/owner only"; code checks only membership → any member sees the full management list incl. `isBanned`, `mutedByAdmin`. | MEDIUM |
| Z5 | **Block is under-enforced.** `blocks` only filters realtime `new_message` in private chats. A blocked user's messages still persist and reappear on refetch; block is not checked on `POST /messages`, reactions, `call_request`, or history reads. | MEDIUM |
| Z6 | **Ban is not enforced on WebSocket rooms already joined.** `chat_banned` asks the client to close the chat; a malicious client can ignore it and stays in `channel:<id>` receiving `new_message` until it disconnects (server removes membership but not the socket room). | MEDIUM |
| Z7 | **`chat.admins` accepts usernames**, resolved server-side; a race between resolve and update could promote the wrong user if usernames change. Minor. | LOW |
| Z8 | **Message edit/delete authz is correct** (sender for edit; sender/admin/owner for delete). Pin correct. Good. | LOW (good) |
| Z9 | **`DELETE /users/:id`** checks `id === token.userId` via `ObjectId.equals` — ok, but no re-auth (password confirm) for account deletion. | LOW |

---

## Input validation & injection

| # | Finding | Severity |
|---|---|---|
| I1 | **No server-side sanitisation of message `content`.** XSS defence is 100% React auto-escaping on the client. Any non-React consumer (Flutter, future email digest, link-preview service, admin tool) that renders `content` as HTML is vulnerable. Also mentions/links/markdown are parsed client-side only. Sanitise + define a safe rendering contract. | HIGH |
| I2 | **Regex search with user input** (`{ $regex: q, $options: 'i' }`) in `chats`, `users`, `messages` search — **ReDoS**: a crafted `q` (e.g. `(a+)+$`) can pin a CPU. Escape the input or use `$text`. | HIGH |
| I3 | **No max length** on `content`, `bio`, `description`, `name`, `tags` → storage abuse / large-payload DoS. `content` can be megabytes. | MEDIUM |
| I4 | **`/upload` accepts every file type** (`fileFilter` `cb(null, true)`), 250 MB, no AV scan, no content sniffing, no EXIF strip. Uploads are served from the same origin at `/uploads/*` → stored-XSS via an uploaded `.html`/`.svg` opened directly, or an uploaded polyglot. Serve uploads from a separate domain with `Content-Disposition: attachment` and a strict `Content-Type`. | HIGH |
| I5 | **`ObjectId` cast errors** partly handled (`Types.ObjectId.isValid`) but not everywhere (`chat.service.delete` does `new Types.ObjectId(channelId)` unguarded → 500 on bad input; `user.service.remove` `new ObjectId(id)` unguarded). Add a `ParseObjectIdPipe`. | MEDIUM |
| I6 | **`class-validator` whitelist on**, `forbidNonWhitelisted: false` → extra fields are silently stripped, not rejected. Set `forbidNonWhitelisted: true` for clearer contracts. | LOW |
| I7 | GIF/wallpaper conversion shells out to `ffmpeg` via `execFile` (array args, not `exec` string) — **not** shell-injectable. Good. Paths are server-generated. | LOW (good) |

---

## Transport / headers / CORS

| # | Finding | Severity |
|---|---|---|
| T1 | **`app.enableCors({ origin: '*', credentials: true })`** when `CORS_ORIGIN` unset — invalid combination (browsers reject credentialed `*`), and if a proxy strips credentials it becomes a fully open API. Gateway separately hardcodes `cors: { origin: '*' }`. Set an explicit allowlist for both. | MEDIUM |
| T2 | **No `helmet`** — missing `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`, HSTS, CSP. The web app has no CSP → XSS mitigation is weaker than it could be. | MEDIUM |
| T3 | `ServeStaticModule` sets `Access-Control-Allow-Origin: *` on `/uploads/*` for all files — combined with I4, uploaded active content is cross-origin readable. | MEDIUM |
| T4 | No TLS enforcement in app config (assumed at proxy). `x-forwarded-proto` trusted blindly in `buildUrl`. | LOW |
| T5 | `next.config.ts` sets no security headers. | LOW |

---

## Rate limiting / abuse

| # | Finding | Severity |
|---|---|---|
| R1 | **No global rate limiting** (`@nestjs/throttler` not installed). Login, register, search, message send, upload, calls — all unthrottled. | HIGH |
| R2 | **Registration is unthrottled + unverified** → mass fake-account creation, each triggering Saved-Messages chat creation. | MEDIUM |
| R3 | **`send_message` / `typing_start` / `call_signal` unthrottled per socket** → message-flood / signal-flood. | MEDIUM |
| R4 | Wallpaper upload has an **in-memory** rate limit (10/10 min) — resets on restart, per-process only, and it's the only one in the codebase. | LOW |
| R5 | No account lockout after N failed logins. | HIGH (dup A4) |

---

## Data exposure

| # | Finding | Severity |
|---|---|---|
| D1 | **`GET /users/search`** returns `email`, `phoneNumber`, `lastSeen`, `isOnline` for any substring match → email + phone **enumeration / scraping**. | HIGH |
| D2 | **`GET /users/:id/status`** returns `email` in a "status" response. | MEDIUM |
| D3 | **Presence broadcast to all** — you learn the online/last-seen of users you share nothing with. | MEDIUM |
| D4 | **`message.readBy` full map** sent to every member → exact "who read this and when" is public to the whole channel. May be intended for a family; still note it. | MEDIUM |
| D5 | **`.lean()` reads bypass `toJSON`** → `isDeleted` (and any future stripped field) can leak on lean-projected reads that select it. | MEDIUM |
| D6 | Private-chat `link` = `private-<sortedUserId1>-<sortedUserId2>` — exposes both raw user ids to any member and in any logs. | LOW |
| D7 | Soft-deleted users' names/avatars remain embedded in others' chat lists and `forwardFrom` snapshots forever. | LOW |
| D8 | `console.error` logs full error objects (could include tokens/PII in stack/context). | LOW |

---

## Realtime-specific

| # | Finding | Severity |
|---|---|---|
| W1 | `call_signal` relays arbitrary `payload` to `user:<targetUserId>` with only "is a participant" check — a participant can spam/oversize SDP/ICE payloads. | MEDIUM |
| W2 | In-memory call state → a crafted reconnect can hijack a participant's `socketId` slot (the code manually patches "stale socket" — indicates the race is real). | MEDIUM |
| W3 | No per-event schema validation on the gateway (DTOs validated only via the pipe on `send_message` because it's a `class`; most `@MessageBody()` are inline `{ channelId: string }` types with no runtime check). | MEDIUM |
| W4 | Typing/uploading/call maps not cleared on disconnect → resource leak, and stale "user is typing" can persist. | LOW |

---

## WebRTC / calls

- **No TURN server** → calls fail on symmetric NAT; also no relay = participant IPs exposed to each other (inherent to P2P, but worth noting for a family app).
- **`NEXT_PUBLIC_CALL_HOST` = `https://calls.example.com/en`** — an external, third-party-looking domain launched via `lib/call-room.ts` for some call flows. Its code is not in these repos (`UNKNOWN`). This is a trust boundary that must be documented/owned or removed.
- Mesh topology leaks each participant's media to every other participant directly.

---

## Positives (keep)

- `execFile` (not `exec`) for ffmpeg — no shell injection.
- Generic auth error messages.
- `tokenVersion` invalidation exists.
- bcrypt (not fast hash).
- Content-hash upload dedupe (no path traversal in filenames — server-generated).
- `class-validator` global pipe with `whitelist`.
- Blocked-user profile reads return 403.

---

## Remediation priority

| P | Items |
|---|---|
| **P0 (now)** | A1 rotate `JWT_SECRET` + purge history; Z2 remove/lock `/config-logs`; Z1 global guard; I4 isolate `/uploads` + restrict types; R1 add throttler; A4 login lockout |
| **P1** | A2/A3 cookie + refresh + short access token; I1 sanitise + safe render contract; I2 escape regex / `$text`; D1 narrow user search; T1/T2 CORS allowlist + helmet + CSP; Z3/Z4/Z5/Z6 fix authz gaps |
| **P2** | A5 password reset; I3 length limits; D2/D3/D4 narrow exposure; W1–W4 gateway validation + rate limit; D5 stop lean leaks |
| **P3** | A6 password policy; D6/D7/D8; TURN server or drop P2P |
