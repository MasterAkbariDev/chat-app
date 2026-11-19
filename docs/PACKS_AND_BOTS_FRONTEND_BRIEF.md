**Update (2026-10-02): inline animated emoji.**
- **Where they go:** animated emoji (pack `type: "emoji"`) are now placed *inside* text messages, like regular emoji,
  instead of being sent as their own message. Stickers and GIFs are still sent on their own.
- **Payload:** `send_message` and `POST /messages` accept `customEmoji: [{offset, length, packItemId}]` (UTF-16 offsets
  into `content`, where a unicode fallback sits). `PUT /messages/:id` accepts the same; omitting it clears them.
- **Server rules:**
  - The server trims leading whitespace and shifts offsets to match.
  - It drops spans that are invalid, overlapping or contain whitespace.
  - It rejects sticker items (400) and items from packs the sender hasn't added (403).
  - It stores `{offset, length, packItemId, packId, relativePath}` on the message.

# Packs (stickers & animated emoji) + Bots — frontend implementation brief

**Update (2026-09-09):** a pack item now has a third way to be used, beyond send/preview below —
as a **message reaction**. `POST /messages/:id/reaction` accepts `{packItemId}` as an alternative
to `{emoji}` (exactly one, never both), gated by the same owner-or-subscriber rule as sending one
(and bumps its usage the same way); the response's `reactions` array and the `reaction_changed`
socket event both carry `packItemId`/`relativePath`/`packId` alongside the existing `emoji` field.
See `docs/plans/BACKEND_PLAN.md` B5 and `docs/plans/FRONTEND_PLAN.md` F5 for the full detail;
frontend lives in `MessageBubble.tsx` (reuses `StickerEmojiPicker` for the reaction picker) and
`ConversationView.tsx`.

**Update (2026-09-09, later the same day):** the "encountered via a received message" gap below
(§ "The core interaction to get right") is now closed too — sending a sticker/animated-emoji
message optionally carries `packItemId`, resolved + authorized server-side the same way a
reaction is, and persisted as `packId`/`packItemId` on the message (a forward copies the
original's). `MessageBubble` now wraps a sticker's image in a button when `packId` is present,
opening `PackPreviewSheet` — the exact "tap it → modal with Add/Remove" interaction this brief
describes below, now reachable from *either* discovery path, not just search/link.

Backend-complete, live-verified (`chat-app/backend`, commit tagged "B13" in its own README).
This document is written to be handed directly to whoever/whatever implements the frontend for
this feature — copy the "Prompt" section below as-is if you're briefing another AI, or read the
whole thing if you're implementing by hand. It deliberately does **not** prescribe frontend code
or component structure — that's a frontend decision — it specifies the contract and the required
behavior precisely enough that any competent implementation will match what Telegram users
already expect.

---

## Prompt

> Implement the frontend for two backend features that already exist and are live: **sticker &
> animated-emoji packs** (Telegram-style — packs you create or add to your own collection, not a
> flat global sticker library), and a **bot** surface for managing them, driven entirely by
> server-provided GUI menu screens (never `/text commands`).
>
> **Emoji picker changes:** the existing emoji picker gets a new, separate tab for **animated
> emoji**, sitting alongside (not merged into) the regular unicode emoji grid. Regular/"base"
> emoji are unchanged — same client-side unicode picker as today, no backend involvement, no
> ownership concept. Animated emoji only appear if the user has added that emoji **pack** to
> their own collection first (see below) — there is no "everyone has all animated emoji" state.
>
> **Sticker picker:** works identically to the animated-emoji tab, structurally — packs you own or
> have added, browsable/searchable, tap to send.
>
> **The core interaction to get right (this is the whole feature):** a pack is either *discovered*
> (search, or opened via a shared link) or *encountered* (someone sends a sticker/emoji from a
> pack you don't have) — either way, tapping it opens a **modal or bottom sheet** showing the
> pack's name, its items (grid preview), owner, item count, and a single **Add** button (or
> **Remove**, if you already have it). This exactly mirrors Telegram's sticker-set preview sheet —
> build it the same way.
>
> **Pack management ("create/edit/remove your own packs") happens through a bot**, not a settings
> page. Open the "Pack Manager" bot (see the Bots section below) from wherever bots live in the
> app's IA (a dedicated "Bots" surface, or an entry inside the sticker/emoji picker — your call,
> but it needs to be reachable from both, since a user might discover it either from "manage my
> stuff" or from "I want to make a pack while I'm looking at stickers"). A bot screen is **just a
> title, some rows, and some buttons**, all described by the server response — build one generic
> screen renderer, not per-bot UI. See the Bots contract below for the exact shape.
>
> Everything below is the precise API contract, current live behavior, and the product rules that
> came out of building the backend — treat it as the source of truth over any assumption.

---

## 1. Packs API (`/v1/packs`, all routes need `Authorization: Bearer <token>`)

Two independent pack "flavors," same API: `type: "sticker" | "emoji"`. Every list/search
endpoint that accepts `type` returns only that flavor when it's passed, both flavors when it
isn't.

### Core concepts the UI must reflect correctly

- **Owning a pack and having it in your collection are different facts.** Creating a pack
  auto-adds it to your own collection (you don't need to separately "Add" your own creation). You
  can later remove your own pack from your collection without deleting it (it stays published,
  you just stop seeing it in your own picker) — same as Telegram.
- **`isPublic` controls search discoverability only, not access.** A private pack is fully
  viewable and addable by anyone who has its `slug` (its invite-link segment) — this is what
  makes "add by link" work for private packs. Don't build any "access denied" UI for viewing a
  pack by id/link; it doesn't happen (a genuinely nonexistent pack id still 404s normally).
- **Only the owner can add, edit, or remove items, or edit/delete the pack itself.** Every other
  action available to a non-owner is limited to subscribe/unsubscribe (the Add/Remove button) and
  using items (sending them).
- **Each item (sticker or animated emoji) carries its own `keywords: string[]`** — the searchable
  tags (e.g. `["😂", "lol", "laugh"]`) distinct from the pack's own `tags`. This is what powers
  "type 😂 in the picker's search box and find matching items across packs you have."

### Endpoints

| Method & path | Auth | Purpose | Notes |
|---|---|---|---|
| `POST /v1/packs` | any user | Create a pack | Body: `{type, name, description?, tags?, isPublic?, slug?}`. Returns the pack summary, already subscribed. |
| `GET /v1/packs/mine?type=` | any user | "My packs" (owned + added) | Always exactly the caller's collection, in saved order. This is what the picker's tab content comes from. |
| `GET /v1/packs/search?q=&type=&limit=&offset=` | any user | Discover public packs | Matches name/description/tags. Never returns private packs. |
| `GET /v1/packs/search-items?q=&type=&limit=` | any user | Live keyword search across items | Scoped to the caller's own collection only (like Telegram — typing an emoji searches packs you have, not the whole catalog). This is the picker's "type to filter" box. |
| `GET /v1/packs/by-slug/:slug` | any user | Resolve an invite link | Feed the slug segment of a shared link (or a bare pasted code) here. Works for private packs. This is what the "add pack via link" flow calls. |
| `GET /v1/packs/:packId` | any user | Pack detail + items | Powers the tap-to-preview modal/sheet. Response includes `isOwner`/`isSubscribed` so the UI knows which button(s) to show without extra logic. |
| `PATCH /v1/packs/:packId` | owner only | Edit name/description/tags/isPublic | 403 if not owner. |
| `DELETE /v1/packs/:packId` | owner only | Delete the pack entirely | Removes it from every subscriber's collection too — if you're building any "who has this pack" awareness, it disappears for everyone. |
| `POST /v1/packs/:packId/items` (multipart) | owner only | Upload item(s) | Fields: `files` (exactly that name — `files[]` is rejected; PNG, JPEG, WebP or GIF, animated WebP/GIF stay animated), `keywords` (JSON array string, applied to every file in that batch). |
| `PATCH /v1/packs/:packId/items/:itemId` | owner only | Edit an item's keywords | Body: `{keywords: string[]}`. Media itself isn't editable — remove and re-add if the image needs to change. |
| `DELETE /v1/packs/:packId/items/:itemId` | owner only | Remove one item | |
| `POST /v1/packs/:packId/subscribe` | any user | Add to my collection | The Add button in the preview modal. Idempotent — calling it twice is not an error. |
| `DELETE /v1/packs/:packId/subscribe` | any user | Remove from my collection | The Remove button. Works on your own pack too (see above). |
| `POST /v1/packs/:packId/items/:itemId/use` | must have the pack | Record sending it | Call this when the user actually sends the sticker/emoji in a message — drives "most used" sorting. 403s if the caller doesn't have the pack (shouldn't happen if the UI only lets you send from packs you have). |

### Response shapes

**Pack summary** (used in lists and as the base of the detail response):
```ts
{
  id: string;
  type: "sticker" | "emoji";
  name: string;
  description: string | null;
  ownerId: string;
  slug: string;              // build your share link as you see fit, e.g. https://.../packs/<slug>
  tags: string[];
  isPublic: boolean;
  itemCount: number;
  totalUsageCount: number;
  isOwner: boolean;          // relative to the caller
  isSubscribed: boolean;     // relative to the caller — drives Add vs. Remove
}
```

**Pack detail** (`GET /v1/packs/:packId`, `.../by-slug/:slug`) — the above, plus:
```ts
{
  items: {
    id: string;
    relativePath: string;    // resolve against your media base URL, same as any other attachment
    keywords: string[];
    usageCount: number;
  }[];
}
```

**Item search result** (`GET /v1/packs/search-items`) — same item shape plus `packId`.

---

## 2. Bots (`/v1/bots`, all routes need auth)

A bot is a **server-driven menu tree** — the server sends a screen (title + rows + buttons) as
JSON; the client renders it generically and posts back whichever row/button was tapped. There is
**no chat-style text interface for bots** — do not build a message-composer-like input for talking
to a bot; every interaction is a tap on a row or a button, or filling in a short form the server
described.

### Endpoints

- `GET /v1/bots` → `{key, name, description, avatarUrl?}[]` — the bot directory.
- `GET /v1/bots/:key/menu?screen=<id>&<contextParams>` → a `BotMenuScreen` (below). Omit `screen`
  to get the bot's home screen. Extra query params become the screen's context (e.g. `?type=
  sticker` when opening "My Sticker Packs").
- `POST /v1/bots/:key/action` (JSON body `{actionId, screenId, params}`) → `{screen: BotMenuScreen}`
  — for actions with no file upload.
- `POST /v1/bots/:key/action/upload` (multipart: `actionId`, `screenId`, `params` as a **JSON
  string**, plus `files`) → same response shape — for actions whose form includes a file field.

### `BotMenuScreen` shape

```ts
{
  screenId: string;
  title: string;
  subtitle?: string;
  toast?: string;            // show once, e.g. as a snackbar, after landing on this screen
  items: {                   // rows
    id: string;
    title: string;
    subtitle?: string;
    imageUrl?: string;       // e.g. a pack item's thumbnail
    badge?: string;
    action: BotAction;       // tapping the row performs this
  }[];
  actions: BotAction[];      // page-level buttons, not tied to a row (e.g. "Create a pack")
}
```

### `BotAction` shape

```ts
{
  id: string;
  label: string;
  type: "navigate" | "invoke" | "form";
  style?: "default" | "primary" | "destructive";
  screenId?: string;         // type "navigate": which screen to fetch next (no server effect)
  fields?: BotFormField[];   // type "form": render these, collect values, then invoke
  confirmText?: string;      // show a confirm dialog with this text before firing invoke/form
  params?: Record<string, unknown>; // opaque context — echo back verbatim, merged with any
                                     // form values, in the POST body when this action fires
}
```

### `BotFormField` shape (for `type: "form"` actions)

```ts
{
  key: string;               // the field name to send back in `params`
  label: string;
  kind: "text" | "textarea" | "toggle" | "select" | "file" | "keywords";
  required?: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[];  // for "select"
  multiple?: boolean;        // for "file" — allow choosing more than one
}
```

The `"keywords"` field kind is a small chip/tag input for entering several short values (emoji or
words) — render it distinctly from a plain text field if your design system has a tag-input
primitive; a comma/space-separated text field is an acceptable fallback.

### How a client should drive this (reference flow)

1. `GET /v1/bots` → show a bot list/directory somewhere reachable in the app.
2. User opens a bot → `GET /v1/bots/:key/menu` (no `screen` param) → render the returned screen.
3. User taps a row or a page action:
   - `"navigate"` → `GET /v1/bots/:key/menu?screen=<action.screenId>&<action.params flattened as query>` → render the new screen. No server mutation happens.
   - `"invoke"` → (optionally show `confirmText` first) → `POST /v1/bots/:key/action` with
     `{actionId: action.id, screenId: <current screen's id>, params: action.params}` → render
     `response.screen`, and if `response.screen.toast` is set, show it once.
   - `"form"` → render `action.fields` as inputs, collect values, merge them into
     `action.params`, then `POST` (using `/action/upload` instead if any field is `kind: "file"`)
     with `{actionId: action.id, screenId: <current>, params: <merged>}` (files go in the
     multipart body's `files`, with `params` as a JSON string in that request).
4. Always re-render from whatever `screen` comes back — the server may navigate you somewhere
   different than where you started (e.g. deleting a pack sends you back to "my packs", not to a
   now-nonexistent pack-detail screen).

### The one bot that exists today: `pack-manager`

Screens: `home` (links to "My Sticker Packs"/"My Emoji Packs" + Create/Add-by-link buttons),
`my-packs` (list, filtered by `type` param, each row opens `pack-detail`), `pack-detail` (owner:
add-items/edit-pack/copy-link/delete-pack actions, plus a destructive "Remove" per item row;
non-owner: a single subscribe/unsubscribe action). This is a complete, working reference for how
a bot's screens compose — build your generic renderer against this bot first, then it'll work for
any future bot without changes.

---

## 3. Product rules the UI must not violate

- Base (unicode) emoji need **zero backend calls** — they're a static client-side catalog, exactly
  like today. Don't route them through the packs API.
- A pack's items can only be sent by someone who has the pack (owns it or has subscribed) — don't
  let a user tap "send" on an item from a pack preview modal before they've tapped Add; the
  preview modal's only action is Add/Remove, not "use this item directly."
  the picker's send action should only ever be reachable for packs already in `GET /v1/packs/mine`.
- Deleting a pack (owner action) is irreversible and removes it from every subscriber — surface a
  real confirmation (the bot already sends `confirmText` for this; honor it).
- Animated items are GIF only today (no WEBM/Lottie) — don't build UI implying video-specific
  controls (scrub bar, etc.) for pack items; they render like any looping animated image.

## 4. Explicitly out of scope (don't build UI for these — they don't exist server-side)

- Reordering your pack collection (the data field exists for it but nothing writes a custom order
  yet — packs currently list in the order you added them).
- Reporting a pack for abuse as its own concept (only the general message/user/channel report
  flow exists).
- A second bot. The framework supports more, but only `pack-manager` is implemented.
