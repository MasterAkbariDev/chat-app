# Admin Panel Plan — `chat-admin` (internal Next.js app)

Required by the Q1 + Q15 decisions. **Separate repo, separate deploy, separate auth** (admin
identities in `admin_users`, TOTP MFA mandatory, admin JWT audience distinct from the user API).
Internal-only — put it behind an IP allowlist / VPN / SSO as well.

Roles: **superadmin** (everything, manage admins), **support** (users, tickets, recovery links),
**moderator** (reports queue, content actions). Every action is written to `moderation_log` /
`admin_audit`.

Stack: Next.js 15 (App Router, server components for data, RSC + server actions or a thin RQ
client against `/v1/admin/*`), the same design tokens as the user app but a denser, table-first
layout. No public assets, no PWA.

Each phase needs the matching backend admin API (`Bn`). Size S/M/L as elsewhere.

---

## D0 — Repo & auth shell · Size S · parallel with B0

- New repo; Next.js app; env for `ADMIN_API_BASE`.
- Server layout: session check → redirect to `/login`. `middleware.ts` IP allowlist.
- CI: lint / typecheck / test / build; `gitleaks`.
- Placeholder dashboard.

---

## D1 — Admin auth + audit + user directory (read) · Size M · needs B1, B4

- `/login`: email + password + **TOTP** (mandatory); lockout; session cookie (short access +
  refresh, like the user app).
- Role-gated navigation; a `useAdmin()` context.
- **User directory:** `GET /v1/admin/users` — searchable/filterable table (username, email, phone,
  created, last active, status: active / suspended / deleted), pagination.
- **User detail:** profile, avatars, channels/memberships, recent devices/sessions, recent
  reports involving them, moderation history. Read-only in this phase.
- **Audit log viewer:** `GET /v1/admin/audit` — every admin action, filterable by actor / target /
  action / date.

**Acceptance:** an admin logs in with MFA; can find any user and see their full context; every
page load and action is auditable.

---

## D2 — User management + password-recovery links + tickets · Size M · needs B4, B10(partial)

- **Recovery requests queue (Q1):** `GET /v1/admin/recovery-requests?status=pending` — list with
  the requesting identity + timestamp + IP. Admin actions:
  - **Approve** → server generates a short opaque token (TTL 30–60 min, one-time) → the panel
    shows the **copyable link** (`https://app.../reset#<token>`) + a "mark as sent" button. The
    admin sends it to the user out of band (the panel does **not** email/SMS it).
  - **Reject** (with a note).
  - Show token status (active / used / expired); allow **revoke**.
- **User actions:** suspend (`until?` + reason) / unsuspend / warn (sends a "Moderation" system DM)
  / force-logout-all (`/v1/auth/logout-all` on their behalf) / soft-delete (with a strong confirm)
  / restore.
- **Support tickets:** `tickets {userId?, subject, body, status: open|pending|resolved,
  assignedTo?, messages: [{author: user|admin, body, at}]}`.
  - `POST /v1/tickets` (from the user app: Settings → "Contact support" → a form; and/or an
    in-app "Moderation" bot conversation).
  - Panel: ticket list (status / assignee filters), ticket detail with a reply thread, assign,
    change status, link a ticket to a user / a recovery request / a report.
  - Notifications to the user: ticket replies arrive as a system DM from a "Support" account.

**Acceptance:** a support admin turns a recovery request into a short, expiring link and marks it
sent; can suspend/warn a user; users can open a ticket and get replies in-app; tokens are
one-time + revocable.

---

## D3 — Reports & moderation queue · Size M · needs B10

- `GET /v1/admin/reports?status=&type=&severity=` — queue with the reported content preview,
  reporter(s) (deduped count), target, reason.
- **Report detail:**
  - message report → the message + surrounding context (a few messages before/after) + the
    channel + the sender's history.
  - user report → the user's recent messages across channels + prior reports/actions.
  - channel report → channel info + recent messages + owner/admins.
- Actions inline: dismiss / delete the message / warn the user / mute the user in the channel /
  ban from the channel / suspend the account / lock the channel. Each writes `moderation_log`.
- Bulk handling; assignment; SLA/age indicators.
- A "Moderation" system account used for warnings + notifying reporters ("Thanks — we reviewed
  this").

**Acceptance:** a moderator works the queue: opens a report, sees context, takes an action, the
action is enforced by the API + logged, the reporter is acknowledged.

---

## D4 — Channels & content admin · Size S · needs B2, B10

- Channel directory (type, members, owner, created, message count, reports).
- Channel detail: members + roles, recent messages, transfer/assign owner, lock/unlock, delete.
- Media browser for a channel (for moderation); hard-delete a media asset (the only place
  deletion is allowed — Q7 keeps everything otherwise) with a confirm + audit.

---

## D5 — Analytics & storage dashboard · Size M · needs B11

- **Usage:** DAU/WAU/MAU, new registrations, messages/day, calls/day, media uploaded/day,
  active channels — simple charts (server-aggregated; a nightly rollup job in the backend).
- **Storage (Q7):** total media size, by tier (hot/cold), growth trend, top channels/users by
  storage, orphan-asset count (archived, not deleted) with a hard-delete action.
- **Health:** API error rate, WS connection count, queue depth (BullMQ), DB size.
- **Push:** delivery success/failure per platform.

**Acceptance:** an admin can see growth + storage cost trajectory and act on orphans / cold-tier
candidates.

---

## D6 — Config Bot admin (deferred — see `CONFIG_BOT_PLAN.md`)

Only after everything else ships:
- Manage the VPN-config feed: source list, last-fetch status, the fetch-over-DNS-VPN health,
  manual "fetch now", edit/curate/categorise configs before they're published to the in-app
  Config section, pin/expire, per-config usage stats.

---

## Cross-cutting

- **Least privilege:** every admin endpoint checks the specific role; superadmin-only for managing
  `admin_users` + hard deletes + config sources.
- **Everything audited:** `admin_audit {actorId, action, target, before?, after?, at, ip}`.
- **No destructive action without a typed confirm** (type the username / channel name).
- **Read-mostly by default:** the panel surfaces data; actions are explicit and rate-limited.
- **PII care:** the panel shows email/phone (support needs them) but access is logged; consider
  redaction for moderator-role.

## Structure

```
src/
  app/
    (auth)/login
    (panel)/layout.tsx           server: admin session + role gate + IP allowlist
    (panel)/dashboard
    (panel)/users/[id]
    (panel)/recovery-requests
    (panel)/tickets/[id]
    (panel)/reports/[id]
    (panel)/channels/[id]
    (panel)/analytics
    (panel)/config            (deferred)
    (panel)/audit
    (panel)/admins            (superadmin)
  api/                        generated client for /v1/admin/*
  design-system/              shared tokens, table/form primitives
```
