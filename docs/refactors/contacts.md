# Refactor Spec: Contacts (address book)

> New feature per DECISIONS Q14. Public discovery stays **username-only**; a Contacts address book
> lets people who already know each other's phone/email save each other.

## 1. Current implementation
None. The `/contacts` route is just a filtered view of private chats + a `usersApi.search` box
that (badly) exposes email/phone of anyone. There is no saved address book, no custom names.

## 2. Current problems
- `GET /users/search` returns `email`, `phoneNumber`, `isOnline`, `lastSeen` for any substring →
  enumeration/scraping (SECURITY D1).
- "Contacts" duplicates the DM list with no added value.
- No way to save someone under a name you choose, or to find them later without scrolling DMs.

## 3. Refactor goal
A real address book: add by **username** (public) or by **exact phone / exact email** (only if you
already know it), store a **custom name**, list with presence, one-tap DM. Phone/email never appear
in public/global search.

## 4. New architecture
```
contacts { ownerId, userId, customName?, savedAt }   indexes: {ownerId, userId} unique, {ownerId, savedAt}
POST   /v1/contacts { username } | { phone } | { email }
   → resolve to exactly one user (exact match on phone/email; rate-limited; generic error if none)
   → create the contact (idempotent)
GET    /v1/contacts        → [{ user: PublicUserDto, customName?, presence, lastDm?: {channelId, at} }]
PATCH  /v1/contacts/:userId { customName }
DELETE /v1/contacts/:userId
GET    /v1/search?scope=people   → username + display-name $text ONLY (never phone/email)
```
- Optional (mobile): `POST /v1/contacts/match { hashes: [...] }` — client sends salted hashes of
  device-address-book phone/emails; server returns which correspond to users. Privacy-gated,
  explicit opt-in, hashes not stored.

## 5. Backend changes
- New `contacts` collection + module (part of `users`).
- Exact-match resolvers for phone/email (normalise phone to E.164; lowercase email); heavy rate
  limit (e.g. 20/day/user) + a generic "no user found" to prevent probing.
- `people` search projection = `PublicUserDto` (no email/phone/status).
- `POST /channels/direct` accepts a contact's `userId`.
- Contact list enrichment: batch presence + last-DM lookup in one aggregation.

## 6. Frontend changes (web + app)
- Contacts screen: "Add contact" → choose method (username / phone / email) → resolve → confirm
  with the found profile → optional custom name → save.
- Contact row: custom name (or display name), @username, presence, "Message".
- `useContacts()` (RQ / Riverpod).
- Remove the old `usersApi.search`-with-PII box; the "New DM" flow uses username search + contacts.
- Mobile: optional "Find friends from your contacts" (opt-in, hashed match).

## 7. UI/UX
- Empty: "No contacts yet. Add someone by their @username — or by phone/email if you have it."
- Add-by-phone/email hint: "You can only add people whose number or email you already know."
- Custom name shown everywhere that user appears **to you** (chat list, DM header) with the real
  @username as a subtitle.
- Duplicate add → "Already in your contacts" + jump to them.

## 8. Data contract
`ContactDto { user: PublicUserDto, customName?, savedAt, presence, lastDm?: { channelId, at } }`.

## 9. Performance
- Contact list: one aggregation (users + presence + last DM), not N requests.
- Add: one exact-match query, rate-limited.

## 10. Migration
- New feature — nothing to migrate. Optionally seed each user's contacts from their existing DM
  peers (with no custom name) so the screen isn't empty on launch.

## 11. Tests
- Add by username / exact phone / exact email; non-exact phone/email → generic "not found".
- Rate limit enforced; probing many numbers is blocked.
- `people` search never returns phone/email (leak test).
- Custom name renders in the chat list + DM header for the owner only.

## 12. Risks
- Phone matching needs consistent normalisation (E.164) — validate + normalise on register too.
- The hashed device-contact match must not become a scraping vector → per-request cap, opt-in,
  no storage.

## 13. Acceptance criteria
- Users add contacts by username, exact phone, or exact email; results carry a custom name.
- Public/global people search returns username + name only — never phone/email.
- Adding by phone/email is rate-limited and non-probeable.
- Contact list loads in one request; "Message" opens/creates the DM.
