# Refactor Spec: User Profile & Preferences

## 1. Current implementation
`user` doc: firstName, lastName, username (unique, lc), email (lc), phoneNumber, bio,
`image: string[]` (avatars), `bigEmojis`, `quickReaction`, `isOnline`, `tokenVersion`,
`globalWallpaperId`. `POST /users` (partial update, DTO field `image`), `PATCH /users/quick-reaction`,
`GET /users/:username` (hand-picked subset, throws 404), `GET /users/by-id/:userId`,
`GET /users/:userId/status` (leaks email). Web: `/profile`, `/profile/edit`, avatar add/remove
with crop + lightbox (multiple avatars).

## 2. Current architecture
```
/profile/edit → usersApi.update({firstName,lastName,username,bio}) → POST /users
avatar → uploadApi.uploadImage → usersApi.update({avatarUrl:[...]})   ← sends `avatarUrl`, schema is `image`
```

## 3. Current problems
- **`image` vs `avatarUrl` mismatch** across schema / DTO / frontend / `.select("avatarUrl")` in `chat.service` (which then reads `undefined`). Confirmed latent bug.
- `findByUsername` returns a bespoke subset (no avatar), declared `|null` but throws 404.
- No `user_profile_updated` broadcast → stale names/avatars in open chats.
- `POST` for update (should be `PATCH`); `email` change allowed with no re-verification.
- `PATCH /users/quick-reaction` does a full `findOne` to validate existence.
- `/users/:userId/status` leaks `email`.
- Multiple avatars — product value unclear; adds lightbox/remove complexity everywhere.
- Client prefs (`bigEmojis`, `quickReaction`) stored as top-level user columns.
- `/profile` = 663 LoC single screen (account + appearance + notifications + security + logout).

## 4. Refactor goal
One field name, one `PublicUserDto`, `PATCH` semantics, profile-update broadcast, prefs separated,
settings grouped, status minimal.

## 5. New architecture
```
users/     UserService → UserRepository ; PublicUserDto mapper (never email/phone/password/isDeleted)
PATCH /v1/users/me            partial: displayName parts, username, bio, avatar
PATCH /v1/users/me/preferences  { theme?, bigEmojis?, quickReaction?, messageTextSize?, readReceipts?, lastSeenVisibility? }
GET   /v1/users/:idOrUsername  PublicUserDto (one resolver, id or @username) — blocked → 403
GET   /v1/users/:id/presence  { status, lastSeen? }  (no email; see presence spec)
avatar: single `avatarUrl` (or `avatarUrls` if multi confirmed) via MediaService
on change → emit user.profile.updated → realtime patches open chats/list caches
```

## 6. Backend changes
- Rename schema `image` → `avatarUrl` (migration); DTO + frontend align.
- Split preferences into `user.preferences` sub-doc (or a `user_prefs` doc); keep them out of `PublicUserDto`.
- `PublicUserDto` mapper everywhere a user is returned.
- One `GET /users/:idOrUsername` resolver; return null → 404 consistently via the filter.
- `quick-reaction` folded into `PATCH /users/me/preferences`; no existence pre-check.
- `email` change → separate verified flow (or disallow until email infra exists).
- Emit `user.profile.updated { id, displayName, avatarUrl }` on relevant changes.

## 7. Frontend changes
- `/app/settings/*` split: Profile / Appearance / Notifications / Privacy / Wallpaper / Security / About.
- `useMe()` (RQ) + `useUpdateMe()` / `useUpdatePreferences()`.
- Realtime `user.profile.updated` patches `participantsMap`, chat list rows, message sender snapshots.
- Single avatar picker (crop → upload → set) unless multi confirmed.

## 8. UI/UX
- Profile: identity card (avatar, name, @username, bio) + inline edit; presence dot from the presence hook.
- Appearance: theme, message text size (S/M/L), big emojis, quick reaction (emoji picker).
- Privacy: blocked users list, last-seen visibility, read receipts toggle.
- Each settings page ≤ ~150 LoC, one concern.
- Copy-username action; QR/share link optional.

## 9. Data contract
`PublicUserDto { id, username, displayName, firstName?, lastName?, bio?, avatarUrl? }`.
`MePreferencesDto { theme, bigEmojis, quickReaction, messageTextSize, readReceipts, lastSeenVisibility }`.

## 10. Performance
- No stale-profile refetch loop; realtime patch instead.
- `quick-reaction` update = 1 write (was findOne + updateOne).
- `PublicUserDto` smaller than the raw doc.

## 11. Migration
- `image` → `avatarUrl` field rename (script; keep a read alias for one release).
- Move `bigEmojis`/`quickReaction` into `preferences` (copy, keep old columns readable briefly).
- New `/v1/users/*` alongside old.

## 12. Tests
- `PublicUserDto` leak test (no email/phone/password/isDeleted).
- Field-rename migration idempotent; `chat.service` avatar resolves after rename.
- `user.profile.updated` patches open caches (name change reflects live).
- Blocked → 403 on the unified resolver.

## 13. Risks
- Field rename touches many files → do it mechanically + a codemod; strong test around `chat.service` DM display.
- Multi-avatar removal is a product call — confirm first.

## 14. Acceptance criteria
- One avatar field name across schema/DTO/frontend; the `chat.service` DM-avatar bug is fixed.
- Every user-returning endpoint uses `PublicUserDto`; no email leak in status.
- Profile changes propagate live to open chats/list.
- Settings is 7 focused pages, none > ~150 LoC.
- `quick-reaction` update is 1 DB write.
