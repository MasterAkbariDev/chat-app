# Per-Feature Refactor Specs

One spec per discovered feature (or feature cluster). Each follows the template from
`init-prompt.txt` §19: current implementation · current architecture · current problems · refactor
goal · new architecture · backend changes · frontend changes · UI/UX · data contract · performance
· migration · tests · risks · acceptance criteria.

| Spec | Covers | Priority | Product decision needed |
|---|---|---|---|
| [authentication.md](./authentication.md) | register, login, sessions, refresh, password reset, devices | P0 | Q1 (email vs admin reset) |
| [user-profile.md](./user-profile.md) | profile, avatars, preferences, settings IA, `image`/`avatarUrl` bug | P1 | Q2 (multi-avatar) |
| [presence.md](./presence.md) | online/last-seen, Redis, scoped emits | P1 | — |
| [channels-and-membership.md](./channels-and-membership.md) | chats, membership, indexes, add-member, list aggregation | P0 | — |
| [direct-messages-and-saved.md](./direct-messages-and-saved.md) | DMs, Saved Messages, hide/clear semantics | P1 | — |
| [contacts.md](./contacts.md) | address book — add by username/exact phone/email, custom names | P1 | resolved (Q14) |
| [messaging.md](./messaging.md) | text, replies, edit, delete, forward, pin, mentions, one write path | P0 | Q7 (retention) |
| [reactions.md](./reactions.md) | reactions, quick reaction, delta events, `emoji_usage` removal | P1 | — |
| [read-receipts.md](./read-receipts.md) | read state, unread counts, `readBy` removal | P0/P1 | Q8 (per-user read visibility) |
| [realtime-gateway.md](./realtime-gateway.md) | gateway → transport-only, Redis adapter, events | P0 | — |
| [attachments-and-media.md](./attachments-and-media.md) | uploads, resize/thumbnail/blurhash, relative URLs, GC | P0 | Q7 (retention) |
| [voice-messages.md](./voice-messages.md) | recording, waveform/duration persistence, global player | P2 | — |
| [voice-calls.md](./voice-calls.md) | 1:1 + group calls — **fork: keep(SFU) / externalise / drop** | P1 | Q3 (calls) |
| [wallpaper.md](./wallpaper.md) | global + per-chat wallpaper — **fork: keep-trimmed / drop** | P2 | Q4 (wallpaper) |
| [gifs-and-stickers.md](./gifs-and-stickers.md) | GIF library, stickers — **forks** | P2/P3 | Q5, Q6 |
| [notifications.md](./notifications.md) | Web Push, server fan-out, preferences | P1 | Q9 (push importance) |
| [moderation-roles-and-bans.md](./moderation-roles-and-bans.md) | roles, bans, kick, ownership transfer, audit log | P1 | — |
| [blocking.md](./blocking.md) | domain-layer block enforcement | P1 | Q10 (group block: hide vs collapse) |

### Not given a full spec (covered elsewhere)
- **config-log** → the insecure endpoint is **removed** in BACKEND B0; the intended feature (a
  curated in-app VPN-config section fed by a foreign crawler over a DNS-VPN) is planned separately
  and deferred: `../plans/CONFIG_BOT_PLAN.md` (DECISIONS Q10).
- **contacts / chat folders** → `contacts.md` + `../plans/FRONTEND_PLAN.md` F6 / `BACKEND_PLAN.md` B6.
- **app_settings** → remove; see `gifs-and-stickers.md` + `THINGS_TO_REMOVE.md`.
- **emoji_usage** → remove; see `reactions.md`.
- **typing / uploading indicators** → covered in `realtime-gateway.md`.
- **theme / PWA** → keep; minor work in `DESIGN_SYSTEM.md` + Phase 10.
