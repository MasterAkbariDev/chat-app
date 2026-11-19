"use client";

import { useSyncExternalStore } from "react";

/** The browser's "Install app" offer (Chromium). Safari has none: iOS installs from its Share sheet. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Where the app is and how it can be installed: running installed, offered an install, an iPhone
 *  (use Share → Add to Home Screen), or a browser with no install here. */
export type InstallState = "installed" | "ready" | "ios" | "unsupported";

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Keep it, so the Install button in Settings can show the browser's own dialog.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
}

function currentState(): InstallState {
  if (typeof window === "undefined") return "unsupported";
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone) return "installed";
  if (deferred) return "ready";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios ? "ios" : "unsupported";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, currentState, () => "unsupported");
}

/** Registers the app's service worker for every signed-in browser, not only those with notifications on.
 *  Chrome offers "Install app" only for a site whose service worker is registered and handles fetches. */
export async function registerAppWorker(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  } catch {
    // Unsupported or blocked: the app works without it, it just can't be installed from here.
  }
}

/** Shows the browser's install dialog. Resolves to whether the user accepted it. */
export async function promptInstall(): Promise<boolean> {
  const ev = deferred;
  if (!ev) return false;
  deferred = null;
  emit();
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  return outcome === "accepted";
}
