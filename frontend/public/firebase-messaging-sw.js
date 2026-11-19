// Background/killed-app push handler — runs in its own service-worker
// context, so it can't share the app's regular ES module code; the
// "compat" build is what Firebase ships specifically for this. Config
// Add your Firebase project's public web configuration below to enable
// background push. A service worker cannot read Next.js environment variables.
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js");

const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};
let messaging = null;
if (firebaseConfig.apiKey) {
  firebase.initializeApp(firebaseConfig);
  messaging = firebase.messaging();
}

// Installability: Chrome only offers "Install app" for a site whose service worker has a fetch handler.
// This one doesn't answer requests itself (no respondWith): the browser fetches as usual.
self.addEventListener("fetch", () => {});

// Fires for a *data-only* message while no app window is focused (a focused
// window gets it in the page instead, and rings there itself). Message pushes
// carry a `notification` block the browser shows by itself; calls are
// data-only (backend FcmService.sendData) so this worker decides:
// - `incoming_call`: an "Incoming call" notification with Answer/Decline
//   that stays until handled (`requireInteraction`).
// - `call_ended`: withdraw it (answered elsewhere, declined, missed, cancelled).
// The tag matches the one the open app uses for the same call
// (lib/call-notification.ts), so the two replace each other.
const callTag = (callId) => `call-${callId}`;
const callUrl = (channelId, callId, action) =>
  `/app/c/${channelId}?call=${encodeURIComponent(callId)}${action ? `&callAction=${action}` : ""}`;

async function closeCall(callId) {
  const list = await self.registration.getNotifications({ tag: callTag(callId) });
  for (const n of list) n.close();
  return list.length;
}

// Chrome counts a push that shows no notification as "silent", and after a few it calls the site
// spammy and quiets its notifications. So a push that has nothing to show still shows a notification,
// and closes it straight away.
async function showThenClose() {
  await self.registration.showNotification("Chat", { tag: "quiet", silent: true, requireInteraction: false });
  const list = await self.registration.getNotifications({ tag: "quiet" });
  for (const n of list) n.close();
}

messaging?.onBackgroundMessage(async (payload) => {
  // A message push carries a notification block: the browser has already shown it. Don't add a
  // placeholder on top of it (that's what showed an empty "Chat" notification).
  if (payload && payload.notification) return;
  const data = (payload && payload.data) || {};
  if (data.type === "incoming_call") {
    const expiresAt = Number(data.expiresAt || 0);
    if (expiresAt && expiresAt <= Date.now()) return showThenClose();
    return self.registration.showNotification(data.fromName || "Incoming call", {
      body: data.isPrivate === "1" ? "Incoming call" : "Incoming group call",
      tag: callTag(data.callId),
      renotify: true,
      requireInteraction: true,
      vibrate: [400, 200, 400, 200, 400],
      data: { kind: "incoming_call", callId: data.callId, channelId: data.channelId, expiresAt },
      actions: [
        { action: "decline", title: "Decline" },
        { action: "answer", title: "Answer" },
      ],
    });
  }
  if (data.type === "call_ended" && data.callId) {
    const closed = await closeCall(data.callId);
    if (!closed) await showThenClose();
    return;
  }
  // Anything else (a push we don't recognise) still counts as shown.
  return showThenClose();
});

// A tap on a message notification opens its chat: the open app window navigates there,
// otherwise a new window opens it.
function openChatUrl(url) {
  return (async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const app = windows.find((w) => new URL(w.url).pathname.startsWith("/app"));
    if (app) {
      app.postMessage({ type: "navigate", url });
      if ("focus" in app) await app.focus();
      return;
    }
    await self.clients.openWindow(url);
  })();
}

self.addEventListener("notificationclick", (event) => {
  const data = (event.notification && event.notification.data) || {};
  // A message notification: open its chat (the FCM payload's data carries the channel id).
  const fcm = data.FCM_MSG || {};
  const chatId = (fcm.data && fcm.data.channelId) || data.channelId;
  if (data.kind !== "incoming_call" && chatId) {
    event.notification.close();
    event.waitUntil(openChatUrl(`/app/c/${chatId}`));
    return;
  }
  if (data.kind !== "incoming_call") return;
  event.notification.close();
  // Tapping the body (no action) opens the app ringing; Answer joins; Decline
  // declines (an open tab does it in the background, otherwise the app opens
  // just long enough to send it — the worker has no session of its own).
  const action = event.action === "answer" || event.action === "decline" ? event.action : null;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const app = windows.find((w) => new URL(w.url).pathname.startsWith("/app"));
      if (app) {
        app.postMessage({ type: "call-action", callId: data.callId, channelId: data.channelId, action });
        if (action !== "decline" && "focus" in app) await app.focus();
        return;
      }
      await self.clients.openWindow(callUrl(data.channelId, data.callId, action));
    })(),
  );
});
