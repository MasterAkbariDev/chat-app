"use client";

import { useSyncExternalStore } from "react";

/** In-app toast settings. Kept on this device (a local preference, like the performance ones). */
export interface ToastPrefs {
  /** Show a pop-up when a message arrives while you're looking at something else. */
  enabled: boolean;
  /** Play the short sound with a pop-up. */
  sound: boolean;
  /** Show the message text. Off shows only who wrote it. */
  showText: boolean;
  /** How long a pop-up stays before it closes by itself. */
  durationSec: 3 | 5 | 8;
}

export const DEFAULT_TOAST_PREFS: ToastPrefs = { enabled: true, sound: true, showText: true, durationSec: 5 };

const KEY = "hearth.toastPrefs";
const listeners = new Set<() => void>();
let cache: ToastPrefs | null = null;

function read(): ToastPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_TOAST_PREFS;
    const p = JSON.parse(raw) as Partial<ToastPrefs>;
    return {
      enabled: p.enabled !== false,
      sound: p.sound !== false,
      showText: p.showText !== false,
      durationSec: p.durationSec === 3 || p.durationSec === 8 ? p.durationSec : 5,
    };
  } catch {
    // Storage blocked or corrupt: the defaults are a fine fallback.
    return DEFAULT_TOAST_PREFS;
  }
}

function snapshot(): ToastPrefs {
  if (!cache) cache = read();
  return cache;
}

export function setToastPrefs(patch: Partial<ToastPrefs>) {
  cache = { ...snapshot(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Not persisted, but the current session still follows the change.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useToastPrefs(): ToastPrefs {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_TOAST_PREFS);
}
