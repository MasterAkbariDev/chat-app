"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize, Minimize, Pause, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/cn";
import { claimPlayback, formatDuration } from "@/lib/recording";
import { usePerformance } from "@/contexts/performance-context";
import { DOUBLE_TAP_MS, HOLD_DELAY_MS, HOLD_RATE, REWIND_RATE, holdLabel, holdSpeed, isDoubleTap, movedBeyond, rewindTime, seekDelta, seekLabel, shouldReplayShort, zoneAt, type SideZone } from "./media-gesture";
import { ProgressLine, ScrubBar } from "./VideoControls";

const HIDE_AFTER_MS = 2500;
const REWIND_TICK_MS = 100;
const FLASH_MS = 650;

export interface VideoPlayerProps {
  src: string;
  poster?: string;
  /** Known length (from the message), shown before metadata loads. */
  durationSec?: number | null;
  /** "compact": a chat bubble — poster, a small play button and the duration; with `onExpand`
   *  the play button opens the media viewer (plays inline only without it). Once playing it
   *  shows just a thin progress line. "full": the media viewer — the HUD (centre play/pause,
   *  progress, time, volume, speed, full screen), toggled by a tap. */
  variant?: "compact" | "full";
  autoPlay?: boolean;
  label: string;
  /** Compact only: opens the media viewer, where the video plays full size. */
  onExpand?: () => void;
  /** Reports the video's real pixel size once its metadata is known. */
  onVideoSize?: (width: number, height: number) => void;
  className?: string;
  /** Fills its box (object-contain); the parent sizes it. */
  fit?: "cover" | "contain";
  /** While true the clip is paused (the viewer is swiping it away); it does not resume by itself. */
  pauseWhen?: boolean;
  /** Playback speed, set by the owner (the viewer's menu). Holding a side still overrides it. */
  rate?: number;
  /** Full only: content under the controls (the viewer's caption); it hides with the HUD. */
  footer?: React.ReactNode;
  /** Full only: reports whether the HUD is showing, so the owner can hide its own chrome with it. */
  onHudChange?: (visible: boolean) => void;
}

/** A side tap waiting out the double-tap window: a second tap on the same side seeks instead. */
interface PendingSideTap {
  zone: SideZone;
  time: number;
  timer: number;
}

interface Gesture {
  id: number;
  x: number;
  y: number;
  holding: boolean;
  moved: boolean;
  timer: number | null;
  detach: () => void;
}

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

const iconBtn =
  "pressable flex size-11 shrink-0 items-center justify-center rounded-full text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white";

/** Hearth's video player: one clip at a time (`claimPlayback`), poster first. The full variant
 *  has a HUD: a tap on the video shows or hides it; it hides by itself after a while during
 *  playback. Holding a side plays at 2× (right) or rewinds (left). Shortcuts (full variant, or
 *  once focused): Space/K play-pause, J/L back/forward 10 s, ←/→ 5 s, M mute, F full screen. */
export function VideoPlayer({ src, poster, durationSec, variant = "compact", autoPlay, label, onExpand, onVideoSize, className, fit = "contain", pauseWhen, rate = 1, footer, onHudChange }: VideoPlayerProps) {
  const full = variant === "full";
  const { prefs, lite } = usePerformance();
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Full variant only: which side is held (2× or rewind).
  const [holding, setHolding] = useState<SideZone | null>(null);
  // The speed of the current hold (2× / 4× rewind, rising as the finger slides), shown on the side.
  const [holdRate, setHoldRate] = useState<number>(HOLD_RATE);
  const holdRef = useRef<number>(HOLD_RATE);
  // Full variant only: the "±10 s" flash after a double tap on a side.
  const [seekFlash, setSeekFlash] = useState<SideZone | null>(null);
  const flashTimer = useRef<number | null>(null);
  const pendingSide = useRef<PendingSideTap | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const stopHold = useRef<(() => void) | null>(null);
  const hideTimer = useRef<number | null>(null);
  const hudOn = useRef(true);
  const rateRef = useRef(rate);
  // No poster (migrated clips) or one that fails to load would leave a black box until play:
  // then the first decodable frame stands in for it (see onLoadedMetadata).
  const [brokenPoster, setBrokenPoster] = useState<string | null>(null);
  const hasStill = !!poster && brokenPoster !== poster;

  useEffect(() => {
    if (!poster) return;
    const probe = new Image();
    probe.onerror = () => setBrokenPoster(poster);
    probe.src = poster;
    return () => {
      probe.onerror = null;
    };
  }, [poster]);

  const duration = mediaDuration && Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : (durationSec ?? 0);
  const shown = seekPreview ?? current;

  /** Shows the HUD; while the clip plays it hides again after a pause in input. */
  const setHud = useCallback((on: boolean) => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
    hudOn.current = on;
    setControlsVisible(on);
    if (on && videoRef.current && !videoRef.current.paused) {
      hideTimer.current = window.setTimeout(() => {
        hudOn.current = false;
        hideTimer.current = null;
        setControlsVisible(false);
      }, HIDE_AFTER_MS);
    }
  }, []);

  const poke = useCallback(() => setHud(true), [setHud]);
  const toggleHud = useCallback(() => setHud(!hudOn.current), [setHud]);

  useEffect(() => () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    if (pendingSide.current) window.clearTimeout(pendingSide.current.timer);
    gestureRef.current?.detach();
    if (gestureRef.current?.timer) window.clearTimeout(gestureRef.current.timer);
    stopHold.current?.();
  }, []);

  // Smooth progress while playing (timeupdate alone fires ~4×/s).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) setCurrent(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    function onChange() {
      setIsFullscreen(document.fullscreenElement === rootRef.current && !!rootRef.current);
    }
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // The viewer swipes this clip away: stop it, so it doesn't play on under the next slide.
  useEffect(() => {
    if (pauseWhen) videoRef.current?.pause();
  }, [pauseWhen]);

  // The owner's speed applies at once, unless a side is held (the hold sets its own rate).
  useEffect(() => {
    rateRef.current = rate;
    const v = videoRef.current;
    if (v && !stopHold.current) v.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    const v = videoRef.current;
    if (!autoPlay || !v) return;
    claimPlayback(v);
    v.play().catch(() => {
      // Autoplay with sound refused — the play button is still there.
    });
  }, [autoPlay, src, reloadKey]);

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v || failed) return;
    if (v.paused || v.ended) {
      claimPlayback(v);
      void v.play().catch(() => undefined);
    } else {
      v.pause();
    }
  }, [failed]);

  const seekBy = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.min(Math.max(0, v.currentTime + delta), v.duration || duration || 0);
    setCurrent(v.currentTime);
  }, [duration]);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 0.6;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current;
    const v = videoRef.current as FullscreenVideo | null;
    if (!root) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else if (root.requestFullscreen) {
      void root.requestFullscreen().catch(() => v?.webkitEnterFullscreen?.());
    } else {
      v?.webkitEnterFullscreen?.(); // iPhone Safari
    }
  }, []);

  function endHold() {
    stopHold.current?.();
    stopHold.current = null;
    setHolding(null);
  }

  /** Right side: play at 2×. Left side: rewind at 4× while held (paused), then resume if it was playing. */
  function startHold(zone: SideZone) {
    const v = videoRef.current;
    if (!v) return;
    holdRef.current = zone === "right" ? HOLD_RATE : REWIND_RATE;
    setHoldRate(holdRef.current);
    setHolding(zone);
    if (zone === "right") {
      v.playbackRate = holdRef.current;
      stopHold.current = () => {
        v.playbackRate = rateRef.current;
      };
      return;
    }
    const wasPlaying = !v.paused && !v.ended;
    v.pause();
    let last = Date.now();
    const id = window.setInterval(() => {
      const now = Date.now();
      v.currentTime = rewindTime(v.currentTime, now - last, holdRef.current);
      last = now;
      setCurrent(v.currentTime);
    }, REWIND_TICK_MS);
    stopHold.current = () => {
      window.clearInterval(id);
      if (wasPlaying) {
        claimPlayback(v);
        void v.play().catch(() => undefined);
      }
    };
  }

  /** Speed of a running hold: slide sideways to step it up (see holdSpeed). */
  function updateHold(zone: SideZone, travel: number) {
    const next = holdSpeed(zone, travel);
    if (next === holdRef.current) return;
    holdRef.current = next;
    setHoldRate(next);
    const v = videoRef.current;
    if (zone === "right" && v) v.playbackRate = next;
  }

  function flashSeek(zone: SideZone) {
    setSeekFlash(zone);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setSeekFlash(null), FLASH_MS);
  }

  /** A side tap still waiting out the double-tap window counts as a single tap: the HUD toggles. */
  function flushPendingSide() {
    const p = pendingSide.current;
    if (!p) return;
    window.clearTimeout(p.timer);
    pendingSide.current = null;
    toggleHud();
  }

  /** Full variant: a tap anywhere on the video shows or hides the HUD; a second tap on the same
   *  side within the double-tap window seeks ±10 s. Pressing and holding a side plays at 2×
   *  (right) or rewinds (left) until released, and sliding sideways steps the speed up. Listens on
   *  window so the release still arrives after pointer capture moves to the stage, and so a drag
   *  never counts as a tap. */
  function onGesturePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!full || gestureRef.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button,input,[data-no-gesture]")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const zone = zoneAt(e.clientX, rect.left, rect.width);
    const side = zone === "center" ? null : zone;
    const g: Gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, holding: false, moved: false, timer: null, detach: () => undefined };
    if (side) {
      g.timer = window.setTimeout(() => {
        g.timer = null;
        g.holding = true;
        startHold(side);
      }, HOLD_DELAY_MS);
    }
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== g.id) return;
      if (g.holding) {
        ev.stopPropagation();
        return;
      }
      if (!g.moved && movedBeyond(ev.clientX - g.x, ev.clientY - g.y)) {
        g.moved = true;
        if (g.timer) window.clearTimeout(g.timer);
        g.timer = null;
      }
    };
    const onHoldMove = (ev: PointerEvent) => {
      if (ev.pointerId === g.id && g.holding && side) updateHold(side, ev.clientX - g.x);
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== g.id) return;
      g.detach();
      if (gestureRef.current === g) gestureRef.current = null;
      if (g.timer) window.clearTimeout(g.timer);
      g.timer = null;
      if (g.holding) {
        endHold();
        return;
      }
      if (ev.type === "pointercancel" || g.moved) return;
      if (!side) {
        flushPendingSide();
        toggleHud();
        return;
      }
      // A side: a second tap on the same side within the window seeks; a single one waits to see.
      const now = Date.now();
      const prev = pendingSide.current;
      if (prev && isDoubleTap(prev, side, now)) {
        window.clearTimeout(prev.timer);
        pendingSide.current = null;
        seekBy(seekDelta(side));
        flashSeek(side);
        return;
      }
      flushPendingSide();
      pendingSide.current = {
        zone: side,
        time: now,
        timer: window.setTimeout(() => {
          pendingSide.current = null;
          toggleHud();
        }, DOUBLE_TAP_MS),
      };
    };
    g.detach = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointermove", onHoldMove, true);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointermove", onHoldMove, true);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    gestureRef.current = g;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.target instanceof HTMLInputElement && e.target.type === "range" && (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End")) return;
    const key = e.key.toLowerCase();
    let handled = true;
    if (key === " " || key === "k") {
      if (key === " " && e.target instanceof HTMLButtonElement && e.target !== e.currentTarget) return; // let the button act
      toggle();
    } else if (key === "j") seekBy(-10);
    else if (key === "l") seekBy(10);
    else if (key === "m") toggleMute();
    else if (key === "f") toggleFullscreen();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      poke();
    }
  }

  function updateBuffered(v: HTMLVideoElement) {
    const d = v.duration;
    if (!d || !Number.isFinite(d) || v.buffered.length === 0) return;
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
    }
    setBuffered(Math.min(1, end / d));
  }

  // The HUD stays up while paused or scrubbing; during playback it follows the tap/move timer.
  // The HUD is shown or hidden by taps; paused it is up by default (see onPause).
  const showChrome = controlsVisible || seekPreview !== null;
  useEffect(() => {
    onHudChange?.(showChrome);
  }, [showChrome, onHudChange]);
  const progressPct = duration > 0 ? Math.min(1, shown / duration) : 0;

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={label}
      tabIndex={full ? -1 : undefined}
      onKeyDown={onKeyDown}
      onPointerMove={poke}
      onPointerDown={onGesturePointerDown}
      onFocus={poke}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        "group/vp relative isolate select-none overflow-hidden bg-black text-white outline-none [-webkit-touch-callout:none]",
        isFullscreen && "flex items-center justify-center",
        className,
      )}
      data-playing={playing || undefined}
    >
      <video
        key={reloadKey}
        ref={videoRef}
        src={src}
        poster={hasStill ? poster ?? undefined : undefined}
        playsInline
        // Metadata only (a small header read) even with a poster, so the length is known. Lite
        // mode keeps a bubble to its still until it is tapped.
        preload={full || autoPlay ? "auto" : hasStill || lite ? "none" : "metadata"}
        aria-label={label}
        // The full variant toggles from onGesturePointerDown instead (a tap shows the HUD).
        onClick={() => {
          if (full || !started) return;
          toggle();
        }}
        // Viewer only: a short clip (see shouldReplayShort) loops natively, so it restarts at the end.
        loop={full && shouldReplayShort(duration, prefs.replayShort)}
        disablePictureInPicture
        controlsList="nodownload noremoteplayback"
        // No browser save/share menu on a press-and-hold; the hold gestures still work.
        onContextMenu={(e) => e.preventDefault()}
        onLoadedMetadata={(e) => {
          setMediaDuration(e.currentTarget.duration);
          if (e.currentTarget.videoWidth && e.currentTarget.videoHeight) onVideoSize?.(e.currentTarget.videoWidth, e.currentTarget.videoHeight);
          e.currentTarget.playbackRate = rateRef.current;
          // Metadata alone paints nothing; nudging the clock to 0.1s makes the browser decode a frame.
          if (!hasStill && !started && e.currentTarget.currentTime === 0) e.currentTarget.currentTime = 0.1;
          setFailed(false);
        }}
        onDurationChange={(e) => setMediaDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => {
          setCurrent(e.currentTarget.currentTime);
          updateBuffered(e.currentTarget);
        }}
        onProgress={(e) => updateBuffered(e.currentTarget)}
        onPlay={() => {
          setPlaying(true);
          setStarted(true);
          poke();
        }}
        onPause={() => {
          setPlaying(false);
          setHud(true);
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onEnded={() => {
          setPlaying(false);
          setHud(true);
        }}
        onVolumeChange={(e) => {
          setMuted(e.currentTarget.muted);
          setVolume(e.currentTarget.volume);
        }}
        onError={() => {
          setFailed(true);
          setWaiting(false);
        }}
        className={cn("block size-full", fit === "cover" ? "object-cover" : "object-contain", !started && !full && "pointer-events-none")}
      />

      {/* Compact: the play button, whenever it is paused. */}
      {!full && !playing && !failed ? (
        <button
          type="button"
          // In a chat bubble, playing always happens full size in the viewer (like Telegram).
          onClick={onExpand ?? toggle}
          aria-label={`Play ${label.toLowerCase()}${duration ? `, ${formatDuration(duration)}` : ""}`}
          className="group/play absolute inset-0 z-[1] flex items-center justify-center rounded-none focus-visible:outline-none"
        >
          <span className="pressable flex size-11 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-md transition-colors group-hover/play:bg-black/50 group-focus-visible/play:ring-2 group-focus-visible/play:ring-white">
            <Play className="ms-1 size-[18px] fill-current" strokeWidth={1.8} aria-hidden />
          </span>
        </button>
      ) : null}

      {/* Full: the centre play/pause, shown with the HUD. It shows a spinner in its place while buffering. */}
      {full && !failed && showChrome ? (
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
          className="pressable absolute left-1/2 top-1/2 z-[2] flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-md transition-colors hover:bg-black/50 focus-visible:outline-2 focus-visible:outline-white"
        >
          {waiting && playing ? (
            <span role="status" aria-label="Loading video" className="size-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : playing ? (
            <Pause className="size-7 fill-current" strokeWidth={1.8} aria-hidden />
          ) : (
            <Play className="ms-1 size-7 fill-current" strokeWidth={1.8} aria-hidden />
          )}
        </button>
      ) : null}

      {!full && waiting && playing && !failed ? (
        <span role="status" aria-label="Loading video" className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm">
            <span className="size-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          </span>
        </span>
      ) : null}

      {/* Full variant: "2×" / "« 4×" while a side is held. */}
      {full && holding ? (
        <span
          aria-hidden
          className={cn(
            "tabular pointer-events-none absolute top-1/2 z-[3] -translate-y-1/2 rounded-full bg-black/45 px-3.5 py-1.5 text-[15px] font-semibold text-white backdrop-blur-md",
            holding === "left" ? "left-8" : "right-8",
          )}
        >
          {holdLabel(holding, holdRate)}
        </span>
      ) : null}

      {/* Full variant: "+10 s" / "−10 s" flashed after a double tap on a side. */}
      {full && seekFlash && !holding ? (
        <span
          aria-hidden
          className={cn(
            "tabular pointer-events-none absolute top-1/2 z-[3] -translate-y-1/2 rounded-full bg-black/45 px-3.5 py-1.5 text-[15px] font-semibold text-white backdrop-blur-md",
            seekFlash === "left" ? "left-8" : "right-8",
          )}
        >
          {seekLabel(seekFlash)}
        </span>
      ) : null}

      {failed ? (
        <div role="alert" className="absolute inset-0 z-[2] flex items-center justify-center p-4">
          <div className="flex flex-col items-center gap-1 rounded-2xl bg-black/60 px-4 py-3 text-center backdrop-blur-md">
            <span className="text-[13.5px] text-white/90">Couldn&apos;t play this video</span>
            <button
              type="button"
              onClick={() => {
                setFailed(false);
                setStarted(false);
                setReloadKey((k) => k + 1);
              }}
              className="pressable inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[13.5px] font-semibold text-white underline decoration-white/50 underline-offset-4 hover:decoration-white focus-visible:outline-2 focus-visible:outline-white"
            >
              <RotateCcw className="size-4" strokeWidth={1.8} aria-hidden />
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {/* Compact, before playing: the duration only. */}
      {!full && !started && duration ? (
        <span className="tabular pointer-events-none absolute start-2 bottom-2 z-[2] rounded-full bg-black/50 px-2 py-0.5 text-[12px] font-medium text-white backdrop-blur-sm">
          {formatDuration(duration)}
        </span>
      ) : null}

      {/* Compact, once started: a thin progress line along the bottom edge, nothing else. */}
      {!full && started && !failed ? <ProgressLine fraction={progressPct} /> : null}

      {/* Full variant HUD: a soft gradient that fades in on tap/move and out while playing. */}
      {full && !failed ? (
        <div
          data-no-gesture=""
          className={cn(
            "absolute inset-x-0 bottom-0 z-[2] transition-opacity duration-300 ease-out",
            showChrome ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-t from-black/75 via-black/35 to-transparent" />
          <div className="px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-16 sm:px-5">
            <ScrubBar
              shown={shown}
              duration={duration}
              buffered={buffered}
              label="Seek"
              active={seekPreview !== null}
              onScrub={(t) => {
                setSeekPreview(t);
                const v = videoRef.current;
                if (v) v.currentTime = t;
              }}
              onScrubEnd={() => setSeekPreview(null)}
            />

            <div className="mt-1 flex items-center gap-1">
              <span className="tabular min-w-0 flex-1 whitespace-nowrap text-[13px] font-medium text-white">
                {formatDuration(shown)}
                <span className="text-white/60"> / {formatDuration(duration)}</span>
              </span>
              <button type="button" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute (M)" : "Mute (M)"} className={iconBtn}>
                {muted || volume === 0 ? <VolumeX className="size-[22px]" strokeWidth={1.8} aria-hidden /> : <Volume2 className="size-[22px]" strokeWidth={1.8} aria-hidden />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label="Volume"
                aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
                onChange={(e) => {
                  const v = videoRef.current;
                  if (!v) return;
                  v.volume = Number(e.target.value);
                  v.muted = v.volume === 0;
                }}
                className="hidden h-1 w-20 cursor-pointer accent-white [@media(hover:hover)_and_(min-width:640px)]:block"
              />
              <button type="button" onClick={toggleFullscreen} aria-label={isFullscreen ? "Exit full screen" : "Full screen"} title="Full screen (F)" className={iconBtn}>
                {isFullscreen ? <Minimize className="size-[22px]" strokeWidth={1.8} aria-hidden /> : <Maximize className="size-[22px]" strokeWidth={1.8} aria-hidden />}
              </button>
            </div>
            {footer}
          </div>
        </div>
      ) : null}
    </div>
  );
}
