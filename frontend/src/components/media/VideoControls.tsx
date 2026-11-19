"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/recording";

/** The HUD's seek track, like a streaming player's: a 3 px line (buffered + played) that thickens
 *  on hover or drag, a knob that appears on hover and focus, and a time tooltip that follows the
 *  pointer (the target time while dragging). A native range sits over it, invisible, so pointer
 *  drag, touch and the keyboard all scrub through the browser's own slider. */
export function ScrubBar({
  shown,
  duration,
  buffered,
  label,
  active,
  onScrub,
  onScrubEnd,
}: {
  /** Seconds to show: the played position, or the scrub target while dragging. */
  shown: number;
  duration: number;
  /** Buffered fraction, 0–1. */
  buffered: number;
  label: string;
  /** True while the pointer is dragging the knob. */
  active: boolean;
  onScrub: (seconds: number) => void;
  onScrubEnd: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  // Seconds under the pointer while it hovers the track (null when it is away).
  const [hover, setHover] = useState<number | null>(null);
  const pct = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;
  const tip = active ? shown : hover;
  // Kept off the edges so the tooltip never runs out of the frame.
  const tipPct = duration > 0 && tip !== null ? Math.min(96, Math.max(4, (tip / duration) * 100)) : 0;

  function secondsAt(clientX: number): number | null {
    const el = wrap.current;
    if (!el || !(duration > 0)) return null;
    const r = el.getBoundingClientRect();
    let f = (clientX - r.left) / r.width;
    if (getComputedStyle(el).direction === "rtl") f = 1 - f;
    return Math.min(1, Math.max(0, f)) * duration;
  }

  return (
    <div
      ref={wrap}
      className="group/scrub relative flex h-8 w-full touch-none items-center"
      onPointerMove={(e) => setHover(secondsAt(e.clientX))}
      onPointerLeave={() => setHover(null)}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 overflow-hidden rounded-full bg-white/25 transition-[height] duration-150 ease-out",
          active ? "h-[5px]" : "h-[3px] group-hover/scrub:h-[5px]",
        )}
      >
        <div className="absolute inset-y-0 start-0 bg-white/40" style={{ width: `${buffered * 100}%` }} />
        <div className="absolute inset-y-0 start-0 bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.4)] transition-[transform,opacity] duration-150 ease-out rtl:translate-x-1/2",
          active ? "scale-110 opacity-100" : "scale-75 opacity-0 group-hover/scrub:scale-100 group-hover/scrub:opacity-100 group-has-[:focus-visible]/scrub:opacity-100",
        )}
        style={{ insetInlineStart: `${pct}%` }}
      />
      {tip !== null ? (
        <span
          aria-hidden
          className="tabular pointer-events-none absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/80 px-2 py-0.5 text-[12px] font-semibold text-white shadow-md rtl:translate-x-1/2"
          style={{ insetInlineStart: `${tipPct}%` }}
        >
          {formatDuration(tip)}
        </span>
      ) : null}
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(shown, duration || 0)}
        aria-label={label}
        aria-valuetext={`${formatDuration(shown)} of ${formatDuration(duration)}`}
        onChange={(e) => onScrub(Number(e.target.value))}
        onPointerUp={onScrubEnd}
        onPointerCancel={onScrubEnd}
        onKeyUp={onScrubEnd}
        onBlur={onScrubEnd}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      />
    </div>
  );
}

/** A thin played line along the bottom edge of a chat bubble (no controls, no knob). */
export function ProgressLine({ fraction }: { fraction: number }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-[2px] bg-white/25">
      <div className="absolute inset-y-0 start-0 bg-accent" style={{ width: `${Math.min(1, Math.max(0, fraction)) * 100}%` }} />
    </div>
  );
}
