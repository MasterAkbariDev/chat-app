"use client";

/* eslint-disable @next/next/no-img-element -- remote, backend-hosted poster frames */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePerformance } from "@/contexts/performance-context";
import { resolvePhotoSrc } from "@/components/ui/Avatar";
import { cn } from "@/lib/cn";

// ---- One IntersectionObserver for every LoopVideo on the page -------------
// "On screen" means at least half of it is visible, so a profile video that's
// mostly scrolled away stops decoding.
const ioCallbacks = new WeakMap<Element, (visible: boolean) => void>();
let sharedObserver: IntersectionObserver | null = null;
function observeHalfVisible(el: Element, cb: (visible: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") {
    cb(true);
    return () => {};
  }
  sharedObserver ??= new IntersectionObserver(
    (entries) => entries.forEach((e) => ioCallbacks.get(e.target)?.(e.isIntersecting && e.intersectionRatio >= 0.5)),
    { threshold: [0, 0.5] },
  );
  ioCallbacks.set(el, cb);
  sharedObserver.observe(el);
  return () => {
    ioCallbacks.delete(el);
    sharedObserver?.unobserve(el);
  };
}

// ---- Tab visibility ---------------------------------------------------------
function subscribeVisibility(cb: () => void) {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}
const pageVisibleSnapshot = () => document.visibilityState === "visible";
const pageVisibleServer = () => false;

// ---- Decoder budget -----------------------------------------------------------
// At most MAX_DECODING videos play at once; the most recent ones to ask win and
// older ones fall back to a paused frame until a slot frees up.
const MAX_DECODING = 2;
let decodeQueue: symbol[] = [];
const decodeListeners = new Set<() => void>();
function subscribeDecode(cb: () => void) {
  decodeListeners.add(cb);
  return () => {
    decodeListeners.delete(cb);
  };
}
function setWanting(id: symbol, want: boolean) {
  const without = decodeQueue.filter((x) => x !== id);
  decodeQueue = want ? [...without, id] : without;
  decodeListeners.forEach((l) => l());
}
function useDecodeSlot(want: boolean): boolean {
  const [id] = useState(() => Symbol("loop-video"));
  useEffect(() => {
    if (!want) return;
    setWanting(id, true);
    return () => setWanting(id, false);
  }, [want, id]);
  return useSyncExternalStore(
    subscribeDecode,
    () => want && decodeQueue.slice(-MAX_DECODING).includes(id),
    () => false,
  );
}

export interface LoopVideoProps {
  /** The (silent, short) video. Absolute, `/uploads/…` or media-relative. */
  src: string;
  /** Still frame shown before playback, and instead of it when motion is off. */
  poster?: string | null;
  /** Parent says this one may play (e.g. it's the current slide). Default true. */
  active?: boolean;
  /** Accessible name; omit for a decorative video. */
  label?: string;
  fit?: "cover" | "contain";
  className?: string;
}

/** A silent, looping profile video that only costs something while you can see it.
 *  - Plays only while ≥ 50 % on screen and the tab is visible (one shared observer).
 *  - Follows Motion & performance: "off", lite mode or reduced motion show the
 *    poster only; "on hover" plays while hovered/focused, or for a few seconds after a tap.
 *  - `preload="metadata"` until first seen; at most two decode at once.
 *  - Releases its decoder and buffer on unmount. */
export function LoopVideo({ src, poster, active = true, label, fit = "cover", className }: LoopVideoProps) {
  const { animatedMedia, reduceMotion, lite } = usePerformance();
  const mode = lite || reduceMotion || animatedMedia === "off" ? "off" : animatedMedia;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  const [seen, setSeen] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [failed, setFailed] = useState(false);
  const pageVisible = useSyncExternalStore(subscribeVisibility, pageVisibleSnapshot, pageVisibleServer);

  const videoSrc = resolvePhotoSrc(src);
  const posterSrc = resolvePhotoSrc(poster);
  const showVideo = mode !== "off" && !failed && !!videoSrc;

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !showVideo) return;
    return observeHalfVisible(el, (visible) => {
      setOnScreen(visible);
      if (visible) setSeen(true);
    });
  }, [showVideo]);

  // Free the decoder and buffered data when the element goes away. (Re-attach
  // the source on setup: Strict Mode runs cleanup then setup on the same node.)
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;
    if (v.getAttribute("src") !== videoSrc) v.setAttribute("src", videoSrc);
    return () => {
      v.pause();
      v.removeAttribute("src");
      v.load();
    };
  }, [showVideo, videoSrc]);

  // "On hover": hover or focus on the video's container, or a tap (plays for a while).
  useEffect(() => {
    const host = videoRef.current?.parentElement;
    if (!host || !showVideo || mode !== "interact") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const on = () => setEngaged(true);
    const off = () => setEngaged(false);
    const tap = () => {
      setEngaged(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(off, 6000);
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
  }, [showVideo, mode]);

  const want = showVideo && active && onScreen && pageVisible && (mode === "auto" || engaged);
  const play = useDecodeSlot(want);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !showVideo) return;
    if (play) {
      v.muted = true; // React doesn't always reflect `muted` onto the element in time for autoplay rules
      v.play().catch(() => {
        // Autoplay refused (data saver, power mode): the poster stays up.
      });
    } else if (!v.paused) {
      v.pause();
    }
  }, [play, showVideo]);


  const fitClass = fit === "cover" ? "object-cover" : "object-contain";

  if (!showVideo) {
    return posterSrc ? (
      <img src={posterSrc} alt={label ?? ""} draggable={false} decoding="async" className={cn("size-full", fitClass, className)} />
    ) : (
      <div aria-label={label} role={label ? "img" : undefined} className={cn("size-full bg-black/20", className)} />
    );
  }

  return (
    <video
      ref={videoRef}
      src={videoSrc ?? undefined}
      poster={posterSrc ?? undefined}
      muted
      loop
      playsInline
      preload={seen ? "auto" : "metadata"}
      disablePictureInPicture
      disableRemotePlayback
      aria-label={label}
      aria-hidden={label ? undefined : true}
      draggable={false}
      onError={() => setFailed(true)}
      className={cn("size-full", fitClass, className)}
    />
  );
}
