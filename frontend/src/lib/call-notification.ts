"use client";

/** Rings outside the page: a system notification while the tab is hidden or
 * unfocused (the in-page banner can't be seen then), plus a "📞" tab title.
 * Uses the push service worker's registration when there is one — only a
 * service-worker notification can carry Answer/Decline buttons — and a plain
 * `Notification` otherwise. Same `tag` as the push the server sends for the
 * same call, so the two replace each other instead of stacking. */

const shown = new Map<string, Notification>();
let savedTitle: string | null = null;

export const callNotificationTag = (callId: string) => `call-${callId}`;

export function callAppUrl(channelId: string, callId: string, action?: "answer" | "decline") {
  const params = new URLSearchParams({ call: callId });
  if (action) params.set("callAction", action);
  return `/app/c/${channelId}?${params.toString()}`;
}

function pageIsWatched() {
  return document.visibilityState === "visible" && document.hasFocus();
}

export async function showIncomingCallNotification(call: { callId: string; channelId: string; fromUsername: string; isPrivate: boolean }) {
  if (typeof window === "undefined") return;
  if (savedTitle == null) savedTitle = document.title;
  document.title = `📞 ${call.fromUsername} is calling…`;
  if (pageIsWatched()) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const title = call.fromUsername;
  const body = call.isPrivate ? "Incoming call" : "Incoming group call";
  const tag = callNotificationTag(call.callId);
  try {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) {
      await reg.showNotification(title, {
        body,
        tag,
        requireInteraction: true,
        renotify: true,
        data: { kind: "incoming_call", callId: call.callId, channelId: call.channelId, url: callAppUrl(call.channelId, call.callId) },
        actions: [
          { action: "decline", title: "Decline" },
          { action: "answer", title: "Answer" },
        ],
      } as NotificationOptions);
      return;
    }
    const n = new Notification(title, { body, tag, requireInteraction: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    shown.set(call.callId, n);
  } catch {
    // Notifications unsupported/blocked — the banner and ringtone still run.
  }
}

export async function closeIncomingCallNotification(callId: string) {
  if (typeof window === "undefined") return;
  if (savedTitle != null) {
    document.title = savedTitle;
    savedTitle = null;
  }
  shown.get(callId)?.close();
  shown.delete(callId);
  try {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    const list = (await reg?.getNotifications({ tag: callNotificationTag(callId) })) ?? [];
    for (const n of list) n.close();
  } catch {
    // ignore
  }
}
