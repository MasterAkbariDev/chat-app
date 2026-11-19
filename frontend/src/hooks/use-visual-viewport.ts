"use client";

import { useEffect } from "react";

/** Below this many px of lost height it's browser chrome (URL bar) moving, not a keyboard. */
const KEYBOARD_MIN_PX = 120;

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) return !el.readOnly && !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image"].includes(el.type);
  return (el as HTMLElement).isContentEditable;
}

/**
 * The on-screen keyboard, for every browser.
 *
 * - Android Chrome honours `interactive-widget=resizes-content` (root layout's
 *   viewport), so the layout viewport — and `100dvh` — shrink by themselves.
 * - iOS Safari (and anything that overlays instead) leaves `innerHeight`
 *   alone and only shrinks `visualViewport`. The difference is published as
 *   `--kb-inset` on <html>, which the app shell subtracts from its height so
 *   the composer sits right on top of the keyboard.
 *
 * Also sets `data-keyboard="open"` on <html> while a keyboard is up (either
 * way), so chrome like the phone tab bar can get out of its way.
 * Mount once (AppShell).
 */
export function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    // Tallest innerHeight seen per width (≈ per orientation): the reference
    // for "the layout viewport got shorter", i.e. a resizing keyboard.
    const tallest = new Map<number, number>();
    let raf = 0;

    function update() {
      raf = 0;
      const w = window.innerWidth;
      const h = window.innerHeight;
      tallest.set(w, Math.max(tallest.get(w) ?? 0, h));
      // Pinch-zoom also shrinks the visual viewport — that's not a keyboard.
      const zoomed = !!vv && vv.scale > 1.01;
      const overlay = vv && !zoomed ? Math.max(0, Math.round(h - vv.height)) : 0;
      const inset = overlay >= KEYBOARD_MIN_PX ? overlay : 0;
      const resized = (tallest.get(w) ?? h) - h >= KEYBOARD_MIN_PX && isEditable(document.activeElement);
      root.style.setProperty("--kb-inset", `${inset}px`);
      if (inset > 0 || resized) root.dataset.keyboard = "open";
      else delete root.dataset.keyboard;
      // iOS pans the page up to reveal the focused field; once the shell has
      // shrunk to fit above the keyboard there's nothing to pan to.
      if (inset > 0 && window.scrollY > 0) window.scrollTo(0, 0);
    }
    function schedule() {
      if (!raf) raf = requestAnimationFrame(update);
    }

    update();
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    // Focus changes alone (keyboard dismissed by tapping out) may not resize.
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      cancelAnimationFrame(raf);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      root.style.removeProperty("--kb-inset");
      delete root.dataset.keyboard;
    };
  }, []);
}
