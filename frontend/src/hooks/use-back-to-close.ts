"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { onNavigationStart } from "@/lib/nav-progress";

/** The phone's back button / gesture (and the browser's Back) closes the
 * topmost open overlay instead of leaving the page — like a native app.
 *
 * Every open overlay owns one same-URL history entry, tagged with its depth
 * (`__overlayDepth`, the rest of the router's state copied so Next's
 * popstate handler sees "same page" and does nothing). Overlays form a
 * stack, so nested ones (a confirm over a sheet, a picker over a dialog)
 * close one per Back press, top first. Closing an overlay any other way
 * (✕, scrim, Esc, an action) pops its entry again — unless another overlay
 * opened in the same moment, which then takes the entry over instead (so a
 * menu row that opens a dialog doesn't Back-pop the dialog it just opened).
 *
 * Exported pieces are module-level on purpose: one stack for the whole app. */

type Entry = {
  /** Return false to refuse (e.g. a non-dismissible dialog) — the entry is re-pushed. */
  close: () => boolean | void;
};

const stack: Entry[] = [];
/** How many overlay entries we believe sit on top of the page's own entry. */
let historyDepth = 0;
/** A pop we triggered ourselves (`history.go(-n)`), not the user: the depth
 *  it lands on, and until when to expect it (a traversal the browser drops
 *  — e.g. overtaken by a navigation — must not swallow a later real Back). */
let ownPop: { depth: number; until: number } | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;
/** Set when the app starts navigating (link click, router.push): an overlay
 *  closing because of that must not step back — the new page's history
 *  entry may land after our pop and the pop would undo the navigation. */
let navigatingUntil = 0;

function stateDepth(): number {
  const d = (window.history.state as { __overlayDepth?: unknown } | null)?.__overlayDepth;
  return typeof d === "number" ? d : 0;
}

function pushEntry(depth: number) {
  try {
    window.history.pushState({ ...(window.history.state ?? {}), __overlayDepth: depth }, "");
    historyDepth = depth;
  } catch {
    // Some embedded browsers throttle/deny pushState — Back just won't close it.
  }
}

/** Bring history in line with the stack after overlays closed without Back. */
function sync() {
  syncTimer = null;
  if (historyDepth <= stack.length) return;
  // Only step back if we're still standing on our own top entry — if the
  // overlay closed because the app navigated (a link inside it), going back
  // would undo that navigation.
  if (stateDepth() !== historyDepth || Date.now() < navigatingUntil) {
    historyDepth = stack.length;
    return;
  }
  const n = historyDepth - stack.length;
  historyDepth = stack.length;
  ownPop = { depth: stack.length, until: Date.now() + 1000 };
  window.history.go(-n);
}

function onPopState() {
  const depth = stateDepth();
  const own = ownPop;
  ownPop = null;
  if (own && Date.now() < own.until && depth === own.depth) return;
  if (depth > stack.length) {
    // Forward into an entry whose overlay is gone — step back over it.
    historyDepth = depth;
    if (!syncTimer) syncTimer = setTimeout(sync, 0);
    return;
  }
  historyDepth = depth;
  while (stack.length > depth) {
    const top = stack[stack.length - 1];
    if (top.close() === false) {
      // Refused (blocking dialog): restore its entry and stop here.
      pushEntry(stack.length);
      return;
    }
    // close() normally unmounts the overlay, whose cleanup removes it; make
    // sure it's gone even if the caller kept it mounted.
    if (stack[stack.length - 1] === top) stack.pop();
  }
}

/** Number of overlays currently registered (for tests / debugging). */
export function openOverlayCount() {
  return stack.length;
}

/** Register an open overlay: Back closes it (topmost first). Mount it with
 *  the overlay (or pass `open`), and keep `onClose` cheap — it's read
 *  through a ref. Return `false` from `onClose` to refuse closing. */
export function useBackToClose(onClose: () => boolean | void, open = true) {
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    if (!listening) {
      listening = true;
      window.addEventListener("popstate", onPopState);
      onNavigationStart(() => {
        navigatingUntil = Date.now() + 1500;
      });
    }
    const entry: Entry = { close: () => onCloseRef.current() };
    stack.push(entry);
    // Reuse an entry left by an overlay that just closed (or a dev-mode
    // effect re-run) instead of pushing a second one.
    if (historyDepth < stack.length) pushEntry(stack.length);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (!syncTimer) syncTimer = setTimeout(sync, 0);
    };
  }, [open]);
}
