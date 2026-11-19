"use client";

import { useEffect, useRef, useState } from "react";
import { usePerformance } from "@/contexts/performance-context";
import { resolveMediaUrl } from "@/lib/media-url";

// One IntersectionObserver for every pack image on the page (a picker can
// hold a hundred), instead of one per image.
const callbacks = new WeakMap<Element, (visible: boolean) => void>();
let sharedObserver: IntersectionObserver | null = null;
function observe(el: Element, cb: (visible: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") {
    cb(true);
    return () => {};
  }
  sharedObserver ??= new IntersectionObserver(
    (entries) => entries.forEach((e) => callbacks.get(e.target)?.(e.isIntersecting)),
    { rootMargin: "64px" },
  );
  callbacks.set(el, cb);
  sharedObserver.observe(el);
  return () => {
    callbacks.delete(el);
    sharedObserver?.unobserve(el);
  };
}

export interface PackImageProps {
  /** Small animated variant (or the original when there isn't one). */
  thumbPath: string;
  /** First-frame still — when absent the image is treated as not animated. */
  stillPath?: string | null;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}

/** A sticker / animated-emoji image that respects Motion & performance
 * settings and only animates when it's worth it:
 *  - **auto** — plays only while on screen (off-screen ones show the still,
 *    so the browser isn't decoding frames nobody can see)
 *  - **interact** — still until hovered, focused or tapped
 *  - **off** — always the still
 * Items without a separate still (static stickers) always show `thumbPath`. */
export function PackImage({ thumbPath, stillPath, alt, className, style, title }: PackImageProps) {
  const { animatedMedia } = usePerformance();
  const ref = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const animated = !!stillPath && stillPath !== thumbPath;

  useEffect(() => {
    const el = ref.current;
    if (!el || !animated || animatedMedia !== "auto") return;
    return observe(el, setVisible);
  }, [animated, animatedMedia]);

  // Hover/focus on the image *or* the button/cell it sits in counts.
  useEffect(() => {
    const host = ref.current?.closest("button,a,[role=article]") ?? ref.current;
    if (!host || !animated || animatedMedia !== "interact") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const on = () => setEngaged(true);
    const off = () => setEngaged(false);
    const tap = () => {
      setEngaged(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(off, 2500);
    };
    host.addEventListener("pointerenter", on);
    host.addEventListener("pointerleave", off);
    host.addEventListener("focusin", on);
    host.addEventListener("focusout", off);
    host.addEventListener("touchstart", tap, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      host.removeEventListener("pointerenter", on);
      host.removeEventListener("pointerleave", off);
      host.removeEventListener("focusin", on);
      host.removeEventListener("focusout", off);
      host.removeEventListener("touchstart", tap);
    };
  }, [animated, animatedMedia]);

  const play = animated && (animatedMedia === "auto" ? visible : animatedMedia === "interact" ? engaged : false);
  const path = !animated || play ? thumbPath : stillPath!;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote, backend-hosted pack media
    <img ref={ref} src={resolveMediaUrl(path)} alt={alt} title={title} draggable={false} decoding="async" loading="lazy" className={className} style={style} />
  );
}
