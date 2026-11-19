# Refactor Spec: Search (users, channels, in-chat messages)

## 1. Current implementation
- **Users:** `GET /users/search?q=` — `$regex` (case-insensitive) across username/email/firstName/lastName/phoneNumber; returns full user docs (email, phone, isOnline, lastSeen).
- **Channels:** `GET /chats/search` == `GET /chats` — `$regex` on name/link; full docs; excludes `saved-*`.
- **In-chat:** `GET /messages/channel/:id/search?q=` — `q==='@'` → `mentions: me`; else `$regex` on `content`; returns up to 500 ordered ids + total. Client loads pages until each hit is visible, then scrolls.
- **Date jump:** 3 endpoints (`first-of-date`, `first-from-date`, `oldest`).

## 2. Current problems
- **ReDoS** — user `q` goes straight into `$regex` (SECURITY I2).
- **No text index used** — chats have a `$text` index that's ignored; collection scans everywhere.
- **PII exposure** — user search returns email/phone → enumeration/scraping (SECURITY D1).
- In-chat search returns 500 ids; the "load until visible then scroll" client loop is fragile / double-fetches.
- 3 date endpoints repeat the full guard.
- No global search (people + channels + messages in one place).
- Channel search + list are the same endpoint wired twice.

## 3. Refactor goal
Indexed, injection-safe search; narrowed user results; one in-chat search that returns a
navigable window; one date-locate endpoint; a unified global search entry.

## 4. New architecture
```
GET /v1/search?q=&scope=people|channels|messages&cursor=
  people   → $text on {username, firstName, lastName} (NOT email/phone) ; min q length 2 ; PublicUserDto[]
  channels → $text on {name, description} for public/discoverable ; ChannelSummaryDto[]
  messages → (global, across the user's channels) $text on message content ; grouped by channel
GET /v1/channels/:id/messages/search?q=&cursor=  → { matches: [{ messageId, snippet, createdAt }], nextCursor }
GET /v1/channels/:id/messages/locate?anchor=messageId|date|oldest  → { cursorWindow }  (merges the 3 date endpoints)
```
- Text indexes: `user {username:'text', firstName:'text', lastName:'text'}`, keep `chats` text
  index, add `messages {content:'text', channelId:1}` (or a dedicated search field if `$text`
  scoring is insufficient — future).
- Escape/normalise `q`; reject pathological input; rate-limit search.

## 5. Backend changes
- New `SearchController` (`/v1/search`) delegating to per-scope services.
- `messages` text index (or partial — only non-deleted, non-system).
- `locate` endpoint replacing the 3 date-nav ones; single guard via `ChannelMemberGuard`.
- In-chat search returns snippets + a cursor window per hit, not 500 bare ids.
- User search projection = `PublicUserDto`; drop email/phone/status.

## 6. Frontend changes
- Global search field at the top of `/app` (Chats list) with scope tabs (Messages · People · Discover).
- In-chat search bar (header): results list with snippets → tap → `locate` → scroll+highlight (no manual pagination loop).
- Date picker → `locate?anchor=date`.
- `useSearch(q, scope)` (RQ, debounced).

## 7. UI/UX
- Global: type → live results grouped by scope; empty/no-results states; recent searches.
- In-chat: match count "3 of 12", up/down nav, highlight, `Ctrl/Cmd+K` to open.
- People results: avatar + name + @handle + "Message" action.
- Discover: channel card + member count + Preview/Join.

## 8. Data contract
`GET /v1/search → { people?: PublicUserDto[], channels?: ChannelSummaryDto[], messages?: [{ channelId, channelTitle, matches: [{ messageId, snippet, createdAt }] }], nextCursor? }`.

## 9. Performance
- Text-index lookups instead of full scans.
- In-chat: one `locate` call per hit navigation instead of a paginate-until-visible loop.
- ReDoS eliminated.

## 10. Migration
- Add text indexes (background build).
- New `/v1/search` + `locate` alongside old; migrate the frontend; remove old routes.

## 11. Tests
- ReDoS: pathological `q` returns quickly / is rejected.
- User search excludes email/phone; min-length enforced.
- `$text` index used (`explain`).
- `locate` correctness for messageId / date / oldest anchors; scroll+highlight e2e.
- In-chat next/prev navigation.

## 12. Risks
- `$text` relevance may be weak for short queries / non-Latin → acceptable v1; a real search engine (Meilisearch/OpenSearch) is a later option (OPTIMIZATION_BACKLOG O3).
- Message text index size on large histories → partial index (exclude deleted/system) + monitor.

## 13. Acceptance criteria
- No user input reaches `$regex` unescaped; search is rate-limited.
- User search returns `PublicUserDto` only (no email/phone/status).
- Chat + message + user search use indexes (`explain` verified).
- One `locate` endpoint replaces the 3 date endpoints.
- In-chat search navigates via `locate`, not a client paginate loop.
- Global search entry exists (Messages · People · Discover).
