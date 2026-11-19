"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useIsFetching } from "@tanstack/react-query";
import { linkProgressSuppressed, onNavigationStart, startNavigationProgress } from "@/lib/nav-progress";

const SHOW_AFTER_MS = 250;
const SETTLE_CAP_MS = 4000;
const HARD_CAP_MS = 12000;

/** A slim bar at the top of the window for navigations that aren't instant.
 * Starts on any in-app link click (an actual click — never on press/hold),
 * back/forward to another URL, or `router.push` (via the
 * app's useRouter wrapper); only becomes visible after 250ms, so quick
 * navigations show nothing; finishes once the new page has rendered and its
 * first data requests have settled (capped, so a background poll can't
 * hold it open). */
export function NavigationProgress() {
  const pathname = usePathname();
  // Only first loads count — a background refresh of data already on screen
  // isn't something the user is waiting for.
  const fetching = useIsFetching({ predicate: (q) => q.state.data === undefined });
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  const pending = useRef(false);
  const committedAt = useRef<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const trickle = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPath = useRef(pathname);
  /** pathname+search of the page on screen (kept current on route changes). */
  const lastUrl = useRef("");

  const clearAll = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (trickle.current) clearInterval(trickle.current);
    trickle.current = null;
  };

  const finish = () => {
    if (!pending.current) return;
    pending.current = false;
    committedAt.current = null;
    clearAll();
    setProgress(1);
    timers.current.push(
      setTimeout(() => {
        setVisible(false);
        timers.current.push(setTimeout(() => setProgress(0), 250));
      }, 180),
    );
  };

  const finishRef = useRef(finish);
  useEffect(() => {
    finishRef.current = finish;
  });

  useEffect(() => {
    lastUrl.current = location.pathname + location.search;
    const start = () => {
      if (pending.current) return;
      clearAll();
      pending.current = true;
      committedAt.current = null;
      setProgress(0.08);
      timers.current.push(setTimeout(() => setVisible(true), SHOW_AFTER_MS));
      timers.current.push(setTimeout(() => finishRef.current(), HARD_CAP_MS));
      // Ease toward 90% while waiting; never claims to be done.
      trickle.current = setInterval(() => setProgress((p) => p + (0.9 - p) * 0.08), 200);
    };
    const off = onNavigationStart(start);

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      // The click a touch long-press releases into (it opened a menu, it
      // isn't a tap on the link under the finger).
      if (linkProgressSuppressed()) return;
      startNavigationProgress();
    };
    // Back/forward only counts when the page itself changes. Overlays (sheets,
    // dialogs, viewers — hooks/use-back-to-close.ts) push same-URL entries
    // and pop them when they close; those pops must not start the bar, or it
    // would creep along for the full hard cap after every long-press menu.
    const onPop = () => {
      const url = location.pathname + location.search;
      if (url === lastUrl.current) return;
      lastUrl.current = url;
      startNavigationProgress();
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    return () => {
      off();
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
      clearAll();
    };
  }, []);

  // The route changed: the page is in; now wait for its first data.
  useEffect(() => {
    if (typeof location !== "undefined") lastUrl.current = location.pathname + location.search;
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    if (!pending.current) return;
    committedAt.current = Date.now();
    timers.current.push(setTimeout(() => finishRef.current(), SETTLE_CAP_MS));
  }, [pathname]);

  useEffect(() => {
    if (pending.current && committedAt.current !== null && fetching === 0) {
      // Give freshly mounted queries a beat to register before calling it done.
      const t = setTimeout(() => {
        if (committedAt.current !== null) finishRef.current();
      }, 120);
      return () => clearTimeout(t);
    }
  }, [fetching, pathname]);

  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 z-[120] h-[3px]"
        style={{ opacity: visible ? 1 : 0, transition: "opacity 200ms ease" }}
      >
        <div
          className="h-full origin-left bg-accent shadow-[0_0_8px_var(--accent)] rtl:origin-right"
          style={{ transform: `scaleX(${progress})`, transition: progress === 0 ? "none" : "transform 200ms ease-out" }}
        />
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {visible ? "Loading" : ""}
      </span>
    </>
  );
}
