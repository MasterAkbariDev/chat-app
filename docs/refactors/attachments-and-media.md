# Refactor Spec: Attachments & Media Pipeline

## 1. Current implementation
`POST /upload` (250 MB, all types) / `POST /upload/image` (10 MB, images). SHA-256 content dedupe
(`upload_records`). Absolute URLs built from the request `Host`. `message.attachments: string[]`.
Client does crop (`react-easy-crop`), video trim/crop, "send as GIF" (mute → server ffmpeg),
optimistic upload with progress (`uploadWithProgress` XHR). Three near-identical XHR uploaders in
`api.ts`; three server-side `dedupeOrStore`/`buildUrl` copies. No server resize / thumbnail /
transcode / blurhash. `originalFilename` returned but not persisted on the message.

## 2. Current architecture
```
pick file → client crop/trim → uploadWithProgress → POST /upload → {url (absolute), originalFilename}
→ send message with attachments:[url] → bubble renders <img>/<video> from getMediaUrl(url)
```

## 3. Current problems
- Absolute URLs baked from headers → break across environments/proxies (`getMediaUrl` has to fix them).
- Every file type accepted, 250 MB, no AV scan, no sniffing, no EXIF strip; served same-origin at `/uploads/*` with `ACAO: *` → stored-XSS / polyglot risk (SECURITY I4/T3).
- No web-size / thumbnail / blurhash → full-res originals downloaded by every viewer (PERF H8).
- No storage quota; disk-only; no CDN/cache headers.
- 3× duplicated dedupe + buildUrl + ffmpeg-path code (BACKEND dup).
- `originalFilename` lost → file bubbles show the hash.
- `blurhash` libs imported client-side with no hash source.
- `attachments: string[]` treated as 0–1 in most bubble code but multi-image messages exist.

## 4. Refactor goal
One `MediaService`: dedupe + validate + resize + thumbnail + blurhash + **relative URLs**,
isolated origin, quotas, GC. Normalised `media[]` on messages.

## 5. New architecture
```
POST /v1/media  (multipart, ≤ 50 MB default, type allowlist)
  → sniff content-type ; reject disallowed
  → SHA-256 dedupe (media_assets: {hash, kind, variants, w, h, blurhash, durationSec?, refCount})
  → image: sharp → {original, web(≤1600px), thumb(≤320px)} + blurhash
  → video: poster frame + (optional) transcode to a web profile ; probe duration ; strip metadata
  → returns MediaRef { id, kind, url (relative), thumbUrl, w, h, blurhash, durationSec? }
message.media: MediaRef[]  (id + denormalised display fields)
served from  media.<domain>  with Content-Disposition, immutable cache headers, no ACAO:* for active types
GC: refCount on media_assets; nightly sweep of refCount 0 older than 24h
```

## 6. Backend changes
- New `media/` module + `MediaService` + `media_assets` collection; delete `upload/*` copies, `gif`/`wallpaper` dedupe copies (they call `MediaService`).
- `sharp` (+ existing ffmpeg helper, deduped) pipeline.
- Relative URLs everywhere; a `MEDIA_BASE_URL` config the client uses to resolve.
- Per-user quota (config); `@nestjs/throttler` on upload.
- EXIF/metadata strip; magic-byte sniffing; extension/type allowlist.
- Migration: leave old absolute URLs working (a resolver rewrites known hosts → relative on read).

## 7. Frontend changes
- One `uploadMedia(file, onProgress)` (delete the 3 XHR copies).
- `<MediaMessage>` renders from `MediaRef`: blurhash placeholder → `<img srcset>` (thumb/web) → full on click (lightbox); `<video>` with poster + duration chip.
- Attachment tray: per-item edit (crop/trim) + remove; grid layout for 2–6.
- Persist `filename` on the message for `type: file`.

## 8. UI/UX
- Upload: inline progress ring on the optimistic bubble; cancelable; retry on failure.
- Images: rounded 12px, tap → lightbox (pinch/swipe), grid for multiples.
- Video: poster + play + duration; tap → fullscreen player; scrubbing.
- Files: card with icon by type + real filename + size + download.
- GIF: from library picker or "send as GIF" (mute a short video).
- Large file → clear "max 50 MB" message before upload starts (client pre-check).

## 9. Data contract
`MediaRef { id, kind: image|video|audio|file, url, thumbUrl?, w?, h?, blurhash?, durationSec?, sizeBytes?, filename? }`.
`MessageDto.media: MediaRef[]`.

## 10. Performance
- Viewer downloads web-size (~200–400 KB) not originals (multi-MB).
- Blurhash → instant layout, no CLS.
- CDN + immutable cache → repeat views ~free.
- Dedupe keeps storage bounded; GC removes orphans.

## 11. Migration
- New `/v1/media` alongside `/upload`; new messages use `media[]`.
- Read path: old `attachments: string[]` → mapped to `MediaRef` on the fly (kind from extension, no thumb/blurhash → lazy-generate on first view or leave as-is).
- Backfill job (optional) to generate variants for recent media.

## 12. Tests
- Type allowlist / sniffing (rename a script to `.png` → rejected).
- Dedupe (same bytes → same asset, refCount++).
- Variant generation (image dimensions, blurhash present); video poster + duration.
- Relative URL in stored data; resolves with `MEDIA_BASE_URL`.
- GC removes refCount-0 assets + files after the window.
- Quota enforcement.

## 13. Risks
- `sharp` native build in Docker → pin + test the image.
- Transcode cost/time for video → make it async (upload returns fast with poster; transcode in a job) or skip transcode initially.
- Old absolute URLs in prod data → keep the read-time resolver indefinitely.

## 14. Acceptance criteria
- Stored media URLs are relative.
- Uploads served from an isolated origin with `Content-Disposition` + immutable cache; no `ACAO:*` on active types.
- Every image has web + thumb variants + blurhash; videos have a poster + duration.
- One `MediaService`; the 3 dedupe/buildUrl copies are gone.
- Largest image a viewer downloads ≤ 400 KB.
- Orphaned files are GC'd; per-user quota enforced.
- `type: file` messages show the real filename after reload.
