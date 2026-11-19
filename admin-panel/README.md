# Admin panel

Internal Next.js app for the chat backend's admin API (`/v1/admin/*`). It is a separate deploy
from the user app and has its own sign-in. See `docs/plans/ADMIN_PANEL_PLAN.md`.

## Status

**Work in progress.** The current panel includes sign-in, user administration, recovery requests, support tickets, and an audit viewer. The planned reports queue, channel administration, analytics dashboard, and admin-management screens are not yet present. Automated checks cover the app, but the complete admin workflow has not been validated end to end in this review.

## Run

```bash
cp .env.example .env.local   # set ADMIN_API_BASE to the backend origin
bun install
bun run dev                  # http://localhost:3100
```

Admin accounts are created by the backend's seed script (`npm run seed:admin` in `backend/`).
Sign-in needs the password and a 6-digit TOTP code every time.

## Checks

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

CI runs the same steps on every push and PR (`.github/workflows/admin-panel-ci.yml`), plus a secrets
scan. CI does not deploy.

## Network restrictions

- `ADMIN_IP_ALLOWLIST`: comma-separated IPv4 addresses or CIDR blocks allowed to reach the panel,
  e.g. `203.0.113.0/24,198.51.100.7`. A malformed entry stops the app from starting.
- If it is unset in production, every request gets a 403. Set it before deploying.
- `ADMIN_TRUST_PROXY=true` only when a proxy you control sets `X-Forwarded-For`. Otherwise the
  address cannot be trusted and the allowlist refuses everyone.
- Local development (`NODE_ENV` not `production`) is not restricted unless the allowlist is set.

## How auth works

- The admin JWT is set in an httpOnly, SameSite=Strict cookie (`admin_session`) on sign-in. It is
  never returned to browser scripts.
- Every API call is made from the server (`lib/api.ts`, server-only). The token is sent as a
  Bearer header.
- `proxy.ts` only redirects visitors with no cookie to `/login`. Each panel page re-checks the
  session with the backend (`GET /v1/admin/auth/me`). The backend enforces each route's role.
- Each admin token carries a version. Sign out everywhere bumps it on the server, so every token
  issued before is rejected on its next request, not when it expires.

## Pages

- `/login`: password + TOTP. Lockout after 5 failed attempts (backend).
- `/users`: directory with search (2+ characters), status filter and pagination. Moderators see
  masked contact details.
- `/users/[id]`: profile, channels, sessions, reports, moderation history, and account actions:
  suspend, lift suspension, warn, sign out everywhere, soft delete (type the username), restore.
  Each view is audited.
- `/recovery`: password-recovery queue (support and superadmin). Approve shows the one-time link
  once. Deny, mark as sent, and revoke.
- `/tickets`, `/tickets/[id]`: support tickets (support and superadmin). Reply, assign, set status,
  link a recovery request or report.
- `/audit`: audit log viewer, superadmin only.

Sign out ends this session. "Sign out everywhere" revokes every admin token for this account.
