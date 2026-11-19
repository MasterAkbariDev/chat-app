/** Tiny event bus for "a navigation started" — set by link clicks (captured
 * globally in NavigationProgress) and by programmatic navigation through the
 * app's `useRouter` wrapper (hooks/use-app-router.ts). */
type Listener = () => void;
const listeners = new Set<Listener>();

export function startNavigationProgress() {
  listeners.forEach((l) => l());
}

export function onNavigationStart(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let suppressUntil = 0;

/** A touch long-press just fired: the click its release may produce isn't a
 *  navigation, so link clicks don't start the bar for a moment. */
export function suppressLinkProgress(ms = 900) {
  suppressUntil = Date.now() + ms;
}

export function linkProgressSuppressed() {
  return Date.now() < suppressUntil;
}
