# Refactor Spec: Chat Wallpaper

> **RESOLVED (DECISIONS Q4): keep the current flow exactly as-is** (global + per-chat, image +
> video, share/accept, the editor UX). Only fix internals: upsert instead of doc-per-apply, auth
> on `getById`, remove the `decline` no-op, route media through `MediaService`, GC orphans.
> Ignore the "trim/drop" variants below — apply only the "§6 backend changes" internals fixes.
> Delivery: BACKEND B9 / FRONTEND F9 / FLUTTER A9.

## 1. Current implementation
`/v2/wallpapers` — per-user global wallpaper (`user.globalWallpaperId`) + per-user-per-chat
(`chatmembers.chatWallpaperId` + `wallpaperBlur/Dim/Brightness`). Image or ≤5s video (server
ffmpeg clip + thumbnail). Params: blur/dim/brightness/fitMode/parallax/videoStartSec. "Share to
chat" posts a `type: system` message with metadata; recipients accept/decline; accept copies
settings to their membership. `wallpaper_updated` WS event. Backend: `wallpaper.service.ts` (510),
`wallpaper-media.service.ts`, `wallpapers` collection. Frontend: `components/wallpaper/*` ×8,
`hooks/use-chat-wallpaper.ts`, `/profile/chat-background`.

## 2. Current architecture
```
upload → /v2/wallpapers/upload/(image|video) → {url, duration?, thumbnailUrl?}
apply global → PATCH /v2/wallpapers/global → CREATES a new Wallpaper doc → user.globalWallpaperId
apply chat → PATCH /v2/wallpapers/chat/:id → new doc + membership cols + system message + WS
resolve → GET /v2/wallpapers/effective/:id → chat > global > null
```

## 3. Current problems
- **New `Wallpaper` document on every apply** → collection + disk grow unbounded (PERF M10).
- `GET /v2/wallpapers/:id` — no ownership/membership check (SECURITY Z3, IDOR).
- `POST /v2/wallpapers/:id/decline` — no-op endpoint.
- Visual params duplicated between the `Wallpaper` doc and `chatmembers` columns.
- ffmpeg dependency (deploy fragility, shared with GIF).
- Large complexity budget (schema + 3 backend files + 8 FE files + 4 membership cols + a system message type + a WS event) for a cosmetic feature.
- Per-apply orphan files (no `MediaService` GC).

## 4. Refactor goal (assuming "keep, trimmed")
Global + per-chat kept; **images only** (drop video); upsert (one doc per owner, one per
owner+chat); auth on read; media via `MediaService`; params on one record.

## 5. New architecture
```
media: MediaService (dedupe, resize, blurhash, relative URL) — no separate wallpaper upload
wallpaper record: upsert by (ownerId, channelId|null) → { mediaId, blur, dim, brightness, fitMode }
GET  /v1/channels/:id/wallpaper        → effective { source: chat|global|none, ...params, media }  (membership required)
PUT  /v1/wallpapers/global             → upsert
PUT  /v1/channels/:id/wallpaper        → upsert + optional { share: true } → system message
DELETE both
share/accept: recipient PUT their own /channels/:id/wallpaper referencing the shared mediaId
```
(If "drop": remove the module, `wallpapers` collection, membership cols, `components/wallpaper/*`,
`/profile/chat-background`, the `wallpaper_share` system message + card.)

## 6. Backend changes
- Collapse to upsert; delete per-apply doc creation.
- Membership: keep only a `wallpaperId` ref (or fold params into the wallpaper doc keyed by
  owner+chat and drop the 4 columns).
- Auth on `GET wallpaper` (membership); `getById` removed or membership-scoped.
- Remove `decline`.
- Drop video path + `wallpaper-media.service.ts` (or keep image-only bits).

## 7. Frontend changes
- `use-chat-wallpaper` reads the one effective endpoint; patches on `wallpaper:updated`.
- Wallpaper editor shared between global (Settings) and per-chat (chat menu → sheet).
- Remove video upload UI, `wallpaper-flow` video branch.
- If "drop": delete `components/wallpaper/*`, the settings route, the system-message card.

## 8. UI/UX
- Settings → Wallpaper: pick from presets + upload image; live preview with blur/dim/brightness sliders; "Apply to all chats".
- In a chat: menu → "Wallpaper" sheet → same editor + "Only this chat" / "Share with <name>".
- Shared: recipient sees a system card "<name> shared a wallpaper" → Preview / Apply / Dismiss.
- Respect `prefers-reduced-motion` (no parallax).

## 9. Data contract
`EffectiveWallpaper { source: "chat"|"global"|"none", media?: MediaRef, blur, dim, brightness, fitMode }`.

## 10. Performance
- One wallpaper doc per scope (was one per apply).
- Media via the shared pipeline (blurhash, web size, CDN).
- No ffmpeg for wallpapers (if video dropped).

## 11. Migration
- Backfill: for each user keep only the latest global wallpaper doc; per-chat keep the latest referenced by membership; delete the rest + orphan files.
- New upsert path; old docs referenced by `globalWallpaperId`/`chatWallpaperId` still resolve during transition.

## 12. Tests
- Upsert: applying twice → one doc.
- `GET wallpaper` requires membership.
- Effective resolution chat > global > none.
- Share → recipient apply → their membership updated, sender's not.

## 13. Risks
- Data loss on the "keep latest, delete rest" migration → snapshot first; the discarded docs are just history.
- Users may want video wallpapers → confirm in OPEN_QUESTIONS before removing.

## 14. Acceptance criteria
- One wallpaper doc per (owner) and per (owner, chat); no growth per apply.
- `GET wallpaper` is membership-guarded; no unauthenticated `getById`.
- `decline` endpoint removed.
- Media served via `MediaService` (relative URL, blurhash).
- If dropped: module, collection, membership cols, FE components, route all removed; system card gone.
