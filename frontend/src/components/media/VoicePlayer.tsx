"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/cn";
import { claimPlayback, fixInfiniteDuration, formatDuration } from "@/lib/recording";
import * as playback from "@/lib/playback";
import type { PlaybackTrack } from "@/lib/playback";

const BAR_COUNT = 40;
const SPEEDS = [1, 1.5, 2] as const;

export interface VoicePlayerProps {
  src: string;
  /** Known duration (seconds) — MediaRecorder files often don't report one. */
  durationSec?: number | null;
  /** 0–1 samples; resampled to the bar count. Missing → a stable pseudo-shape. */
  waveform?: number[] | null;
  /** "own" sits on the sender's accent bubble; "other" on a neutral bubble or panel. */
  tone?: "own" | "other";
  label?: string;
  className?: string;
  /** A message in a chat: plays through the app-wide player (keeps playing while you scroll
   *  or change chats, shows in the "now playing" bar). Without it (recording review) the
   *  clip plays locally. */
  track?: PlaybackTrack;
  /** Next voice message after this one, for auto-advance. */
  resolveNext?: (id: string) => PlaybackTrack | null;
}

function resample(values: number[], count: number): number[] {
  if (values.length === 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const start = Math.floor((i / count) * values.length);
    const end = Math.max(start + 1, Math.floor(((i + 1) / count) * values.length));
    let peak = 0;
    for (let j = start; j < end; j++) peak = Math.max(peak, values[j] ?? 0);
    return peak;
  });
}

function pseudoWaveform(seed: string, count: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return Array.from({ length: count }, (_, i) => {
    h = Math.imul(h ^ (i + 1), 2654435761);
    return 0.25 + (((h >>> 0) % 1000) / 1000) * 0.6;
  });
}

/** Voice message player: play/pause, a seekable waveform (also a keyboard
 * slider — arrows skip 5 s), elapsed/remaining time and 1×/1.5×/2× speed. */
export function VoicePlayer({ src, durationSec, waveform, tone = "other", label = "Voice message", className, track, resolveNext }: VoicePlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [localPlaying, setPlaying] = useState(false);
  const [localCurrent, setCurrent] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [localStarted, setStarted] = useState(false);
  const [localFailed, setFailed] = useState(false);
  const shared = usePlaybackFor(track?.id);

  const playing = track ? !!shared?.playing : localPlaying;
  const current = track ? (shared?.current ?? 0) : localCurrent;
  const started = track ? !!shared : localStarted;
  const failed = track ? !!shared?.failed : localFailed;
  const rate = track ? (shared?.rate ?? playback.getPlaybackState().rate) : SPEEDS[speedIdx];
  const known = track ? shared?.duration || null : mediaDuration;
  const duration = known && Number.isFinite(known) && known > 0 ? known : (durationSec ?? 0);
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;
  const bars = useMemo(
    () => (waveform && waveform.length ? resample(waveform, BAR_COUNT) : pseudoWaveform(src, BAR_COUNT)),
    [waveform, src],
  );

  // Smooth progress while playing (timeupdate only fires ~4×/s).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el) setCurrent(el.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  function toggle() {
    if (track) {
      if (shared) playback.toggle();
      else playback.play(track, { resolveNext });
      return;
    }
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      claimPlayback(el);
      el.playbackRate = SPEEDS[speedIdx];
      el.play().catch(() => setFailed(true));
      setStarted(true);
    } else {
      el.pause();
    }
  }

  function seekTo(fraction: number) {
    if (track) {
      const t = Math.max(0, Math.min(duration, fraction * duration));
      if (!shared) playback.play(track, { resolveNext, from: t });
      else playback.seek(t);
      return;
    }
    const el = audioRef.current;
    if (!el || duration <= 0) return;
    const t = Math.max(0, Math.min(duration, fraction * duration));
    el.currentTime = t;
    setCurrent(t);
    setStarted(true);
  }

  function cycleSpeed() {
    if (track) {
      playback.cycleRate();
      return;
    }
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
  }

  const own = tone === "own";

  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      {track ? null : <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => {
          fixInfiniteDuration(e.currentTarget);
          setMediaDuration(e.currentTarget.duration);
        }}
        onDurationChange={(e) => setMediaDuration(e.currentTarget.duration)}
        // Fallback for when animation frames are throttled (background tab).
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
          setStarted(false);
        }}
        onError={() => setFailed(true)}
        className="hidden"
      />}
      <button
        type="button"
        onClick={toggle}
        disabled={failed}
        aria-label={playing ? `Pause ${label.toLowerCase()}` : `Play ${label.toLowerCase()}`}
        className={cn(
          "pressable flex size-10 shrink-0 items-center justify-center rounded-full disabled:opacity-50",
          own ? "bg-own-fg text-own" : "bg-accent text-accent-fg hover:bg-accent-hover",
        )}
      >
        {playing ? <Pause className="size-[18px]" fill="currentColor" strokeWidth={0} /> : <Play className="ms-0.5 size-[18px]" fill="currentColor" strokeWidth={0} />}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div
          role="slider"
          tabIndex={0}
          aria-label={`${label} position`}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          aria-valuetext={`${formatDuration(current)} of ${formatDuration(duration)}`}
          onPointerDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const frac = getComputedStyle(e.currentTarget).direction === "rtl" ? 1 - x / rect.width : x / rect.width;
            seekTo(frac);
          }}
          onKeyDown={(e) => {
            if (duration <= 0) return;
            if (e.key === "ArrowRight" || e.key === "ArrowUp") {
              e.preventDefault();
              seekTo((current + 5) / duration);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
              e.preventDefault();
              seekTo((current - 5) / duration);
            } else if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              toggle();
            }
          }}
          className="flex h-7 cursor-pointer items-center gap-[2px] rounded-[4px]"
        >
          {bars.map((v, i) => {
            const played = (i + 0.5) / bars.length <= progress;
            return (
              <span
                key={i}
                aria-hidden
                className={cn(
                  "w-[3px] min-w-[2px] flex-1 rounded-full transition-colors duration-100",
                  own ? (played ? "bg-own-fg" : "bg-own-fg/40") : played ? "bg-accent" : "bg-line-strong",
                )}
                style={{ height: `${Math.max(14, v * 100)}%` }}
              />
            );
          })}
        </div>
        <div className={cn("flex items-center gap-2 text-[12px] leading-none", own ? "text-own-meta" : "text-muted")}>
          <span className="tabular">{failed ? "Can't play this clip" : formatDuration(started ? current : duration)}</span>
          {!failed ? (
            <button
              type="button"
              onClick={cycleSpeed}
              aria-label={`Playback speed ${rate}×`}
              className={cn(
                "pressable rounded-full px-1.5 py-0.5 text-[11.5px] font-bold",
                own ? "bg-own-fg/15 text-own-fg" : "bg-sunken text-fg-2 hover:text-fg",
              )}
            >
              {rate}×
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The shared player's state while `id` is the track, else null (no re-renders). */
function usePlaybackFor(id: string | undefined) {
  return playback.usePlayback((s) => (id && s.track?.id === id ? s : null));
}
