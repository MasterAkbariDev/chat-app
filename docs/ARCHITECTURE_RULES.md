# Architecture Rules

Rules future contributors must follow. Each is derived from a concrete problem found in the audit.

## Data & API

1. **Do not fetch data a screen does not render.** Every endpoint returns a purpose-built DTO.
   *(Why: `my-chats` ships `bio`, `tags`, `admins[]`; messages ship full `readBy`/`reactions` maps.)*

2. **One endpoint per screen need, not per screen.** Reuse list/detail endpoints across web +
   Flutter; add query params, don't add routes.
   *(Why: `/chats`, `/chats/search`, `/chats/:id/display`, 3 date-nav endpoints, 3 unread endpoints.)*

3. **All list endpoints are keyset-paginated** (`?cursor=&limit=`). No `skip`/`offset`.
   *(Why: `messages.find().skip(offset)`, all search, GIF lists.)*

4. **No N+1 in a request handler.** If a handler loops a query, it's a bug — batch with `$in`,
   `$lookup`, or an aggregation. CI runs an integration test asserting query count per endpoint.
   *(Why: `my-chats` per-DM `user.findById`; admin sync `save()` loop.)*

5. **Every hot query has a supporting index**, verified by an `explain()` test.
   *(Why: `chatmembers` has no `(channelId,userId)` index; searches use `$regex` not `$text`.)*

6. **Media URLs are stored relative** (`/uploads/...`); clients resolve against their configured
   base. Never bake the request `Host` into stored data.

7. **One canonical response envelope.** Success: the resource or `{ items, nextCursor }`. Error:
   `{ error: { code, message, details? } }`. No `true` / `void` / bare-array responses.

8. **API DTOs and TS types are generated from one OpenAPI spec.** The frontend never hand-writes
   a backend type.
   *(Why: `types/enums.ts` missing `saved_messages`; `avatarUrl` vs `image` drift.)*

9. **Read state is a single pointer per membership** (`lastReadMessageId` + `lastReadAt`).
   Never write per-message per-user read keys.

10. **Reactions and reads emit deltas over WebSocket**, never the whole message.

## Domain & backend

11. **One source of truth per fact.** Roles live only in `chatmembers.role` (no `chat.admins[]`).
    Presence lives only in the presence service (no `user.isOnline`).

12. **A guard, not a copy-paste.** Cross-cutting checks (auth, membership, channel-admin,
    not-banned) are guards/decorators used once each.
    *(Why: the membership+ban+deleted block appears 5× verbatim in `MessageService`.)*

13. **Controllers are thin.** No business logic, no gateway calls, no DB access in a controller.
    *(Why: `ChatController.getOrCreateDirect`, `MessageController` edit/reaction call the gateway.)*

14. **The gateway is transport only.** Domain services emit in-process events
    (`message.created`, `reaction.changed`, `presence.changed`, …); the `realtime` module is the
    *only* code that calls `server.emit`. Domain code never imports the gateway.
    *(Why: `ChatGateway` participates in 6 `forwardRef` cycles.)*

15. **Every server→client event has exactly one documented consumer** and a stable, versioned
    payload shape. Undocumented events fail review.

16. **One write path per resource.** A message is created by `MessageService.create` whether the
    request arrives via REST or WS; that method is the only place that persists a message and the
    only place that raises `message.created`.
    *(Why: today only the WS path broadcasts; REST `POST /messages` is silent.)*

17. **Feature modules are independently disable-able** behind config flags: `calls`, `gifs`,
    `stickers`, `wallpaper`, `configLog`, `push`. Core (auth/users/channels/messages/media/
    presence/realtime) has no dependency on them.

18. **Side-effect-free reads.** A `GET` never creates a user, channel, membership, or message.
    *(Why: `GET /chats/my-chats` creates Saved Messages; `GET /chats/direct/:id` emits WS;
    `AppSettings.onModuleInit` upserts.)*

19. **All shell-outs use `execFile` with an argv array** (never `exec` with a string). Media
    processing runs with a timeout and output size cap.

20. **No unauthenticated write endpoints.** A global `JwtAuthGuard` + explicit `@Public()` on the
    (few) public routes. Public routes are login, register, password-reset, health.

21. **Rate-limit every public and every abuse-prone endpoint** (auth, search, message send,
    upload, call signalling) via a shared, store-backed limiter.

22. **Soft-deleted / expired data has a purge job.** `isDeleted` is not "forever".

## Frontend

23. **Server state goes through the query cache** (TanStack Query). No bespoke `Map` refs, no
    `window.dispatchEvent('*:invalidate')` bus, no manual refetch fan-out.

24. **Context is for cross-cutting client state only** (auth, theme, socket, active call). Feature
    state stays in the feature; a component over ~400 LoC or ~15 `useState` is a refactor trigger.
    *(Why: `chats/[channelId]/page.tsx` = 3706 LoC / ~60 `useState`.)*

25. **A route component orchestrates; it does not implement.** Fetching lives in hooks, rendering
    in child components, side-effects in effects named for their job.

26. **Message list is virtualized; message items are `React.memo` with stable props.** Inline
    callbacks in a list render are a bug.

27. **Heavy, rarely-first-paint code is `next/dynamic`**: emoji/GIF/sticker pickers, media
    editor, call UI, lightboxes, `simple-peer`.

28. **No feature-specific logic in shared components.** `<MessageItem>` doesn't know about
    wallpapers; a `<WallpaperSystemCard>` renders that message type.

29. **Use design-system primitives** (`Button`, `Field`, `Sheet`, `ListRow`, `Avatar`, `Bubble`).
    No new `rounded-2xl border bg-surface px-4 py-3` one-offs; no `text-[13px]` arbitrary values.

30. **One modal layer at a time.** The overlay context enforces max depth 1 for dialogs.

31. **`localStorage` is for tiny per-device prefs only** (theme, notify flags). Never the auth
    token (httpOnly cookie) or server state.

32. **Every interactive element meets a11y baseline** (44px target, focus ring, label,
    `prefers-reduced-motion`). Modals trap focus and restore it.

## Process

33. **Every feature ships with tests** for its critical path (see TEST strategy in REFACTOR_PLAN).
    The current repos have ~0 tests; new/changed code requires coverage of the happy path + the
    main failure.

34. **No secrets in the repo.** `.env` is git-ignored; example files carry placeholders only;
    CI scans for committed secrets.

35. **Perf budgets are enforced in CI** (bundle size for the chat route; query-count tests;
    payload-size assertions on list endpoints). Regressions fail the build.

36. **Docs move with the code.** `REALTIME_ARCHITECTURE.md` event tables and the OpenAPI spec are
    updated in the same PR as the change (the current `API_SUMMARY.md` / `FLUTTER_INTEGRATION.md`
    are already stale on the namespace and DTOs).
