# Open Questions

> **✅ ALL ANSWERED 2026-09-02 — see [DECISIONS.md](./DECISIONS.md).** This file is kept for the
> rationale/options context. The decisions drive [plans/](./plans/).

Things that **cannot** be determined from the code and need a product/team answer before the
relevant refactor phase. Format per init-prompt §42.

---

## Q1 — Password reset / account recovery

**Question:** How should users recover a forgotten password? Is there (or can there be) email
infrastructure (SMTP / a transactional provider)? If not, is an admin-issued reset link acceptable?
**Why we need to know:** there is currently **no recovery path** — a forgotten password = a locked
account. The auth refactor (Phase 4) must implement one.
**What it affects:** whether we add an `email` module + templates + a provider, or a
manual/admin flow; whether `email` becomes a *verified* field.
**Options:** (a) transactional email (SendGrid/SES/Postmark) + verified email; (b) admin console
issues a one-time reset link; (c) recovery via a trusted family member ("family admin").
**Recommendation:** (a) if any email budget exists; otherwise (b) short-term.

## Q2 — Multiple avatar images per user

**Question:** Is "a user has several profile photos" (`avatarUrl: string[]`, lightbox, add/remove)
an intentional feature, or should each user have one avatar?
**Why:** it adds a lightbox + remove flow + array handling in ~6 components and every DTO.
**Affects:** `user-profile.md` (single `avatarUrl` vs `avatarUrls`), the `image`→`avatarUrl`
rename, the profile UI.
**Options:** (a) single avatar; (b) keep a small gallery (max 5); (c) primary + gallery.
**Recommendation:** (a) single, unless a concrete use case exists.

## Q3 — Voice/video calls: keep, externalise, or drop?

**Question:** How often are calls actually used? Are calls a core promise of this app? Is video
wanted?
**Why:** ~2000 LoC across both repos, in-memory single-process state (won't scale/restart), no
TURN, an **external `NEXT_PUBLIC_CALL_HOST` domain whose code we don't have**. This is the single
largest complexity/risk item.
**Affects:** `voice-calls.md` fork — Option A (SFU + TURN + Redis, HIGH effort + infra), B
(externalise to a hosted room link), C (remove ~2000 LoC + `simple-peer` + `CALL_HOST`).
**Options / data needed:** call-start events per week; number of participants; % of calls that
connect successfully; do users expect video.
**Recommendation:** instrument first. If < a few calls/week → **C (remove)**. If calls matter →
**A with LiveKit (managed)**. Also: **what is `calls.example.com/en`?** Who owns it?

## Q4 — Chat wallpaper: how much of it stays?

**Question:** Keep global + per-chat + video wallpapers, or trim?
**Why:** schema + 3 backend files + 8 frontend files + 4 membership columns + a system message
type + a WS event + an ffmpeg dependency, for a cosmetic feature; `wallpapers` grows a doc per
apply (unbounded).
**Affects:** `wallpaper.md` fork.
**Options:** (a) keep everything; (b) global + per-chat, **images only** (drop video); (c) global
image only; (d) drop entirely.
**Recommendation:** (b) or (c).

## Q5 — GIFs: personal clips, Giphy/Tenor search, or drop?

**Question:** What do users expect from the GIF button — search a public GIF catalogue, or a
personal library of clips they made? (Today: personal uploaded clips; `GIPHY_API_KEY` in env but
**no Giphy code**.)
**Why:** "trending" is an expensive aggregation; the feature doesn't match the common mental
model; integrating Giphy adds a third-party dependency + content-rating responsibility.
**Affects:** `gifs-and-stickers.md` fork.
**Options:** (a) rename to "Clips" (personal, no trending); (b) integrate Giphy/Tenor; (c) drop
(send as normal video/GIF attachments).
**Recommendation:** (a) for a family app.

## Q6 — Stickers: invest or remove?

**Question:** Are stickers used? Should we build real sticker upload + a proper picker?
**Why:** `usageCount` is never incremented, there's a dead stub endpoint, no upload path, tiny
unclear UI.
**Affects:** `gifs-and-stickers.md` — keep-and-finish vs remove the module + collection.
**Options:** (a) finish (upload, usage tracking, picker); (b) remove.
**Recommendation:** (b) unless there's demand; emoji + clips cover most of the need.

## Q7 — Message & media retention

**Question:** Should messages/media be kept forever? Is there a retention policy (e.g. delete
media after N months, purge soft-deleted messages after N days)? Any legal/family expectation of
permanence?
**Why:** `messages` and `wallpapers` grow unbounded; soft-deletes never purge; disk has no quota;
no archival.
**Affects:** `messaging.md`, `attachments-and-media.md` (Phase 8 purge/archival job), storage
budget, per-user quota size.
**Options:** (a) keep everything (need storage plan + object storage/CDN); (b) media TTL +
soft-delete purge; (c) per-user storage cap with oldest-media eviction.

## Q8 — Read-receipt visibility

**Question:** Should every group member be able to see exactly *who* read each message and *when*
(current behaviour: full `readBy` map to everyone), or is a "Seen by N" count enough? Should there
be a "send read receipts" opt-out?
**Why:** privacy vs the current design; the `readBy` map is also a performance problem.
**Affects:** `read-receipts.md` — pointer model + a privacy toggle; whether "Seen by <names>" is
available at all.
**Recommendation:** "Seen by N" with a lazy name list; add a receipts toggle (default on for a
family app).

## Q9 — How important is push (app-closed) notification?

**Question:** Is "get notified when the app is closed" a must-have? (Today: **foreground only**;
iOS needs the PWA installed and still has no push.)
**Why:** determines whether Phase 7 builds Web Push (VAPID + SW + `push_subscriptions` + a job
queue) now or defers it.
**Affects:** `notifications.md` priority; whether the web app needs a real service worker.
**Recommendation:** yes for a chat app — prioritise Web Push in Phase 7, FCM/APNs for Flutter.

## Q10 — Blocking a user who is in a shared group

**Question:** When you block someone who's in a group with you, should their messages be fully
hidden, or collapsed to "Blocked message — tap to show"?
**Why:** the current block only affects DMs; groups do nothing. We need a defined behaviour.
**Affects:** `blocking.md` group rendering.
**Recommendation:** collapse with reveal (safer than silent full-hide; user can still follow
context).

## Q11 — `config-log` endpoint: what depends on it?

**Question:** What calls `POST /config-logs` (the unauthenticated, default-password endpoint that
posts to a `configs` channel)? Is the "deployment logs into a chat channel" feature actually used
by anyone?
**Why:** it's a security hole (SECURITY Z2) and we want to remove it, but something may post to it.
**Affects:** whether we delete it or lock it down (strong secret + IP allowlist + auth).
**Recommendation:** if nothing critical depends on it → delete; otherwise lock down.

## Q12 — Chat tags

**Question:** Is the per-chat `tags` feature used? There's a `POST /chats/:id/tags` endpoint (any
member can set) and an index, but no tag-filter UI in the reviewed screens.
**Affects:** keep + build a tag filter, or remove `chat.tags` + the endpoint.
**Recommendation:** remove unless there's a plan for it.

## Q13 — Target scale & hosting

**Question:** How many users / concurrent connections should the refactored system support? Single
region? What's the hosting target (VPS, a PaaS, Kubernetes)? Is a Redis instance available?
**Why:** drives whether Phase 3 (Redis adapter, multi-node) and Phase 8 (object storage/CDN) are
day-1 or deferred; sets the load-test target (`PERFORMANCE_AUDIT` budgets).
**Options:** (a) "a few families, one small box" → keep single-node, still add indexes + the
API/UI cleanups; (b) "hundreds–thousands" → Redis + multi-node + object storage are required.

## Q14 — Identity: username vs phone vs email as the primary handle

**Question:** How do family members find and add each other — by @username, phone number, an
invite link, or a QR code? Is phone number meant to be a real, verified identifier (it's accepted
at register/login but never validated)?
**Why:** shapes `/app/new`, user search (which currently leaks email+phone), and whether we add
phone verification.
**Recommendation:** invite links + @username as the primary; drop phone from search; either
verify phone or make it optional-and-private.

## Q15 — Moderation model for a family app

**Question:** Who can create channels? Is there a notion of a "family owner/admin" above channel
owners? Do we need a report/abuse flow, or is social trust sufficient?
**Affects:** whether we build `moderation_log` + a report feature (currently none) + a global
admin role.
**Recommendation:** keep it light (channel owner/admin only) + an audit log; skip a report flow
unless requested.
