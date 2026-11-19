"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePerformance } from "@/contexts/performance-context";
import { cn } from "@/lib/cn";
import type { Wallpaper } from "@/lib/api/wallpaper";

export type ChatWallpaperData = Pick<Wallpaper, "type" | "mediaUrl" | "thumbnailUrl" | "blur" | "dim" | "brightness" | "fitMode">;

/** How long the window may sit unfocused (another app in front) before a
 * video wallpaper pauses. Short focus hops (devtools, a notification) don't
 * restart the loop; a chat left open behind other work stops costing frames. */
const BLUR_PAUSE_MS = 30_000;

/* ---------------------------------------------------------------------------
 * Environment hints. Every API here is optional in some browser, so each one
 * is feature-checked and falls back to "no hint" rather than throwing.
 * ------------------------------------------------------------------------- */

function subscribeVisibility(cb: () => void) {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}
const getPageVisible = () => document.visibilityState !== "hidden";

interface NetworkInformationLike extends EventTarget {
  saveData?: boolean;
}
function connection(): NetworkInformationLike | undefined {
  try {
    return (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  } catch {
    return undefined;
  }
}
function subscribeSaveData(cb: () => void) {
  const c = connection();
  if (!c || typeof c.addEventListener !== "function") return () => {};
  c.addEventListener("change", cb);
  return () => c.removeEventListener("change", cb);
}
const getSaveData = () => connection()?.saveData === true;

interface BatteryLike extends EventTarget {
  charging: boolean;
  level: number;
}
/** True when the battery is low and not charging — the closest thing to an
 * OS "battery saver" signal the web exposes (Chromium only; elsewhere false). */
function useBatterySaverHint() {
  const [low, setLow] = useState(false);
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    if (typeof nav.getBattery !== "function") return;
    let battery: BatteryLike | null = null;
    let cancelled = false;
    const update = () => {
      if (battery) setLow(!battery.charging && battery.level <= 0.2);
    };
    nav
      .getBattery()
      .then((b) => {
        if (cancelled) return;
        battery = b;
        update();
        b.addEventListener("chargingchange", update);
        b.addEventListener("levelchange", update);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      battery?.removeEventListener("chargingchange", update);
      battery?.removeEventListener("levelchange", update);
    };
  }, []);
  return low;
}

/** False after the window has been unfocused for BLUR_PAUSE_MS. */
function useWindowRecentlyFocused() {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setFocused(false), BLUR_PAUSE_MS);
    };
    const onFocus = () => {
      clearTimeout(timer);
      setFocused(true);
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return focused;
}

/** Whether the element is on screen at all (a hidden pane, a collapsed
 * layout, scrolled away). Defaults to true where IntersectionObserver is
 * missing. */
function useInView(ref: React.RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setInView(entry.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

/* ---------------------------------------------------------------------------
 * Compositing helpers
 * ------------------------------------------------------------------------- */

const OBJECT_FIT: Record<ChatWallpaperData["fitMode"], React.CSSProperties["objectFit"]> = {
  cover: "cover",
  contain: "contain",
  stretch: "fill",
};

function backgroundSize(fit: ChatWallpaperData["fitMode"]) {
  return fit === "stretch" ? "100% 100%" : fit;
}

/** Folds brightness and dim into plain colour overlays, so a playing video
 * never needs a `filter` (which would force an extra offscreen pass on every
 * decoded frame). Darkening is exact: one black layer whose alpha combines
 * both. Brightening above 100% is approximated with a white wash beneath the
 * dim. */
function overlays(dim: number, brightness: number) {
  const d = Math.min(Math.max(dim, 0), 100) / 100;
  const b = Math.min(Math.max(brightness, 50), 150) / 100;
  if (b <= 1) return { white: 0, black: 1 - (1 - d) * b };
  return { white: Math.min((b - 1) * 0.6, 0.3), black: d };
}

/* ---------------------------------------------------------------------------
 * Component
 * ------------------------------------------------------------------------- */

/**
 * The wallpaper layer behind a conversation (and the settings preview).
 * Purely decorative: aria-hidden, no pointer events, `contain: strict` so its
 * repaints never invalidate the message list above it.
 *
 * Image: rendered as before — a background with blur (dropped in lite mode)
 * and brightness filters, plus a dim overlay.
 *
 * Video (a ≤10 s, ≤1280px, ≤24 fps silent H.264 loop from the server):
 * - The poster frame is painted first; the video fades in over it once its
 *   first frame has decoded, so there's no black flash.
 * - Only the poster is shown in lite mode, with reduce motion, with animated
 *   media off, with Save-Data, or on a low, discharging battery. The <video>
 *   isn't even mounted then, so nothing downloads or decodes.
 * - Playback pauses while the tab is hidden, the pane is off screen, or the
 *   window has been unfocused for a while.
 * - Blur isn't applied while the video plays (a blur filter on a moving layer
 *   re-runs every frame); the still poster is blurred instead in poster-only
 *   mode. Brightness and dim are colour overlays, not filters.
 */
export function ChatWallpaper({ wallpaper, className }: { wallpaper: ChatWallpaperData; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
      style={{ contain: "strict" }}
    >
      {wallpaper.type === "video" ? (
        // Keyed so switching clips resets the "first frame decoded" state.
        <VideoWallpaper key={wallpaper.mediaUrl} wallpaper={wallpaper} />
      ) : (
        <ImageWallpaper wallpaper={wallpaper} />
      )}
    </div>
  );
}

function ImageWallpaper({ wallpaper }: { wallpaper: ChatWallpaperData }) {
  const { lite } = usePerformance();
  const blur = lite ? 0 : wallpaper.blur;
  // Oversized past the blur radius so blurred edges don't fade to the frame colour.
  const bleed = Math.max(24, blur * 2);
  return (
    <>
      <div
        className="absolute"
        style={{
          inset: -bleed,
          backgroundImage: `url(${wallpaper.mediaUrl})`,
          backgroundSize: backgroundSize(wallpaper.fitMode),
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          // Lite mode drops the blur: a full-screen blur re-rasterizes on
          // every scroll frame and is the heaviest effect on weak GPUs.
          filter: `${blur ? `blur(${blur}px) ` : ""}brightness(${wallpaper.brightness}%)`,
        }}
      />
      <div className="absolute inset-0" style={{ background: `rgba(0,0,0,${wallpaper.dim / 100})` }} />
    </>
  );
}

function VideoWallpaper({ wallpaper }: { wallpaper: ChatWallpaperData }) {
  const { lite, reduceMotion, animatedMedia } = usePerformance();
  const saveData = useSyncExternalStore(subscribeSaveData, getSaveData, () => false);
  const lowBattery = useBatterySaverHint();
  const pageVisible = useSyncExternalStore(subscribeVisibility, getPageVisible, () => true);
  const windowFocused = useWindowRecentlyFocused();
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [firstFrame, setFirstFrame] = useState(false);

  const posterOnly = lite || reduceMotion || animatedMedia === "off" || saveData || lowBattery;
  const shouldPlay = !posterOnly && pageVisible && windowFocused && inView;
  const shouldPlayRef = useRef(shouldPlay);

  useEffect(() => {
    shouldPlayRef.current = shouldPlay;
    const video = videoRef.current;
    if (!video) return;
    if (shouldPlay) {
      // Autoplay of a muted inline video is allowed everywhere; a rejection
      // (e.g. an aggressive power-saving policy) just leaves the poster.
      video.play()?.catch(() => {});
    } else if (!video.paused) {
      video.pause();
    }
  }, [shouldPlay]);

  const { white, black } = overlays(wallpaper.dim, wallpaper.brightness);
  const posterBlur = posterOnly && !lite ? wallpaper.blur : 0;
  const poster = wallpaper.thumbnailUrl;

  return (
    <div ref={rootRef} className="absolute inset-0">
      {poster ? (
        <div
          className="absolute"
          style={{
            inset: posterBlur ? -Math.max(24, posterBlur * 2) : 0,
            backgroundImage: `url(${poster})`,
            backgroundSize: backgroundSize(wallpaper.fitMode),
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            filter: posterBlur ? `blur(${posterBlur}px)` : undefined,
            // Fully hidden behind the playing video — skip painting it.
            visibility: firstFrame && !posterOnly ? "hidden" : undefined,
          }}
        />
      ) : null}
      {posterOnly ? null : (
        <video
          ref={videoRef}
          src={wallpaper.mediaUrl}
          poster={poster ?? undefined}
          muted
          playsInline
          loop
          autoPlay
          preload="auto"
          disablePictureInPicture
          disableRemotePlayback
          tabIndex={-1}
          onLoadedData={() => setFirstFrame(true)}
          // `autoPlay` can start the clip while the tab is hidden or the pane
          // is off screen; honour the current gate.
          onPlay={(e) => {
            if (!shouldPlayRef.current) e.currentTarget.pause();
          }}
          className={cn(
            "absolute inset-0 size-full transition-opacity duration-300 ease-out",
            firstFrame ? "opacity-100" : "opacity-0",
          )}
          style={{ objectFit: OBJECT_FIT[wallpaper.fitMode] }}
        />
      )}
      {white ? <div className="absolute inset-0" style={{ background: `rgba(255,255,255,${white})` }} /> : null}
      {black ? <div className="absolute inset-0" style={{ background: `rgba(0,0,0,${black})` }} /> : null}
    </div>
  );
}
