"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Play, VolumeX } from "lucide-react";
import { cn } from "@/lib/cn";
import { claimPlayback, fixInfiniteDuration, formatDuration } from "@/lib/recording";
import { videoPosterUrl } from "@/lib/media-url";
import { usePerformance } from "@/contexts/performance-context";
import * as playback from "@/lib/playback";
import type { PlaybackTrack } from "@/lib/playback";

export interface VideoNotePlayerProps {
  src: string;
  durationSec?: number | null;
  /** Diameter in px. */
  size?: number;
  /** Start playing (with sound) as soon as it can — used for the review step
   *  right after recording, where the tap on "stop" counts as the gesture. */
  autoPlay?: boolean;
  label?: string;
  className?: string;
  /** A message in a chat: plays through the app-wide player (grows while playing, keeps
   *  playing in a floating circle when scrolled away). Without it (recording review) the
   *  clip plays locally. */
  track?: PlaybackTrack;
}

/** A round "video message" (Telegram-style). Tap to play with sound, tap
 * again to pause; a ring around the edge shows progress. Ends rewound to the
 * start, ready to rewatch. */
export function VideoNotePlayer(props: VideoNotePlayerProps) {
  return props.track ? <ChatVideoNote {...props} track={props.track} /> : <LocalVideoNote {...props} />;
}

function LocalVideoNote({ src, durationSec, size = 240, autoPlay, label = "Video message", className }: VideoNotePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  // `current` alone can't tell "never played" apart: the `#t=0.1` poster
  // nudge sets currentTime before anyone presses play.
  const [started, setStarted] = useState(false);

  const duration = mediaDuration && Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : (durationSec ?? 0);
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;
  const stroke = 4;
  const r = size / 2 - stroke / 2;
  const circumference = 2 * Math.PI * r;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (videoRef.current) setCurrent(videoRef.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    const el = videoRef.current;
    if (!autoPlay || !el) return;
    claimPlayback(el);
    el.play().catch(() => {
      // Autoplay with sound refused — fall back to tap-to-play.
    });
  }, [autoPlay, src]);

  function toggle() {
    const el = videoRef.current;
    if (!el || failed) return;
    if (el.paused) {
      claimPlayback(el);
      el.muted = false;
      el.play().catch(() => setFailed(true));
    } else {
      el.pause();
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`${playing ? "Pause" : "Play"} ${label.toLowerCase()}, ${formatDuration(duration)}`}
      className={cn("pressable group/vn relative shrink-0 rounded-full", className)}
      style={{ width: size, height: size }}
    >
      <video
        ref={videoRef}
        // `#t=` nudges Safari/iOS into painting the first frame as a poster.
        src={src.startsWith("blob:") ? src : `${src}#t=0.1`}
        poster={videoPosterUrl(src)}
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => {
          fixInfiniteDuration(e.currentTarget);
          setMediaDuration(e.currentTarget.duration);
        }}
        onDurationChange={(e) => setMediaDuration(e.currentTarget.duration)}
        // Fallback for when animation frames are throttled (background tab).
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => {
          setPlaying(true);
          setStarted(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={(e) => {
          setPlaying(false);
          setCurrent(0);
          setStarted(false);
          e.currentTarget.currentTime = 0;
        }}
        onError={() => setFailed(true)}
        className="size-full rounded-full bg-sunken object-cover"
      />
      <svg className="pointer-events-none absolute inset-0 -rotate-90" width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.25)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          style={{ opacity: started ? 1 : 0, transition: "opacity 160ms" }}
        />
      </svg>
      {!playing ? (
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
          <span className="flex size-12 items-center justify-center rounded-full bg-black/45 text-white transition-transform group-hover/vn:scale-105">
            {failed ? <VolumeX className="size-5" strokeWidth={2} /> : <Play className="ms-0.5 size-6" fill="currentColor" strokeWidth={0} />}
          </span>
        </span>
      ) : null}
      <span className="tabular pointer-events-none absolute bottom-[12%] start-1/2 -translate-x-1/2 rounded-full bg-black/55 px-2 py-0.5 text-[12px] font-semibold text-white rtl:translate-x-1/2">
        {failed ? "Can't play" : formatDuration(started ? current : duration)}
      </span>
    </button>
  );
}

/** How big a playing video note gets (Telegram grows it while it plays). */
function grownSize(base: number): number {
  if (typeof window === "undefined") return base;
  return Math.max(base, Math.min(320, Math.round(window.innerWidth * 0.8)));
}

/** Seconds → fraction of a turn clockwise from 12 o'clock, for a point on the circle. */
function angleFraction(el: HTMLElement, x: number, y: number): number {
  const r = el.getBoundingClientRect();
  const a = Math.atan2(x - (r.left + r.width / 2), -(y - (r.top + r.height / 2)));
  return (a < 0 ? a + 2 * Math.PI : a) / (2 * Math.PI);
}

/** A video note in a chat. Silent looping preview while on screen (if animated media is
 *  allowed); a tap plays it from the start with sound and the circle grows; drag around it
 *  (or ←/→) to seek; tap again to pause. */
function ChatVideoNote({ src, durationSec, size = 240, label = "Video message", className, track }: VideoNotePlayerProps & { track: PlaybackTrack }) {
  const { animatedMedia, reduceMotion } = usePerformance();
  const shared = playback.usePlayback((s) => (s.track?.id === track.id ? s : null));
  const active = !!shared;
  const rootRef = useRef<HTMLButtonElement>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [seekingAt, setSeekingAt] = useState<number | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const duration = shared?.duration || durationSec || 0;
  const current = seekingAt ?? shared?.current ?? 0;
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;
  const diameter = active ? grownSize(size) : size;
  const stroke = 4;
  const r = diameter / 2 - stroke / 2;
  const circumference = 2 * Math.PI * r;
  const previewOn = !active && visible && animatedMedia === "auto";

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // While playing and on screen, the shared video sits in this circle; off screen (or
  // unmounted by the virtual list) it moves to the floating circle and keeps playing.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!active || !visible || !host) return;
    return playback.hostVideoInBubble(track.id, host);
  }, [active, visible, track.id]);

  useEffect(() => {
    const v = previewRef.current;
    if (!v) return;
    if (previewOn) void v.play().catch(() => undefined);
    else v.pause();
  }, [previewOn]);

  function start() {
    playback.play(track, { from: 0 });
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!active) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || !rootRef.current) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    if (!d.moved) {
      d.moved = true;
      rootRef.current.setPointerCapture?.(e.pointerId);
    }
    setSeekingAt(angleFraction(rootRef.current, e.clientX, e.clientY) * duration);
  }
  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      suppressClick.current = true;
      if (seekingAt != null) playback.seek(seekingAt);
      setSeekingAt(null);
    }
  }

  return (
    <button
      ref={rootRef}
      type="button"
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        if (active) playback.toggle();
        else start();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={(e) => {
        if (!active || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        e.stopPropagation();
        playback.seek(current + (e.key === "ArrowRight" ? 5 : -5));
      }}
      aria-label={`${shared?.playing ? "Pause" : "Play"} ${label.toLowerCase()}, ${formatDuration(duration)}`}
      aria-pressed={active ? !!shared?.playing : undefined}
      data-video-note=""
      data-active={active || undefined}
      className={cn("pressable group/vn relative shrink-0 touch-pan-y rounded-full", active && "touch-none", className)}
      style={{
        width: diameter,
        height: diameter,
        transition: reduceMotion ? "none" : "width 260ms var(--ease-out), height 260ms var(--ease-out)",
      }}
    >
      <span className="absolute inset-0 overflow-hidden rounded-full bg-sunken">
        {active ? (
          <span ref={hostRef} className="absolute inset-0 block [&>video]:size-full" />
        ) : null}
        {!active || !shared?.inBubble ? (
          <video
            ref={previewRef}
            src={`${src}#t=0.1`}
            poster={videoPosterUrl(src)}
            muted
            loop
            playsInline
            preload="metadata"
            aria-hidden
            className={cn("size-full object-cover", active && "opacity-60")}
          />
        ) : null}
      </span>
      <svg className="pointer-events-none absolute inset-0 -rotate-90" width={diameter} height={diameter} aria-hidden>
        <circle cx={diameter / 2} cy={diameter / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.25)" strokeWidth={stroke} style={{ opacity: active ? 1 : 0 }} />
        <circle
          cx={diameter / 2}
          cy={diameter / 2}
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          style={{ opacity: active ? 1 : 0, transition: "opacity 160ms" }}
        />
      </svg>
      {!shared?.playing ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
          <span className="flex size-12 items-center justify-center rounded-full bg-black/45 text-white transition-transform group-hover/vn:scale-105">
            {shared?.failed ? <VolumeX className="size-5" strokeWidth={2} /> : <Play className="ms-0.5 size-6" fill="currentColor" strokeWidth={0} />}
          </span>
        </span>
      ) : null}
      {!active ? (
        <span aria-hidden className="pointer-events-none absolute end-[14%] top-[12%] flex size-6 items-center justify-center rounded-full bg-black/50 text-white">
          <VolumeX className="size-3.5" strokeWidth={2.2} />
        </span>
      ) : null}
      {seekingAt != null ? (
        <span className="tabular pointer-events-none absolute start-1/2 top-[10%] -translate-x-1/2 rounded-full bg-black/70 px-2.5 py-1 text-[13px] font-bold text-white rtl:translate-x-1/2">
          {formatDuration(seekingAt)} / {formatDuration(duration)}
        </span>
      ) : null}
      <span className="tabular pointer-events-none absolute bottom-[12%] start-1/2 -translate-x-1/2 rounded-full bg-black/55 px-2 py-0.5 text-[12px] font-semibold text-white rtl:translate-x-1/2">
        {shared?.failed ? "Can't play" : formatDuration(active ? current : duration)}
      </span>
    </button>
  );
}
