# Product Decisions (answers to OPEN_QUESTIONS)

Recorded 2026-09-02. These override the "forks" in `refactors/*.md` and drive `plans/*`.

| # | Question | Decision |
|---|---|---|
| **Q1** | Password reset / recovery | **No self-serve reset.** User requests recovery → **Admin Panel** approves → panel generates a **short random link** valid for a limited duration → admin sends it manually (out of band). ⇒ **an Admin Panel is now in scope**, with user management + a **support ticketing** system. |
| **Q2** | Multiple avatars | **Keep.** Users upload several avatars and pick one as the **main** (shown everywhere); others viewable in a gallery/lightbox. |
| **Q3** | Voice/video calls | **Will be used. Current implementation is a prototype — treat as "not implemented".** Build properly: **SFU** (LiveKit or mediasoup) + **TURN** (coturn) + Redis-backed signalling state. Audio first; video-capable architecture. |
| **Q4** | Chat wallpaper | **Keep the current flow as-is** (global + per-chat, image + video, share/accept, the editor UX). Only fix internals: upsert instead of doc-per-apply, auth on `getById`, remove the `decline` no-op, route media through the shared `MediaService`, GC orphans. |
| **Q5** | GIFs | **Personal GIF library** (uploaded/recorded clips) **+ a separate "global" tab** (like Telegram) showing **public GIFs from a third-party service** (Tenor or Giphy), **not** hosted by the app. Needs an API key, a content-rating filter, and attribution. |
| **Q6** | Stickers | **Keep and do it properly:** real sticker/pack upload via `MediaService`, a proper picker, `usageCount` maintained via a real "use" endpoint, recents. |
| **Q7** | Message & media retention | **Keep everything forever.** No purge. The problem to solve is **storage**: move to **object storage (S3-compatible) + CDN**, content-dedupe, and **lifecycle tiering** (hot → cold storage class for old media; never delete). |
| **Q8** | Read-receipt visibility | **Telegram-style, author-only.** In DMs **and** groups: the **message author** can see who has seen **their own** message; nobody can see who saw someone else's. **Channels: no read info at all** (optional aggregate view count later). |
| **Q9** | Push notifications | **Flutter app: full background push** (FCM/APNs) — notify even when the app is closed. **Web: foreground only** — while a tab is open, show in-app notifications for new messages / calls / etc. **if the chat is not muted** (no Web Push service worker, per the product call). The server `NotificationService` still computes "should notify" (mute + level + not-in-chat) and fans out to Flutter. |
| **Q10 / Q11** | `config` section / config bot | **New feature, deferred to the LAST phase (optional / not required for launch).** Goal: a foreign server crawls VPN configs (VLESS/VMESS) → writes a text file; the chat VPS fetches it **over a DNS-based VPN** (to bypass DPI) and posts configs into a dedicated in-app **Config section / bot** for users. Requires **new scripts on the foreign server** too. ⇒ **`TODO` + a fully-planned final phase; not built until everything else ships.** The current insecure `POST /config-logs` endpoint is removed/replaced by this. |
| **Q12** | Chat tags / grouping | **Yes — Telegram-style chat folders.** User-defined folders with filters (by type, by tag, include/exclude specific chats), reorderable, shown as tabs. Supersedes the current free-form `chat.tags` (tags become an input to folders). |
| **Q13** | Target scale | **100–1000 users**, single region. **Modular monolith + Redis + object storage.** Not required to horizontally scale now, but structured so it can (Redis adapter, stateless API, externalised media/call state). Prioritise **maintainability + iteration speed**. |
| **Q14** | Finding / adding people | **Public discovery: username only.** Plus a **Contacts (address book)**: you can look someone up by **username, phone, or email** *to add them as a saved contact* (with a custom name); saved contacts are searchable locally. Phone/email are **not** exposed in public/global search results. |
| **Q15** | Moderation / reporting | **Yes, via the Admin Panel.** Build a **reporting system** (report message / user / channel) → a **moderation queue** in the panel → actions (warn, delete content, mute, ban from channel, suspend account). Model it on Telegram's report → review → action flow. |

## Consequences for the doc set

- **New project: Admin Panel** (`chat-admin`, separate Next.js app). Assumed separate app,
  separate deploy, admin-role auth. Plans: `plans/ADMIN_PANEL_PLAN.md`.
- **Calls** → `refactors/voice-calls.md` **Option A** (SFU + TURN + Redis). Not "drop".
- **Wallpaper** → `refactors/wallpaper.md`: "keep full flow, fix internals" (not the trim/drop variants).
- **GIFs/Stickers** → `refactors/gifs-and-stickers.md`: GIFs = personal + third-party global tab;
  Stickers = keep + finish.
- **Read receipts** → `refactors/read-receipts.md`: author-only visibility, no "Seen by" for
  non-authors, none in channels.
- **Notifications** → `refactors/notifications.md`: **web = foreground only** (drop the Web Push /
  service-worker sections); **Flutter = FCM/APNs background**; server fan-out kept.
- **Contacts** → new: `refactors/contacts.md` (address book) in addition to
  `direct-messages-and-saved.md`.
- **Folders** → new: covered in `FRONTEND_PLAN.md` + a backend `chat_folders` model.
- **VPN config bot** → `plans/CONFIG_BOT_PLAN.md` (final, optional phase; includes the
  foreign-server crawler scripts).
- **Retention** → `refactors/attachments-and-media.md`: no purge; add object storage + tiering.

## Coordinated program

Four project plans, one shared timeline:

| Plan | File |
|---|---|
| Backend (NestJS API + realtime + workers) | [plans/BACKEND_PLAN.md](./plans/BACKEND_PLAN.md) |
| Frontend — user web app (Next.js) | [plans/FRONTEND_PLAN.md](./plans/FRONTEND_PLAN.md) |
| App — Flutter (iOS + Android) | [plans/FLUTTER_APP_PLAN.md](./plans/FLUTTER_APP_PLAN.md) |
| Admin Panel (Next.js, internal) | [plans/ADMIN_PANEL_PLAN.md](./plans/ADMIN_PANEL_PLAN.md) |
| VPN Config Bot (deferred, optional) | [plans/CONFIG_BOT_PLAN.md](./plans/CONFIG_BOT_PLAN.md) |

The cross-project dependency map is in [plans/README.md](./plans/README.md).
