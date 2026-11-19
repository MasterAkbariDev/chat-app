"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Mic, Music, Pause, Play, SkipBack, SkipForward, Video, X } from "lucide-react";
import { useRouter } from "@/hooks/use-app-router";
import { usePerformance } from "@/contexts/performance-context";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/recording";
import * as playback from "@/lib/playback";

function shortDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function useJump() {
  const router = useRouter();
  return useCallback(
    (track: playback.PlaybackTrack) => {
      if (!playback.jumpToTrack(track) && track.channelId) router.push(`/app/c/${track.channelId}`);
    },
    [router],
  );
}

/** Telegram-style "now playing" strip for voice and video messages: play/pause, who and
 *  when (tap to show the message), a progress line you can click to seek, speed, close.
 *  Reads the app-wide player, so it stays while you scroll or switch chats. */
export function NowPlayingBar({ className }: { className?: string }) {
  const s = playback.usePlayback((x) => x);
  const jump = useJump();
  if (!s.track) return null;
  const { track } = s;
  const duration = s.duration || track.durationSec || 0;
  const progress = duration > 0 ? Math.min(1, s.current / duration) : 0;
  const music = track.kind === "music";
  const kindLabel = track.kind === "voice" ? "Voice message" : music ? "Music" : "Video message";
  const Icon = track.kind === "voice" ? Mic : music ? Music : Video;
  const hasPrev = music;
  const hasNext = music && playback.hasAdjacent(1);
  const skipClass = "pressable flex size-10 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-sunken hover:text-fg disabled:opacity-35";

  return (
    <div role="region" aria-label="Now playing" className={cn("relative shrink-0 border-b border-line bg-panel", className)} data-now-playing="">
      <div className="flex h-12 items-center gap-1 px-2 lg:px-4">
        {hasPrev ? (
          <button type="button" onClick={() => playback.skip(-1)} aria-label="Previous track" title="Previous" className={skipClass}>
            <SkipBack className="size-[18px] fill-current rtl:-scale-x-100" strokeWidth={1.5} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={playback.toggle}
          aria-label={s.playing ? `Pause ${kindLabel.toLowerCase()}` : `Play ${kindLabel.toLowerCase()}`}
          className="pressable flex size-10 shrink-0 items-center justify-center rounded-full text-accent-text hover:bg-sunken"
        >
          {s.playing ? <Pause className="size-5 fill-current" strokeWidth={0} /> : <Play className="ms-0.5 size-5 fill-current" strokeWidth={0} />}
        </button>
        {music ? (
          <button type="button" onClick={() => playback.skip(1)} disabled={!hasNext} aria-label="Next track" title="Next" className={skipClass}>
            <SkipForward className="size-[18px] fill-current rtl:-scale-x-100" strokeWidth={1.5} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => jump(track)}
          title="Show message"
          className="focus-inset min-w-0 flex-1 rounded-[var(--radius-sm)] px-1.5 py-1 text-start hover:bg-sunken"
        >
          <span dir="auto" className="block truncate text-[14px] font-semibold leading-tight">
            {music ? (track.title ?? "Music") : track.senderName}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-[12.5px] leading-tight text-muted">
            <Icon className="size-3.5 shrink-0" strokeWidth={2} aria-hidden />
            <span dir="auto" className="min-w-0 truncate">
              {music ? (track.artist ?? kindLabel) : kindLabel}
              {!music && track.createdAt ? ` · ${shortDate(track.createdAt)}` : ""}
            </span>
            <span className="tabular shrink-0"> · {s.failed ? "Can't play" : `${formatDuration(s.current)} / ${formatDuration(duration)}`}</span>
          </span>
        </button>
        {music ? null : <button
          type="button"
          onClick={playback.cycleRate}
          aria-label={`Playback speed ${s.rate}×`}
          title="Playback speed"
          className="pressable tabular h-9 min-w-11 shrink-0 rounded-full px-2 text-[13px] font-bold text-fg-2 hover:bg-sunken hover:text-fg"
        >
          {s.rate}×
        </button>}
        <button
          type="button"
          onClick={playback.stop}
          aria-label="Stop and close player"
          title="Close"
          className="pressable flex size-10 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-sunken hover:text-fg"
        >
          <X className="size-5" strokeWidth={2} />
        </button>
      </div>
      {/* Progress: a thin line along the bottom edge; also a seek slider. */}
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(s.current, duration || 0)}
        onChange={(e) => playback.seek(Number(e.target.value))}
        aria-label={`${kindLabel} position`}
        aria-valuetext={`${formatDuration(s.current)} of ${formatDuration(duration)}`}
        className="absolute inset-x-0 -bottom-[5px] h-[10px] w-full cursor-pointer opacity-0"
      />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px]">
        <div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}

/** Mounted once (AppShell). Owns the floating circle a playing video message moves into
 *  when its bubble scrolls out of view or the chat is left. */
export function PlaybackHost() {
  const s = playback.usePlayback((x) => (x.track?.kind === "video_note" ? x : null));
  const { reduceMotion } = usePerformance();
  const hostRef = useRef<HTMLSpanElement>(null);
  const jump = useJump();
  const [mounted, setMounted] = useState(false);
  const show = !!s && !s.inBubble;

  // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only floating UI
  useEffect(() => setMounted(true), []);

  const hasVideo = !!s?.track;
  useLayoutEffect(() => {
    if (!hasVideo || !mounted) return;
    playback.registerPipHost(hostRef.current);
    return () => playback.registerPipHost(null);
  }, [hasVideo, mounted]);

  if (!mounted || !s?.track) return null;
  const track = s.track;
  const duration = s.duration || track.durationSec || 0;
  const progress = duration > 0 ? Math.min(1, s.current / duration) : 0;
  const size = 132;
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;

  return (
    <div
      className={cn(
        "fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] end-4 z-[80] lg:bottom-24 lg:end-8",
        show ? "opacity-100" : "pointer-events-none invisible opacity-0",
        !reduceMotion && "transition-opacity duration-200",
      )}
      aria-hidden={!show}
      data-pip=""
    >
      <div className="relative" style={{ width: size, height: size }}>
        <button
          type="button"
          onClick={playback.toggle}
          aria-label={s.playing ? "Pause video message" : "Play video message"}
          tabIndex={show ? 0 : -1}
          className="pressable relative block size-full overflow-hidden rounded-full bg-black shadow-lg"
        >
          <span ref={hostRef} className="absolute inset-0 block [&>video]:size-full" />
          <svg className="pointer-events-none absolute inset-0 -rotate-90" width={size} height={size} aria-hidden>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--accent)" strokeWidth={3} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} />
          </svg>
          {!s.playing ? (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
              <span className="flex size-10 items-center justify-center rounded-full bg-black/50 text-white">
                <Play className="ms-0.5 size-5 fill-current" strokeWidth={0} />
              </span>
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={playback.stop}
          aria-label="Stop video message"
          tabIndex={show ? 0 : -1}
          className="pressable absolute -end-1 -top-1 flex size-8 items-center justify-center rounded-full border border-line bg-raised text-fg-2 shadow-md hover:text-fg"
        >
          <X className="size-4" strokeWidth={2.2} />
        </button>
        <button
          type="button"
          onClick={() => jump(track)}
          tabIndex={show ? 0 : -1}
          className="tabular absolute -bottom-2 start-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/70 px-2 py-0.5 text-[12px] font-semibold text-white rtl:translate-x-1/2"
          aria-label="Show message"
        >
          {formatDuration(s.current)}
        </button>
      </div>
    </div>
  );
}
