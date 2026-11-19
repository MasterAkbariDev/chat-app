# Refactor Spec: Notifications

> **RESOLVED (DECISIONS Q9): split by platform.**
> - **Flutter app:** full background push (FCM/APNs) — notify even when the app is closed.
> - **Web:** **foreground only** — while a tab is open, in-app toast/sound for new messages/calls
>   if the chat isn't muted. **No Web Push / service worker** (product call). **Ignore §4–§8's
>   Web Push / VAPID / SW / `push_subscriptions` content** — replace with `push_tokens` (mobile).
> The server `NotificationService` fan-out (mute + level + "channel open" checks + queue) is kept,
> targeting FCM/APNs only. Delivery: BACKEND B7 / FRONTEND F7 / FLUTTER A7.

## 1. Current implementation
**Client-only.** `app-shell.tsx` listens for `new_message`; if the tab is hidden it bumps a
tab-title counter; if `localStorage.legacy_chat_notify_enabled === '1'` and
`Notification.permission === 'granted'` it fires a browser `Notification`; if
`legacy_chat_sound_enabled` it plays `/sounds/new-message.mp3` (throttled 1.5s). Mute decision
uses a `muteMap` fetched from `my-chats` (also duplicated in `chat-list`). Incoming-call
notification in `call-socket-listener`. `/profile` has the toggles + iOS "add to home screen"
guidance. `pwa-registry.tsx` registers a service worker (contents `UNKNOWN`, in `public/`).
**No server push, no Web Push, no VAPID, no `push_subscriptions`.**

## 2. Current problems
- Only works with a tab open; nothing when the app is closed / backgrounded (the point of push).
- iOS Safari: unsupported unless installed (UI explains it) — still no push even then without Web Push.
- Per-message work in `app-shell`: reads `localStorage` synchronously, recomputes mention/mute logic.
- `muteMap` fetched + maintained in two components.
- No per-type preferences (mentions vs all vs none), no quiet hours, no per-chat "notify anyway".
- Notification content for `voice_call` messages parses JSON inline in the shell.

## 3. Refactor goal
Real background push (Web Push now; APNs/FCM later for Flutter) with server-side fan-out honouring
mute + preferences; foreground in-app notifications stay but get lighter.

## 4. New architecture
```
push_subscriptions { userId, endpoint, keys, ua, createdAt }   (Web Push)
On message.created / mention / call:ringing → NotificationService:
  resolve recipients (channel members minus sender) → for each: check mute + preference + not-in-active-chat
  → enqueue a push job (BullMQ/Redis) → send Web Push { title, body, tag: channelId, data: {channelId, messageId} }
Service worker: `push` handler → showNotification ; `notificationclick` → focus/open /app/c/:id?m=:messageId
Foreground: realtime `message:new` still updates the list + optional sound; NO browser Notification while focused
Preferences (server): { push: on/off, level: all|mentions|none, sound, quietHours?, perChatOverrides }
```

## 5. Backend changes
- `notifications/` module: `push_subscriptions` collection, VAPID keys (config), `web-push` lib, a job queue.
- Subscribe to domain events (`message.created`, `mention.created`, `call.ringing`).
- Recipient resolution respects `chatmembers.isMuted`, `preferences.level`, per-chat overrides, and "user currently has this channel open" (from presence/room membership) to avoid double-notifying.
- `POST /v1/push/subscribe` / `DELETE /v1/push/subscribe`.
- `PATCH /v1/users/me/preferences` carries notification prefs (from user-profile spec).
- Digest/quiet-hours (optional, later).

## 6. Frontend changes
- On enabling push in Settings: request permission → `pushManager.subscribe(VAPID)` → `POST /v1/push/subscribe`.
- Service worker `push` + `notificationclick` handlers (real file, versioned).
- `app-shell` foreground handler simplified: update list/badge + sound; no `new Notification` while focused; drop the inline `voice_call` JSON parse (server builds the body).
- `useMuteState` single hook (RQ) shared by shell + list.
- Tab-title counter kept (cheap, useful).

## 7. UI/UX
- Settings → Notifications: master toggle, "Notify me about" (All messages / Only mentions & calls / Nothing), Sound, Quiet hours, per-chat overrides live in the chat menu ("Notifications: Default / All / Mentions / Off").
- iOS: same "install to enable" guidance, but once installed + subscribed, real push works.
- Notification: "<sender> in <chat>: <preview>" (or "sent a photo" / "🎤 Voice message" / "📞 Incoming call"); click → open the chat at the message.
- Respect Do Not Disturb / quiet hours.

## 8. Data contract
`POST /v1/push/subscribe { endpoint, keys: { p256dh, auth }, ua }`.
Push payload `{ title, body, tag, data: { channelId, messageId } }`.

## 9. Performance
- Fan-out is queued (BullMQ) — not on the message-send hot path.
- Recipient resolution batched; skip users with an open socket in that channel room.
- Foreground path does less per message (no localStorage read, no JSON parse).

## 10. Migration
- Ship Web Push additively; keep the current foreground behaviour.
- Migrate `localStorage` flags → server preferences (read old flag once, write to prefs).
- Flutter later reuses `NotificationService` with FCM/APNs tokens in the same collection (add a `platform` field).

## 11. Tests
- Subscribe → message from another user while app closed → push received with correct deep link.
- Mute / level=mentions / quiet hours suppress correctly.
- No push when the recipient has the channel open.
- `notificationclick` opens `/app/c/:id?m=`.
- Unsubscribe on permission revoke / logout.

## 12. Risks
- Web Push browser support / iOS quirks (must be installed PWA on iOS 16.4+).
- VAPID key management (config, rotation).
- Notification spam if fan-out isn't debounced → per-user cooldown + collapse by `tag`.

## 13. Acceptance criteria
- A user receives a notification for a new message/mention/call **with the app closed** (supported platforms).
- Notifications honour mute + level + per-chat overrides + quiet hours, server-side.
- No browser Notification fires while the app is focused.
- Fan-out runs off the send hot path (queued).
- One shared mute-state hook; no duplicated `muteMap`.
