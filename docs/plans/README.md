# Phased Delivery Plans

Five coordinated plans on one timeline. Read `../DECISIONS.md` first.

| Plan | Repo (proposed) | Owner track |
|---|---|---|
| [BACKEND_PLAN.md](./BACKEND_PLAN.md) | `legacy-chat` | API, realtime, workers, DB, infra |
| [FRONTEND_PLAN.md](./FRONTEND_PLAN.md) | `legacy-frontend` | user web app |
| [FLUTTER_APP_PLAN.md](./FLUTTER_APP_PLAN.md) | `chat-mobile` (new) | iOS + Android |
| [ADMIN_PANEL_PLAN.md](./ADMIN_PANEL_PLAN.md) | `chat-admin` (new) | internal ops tool |
| [CONFIG_BOT_PLAN.md](./CONFIG_BOT_PLAN.md) | `legacy-chat` + `config-crawler` (new) | **deferred / optional, last** |

## Shared conventions (all repos)

- **Contract:** the backend publishes an **OpenAPI 3.1 spec** + an **AsyncAPI-style realtime event
  doc**. Web, Flutter, and Admin generate their clients/types from it. No hand-written cross-repo types.
- **Auth:** access token (15 min) + rotating refresh. Web/Admin use an httpOnly cookie; Flutter
  uses secure storage. One `PublicUserDto`.
- **API base:** versioned `/v1`. One response envelope. Cursor pagination.
- **Realtime:** Socket.IO namespace `/`, Redis adapter. Delta events for reactions/reads.
- **Media:** one `MediaService`; **relative URLs**; object storage + CDN; blurhash + variants.
- **Infra target (Q13):** 100–1000 users, single region — 1–2 API nodes, MongoDB (replica set),
  Redis, an S3-compatible bucket + CDN, coturn, an SFU (LiveKit). Modular monolith, stateless API.
- **Feature flags:** `calls`, `gifsGlobal`, `stickers`, `wallpaper`, `folders`, `configBot`,
  `reporting` — each independently switchable.
- **Testing:** every phase ships critical-path tests. Critical flows gated on every deploy:
  login · start conversation · send · receive · reconnect · attachment · search · notification.

## Cross-project dependency map

```
BACKEND B0 Safety ─────────────────────────────────────────────────────────────────►
BACKEND B1 Contract (OpenAPI + AsyncAPI) ──┬──► FRONTEND F1 ─┬──► FLUTTER A1 ─┬──► ADMIN D1
                                           │                │               │
BACKEND B2 Data layer + channels/media ────┼──► FRONTEND F2  ├──► FLUTTER A2  │
BACKEND B3 Realtime + presence ────────────┼──► FRONTEND F3  ├──► FLUTTER A3  │
BACKEND B4 Auth + sessions + admin-auth ───┼──► FRONTEND F4  ├──► FLUTTER A4  ├──► ADMIN D2 (user mgmt + reset links)
BACKEND B5 Messaging + reactions + reads ──┼──► FRONTEND F5  ├──► FLUTTER A5
BACKEND B6 Contacts + folders + search ────┼──► FRONTEND F6  ├──► FLUTTER A6
BACKEND B7 Notifications fan-out ──────────┼──► FRONTEND F7  ├──► FLUTTER A7 (FCM/APNs)
BACKEND B8 Calls (SFU + TURN) ─────────────┼──► FRONTEND F8  ├──► FLUTTER A8
BACKEND B9 GIF(3p)/stickers/wallpaper ─────┼──► FRONTEND F9  ├──► FLUTTER A9
BACKEND B10 Reporting/moderation API ──────┼──► FRONTEND F10 ├──► FLUTTER A10  └──► ADMIN D3 (moderation queue) + D4 (tickets) + D5 (analytics)
BACKEND B11 Storage tiering + perf + a11y ─┴──► FRONTEND F11 └──► FLUTTER A11
BACKEND B12 + ALL: Config bot (deferred) ──────► FRONTEND F12 ────► FLUTTER A12 ────► ADMIN D6
```

**Rule:** a frontend/app/admin phase never starts before the backend phase it depends on has a
**stable contract merged** (endpoints may still be optimised behind it).

## Milestones

| M | Contents | Rough sequencing |
|---|---|---|
| **M0 — Hardened** | B0 (secrets, guard, throttle, indexes, `/config-logs` removed, CI) | first, blocking |
| **M1 — Contract** | B1 + F1 + A1 scaffold + D1 scaffold | after M0 |
| **M2 — Core chat (web)** | B2–B3–B5 + F2–F3–F5 | web reaches feature parity on messaging |
| **M3 — Accounts** | B4 + F4 + D2 (admin user mgmt + reset links + tickets D4) | password recovery works via admin |
| **M4 — App alpha** | A2–A5 (Flutter: auth, list, chat, media, reactions, reads) | parallel from M2 |
| **M5 — Social** | B6–B7 + F6–F7 + A6–A7 (contacts, folders, search, push) | |
| **M6 — Calls** | B8 + F8 + A8 (SFU + TURN) | after M5 |
| **M7 — Rich media** | B9 + F9 + A9 (GIF global tab, stickers, wallpaper internals) | |
| **M8 — Moderation** | B10 + D3 + F10 + A10 (reporting → admin queue) | |
| **M9 — Scale & polish** | B11 + F11 + A11 + D5 (storage tiering, perf budgets, a11y, analytics) | |
| **M10 — Config bot** | CONFIG_BOT_PLAN (foreign crawler + fetch-over-DNS-VPN + in-app section) | **optional, last, not required for launch** |
