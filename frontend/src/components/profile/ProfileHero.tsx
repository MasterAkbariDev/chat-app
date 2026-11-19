"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Star } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { usePerformance } from "@/contexts/performance-context";
import { personColor } from "@/lib/avatar-color";
import type { ProfilePhoto } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { PhotoCounter, SegmentBars, SlideTrack, useSlideTrack } from "./photo-slides";
import { ProfilePhotoViewer } from "./ProfilePhotoViewer";

// Collapsed geometry (px): a 120px circle, then the name block under it.
const AVATAR = 120;
const TOP = 24;
const NAME_TOP = TOP + AVATAR + 18;
const BOTTOM = 6;
const DUR = 440;
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

export interface ProfileHeroProps {
  /** Stable id for the person colour (initials, photo backdrop). */
  colorId: string;
  name: string;
  username: string;
  /** "online" / "last seen 5m ago"; omit while unknown. */
  status?: { text: string; online: boolean } | null;
  /** Main first. Empty shows initials and nothing expands. */
  photos: ProfilePhoto[];
  /** Your own profile: offers "Set as main" on photos that aren't. */
  onSetMain?: (photo: ProfilePhoto) => Promise<unknown>;
  /** The scrolling element the hero sits at the top of (pull-down and scroll-to-collapse). */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Everything under the header; it moves with the hero as it opens and closes. */
  children?: React.ReactNode;
}

type Gesture = {
  x0: number;
  y0: number;
  axis: "x" | "y" | "none" | null;
  startP: number;
  inPhoto: boolean;
  lastX: number;
  lastY: number;
  lastT: number;
  vx: number;
  vy: number;
};

type GestureApi = {
  begin: (x: number, y: number, target: EventTarget | null, t: number) => void;
  /** True when the hero took the move (so the page shouldn't scroll). */
  move: (x: number, y: number, t: number) => boolean;
  end: () => void;
  wheel: (e: WheelEvent) => void;
  scroll: () => void;
};

/** Telegram-style profile header. A 120px circle with the name under it; pull
 *  down (touch, mouse drag, trackpad/wheel up at the top), tap or press Enter and
 *  the circle opens into a full-width square photo with the name on a scrim.
 *  Scroll or push up to close it again. With several photos: segment bars, an
 *  n / N counter, tap the left/right half, swipe or use ←/→. Everything moves
 *  with transform and clip-path only: the layout changes once per open/close and
 *  the content below is offset to hide that jump (FLIP). */
export function ProfileHero({ colorId, name, username, status, photos, onSetMain, scrollRef, children }: ProfileHeroProps) {
  const { reduceMotion } = usePerformance();
  const [expanded, setExpanded] = useState(false);
  const [index, setIndex] = useState(0);
  const [viewerAt, setViewerAt] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [nameH, setNameH] = useState(60);
  const [settingMain, setSettingMain] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const rootRef = useRef<HTMLElement>(null);
  const photoRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLDivElement>(null);
  const belowRef = useRef<HTMLDivElement>(null);

  const count = photos.length;
  const hasPhoto = count > 0;
  const safeIndex = Math.min(index, Math.max(count - 1, 0));
  const current = hasPhoto ? photos[safeIndex] : null;
  const isExpanded = expanded && hasPhoto && width > 0;
  const collapsedH = NAME_TOP + nameH + BOTTOM;
  const layoutH = isExpanded ? width : collapsedH;
  const { bg } = personColor(colorId);

  const track = useSlideTrack({ count, index: safeIndex, onIndex: setIndex, instant: reduceMotion });

  // ---- Painting: every in-between state is a function of one progress p ∈ [0, 1].
  const geo = useRef({ width: 0, collapsedH, layoutH });
  const progress = useRef(0);
  const paint = useCallback((p: number, animate: boolean) => {
    const { width: W, collapsedH: Hc, layoutH: L } = geo.current;
    if (!W) return;
    progress.current = p;
    const s = AVATAR / W;
    const scale = s + (1 - s) * p;
    const ty = TOP * (1 - p);
    const t = (props: string) => (animate ? props.split(",").map((x) => `${x.trim()} ${DUR}ms ${EASE}`).join(", ") : "none");
    // Labels come in over the last half, once the photo is mostly square.
    const fade = Math.max(0, (p - 0.5) * 2) ** 2;
    // The photo's visible box, so the scrims and labels never spill past it mid-way.
    const size = scale * W;
    const side = (W - size) / 2;
    const radius = 0.5 * (1 - p) * size;

    const photo = photoRef.current;
    if (photo) {
      photo.style.transition = t("transform, clip-path");
      photo.style.transform = `translate3d(0, ${ty}px, 0) scale(${scale})`;
      photo.style.clipPath = `inset(0 round ${50 * (1 - p)}%)`;
    }
    const top = topRef.current;
    if (top) {
      top.style.transition = t("opacity, transform, clip-path");
      top.style.opacity = String(fade);
      top.style.transform = `translate3d(0, ${ty}px, 0)`;
      top.style.clipPath = `inset(0px ${side}px ${W - size}px round ${radius}px)`;
    }
    const bottom = bottomRef.current;
    if (bottom) {
      const shift = ty + size - W;
      bottom.style.transition = t("opacity, transform, clip-path");
      bottom.style.opacity = String(fade);
      bottom.style.transform = `translate3d(0, ${shift}px, 0)`;
      bottom.style.clipPath = `inset(${ty - shift}px ${side}px 0px round ${radius}px)`;
    }
    const nm = nameRef.current;
    if (nm) {
      nm.style.transition = t("opacity, transform");
      nm.style.opacity = String(Math.max(0, 1 - p * 1.6));
      nm.style.transform = p ? `translate3d(0, ${p * 16}px, 0)` : "";
    }
    const below = belowRef.current;
    if (below) {
      const offset = Hc + (W - Hc) * p - L;
      below.style.transition = t("transform");
      below.style.transform = Math.abs(offset) < 0.5 ? "" : `translate3d(0, ${offset}px, 0)`;
    }
  }, []);

  // Commit: the layout height changes once; re-anchor at the current progress,
  // then animate to the new resting state.
  useLayoutEffect(() => {
    geo.current = { width, collapsedH, layoutH };
    const target = isExpanded ? 1 : 0;
    paint(progress.current, false);
    if (progress.current === target) return;
    if (reduceMotion) return paint(target, false);
    void photoRef.current?.offsetWidth; // flush the un-animated frame first
    paint(target, true);
  }, [isExpanded, width, collapsedH, layoutH, paint, reduceMotion]);

  // Measure the column width and the collapsed name block.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const nm = nameRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => {
      setWidth(root.clientWidth);
      if (nm) setNameH(nm.offsetHeight);
    });
    ro.observe(root);
    if (nm) ro.observe(nm);
    return () => ro.disconnect();
  }, []);

  const { setWidth: setTrackWidth } = track;
  useLayoutEffect(() => {
    setTrackWidth(width);
  }, [setTrackWidth, width]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  const settle = useCallback(
    (next: boolean) => {
      if (next === isExpanded) paint(next ? 1 : 0, !reduceMotion);
      else setExpanded(next);
    },
    [isExpanded, paint, reduceMotion],
  );

  const go = useCallback(
    (dir: number, wrap = false) => {
      if (count < 2) return;
      setIndex((i) => {
        const n = i + dir;
        if (wrap) return (n + count) % count;
        return Math.min(Math.max(n, 0), count - 1);
      });
    },
    [count],
  );

  // ---- Gestures (touch on the scroller, mouse drag on the hero, wheel) --------
  const gesture = useRef<Gesture | null>(null);
  const suppressClickUntil = useRef(0);
  const wheel = useRef({ acc: 0, lockUntil: 0 });
  const api = useRef<GestureApi>({ begin: () => {}, move: () => false, end: () => {}, wheel: () => {}, scroll: () => {} });

  useLayoutEffect(() => {
    const viewerOpen = viewerAt !== null;
    api.current.begin = (x, y, target, t) => {
      if (viewerOpen || !hasPhoto || !width) {
        gesture.current = null;
        return;
      }
      const inPhoto = !!(target instanceof Node && (photoRef.current?.contains(target) || topRef.current?.contains(target)));
      gesture.current = { x0: x, y0: y, axis: null, startP: progress.current, inPhoto, lastX: x, lastY: y, lastT: t, vx: 0, vy: 0 };
    };
    api.current.move = (x, y, t) => {
      const g = gesture.current;
      if (!g || g.axis === "none") return false;
      const dx = x - g.x0;
      const dy = y - g.y0;
      if (!g.axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return false;
        const atTop = (scrollRef.current?.scrollTop ?? 0) <= 0;
        if (Math.abs(dx) > Math.abs(dy)) g.axis = isExpanded && g.inPhoto && count > 1 ? "x" : "none";
        else g.axis = atTop && ((dy > 0 && !isExpanded) || (dy < 0 && isExpanded)) ? "y" : "none";
        if (g.axis === "none") return false;
      }
      const dt = Math.max(1, t - g.lastT);
      g.vx = (x - g.lastX) / dt;
      g.vy = (y - g.lastY) / dt;
      g.lastX = x;
      g.lastY = y;
      g.lastT = t;
      if (g.axis === "y") {
        const range = Math.max(1, width - collapsedH);
        paint(Math.min(1, Math.max(0, g.startP + dy / range)), false);
      } else {
        track.drag(dx);
      }
      return true;
    };
    api.current.end = () => {
      const g = gesture.current;
      gesture.current = null;
      if (!g || !g.axis || g.axis === "none") return;
      suppressClickUntil.current = performance.now() + 350;
      if (g.axis === "y") {
        const p = progress.current;
        const next = g.vy > 0.45 ? true : g.vy < -0.45 ? false : g.startP < 0.5 ? p > 0.25 : p > 0.75;
        settle(next);
      } else {
        track.release(g.lastX - g.x0, g.vx);
      }
    };
    api.current.wheel = (e) => {
      const w = wheel.current;
      const sc = scrollRef.current;
      if (viewerOpen || !hasPhoto || !sc || sc.scrollTop > 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        w.acc = 0;
        return;
      }
      if (performance.now() < w.lockUntil) {
        // Swallow the trackpad's momentum tail right after a change.
        if (e.cancelable) e.preventDefault();
        return;
      }
      if (!isExpanded && e.deltaY < 0) {
        w.acc += e.deltaY;
        if (e.cancelable) e.preventDefault();
        if (w.acc < -60) {
          w.acc = 0;
          w.lockUntil = performance.now() + 650;
          settle(true);
        }
      } else if (isExpanded && e.deltaY > 0) {
        w.acc += e.deltaY;
        if (e.cancelable) e.preventDefault();
        if (w.acc > 24) {
          w.acc = 0;
          w.lockUntil = performance.now() + 650;
          settle(false);
        }
      } else {
        w.acc = 0;
      }
    };
    api.current.scroll = () => {
      // Scrolled some other way (keyboard, scrollbar): close it.
      if (isExpanded && (scrollRef.current?.scrollTop ?? 0) > 4 && !gesture.current) settle(false);
    };
  });

  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        gesture.current = null;
        return;
      }
      const t = e.touches[0];
      api.current.begin(t.clientX, t.clientY, e.target, e.timeStamp);
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t && api.current.move(t.clientX, t.clientY, e.timeStamp) && e.cancelable) e.preventDefault();
    };
    const onEnd = () => api.current.end();
    const onWheel = (e: WheelEvent) => api.current.wheel(e);
    const onScroll = () => api.current.scroll();
    sc.addEventListener("touchstart", onStart, { passive: true });
    sc.addEventListener("touchmove", onMove, { passive: false });
    sc.addEventListener("touchend", onEnd);
    sc.addEventListener("touchcancel", onEnd);
    sc.addEventListener("wheel", onWheel, { passive: false });
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sc.removeEventListener("touchstart", onStart);
      sc.removeEventListener("touchmove", onMove);
      sc.removeEventListener("touchend", onEnd);
      sc.removeEventListener("touchcancel", onEnd);
      sc.removeEventListener("wheel", onWheel);
      sc.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef]);

  function onMouseDown(e: React.PointerEvent) {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    api.current.begin(e.clientX, e.clientY, e.target, e.timeStamp);
    const move = (ev: PointerEvent) => {
      if (api.current.move(ev.clientX, ev.clientY, ev.timeStamp)) ev.preventDefault();
    };
    const up = () => {
      api.current.end();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  // ---- Taps and keys on the photo ------------------------------------------------
  function onPhotoClick(e: React.MouseEvent<HTMLDivElement>) {
    if (performance.now() < suppressClickUntil.current) return;
    if (!isExpanded) return setExpanded(true);
    if (count < 2) return setViewerAt(safeIndex);
    const rect = e.currentTarget.getBoundingClientRect();
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const right = e.clientX - rect.left > rect.width / 2;
    go(right !== rtl ? 1 : -1, true);
  }

  function onPhotoKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!isExpanded) setExpanded(true);
      else setViewerAt(safeIndex);
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && isExpanded && count > 1) {
      e.preventDefault();
      const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
      go((e.key === "ArrowRight") !== rtl ? 1 : -1);
    } else if (e.key === "Escape" && isExpanded) {
      e.preventDefault();
      e.stopPropagation();
      setExpanded(false);
    }
  }

  async function makeMain() {
    if (!current || !onSetMain) return;
    setSettingMain(true);
    try {
      await onSetMain(current);
      setIndex(0); // The main photo always comes first.
      setNotice("Main photo updated. Everyone sees it now.");
    } catch {
      setNotice("Couldn't set your main photo. Try again.");
    } finally {
      setSettingMain(false);
    }
  }

  const hit = isExpanded ? "pointer-events-auto" : "pointer-events-none";
  const chip = "inline-flex h-8 items-center gap-1.5 rounded-full bg-black/45 px-3 text-[13px] font-semibold text-white";
  const roundBtn =
    "pressable flex size-10 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/60 [&_svg]:size-[18px] disabled:opacity-40";
  const photoLabel = !isExpanded
    ? `Open ${name}'s profile photo${count > 1 ? `s (${count})` : ""}`
    : `${name}'s photo ${safeIndex + 1} of ${count}. Enter for full screen${count > 1 ? ", arrow keys for more" : ""}.`;

  return (
    <>
      <section
        ref={rootRef}
        aria-label={`${name}'s profile`}
        className="group/hero relative w-full select-none"
        style={{ height: layoutH }}
        onPointerDown={onMouseDown}
      >
        {/* Collapsed: name, @username and status under the circle. */}
        <div ref={nameRef} className="absolute inset-x-0 px-5 text-center" style={{ top: NAME_TOP }}>
          <h2 dir="auto" className="break-words font-display text-[26px] font-bold leading-tight tracking-[-0.01em] text-fg">
            {name}
          </h2>
          <p className="mt-1 flex flex-wrap items-center justify-center gap-x-1.5 text-[14.5px] text-muted">
            <span dir="ltr">@{username}</span>
            {status ? (
              <>
                <span aria-hidden>·</span>
                <span className={cn("inline-flex items-center gap-1.5", status.online && "font-medium text-accent-text")}>
                  {status.online ? <span aria-hidden className="size-2 rounded-full bg-online" /> : null}
                  {status.text}
                </span>
              </>
            ) : null}
          </p>
        </div>

        {hasPhoto ? (
          <>
            {/* The photo: one full-width square, scaled and clipped into the circle. */}
            <div
              ref={photoRef}
              role="button"
              tabIndex={0}
              aria-label={photoLabel}
              aria-expanded={isExpanded}
              onClick={onPhotoClick}
              onKeyDown={onPhotoKeyDown}
              className="peer absolute start-0 top-0 z-[1] cursor-pointer overflow-hidden outline-none"
              style={{
                width: width || AVATAR,
                height: width || AVATAR,
                transformOrigin: "50% 0",
                background: bg,
                visibility: width ? undefined : "hidden",
                willChange: "transform",
                clipPath: "inset(0 round 50%)",
              }}
            >
              <SlideTrack photos={photos} index={safeIndex} track={track} preloadNext={isExpanded} />
            </div>
            {/* Focus ring (the photo's own would be clipped away). */}
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute z-[3] opacity-0 ring-2 ring-accent transition-opacity peer-focus-visible:opacity-100",
                isExpanded ? "inset-x-0 top-0 ring-inset" : "rounded-full ring-offset-2 ring-offset-canvas",
              )}
              style={
                isExpanded
                  ? { height: width }
                  : { width: AVATAR, height: AVATAR, top: TOP, left: `calc(50% - ${AVATAR / 2}px)` }
              }
            />

            {/* Bottom of the open photo: scrim + name. Decorative (the h2 above is the heading). */}
            <div ref={bottomRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[2] opacity-0" style={{ height: width }}>
              <div className="absolute inset-x-0 bottom-0 h-[52%] bg-gradient-to-t from-black/75 via-black/35 to-transparent" />
              <div className="absolute inset-x-0 bottom-0 px-5 pb-5 text-white">
                <div dir="auto" className="break-words font-display text-[28px] font-bold leading-tight tracking-[-0.01em] [text-shadow:0_1px_12px_rgb(0_0_0/0.35)]">
                  {name}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[14.5px] text-white/85">
                  {status?.online ? <span className="size-2 rounded-full bg-online" style={{ boxShadow: "0 0 0 2px rgb(0 0 0 / 0.25)" }} /> : null}
                  <span>{status ? status.text : `@${username}`}</span>
                </div>
              </div>
            </div>

            {/* Top of the open photo: segments, counter and actions. */}
            <div
              ref={topRef}
              inert={!isExpanded}
              className="pointer-events-none absolute inset-x-0 top-0 z-[2] opacity-0"
              style={{ height: width }}
            >
              <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/45 to-transparent" />
              <SegmentBars count={count} index={safeIndex} className="absolute inset-x-3 top-3" />
              <div className={cn(hit, "absolute end-3 top-6 flex items-center gap-1.5")}>
                {onSetMain && current ? (
                  current.isMain ? (
                    <span className={chip}>
                      <Star className="size-3.5 fill-current" strokeWidth={2} aria-hidden />
                      Main
                    </span>
                  ) : (
                    <button type="button" onClick={() => void makeMain()} disabled={settingMain} className={cn(chip, "pressable h-10 hover:bg-black/60")}>
                      {settingMain ? <Spinner className="size-3.5 text-white" label="Setting main photo" /> : <Star className="size-3.5" strokeWidth={2.2} aria-hidden />}
                      Set as main
                    </button>
                  )
                ) : null}
                {count > 1 ? <PhotoCounter index={safeIndex} count={count} className="h-8 px-3 text-[13px]" /> : null}
                <button type="button" onClick={() => setViewerAt(safeIndex)} aria-label="View full screen" title="View full screen" className={roundBtn}>
                  <Maximize2 strokeWidth={2.2} />
                </button>
              </div>
              {notice ? (
                <p role="status" className="pointer-events-none absolute inset-x-3 top-[4.25rem] mx-auto w-fit max-w-full rounded-full bg-black/60 px-3 py-1.5 text-center text-[13px] font-medium text-white">
                  {notice}
                </p>
              ) : null}
              {count > 1 ? (
                <>
                  <button
                    type="button"
                    onClick={() => go(-1)}
                    disabled={safeIndex === 0}
                    aria-label="Previous photo"
                    title="Previous photo"
                    className={cn(roundBtn, hit, "absolute start-3 top-1/2 hidden -translate-y-1/2 opacity-0 transition-opacity group-hover/hero:opacity-100 focus-visible:opacity-100 [@media(hover:hover)]:flex")}
                  >
                    <ChevronLeft className="rtl:rotate-180" strokeWidth={2.2} />
                  </button>
                  <button
                    type="button"
                    onClick={() => go(1)}
                    disabled={safeIndex === count - 1}
                    aria-label="Next photo"
                    title="Next photo"
                    className={cn(roundBtn, hit, "absolute end-3 top-1/2 hidden -translate-y-1/2 opacity-0 transition-opacity group-hover/hero:opacity-100 focus-visible:opacity-100 [@media(hover:hover)]:flex")}
                  >
                    <ChevronRight className="rtl:rotate-180" strokeWidth={2.2} />
                  </button>
                </>
              ) : null}
            </div>
          </>
        ) : (
          <div className="absolute start-1/2 -translate-x-1/2 rtl:translate-x-1/2" style={{ top: TOP }}>
            <Avatar colorId={colorId} name={name} size={AVATAR} />
          </div>
        )}
      </section>

      <div ref={belowRef} className="relative">
        {children}
      </div>

      {viewerAt !== null && hasPhoto ? (
        <ProfilePhotoViewer
          photos={photos}
          startIndex={viewerAt}
          name={name}
          onSetMain={onSetMain}
          onClose={() => setViewerAt(null)}
        />
      ) : null}
    </>
  );
}
