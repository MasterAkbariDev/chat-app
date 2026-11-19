# Design System: "Hearth"

_Last updated 2026-10-03. Replaces the earlier "Modern Glassic" system (translucent glass, blur, glow and
floating islands), which was retired in the full UI/UX redesign. Source of truth: `frontend/src/app/globals.css`
(tokens) and `frontend/src/components/ui/` (primitives)._

## Principles
- **Solid, calm, layered surfaces.** No glass, blur, glow or decorative gradients. Panels sit flush and are
  divided by 1px hairlines, with no floating islands and no gaps around them.
- **For every age.** 15px body text, touch targets of at least 40px (44px preferred), plain sentence-case copy,
  WCAG AA contrast checked for every token pair.
- **One expressive device: per-person colour.** Every person or chat gets a stable hue (`personColor(id)` in
  `lib/avatar-color.ts`, FNV-1a hash across 8 hues). It colours their avatar, their name in group chats, and
  reply quote bars. **Circles are people; rounded squares are groups and channels.**
- **Motion answers actions.** Menus pop, sheets slide up and new messages settle in. There are no ambient or
  staggered entrance animations. `prefers-reduced-motion` is honoured globally.

## Tokens
Five themes (Daybreak, Aurora, Meadow, Rose, Mono), each with a light and dark mode, are selected by
`[data-theme][data-mode]` on `<html>`. An inline bootstrap script (`THEME_BOOTSTRAP_SCRIPT` in
`lib/themes.ts`) applies the stored choice before first paint, so there's no flash.

| Layer | Utility | Use |
|---|---|---|
| canvas | `bg-canvas` | app background, conversation pane |
| panel | `bg-panel` | nav rail, list pane, headers, composer dock, list groups |
| raised | `bg-raised` | menus, dialogs, popovers, cards |
| sunken | `bg-sunken` | inputs, hover fills, icon tiles |
| lines | `border-line`, `border-line-strong` | hairlines; hover/emphasis |
| text | `text-fg`, `text-fg-2`, `text-muted` | primary, secondary, meta |
| accent | `bg-accent` + `text-accent-fg`; `bg-accent-soft` + `text-accent-text`; `hover:bg-accent-hover` | filled; tinted/selected |
| bubbles | `bg-own` / `text-own-fg` / `text-own-meta`; `bg-other` | own / other message |
| status | `danger`, `success`, `warning` (+ `-soft`), `bg-online` | states, presence |
| person | `var(--person-N-bg)` / `var(--person-N-fg)`, N = 0–7 | via `personColor()` / `<Avatar colorId>` |

- **Radii:** 10px `--radius-sm` for controls; 14px `--radius-md` for cards, list groups and menus; 20px
  `--radius-lg` for dialogs and sheets; 18px `--radius-bubble`, whose sender-side corners tighten to 6px within
  a run of messages; `rounded-full` for chips, icon buttons and avatars.
- **Elevation:** `shadow-md` for popovers and `shadow-lg` for dialogs and menus only. Flat surfaces have none.
- **Type:** Figtree for the UI; Vazirmatn as a per-glyph fallback for Persian and Arabic; Bricolage Grotesque
  (`font-display`) only for page titles and the auth hero. Scale: 12.5 / 13.5 / 15 (body) / 16–17 / 18
  (dialog titles) / 20–24 (page titles) / 28–30 (hero). Use `tabular` for times and counts. Never monospace.
- **Focus:** one global `:focus-visible` ring (2px accent, 2px offset), in `@layer base` so utilities can
  override it; `focus-inset` for full-bleed rows.
- **Cascade:** base styles live in `@layer base`, so Tailwind utilities always win. Don't add unlayered global
  rules.

## Primitives (`components/ui/`)
- `Button` (primary | secondary | ghost | danger | danger-soft; sm | md | lg; `loading`, `block`) and
  `buttonClasses()` for links.
- `IconButton` (ghost | subtle | accent | danger; `aria-label` is required and doubles as the tooltip).
- `Field` (label, `labelAside`, hint and error, all auto-wired with `htmlFor` / `aria-describedby` /
  `aria-invalid`), `Input`, `Textarea`, `PasswordInput`.
- `Chip` (`aria-pressed` filter), `SegmentedTabs` (radiogroup with arrow keys), `Switch` (role=switch),
  `TagInput`.
- `Avatar` (`colorId`, `name`, `shape`, `presence`, `src`).
- `Dialog` and `ConfirmDialog`: portal, focus trap, dialog stack (only the top dialog handles Esc and Tab),
  focus returns to the opener, scroll lock, bottom sheet on phones. **Every modal uses these.** Destructive
  actions always confirm, with the action named in the button ("Delete for everyone").
- `Menu`, `useMenuState()`, `useLongPress()`: a portalled, collision-aware action menu with the full keyboard
  model. It opens from a ⋯ button, a right-click, or a long-press on touch.
- `ListGroup` / `ListItem` for settings-style screens; `PageHeader` / `PageBody` as the frame for every
  secondary screen.
- `DatePicker`: a calendar in a `Dialog` (card on desktop, sheet on phones), following the WAI-ARIA date picker
  dialog pattern. Arrows move by day or week (mirrored in RTL), Home/End go to the week's ends, PageUp/PageDown
  move by month (with Shift, by year), and Enter picks. The heading opens a month/year grid, and there's a Today
  button. It takes `min`/`max` and `dimBefore`; days are 44px. Month names, digits and the week's first day come
  from `Intl` for the device locale, always on the Gregorian calendar. Values are local `YYYY-MM-DD` strings
  (helpers in `lib/calendar.ts`); never use `toISOString()` for these. It powers the chat's "Jump to date", where
  days before the first message are dimmed. Don't use native `<input type="date">`.
- `EmptyState`, `Skeleton` / `SkeletonRow` / `SkeletonList`, `Spinner`.
  `MessageListSkeleton` (`components/chat/`) shows placeholder bubbles while a conversation's first page loads.
  The pulse stops under Reduce motion.

## Layout
- **Desktop (`lg`+):** a 72px nav rail, a 352px chat list and the routed page, all flush.
- **Phone:** full-screen pages. The Chats, Contacts and Settings tabs show a bottom tab bar (with safe-area
  padding). The bar is hidden inside a conversation and in the new-chat flow.
- **Chats in the nav:** the unread badge counts non-muted chats with anything unread.

## Conversation behaviour
- A chat opens at the first unread message (under a "New messages" divider) or else at the newest message.
  Short conversations are anchored to the bottom.
- New messages keep the view pinned to the bottom while you're there. If you've scrolled up, they're counted on
  the jump-to-latest button instead.
- Runs of messages from the same sender within 5 minutes share corners, one name and one avatar (groups only).
  Timestamps, edited state and delivery ticks sit inside the bubble.
- Message actions: a hover/focus action bar (react, reply, more), right-click, or long-press, which also shows a
  quick-reaction strip. Swipe-to-reply is touch only, so dragging with a mouse still selects text.
- Composer: auto-growing textarea. On desktop Enter sends and Shift+Enter adds a newline; on touch devices the
  return key adds a newline. Reply and edit banners, an accessible @mention listbox, and an emoji/sticker
  picker. With an empty field, the send slot offers voice and video messages (see below).

## Voice and video messages
- With nothing typed, the composer's send slot is a single **record button** (`components/media/RecordButton.tsx`):
  - **Tap** switches between voice and video. The choice is remembered in `localStorage` (`chat:record-mode`)
    and announced with a short hint.
  - **Hold** (300 ms, with a ring that fills while you hold) starts recording in the current mode. On a keyboard,
    hold Enter/Space; a quick press switches modes.
  - Once recording starts, the recorder takes over, so letting go doesn't send.
  - The button only appears where the browser can record (a secure context with MediaRecorder).
- **Voice** (`components/media/VoiceRecorder.tsx`) replaces the composer row while recording:
  - Controls: discard, pause/resume, stop to listen back, and send (which works mid-recording too).
  - Shows a live input-level meter and a timer that counts only recorded time.
  - Stops itself at 15 minutes.
  - Uploads via `POST /upload` (stored as-is), preferring AAC/M4A over Opus/WebM.
  - The message stores `durationSec` and a 48-bar `waveform`.
- **Video messages** (`VideoNoteRecorder.tsx`, type `video_note`) are round, Telegram-style clips:
  - The camera is drawn centre-cropped and mirrored into a 480×480 canvas, and that canvas is what's recorded.
  - A progress ring fills towards the 60-second cap.
  - Controls: pause/resume, switch camera (if there's more than one), stop to watch it back, record again,
    discard, and send.
  - Recording pauses automatically when the tab is hidden.
  - Uploads via `POST /upload/video` at 480p, where it's transcoded to H.264/AAC MP4.
- **Players** (`VoicePlayer`, `VideoNotePlayer`): the voice player has a seekable waveform that also works as a
  keyboard slider, plus 1×/1.5×/2× speed. The video player is tap-to-play with a progress ring and duration badge.
  Only one clip plays at a time.
- **Backend:** `/uploads/*` sends `Cross-Origin-Resource-Policy: cross-origin`, so the web app (a different
  origin) can embed uploaded media. Every other route keeps helmet's `same-origin`.

## Photos
- **Several profile photos/videos per person**, ordered main first; everyone can see all of them. Manage them in
  "Profile photos" (`components/profile/ProfilePhotosManager.tsx`), opened from Settings (tap your avatar), Edit
  profile, or your own profile: add (image ≤ 10 MB, video ≤ 50 MB → "Preparing your video…"), "Set as main photo",
  Open, Delete. Changes save immediately.
- **Profile videos** are cut server-side to a silent ≤ 10 s, 640 px square loop (tens of KB). `avatarUrl[0]` is always a
  still (the main image or the video's poster), so lists and small avatars stay cheap; `avatarVideoUrl` is set when
  the main photo is a video.
- **`LoopVideo`** (`components/media/LoopVideo.tsx`) is the only way to show a looping avatar video: plays only while
  ≥ 50% on screen and the tab is visible, at most 2 decoding at once, poster only in Lite mode / Reduce motion /
  animated media "off", play-on-hover for "hover".
- **Profile header** (`components/profile/ProfileHero.tsx`, Telegram-style): a 120 px circle with name, @username and
  status; tap, Enter or pull down expands it to a full-width square (transform/clip-path only) with the name on a
  gradient. Galleries have segment bars, an "n / N" counter, tap halves / swipe / ←→ to move, next photo preloaded.
  Scroll down, push up or Esc collapses it. "View full screen" opens `ProfilePhotoViewer` (n / N, thumbnails, swipe
  down or Esc to close). "Set as main" appears only on your own profile.
- **Chat header:** in a DM whose partner's main photo is a video, the 40 px header avatar loops it through `LoopVideo`
  (via `Avatar`'s `media` slot); the chat list sends `otherUser.avatarVideoUrl` for this. List rows stay stills.
- **Group/channel photo:** when creating it (New → Group/Channel), or Chat info → Edit (needs "change info").
- `Avatar` falls back to initials if a photo fails to load.

## Wallpapers
- **Per chat** (DMs and groups): the chat's ⋮ menu → "Change wallpaper", or Chat info → Wallpaper
  (`/app/settings/wallpaper?chat=<id>`). It overrides the global one for you only, and posts a "changed the chat
  wallpaper" message whose "Use this wallpaper" button lets the others take it too (Telegram's "set for both").
- Settings → Wallpaper: presets, or **Choose from device** (image ≤ 15 MB, video ≤ 60 MB), applied globally or per chat.
  Videos are cut server-side to a silent ≤ 10 s loop, ≤ 1280 px, ≤ 24 fps (≈ 0.7 MB) with a poster.
- `components/chat/ChatWallpaper.tsx` renders it: the video pauses when the tab is hidden, the pane is off screen, or
  the window has been unfocused for 30 s, and isn't mounted at all (poster only) in Lite mode, Reduce motion, animated
  media "off", Save-Data or low battery. No filters on a playing video: dim and brightness are overlays, and blur only
  applies to the poster.

## Groups and channels
- **Public or private.** Public chats have an @link, show up in search, and anyone can preview them (read-only,
  with a "Join group/channel" bar) before joining. Private chats are joined by invite link only; to a non-member
  they don't exist ("This chat is private").
- **Roles and rights** (Telegram-style, `backend/src/chat/permissions.ts`):
  - **Owner:** everything; the only one who can delete the group/channel (Chat info → danger zone) and change
    public/private and the @link.
  - **Admins** each have their own rights: change info, delete messages, ban and restrict, invite people, pin, add
    admins; channels add post messages and edit others' posts. A new admin gets all but "add admins". An admin with
    "add admins" grants only rights they hold and edits only admins they appointed; rights they lack stay as the
    owner set them (`AdminRightsDialog`).
  - **Members (groups):** group-wide defaults (send messages, media, stickers & GIFs, voice & round video, add
    members, pin, change info) plus per-person exceptions in either direction (`MemberPermissionsDialog`, "Exception"
    badge). `sendMessages: false` is "muted". Managed on Chat info → Permissions (`/app/c/<id>/permissions`).
  - The UI only offers what `myPermissions` allows (`hooks/use-chat-permissions.ts`); the server enforces it too.
- **Invite links** (`/app/join/<code>`, Chat info, owner/admin): Copy, Share, Reset (the old link stops working).
  Signed-out visitors go back to the invite after signing in. The code is never sent to anyone else.
- **Composer:** in a channel only the owner and admins post; subscribers get a Mute/Unmute bar instead. A group
  member muted by an admin sees "Admins have muted you in this group".
- **Live updates:** `chat_updated` (name, photo, visibility), `channel_roles_updated` and `chat_permissions_updated`
  refresh the list, header, info and permissions screens; `chat_deleted` drops the chat and leaves it if open
  ("This group was deleted") — all in `hooks/use-chat-meta-events.ts`.

## Search
- One box (chat list, and Ctrl/⌘ K) with sections **Chats** (your own, instant, from 1 character), **People**,
  **Public groups & channels** (with Join) and **Messages** (your chats only; opens at the message with
  `?message=<id>`). Filter chips narrow it to one section; `@name` puts People first.
- **Matching:** every typed word must match the start of a word ("kar" finds "Karimi"); Persian and Arabic ی/ي and
  ک/ك match each other. Messages match anywhere in the text. Matches are highlighted.
- 4 results per section, then "Show more" / "Load more" (offset paging). Recent searches and recently opened
  results show when the box is empty. Full keyboard support (↑/↓, Enter, Esc; Shift+Enter joins a public chat).
- Server: `GET /v1/search?scope=&q=&limit=&offset=`, 90/min. User input is always regex-escaped.

## Privacy (Settings → Privacy and security)
- Telegram's model: Phone number (default My contacts), Email (Nobody), Last seen & online, Profile photos, Bio,
  Calls, Groups & channels, Forwarded messages (all Everybody), Find me by username (Everybody), Find me by phone or
  email (My contacts). Each is Everybody / My contacts / Nobody plus **Always allow** and **Never allow** lists.
  "My contacts" = people *you* saved. Rows show the value with counts ("Nobody (+2)", "My contacts (−1, +2)") and
  open `/app/settings/privacy/<key>`; changes save at once (optimistic, rolled back on error).
- The server filters everything (`backend/src/privacy/`), so the UI only has to handle missing values gracefully:
  no photo → initials, empty gallery; no bio/phone/email → no row; hidden last seen → "last seen recently /
  within a week / within a month / a long time ago" (`lib/last-seen.ts`); `canCall: false` → the call button stays
  visible but inert with "X doesn't accept calls from you"; group pickers show "Can't be added — their privacy
  settings" and, after a refused add, offer **Send invite link**.
- Last seen is reciprocal: hide yours from someone and you don't see theirs (also read times in message info).

## Stickers, GIFs and animated emoji
- **Stickers and GIFs** are always sent as their own message, never mixed into text.
- **Animated emoji** go *into* the text like regular emoji (`components/chat/RichMessageInput.tsx`, a
  contenteditable field that shows them inline as you type). The picker stays open so you can add several.
  - **Storage:** the message keeps a unicode stand-in for each one in `content` (the item's first emoji keyword), plus
    `customEmoji: [{offset, length, packItemId}]` (UTF-16 offsets). Previews, search, notifications and older
    clients still read naturally.
  - **Server checks:** the server checks every span, only accepts items from animated-emoji packs the sender has
    added, and fills in `packId`/`relativePath` itself.
  - **Edits:** editing re-sends the full set.
- A message made of only 1–3 emoji (animated or regular) shows large, without a bubble.

## Picker layout
- Every tab (Emoji, Animated, Stickers) has a **jump row** under the tabs, with one button per section showing that
  section's first item (always the still frame, so the row doesn't flicker).
  - Tapping a button scrolls that section to the top.
  - The button for the section you're scrolled to is highlighted (scroll-spy).
  - The pack tabs end the row with "Manage packs".
- Grid sizes: emoji 8 columns, **animated emoji 7 columns (~40px cells)**, stickers 4 columns.

## Media performance
- **Small variants:** pack items carry `thumbPath` (128px WebP, animation kept, re-timed to ~17 fps) and `stillPath`
  (first frame) next to `relativePath` (original).
  - **Generation:** they're made at upload, or backfilled in the background the first time an older item is read.
    Variants are versioned by file name, so changing the size regenerates them.
  - **Who uses what:** grids, inline emoji and reaction pills use the small variant; a sent sticker uses the original.
  - **Savings** on the demo packs: stickers 915 KB → 55 KB, animated 5.4 MB → 1.1 MB, stills 58 KB.
- **`<PackImage>`** (`components/packs/PackImage.tsx`) decides between animated and still. It uses one shared
  IntersectionObserver, so off-screen items show their still and nothing decodes frames nobody can see.
- **Rate limiting:** media files (`/uploads/media/*`) are not rate-limited like the API. They're immutable and
  year-cached, and one picker open legitimately loads dozens of them.

## Media in messages
- **Placeholders** (`components/media/BubbleMedia.tsx`): every photo, GIF and video box is sized from
  `attachmentMeta` width/height *before* anything loads (aspect clamped to 0.6–1.9, max 380 px tall; 4:3 photos /
  16:9 videos when unknown; grid cells are square), so the chat never jumps. Under it: the blurhash (decoded once
  and cached) or a soft pulse (stilled by Reduce motion / Lite). The media fades in on load; a failed photo tries
  the original once, then shows "Couldn't load photo · Try again". Stickers keep their own aspect ratio (`attachmentMeta`/pack item width×height), long side clamped to 120–200 px (`stickerBox()`); 160 px square until the size is known.
- **Sizes** (`lib/media-src.ts`): bubbles never load an original when a smaller copy exists. MediaService photos use
  `thumb.jpg` / `web.jpg` via `srcset`; old `/uploads/<file>` photos use `GET /uploads/_w/<320|640|1280>/<file>` —
  WebP copies made on first request by the backend (`src/media/legacy-resize.*`), cached under
  `uploads/_resized/`, year-long immutable cache (falls back to the original if it can't be decoded). All `/uploads`
  files are content-hash named and served `immutable` too. Images are `loading="lazy"`, `decoding="async"`.
- **Viewer** (`components/media/MediaViewer.tsx`): tapping a photo, GIF or video opens a full-screen overlay (never a
  new tab) over the chat's loaded media — sender, date, "n of N", download, close. ←/→, swipe or the side buttons
  page; Esc or swipe down closes; focus is trapped and returns to the bubble. Photos: the bubble's copy shows at once,
  the 1280 px / web copy fades in, the original loads only when zoomed in past 1.6×; pinch, wheel, double-tap or +/−
  zoom, drag pans. GIFs play large, looping and muted with no controls; a tap pauses. `ConversationView` mounts
  `MediaViewerProvider`; without one a bubble opens its own media only.
- **Video player** (`components/media/VideoPlayer.tsx`): in bubbles, a poster with a play button, duration badge and
  "Open full screen"; it plays inline with slim controls. In the viewer: play/pause, a scrubber with the buffered
  range, time, mute + volume, speed (1× / 1.5× / 2× / 0.5×), full screen; Space/K, J/L (±10 s), M, F; controls
  fade after 2.5 s of playback. One clip plays at a time. Round video messages keep `VideoNotePlayer`.
- **Now playing** (`lib/playback.ts`, `components/media/NowPlayingBar.tsx`): voice and round video messages in chats
  play through one app-wide player, so they keep playing while you scroll (even when the bubble is virtualised away) and
  when you change chats or pages. A strip under the chat header (top of the page elsewhere) shows play/pause, who and
  when (tap to jump to the message), a seekable progress line, speed (1× / 1.5× / 2×, shared) and close. A finished voice
  message moves on to the chat's next one. Recording review keeps playing locally.
- **Round video messages:** a silent looping preview while on screen (if animated media is "Play"); a tap plays from
  the start with sound and the circle grows to min(320 px, 80vw) (no animation with Reduce motion), with a progress
  ring. Drag around the circle (or ←/→) to seek, with a time tooltip; tap pauses; it shrinks back when it ends or is
  closed. Scrolled out of view, it continues in a floating circle in the corner (`PlaybackHost`, mounted in AppShell).
- **Files and music** (attach menu → File / Music, any number at once, up to 200 MB each, via `POST /upload/file`;
  kept byte-for-byte): `FileMessage` — a round icon tinted by type (person hues: PDF red, sheets green, archives amber,
  …) or a thumbnail for images, name ellipsized in the middle so the extension stays, "size · EXT"; tap downloads with a
  progress ring (tap again cancels), then saves/opens. `MusicMessage` (type `audio`; audio picked under File goes out as
  music too) — round play button over the cover art, title and artist from the file's tags (server-side, ffmpeg), seek
  bar once started; plays through the now-playing bar with previous/next through the chat's music and no speed control.
  Sending shows the bubble at once with an upload ring (cancel / retry / remove).
- **Backfill:** `backend/scripts/backfill-legacy-media-meta.ts` gives old `/uploads/...` photo messages their
  width/height/blurhash (`npm run migrate:media-meta -- --dry-run`; in the production image
  `node dist/scripts/backfill-legacy-media-meta.js` with `DATABASE_URL` and `LEGACY_UPLOADS_DIR`). Safe to re-run.

## Motion & performance settings (Settings → Appearance)
Saved per device in `localStorage` (`chat:performance`), applied to `<html>` before first paint
(`data-motion="reduce|full"`, `data-lite`):
- **Lite mode:** for older devices. Reduces motion, shows stills only, and skips the wallpaper blur.
- **Reduce motion:** Device (default) / On / Off. Kills CSS animations and transitions, and makes scrolling instant.
- **Animated emoji & stickers:** Play (while on screen) / On hover (or tap) / Off (first frame). When Reduce motion is
  on, Play is downgraded to On hover.

