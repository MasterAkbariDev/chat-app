"use client";

import type { FirebaseApp } from "firebase/app";
import type { Messaging } from "firebase/messaging";
import { registerPushToken, unregisterPushToken } from "./api/users";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;

const LOCAL_STORAGE_KEY = "chat:push-token";

/** True once real Firebase env vars exist — lets every caller no-op cleanly
 * in an environment without them configured, same "degrade quietly, don't
 * throw" posture as the backend's own `FcmService.isConfigured`. Doesn't
 * import the Firebase SDK at all — this can be checked (e.g. to decide
 * whether to render a "Browser notifications" toggle) without pulling any
 * of it into the bundle. */
export function isPushConfigured(): boolean {
  return !!(firebaseConfig.apiKey && VAPID_KEY);
}

/** A cheap, synchronous proxy for "can this browser even do push at all" —
 *  checked without loading the Firebase SDK (unlike the real, authoritative
 *  `isSupported()` check inside `getMessagingIfSupported`, which needs the
 *  dynamic import). Safari on iOS before 16.4, and any browser with no
 *  service-worker/Push API support, fails this — used so the Settings toggle
 *  can tell that case apart from "permission denied" instead of collapsing
 *  both into the same silent no-op. */
export function isPushLikelySupported(): boolean {
  if (typeof window === "undefined") return false;
  return "serviceWorker" in navigator && "PushManager" in window;
}

let app: FirebaseApp | null = null;

/** Every actual call into the `firebase` SDK is a dynamic `import()`, not a
 * top-level one — `firebase/app` + `firebase/messaging` are a genuinely
 * heavy dependency (Architecture Rules #27 names push/call code explicitly)
 * that a page has no reason to pay for until push is actually toggled on,
 * a token needs registering, or logout needs to unregister one. Only this
 * function and the ones below it ever touch the real SDK. */
async function getMessagingIfSupported(): Promise<Messaging | null> {
  if (!isPushConfigured()) return null;
  // Safari/iOS and any browser without the Push API/service-worker support
  // fail this check — asking anyway would throw deep inside the SDK.
  if (typeof window === "undefined") return null;
  const [{ initializeApp, getApps }, { getMessaging, isSupported }] = await Promise.all([
    import("firebase/app"),
    import("firebase/messaging"),
  ]);
  if (!(await isSupported())) return null;
  if (!app) app = getApps()[0] ?? initializeApp(firebaseConfig);
  return getMessaging(app);
}

/** Full opt-in flow: browser permission prompt → service worker registration
 * → real FCM token → registered with the backend. Returns the token on
 * success so the caller can show a real "enabled" state, or null for any
 * reason (unsupported browser, permission denied, not configured) — every
 * failure mode here is a normal, expected outcome to handle quietly, not an
 * error to surface loudly. */
export async function enablePushNotifications(): Promise<string | null> {
  const messaging = await getMessagingIfSupported();
  if (!messaging) return null;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;

  const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  const { getToken } = await import("firebase/messaging");
  const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
  if (!token) return null;

  await registerPushToken(token, navigator.userAgent);
  localStorage.setItem(LOCAL_STORAGE_KEY, token);
  return token;
}

/**
 * After sign-in: if this browser already has notification permission, register its push token for the
 * account that's signed in now. Silent: browsers only show the permission prompt from a tap, so a browser
 * that was never allowed still needs Settings → Notifications once. Safe to call on every sign-in.
 */
export async function syncPushForSignedInUser(): Promise<void> {
  if (!isPushConfigured() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const messaging = await getMessagingIfSupported();
  if (!messaging) return;
  const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  const { getToken } = await import("firebase/messaging");
  const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
  if (!token) return;
  await registerPushToken(token, navigator.userAgent);
  localStorage.setItem(LOCAL_STORAGE_KEY, token);
}

/** Unregisters both sides — the backend's copy (so a signed-out/opted-out
 * browser stops receiving push) and FCM's own token, then forgets it
 * locally. Safe to call even if push was never enabled (each step no-ops
 * on missing state rather than throwing) — including from `logout()`,
 * which calls this unconditionally on every sign-out. */
export async function disablePushNotifications(): Promise<void> {
  const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (stored) {
    await unregisterPushToken(stored).catch(() => {});
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  }
  const messaging = await getMessagingIfSupported();
  if (messaging) {
    const { deleteToken } = await import("firebase/messaging");
    await deleteToken(messaging).catch(() => {});
  }
}

/** Whether this browser currently has a registered token *and* the
 * permission is still granted (a user can revoke notification permission
 * from browser chrome directly, without ever calling `disablePushNotifications`
 * — this catches that case so the Settings toggle doesn't lie). Reads only
 * `localStorage`/`Notification` — never touches the Firebase SDK, so it's
 * safe to call on every render without paying for the dynamic import. */
export function getStoredPushState(): { hasToken: boolean; permission: NotificationPermission | "unsupported"; enabled: boolean } {
  if (typeof Notification === "undefined") return { hasToken: false, permission: "unsupported", enabled: false };
  const hasToken = !!localStorage.getItem(LOCAL_STORAGE_KEY);
  const permission = Notification.permission;
  // On only when this app has a token AND the app's own permission is granted: a token stored by another
  // context (e.g. the browser tab) says nothing about this one.
  return { hasToken, permission, enabled: hasToken && permission === "granted" };
}
