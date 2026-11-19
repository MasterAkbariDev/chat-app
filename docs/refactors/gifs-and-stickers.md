# Refactor Spec: GIFs & Stickers

> **RESOLVED (DECISIONS Q5, Q6):**
> - **GIFs:** personal library (uploaded/recorded clips) **+ a separate "global" tab** backed by a
>   **third-party service** (Tenor recommended, Giphy alt) via a **server-side proxy** — key
>   server-only, content-filtered, attributed. Drop the local "trending" aggregation + `app_settings`.
> - **Stickers:** **keep and finish** — real upload via `MediaService`, proper picker, `usageCount`
>   maintained via a real `/use` endpoint, recents. Remove the dead `bot/create-from-message` stub.
> Delivery: BACKEND B9 / FRONTEND F9 / FLUTTER A9.

## 1. Current implementation
### GIFs
`user_gifs` (one row per user per file). `GET /gifs` → `{ mine, trending, settings }` (trending
gated by `app_settings.trendingGifs`, Compass-only). `POST /gifs/upload` (video ≤50 MB → ffmpeg →
gif). `POST /gifs/:id/use` (`updateMany` by filename for public copies). `POST /gifs` (publish),
`POST /gifs/mine` (add by id or `/uploads/gifs/` URL), `DELETE /gifs/mine/:id`.
**No Giphy code** despite `GIPHY_API_KEY` in env + `API_SUMMARY.md`.

### Stickers
`sticker_packs` (name, creatorId, `stickers: string[]` URLs, tags, isPublic, usageCount).
`POST /stickers/packs`, `GET /stickers/packs`, `/search`, `/:id`, `POST /:id/stickers`.
`POST /stickers/bot/create-from-message` — **always throws** (dead). `usageCount` **never
incremented** (no "use sticker" endpoint). No sticker file upload — packs are "URLs you host".

## 2. Current problems
- GIFs: "trending" is a `$group` aggregation over all public gifs on every open (PERF H6); `recordUse` `updateMany` across users' copies; ffmpeg dependency; product mismatch (users expect Giphy-style search, get "your uploaded clips").
- `app_settings` module exists for one boolean.
- Stickers: dead stub endpoint + dead service method; `usageCount` meaningless; no upload; tiny/unclear UI; `ChatModule` imported only for the dead method.
- Both: full routes (`/chats/gifs/new`, `/chats/stickers/new`) for modal tasks.

## 3. Decision fork

### GIFs
- **A (recommended for a family app):** Rename to **"Clips"** — a small personal library of short
  looping clips you record/upload. Drop "trending" + `app_settings`. Keep upload + library + send.
- **B:** Integrate **Giphy/Tenor** search (needs an API key + attribution + content rating filter).
  Keep the personal library as "recent/favourites".
- **C:** Drop entirely (users send video/GIF as normal attachments).

### Stickers
- **Keep:** add real sticker upload (`MediaService`, packs of uploaded images), a `POST
  /stickers/:id/use` that increments `usageCount`, and surface a usable picker. Remove the dead stub.
- **Drop:** remove `sticker` module, `sticker_packs`, `sticker-picker`, `/chats/stickers/new`.

## 4. Refactor goal (assuming GIFs→A "Clips", Stickers→keep-minimal or drop)
Small, indexed personal libraries; media via `MediaService`; pickers as sheets; no dead code; no
`app_settings`.

## 5. New architecture
```
clips:  clips { ownerId, mediaId, title?, lastUsedAt, usageCount }  index {ownerId, lastUsedAt:-1}
        POST /v1/clips (upload short video → MediaService gif/loop) ; GET /v1/clips?cursor= ; POST /v1/clips/:id/use ; DELETE
stickers (if kept): sticker_packs { ownerId, name, stickerMediaIds: string[], isPublic }
        POST /v1/sticker-packs ; POST /v1/sticker-packs/:id/stickers (upload) ; GET (mine + public) ; POST /v1/stickers/:id/use
send: message { type: gif|sticker, media: [MediaRef] }
```
- Delete `app_settings` module → env/config flag if any global toggle survives.
- Delete `POST /stickers/bot/create-from-message` + `StickerService.createFromMessage`.
- ffmpeg gif conversion → shared `MediaService` helper (deduped with wallpaper).

## 6. Backend changes
- New `clips/` (or trim `gif/`); `sticker/` kept-minimal or removed.
- `MediaService` for all conversion/dedupe/URLs.
- Remove trending aggregation + `AppSettingsModule`.
- `usageCount` incremented via a real `/use` endpoint; sort by `lastUsedAt`.

## 7. Frontend changes
- GIF/Clip picker: sheet with "Recent" + "+ New" (records/uploads inline) — no `/chats/gifs/new` route.
- Sticker picker (if kept): sheet with packs + "+ New pack" inline.
- `useClips()` / `useStickerPacks()` (RQ).
- Remove `/chats/gifs/new`, `/chats/stickers/new` routes.

## 8. UI/UX
- Composer → GIF/sticker button → bottom sheet.
- Grid of recents; tap to send; long-press to remove.
- "New": pick video → trim/mute → save to library + send.
- Empty: "No clips yet — record a short one."

## 9. Data contract
`ClipDto { id, media: MediaRef, title?, lastUsedAt }`. `StickerPackDto { id, name, stickers: MediaRef[], isPublic }`.

## 10. Performance
- No trending aggregation on open.
- `use` = 1 update on the owner's row (not `updateMany` across users).
- Media via CDN.

## 11. Migration
- Backfill `clips` from `user_gifs` (dedupe by file); drop `user_gifs` after.
- `app_settings` → config; drop collection.
- Stickers: if kept, migrate `stickers: string[]` URLs → `MediaRef`s (best-effort); if dropped, snapshot + remove.

## 12. Tests
- Clip upload → library + send; `/use` bumps `lastUsedAt`.
- No `app_settings` dependency remains.
- Dead sticker endpoint returns 404 (removed).
- Picker sheets (no route navigation).

## 13. Risks
- Giphy path (B) adds a third-party dependency + content-moderation responsibility → only if the owner wants it.
- Removing stickers is one-way → confirm.

## 14. Acceptance criteria
- No "trending" aggregation; `app_settings` module + collection gone.
- Dead sticker stub endpoint + service method removed.
- GIF/sticker creation happens in a sheet, not a route.
- All GIF/sticker media flows through `MediaService` (relative URLs, dedupe).
- `usageCount` is actually maintained (or the field is removed).
