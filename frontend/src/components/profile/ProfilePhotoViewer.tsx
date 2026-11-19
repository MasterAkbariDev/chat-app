"use client";

/* eslint-disable @next/next/no-img-element -- remote, backend-hosted thumbnails */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Play, Star, X } from "lucide-react";
import { resolvePhotoSrc } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { usePerformance } from "@/contexts/performance-context";
import { useBackToClose } from "@/hooks/use-back-to-close";
import type { ProfilePhoto } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { SlideTrack, useSlideTrack } from "./photo-slides";
import { photoStill } from "./use-profile-photos";

const FOCUSABLE = 'button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';

export interface ProfilePhotoViewerProps {
  photos: ProfilePhoto[];
  startIndex?: number;
  /** Whose photos — for the accessible name and the header. */
  name: string;
  onClose: () => void;
  /** Your own photos: offers "Set as main" on the ones that aren't. */
  onSetMain?: (photo: ProfilePhoto) => Promise<unknown>;
}

/** Full-screen photo viewer: every photo with an n / N counter, swipe or
 *  ←/→ to move, a thumbnail strip, swipe down or Esc to close. Focus is trapped
 *  inside and returns to whatever opened it. */
export function ProfilePhotoViewer({ photos, startIndex = 0, name, onClose, onSetMain }: ProfilePhotoViewerProps) {
  const { reduceMotion } = usePerformance();
  const [index, setIndex] = useState(() => Math.min(Math.max(startIndex, 0), Math.max(photos.length - 1, 0)));
  const [settingMain, setSettingMain] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragY, setDragY] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const thumbsRef = useRef<HTMLDivElement>(null);
  const [returnFocusTo] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  // Phone/browser Back closes the viewer instead of leaving the page.
  useBackToClose(() => onCloseRef.current());

  const count = photos.length;
  const safeIndex = Math.min(index, Math.max(count - 1, 0));
  const current = photos[safeIndex];
  const track = useSlideTrack({ count, index: safeIndex, onIndex: setIndex, instant: reduceMotion });

  // Close if the list empties underneath us (e.g. the last photo was deleted).
  useEffect(() => {
    if (count === 0) onCloseRef.current();
  }, [count]);

  // Stage width for paging.
  const { setWidth } = track;
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [setWidth]);

  // Focus in, scroll lock, focus back out.
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      if (returnFocusTo?.isConnected) returnFocusTo.focus({ preventScroll: true });
    };
  }, [returnFocusTo]);

  // Keys, on window capture so a Dialog underneath (the photo manager) never
  // sees them: Esc, ←/→, Home/End and a Tab trap.
  const go = useCallback((dir: number) => setIndex((i) => Math.min(Math.max(i + dir, 0), count - 1)), [count]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const root = rootRef.current;
      if (!root) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCloseRef.current();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const rtl = getComputedStyle(root).direction === "rtl";
        go((e.key === "ArrowRight") !== rtl ? 1 : -1);
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setIndex(e.key === "Home" ? 0 : count - 1);
      } else if (e.key === "Tab") {
        e.stopImmediatePropagation();
        const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
        if (nodes.length === 0) return e.preventDefault();
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (!root.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [count, go]);

  // Keep the current thumbnail in view.
  useEffect(() => {
    const strip = thumbsRef.current;
    const thumb = strip?.querySelector<HTMLElement>(`[data-index="${safeIndex}"]`);
    if (!strip || !thumb) return;
    const left = thumb.offsetLeft - strip.clientWidth / 2 + thumb.clientWidth / 2;
    strip.scrollTo({ left, behavior: reduceMotion ? "auto" : "smooth" });
  }, [safeIndex, reduceMotion]);

  // Swipe: horizontal pages, vertical (down) closes. Pointer events with
  // touch-action: none, since nothing in here scrolls.
  const gesture = useRef<{ id: number; x: number; y: number; axis: "x" | "y" | null; lastX: number; lastT: number; vx: number } | null>(null);
  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || count === 0) return;
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: null, lastX: e.clientX, lastT: e.timeStamp, vx: 0 };
  }
  function onPointerMove(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
    const dt = Math.max(1, e.timeStamp - g.lastT);
    g.vx = (e.clientX - g.lastX) / dt;
    g.lastX = e.clientX;
    g.lastT = e.timeStamp;
    if (g.axis === "x") track.drag(dx);
    else setDragY(Math.max(0, dy));
  }
  function onPointerUp(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (!g.axis) {
      // A tap: the left or right half pages, like the profile header.
      if (count < 2 || (e.target as HTMLElement).closest("button")) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
      const right = e.clientX - rect.left > rect.width / 2;
      go(right !== rtl ? 1 : -1);
    } else if (g.axis === "x") track.release(e.clientX - g.x, g.vx);
    else if (g.axis === "y") {
      if (e.clientY - g.y > 110) onCloseRef.current();
      else setDragY(0);
    }
  }

  async function setMain() {
    if (!current || !onSetMain) return;
    setSettingMain(true);
    setNotice(null);
    try {
      await onSetMain(current);
      setIndex(0); // The main photo always comes first.
      setNotice("This is your main photo now. Everyone sees it next to your name.");
    } catch {
      setNotice("Couldn't set your main photo. Check your connection and try again.");
    } finally {
      setSettingMain(false);
    }
  }

  if (typeof document === "undefined" || !current) return null;

  const fade = dragY ? Math.max(0.35, 1 - dragY / 400) : 1;
  const chromeBtn =
    "pressable flex size-11 items-center justify-center rounded-full text-white hover:bg-white/15 [&_svg]:size-6 disabled:opacity-40 disabled:hover:bg-transparent";

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${name}'s photos`}
      className="fade-in fixed inset-0 z-[95] flex flex-col text-white"
      style={{ backgroundColor: `rgb(0 0 0 / ${fade})` }}
    >
      {/* Top bar */}
      <div className="safe-top relative z-10 shrink-0" style={{ opacity: fade }}>
        <div className="flex h-14 items-center gap-2 px-2 sm:px-4">
          <button ref={closeRef} type="button" onClick={() => onCloseRef.current()} aria-label="Close" title="Close" className={chromeBtn}>
            <X strokeWidth={2} />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <div dir="auto" className="truncate text-[15px] font-semibold leading-tight">
              {name}
            </div>
            {count > 1 ? (
              <div className="tabular text-[13px] text-white/70" aria-live="polite" aria-atomic>
                {safeIndex + 1} / {count}
              </div>
            ) : null}
          </div>
          {onSetMain ? (
            current.isMain ? (
              <span className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-white/12 px-3 text-[13.5px] font-semibold">
                <Star className="size-4 fill-current" strokeWidth={2} aria-hidden />
                Main photo
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void setMain()}
                disabled={settingMain}
                className="pressable inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-white px-4 text-[14px] font-semibold text-black hover:bg-white/90 disabled:opacity-70"
              >
                {settingMain ? <Spinner className="size-4 border-black/70 text-black" label="Setting main photo" /> : <Star className="size-4" strokeWidth={2} aria-hidden />}
                Set as main
              </button>
            )
          ) : (
            <span aria-hidden className="size-11 shrink-0" />
          )}
        </div>
      </div>

      {/* Stage */}
      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="absolute inset-0"
          style={{
            transform: dragY ? `translate3d(0, ${dragY}px, 0) scale(${1 - Math.min(dragY, 300) / 1500})` : undefined,
            transition: dragY ? "none" : "transform 220ms var(--ease-out)",
          }}
        >
          <SlideTrack photos={photos} index={safeIndex} track={track} fit="contain" label={(i) => `${name}'s photo ${i + 1} of ${count}`} />
        </div>

        {count > 1 ? (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={safeIndex === 0}
              aria-label="Previous photo"
              title="Previous photo"
              className={cn(chromeBtn, "absolute start-3 top-1/2 hidden -translate-y-1/2 bg-black/35 [@media(hover:hover)]:flex")}
            >
              <ChevronLeft className="rtl:rotate-180" strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              disabled={safeIndex === count - 1}
              aria-label="Next photo"
              title="Next photo"
              className={cn(chromeBtn, "absolute end-3 top-1/2 hidden -translate-y-1/2 bg-black/35 [@media(hover:hover)]:flex")}
            >
              <ChevronRight className="rtl:rotate-180" strokeWidth={2} />
            </button>
          </>
        ) : null}
      </div>

      {/* Notice + thumbnails */}
      <div className="relative z-10 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]" style={{ opacity: fade }}>
        <p aria-live="polite" className="min-h-0 px-4 text-center text-[13.5px] text-white/85 empty:hidden">
          {notice}
        </p>
        {count > 1 ? (
          <div ref={thumbsRef} className="mx-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex max-w-full gap-1.5 overflow-x-auto px-4 pb-1 pt-3" role="group" aria-label="All photos">
            {photos.map((p, i) => {
              const src = resolvePhotoSrc(photoStill(p));
              const selected = i === safeIndex;
              return (
                <button
                  key={p.id}
                  type="button"
                  data-index={i}
                  onClick={() => setIndex(i)}
                  aria-label={`Photo ${i + 1} of ${count}${p.isMain ? ", main photo" : ""}${p.kind === "video" ? ", video" : ""}`}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "pressable relative size-12 shrink-0 overflow-hidden rounded-[var(--radius-sm)] bg-white/10 transition-opacity",
                    selected ? "opacity-100 ring-2 ring-white ring-offset-2 ring-offset-black" : "opacity-55 hover:opacity-85",
                  )}
                  style={{ marginInlineStart: i === 0 ? "auto" : undefined, marginInlineEnd: i === count - 1 ? "auto" : undefined }}
                >
                  {src ? <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-cover" /> : null}
                  {p.kind === "video" ? (
                    <span aria-hidden className="absolute bottom-0.5 start-0.5 flex size-4 items-center justify-center rounded-full bg-black/55">
                      <Play className="size-2.5 fill-current" strokeWidth={0} />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
