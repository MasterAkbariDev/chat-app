# Refactor Spec: Authentication & Sessions

## 1. Current implementation
- `POST /auth/register` (bcrypt cost 10, uniqueness on email+username), `POST /auth/login`
  (email **or** phone + password), `POST /auth/profile` (by email from token), `POST /auth/logout-all`
  (bump `tokenVersion`), `POST /auth/change-password`.
- JWT HS256, `expiresIn: 7d`, payload `{ userId, email, tokenVersion }`.
- `JwtStrategy.validate` re-reads the user every request (`isDeleted`, `tokenVersion`).
- Web: token + full user JSON in `localStorage`; `AuthContext`; 401 → wipe + `/login`.
  Client-only route gating via `ProtectedRoute` effect.
- No refresh token, no password reset, no verification, no lockout, no per-device revoke.

## 2. Current architecture
```
login form → AuthContext.login → authApi.login → POST /auth/login
  → AuthService.validateUser ($or email/phone) → bcrypt → login() returns {access_token, _doc}
  → localStorage(token,user) → router.push(/chats)
every request → axios wrapper adds Bearer → JwtStrategy.validate → user.findById (DB hit) → handler
```

## 3. Current problems
- **`JWT_SECRET` committed** in `legacy-chat/.env` (CRITICAL — SECURITY A1).
- 7-day token, no refresh, revoke = all devices (A2).
- Token + PII in `localStorage` → XSS = takeover (A3).
- No brute-force protection (A4); no password reset (A5); min length 6 (A6).
- DB read per request for `tokenVersion` (PERF H3).
- 3 different "user" response shapes (register raw doc / login `_doc` / profile `findByEmail`).
- `AuthContext` trusts cached `user`, skips `/auth/profile` → stale profile.
- `POST` used for a read (`/auth/profile`).

## 4. Refactor goal
Short-lived access token + rotating refresh token in an httpOnly cookie; recoverable accounts;
real device management; zero DB reads on the auth hot path; one `PublicUserDto`.

## 5. New architecture
```
POST /v1/auth/register|login  → sets: accessToken (JSON, 15m) + refreshToken (httpOnly Secure
     SameSite=Lax cookie, 30d, rotating), persists a `sessions` row {id,userId,device,ip,createdAt,lastUsedAt}
POST /v1/auth/refresh         → rotates refresh (reuse-detection revokes the family), new access
POST /v1/auth/logout          → revoke this session
POST /v1/auth/logout-all      → revoke all sessions for the user
POST /v1/auth/forgot-password / reset-password  → email or admin-issued token
GET  /v1/auth/me              → PublicUserDto (replaces POST /auth/profile)
GET  /v1/auth/sessions        → device list ; DELETE /v1/auth/sessions/:id → revoke one

Hot path: access token verified by signature only; `tokenVersion` (or a session revocation set)
cached in Redis; JwtStrategy does 0 Mongo reads.
Web: Next middleware reads the cookie for redirects; `/app` is a server layout doing the session check.
CSRF: SameSite=Lax + a double-submit token for cookie-auth mutations.
```

## 6. Backend changes
- New `sessions` collection; `RefreshTokenService` (rotation + reuse detection).
- `AuthController` → cookie-setting; `@Public()` on register/login/refresh/forgot/reset/health; global `JwtAuthGuard`.
- `PublicUserDto` mapper used by every auth response.
- Redis `tokenVersion` / revocation cache.
- `@nestjs/throttler` on all auth routes; login lockout (progressive delay after N fails).
- Password policy (length ≥ 10, breach-list check optional).
- Email module (or admin-reset) for password reset — see OPEN_QUESTIONS.

## 7. Frontend changes
- `AuthContext` keeps only in-memory access token + `user` (from `/auth/me`); no token in `localStorage`.
- Silent refresh on 401 (once) via `/auth/refresh`; on failure → `/login`.
- Next `middleware.ts` redirect based on the cookie; `(app)` server layout.
- `/app/settings/security`: change password + **Devices** list with revoke.
- `/forgot-password`, `/reset-password` routes.

## 8. UI/UX
- Login: email/phone toggle kept; add "Forgot password?" link; inline + toast errors; loading state on the button; lockout message ("Too many attempts, try again in Nm").
- Register: keep fields; add password strength meter + confirm; async username availability; explain "@username lets family find you".
- Devices screen: list rows (device, location-ish from IP, "this device", last active) + "Sign out" per row + "Sign out everywhere".
- Reduced motion respected; 44px targets; focus management on route change.

## 9. Data contract
- `PublicUserDto { id, username, displayName, firstName?, lastName?, bio?, avatarUrl?, quickReaction?, bigEmojis? }` — **never** `email`, `phoneNumber`, `password`, `isDeleted`, `tokenVersion`.
- `SessionDto { id, device, approxLocation?, current: boolean, lastUsedAt }`.
- Access token claims: `{ sub, sid }` only (no email).

## 10. Performance
- 0 Mongo reads per authenticated request (was 1). At 500 rps that's 500 fewer `user` reads/s.
- Refresh calls are rare (every ~15 min per active client).

## 11. Migration
- Add `sessions` + Redis cache alongside the current flow (parallel, `/v1`).
- Issue refresh cookies on next login; old 7-day tokens still accepted until expiry (dual-verify).
- After 7 days, remove the legacy path.
- One-time `tokenVersion` bump not needed (natural expiry).

## 12. Tests
- Unit: `RefreshTokenService` rotation + reuse detection; `PublicUserDto` (no leak).
- Integration: login lockout; `/auth/me`; logout-all invalidates every session; refresh rotates;
  expired/absent access → 401; CSRF token required for cookie mutations.
- E2E: register → refresh across 15-min boundary → still logged in; forgot → reset → login.

## 13. Risks & mitigations
- Cookie/CSRF migration bugs → dual-run `/v1`, feature flag, thorough E2E.
- Email dependency for reset → decide admin-reset fallback first (OPEN_QUESTIONS Q1).
- Redis outage → fall back to a short DB `tokenVersion` check (degraded, not down).

## 14. Acceptance criteria
- No secret in repo or git history; secret scanner in CI.
- Access token TTL ≤ 15 min; refresh rotates; reuse revokes the family.
- A stolen access token is unusable after ≤ 15 min without logging out other devices.
- Users can recover a forgotten password.
- Devices screen lists sessions and revokes individually + all.
- `JwtStrategy` performs 0 Mongo reads on the hot path (verified by query-count test).
- All auth responses return `PublicUserDto` (contract test).
