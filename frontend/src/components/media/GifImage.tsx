"use client";

import { useEffect, useRef, useState } from "react";
import { usePerformance } from "@/contexts/performance-context";
import { cn } from "@/lib/cn";

// One IntersectionObserver for every GIF on the page (a picker grid can hold
// a hundred), instead of one per image.
const callbacks = new WeakMap<Element, (visible: boolean) => void>();
let sharedObserver: IntersectionObserver | null = null;
function observe(el: Element, cb: (visible: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") {
    cb(true);
    return () => {};
  }
  sharedObserver ??= new IntersectionObserver((entries) => entries.forEach((e) => callbacks.get(e.target)?.(e.isIntersecting)), { rootMargin: "48px" });
  callbacks.set(el, cb);
  sharedObserver.observe(el);
  return () => {
    callbacks.delete(el);
    sharedObserver?.unobserve(el);
  };
}

export interface GifImageProps {
  /** Absolute URL of the GIF. */
  src: string;
  alt: string;
  className?: string;
  /** Classes for the image/still itself (object-fit etc.). */
  mediaClassName?: string;
}

/** A looping GIF that follows Motion & performance settings like PackImage:
 *  - **auto** — plays only while on screen
 *  - **interact** — still until hovered, focused or tapped
 *  - **off** — always the still
 * GIFs have no separate still on the server, so the first frame is painted
 * into a canvas once loaded; while paused the <img> is unmounted, so the
 * browser stops decoding frames nobody sees. */
export function GifImage({ src, alt, className, mediaClassName }: GifImageProps) {
  const { animatedMedia } = usePerformance();
  const boxRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [engaged, setEngaged] = useState(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || animatedMedia !== "auto") return;
    return observe(el, setVisible);
  }, [animatedMedia]);

  useEffect(() => {
    const host = boxRef.current?.closest("button,a,[role=article]") ?? boxRef.current;
    if (!host || animatedMedia !== "interact") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const on = () => setEngaged(true);
    const off = () => setEngaged(false);
    const tap = () => {
      setEngaged(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(off, 3000);
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
  }, [animatedMedia]);

  const play = animatedMedia === "auto" ? visible : animatedMedia === "interact" ? engaged : false;
  const hasStill = captured === src;
  // Until the first frame is captured the image has to be mounted to load.
  const showImg = play || !hasStill;

  function capture(img: HTMLImageElement) {
    if (captured === src) return;
    const canvas = canvasRef.current;
    if (!canvas || !img.naturalWidth) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    // Drawing a cross-origin image only taints the canvas for *reading*;
    // showing it is fine.
    canvas.getContext("2d")?.drawImage(img, 0, 0);
    setCaptured(src);
  }

  return (
    <span ref={boxRef} className={cn("relative block overflow-hidden", className)}>
      <canvas ref={canvasRef} aria-hidden className={cn("size-full", mediaClassName, showImg && "hidden")} />
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote, backend-hosted GIF
        <img
          src={src}
          alt={alt}
          draggable={false}
          decoding="async"
          loading="lazy"
          onLoad={(e) => capture(e.currentTarget)}
          className={cn("size-full", mediaClassName)}
        />
      ) : (
        <span className="sr-only">{alt}</span>
      )}
    </span>
  );
}
