"use client";

import { useRef } from "react";
import { cn } from "@/lib/cn";

const MIN_LEN = 0.5;

export function formatClock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}

interface TrimTimelineProps {
  duration: number;
  start: number;
  end: number;
  /** Playhead, seconds. */
  current: number;
  thumbs: string[];
  /** Longest allowed selection (e.g. 10 s for a profile video). */
  maxLen?: number;
  onChange: (start: number, end: number, edge: "start" | "end") => void;
  /** Scrub (tap/drag on the strip between the handles). */
  onSeek: (t: number) => void;
  /** Single-marker mode (cover frame): no handles, the marker is `current`. */
  marker?: boolean;
}

/** A filmstrip with start/end handles (Telegram's trimmer). Handles are sliders for keyboard
 *  and screen-reader users; the strip itself scrubs. */
export function TrimTimeline({ duration, start, end, current, thumbs, maxLen, onChange, onSeek, marker }: TrimTimelineProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<"start" | "end" | "seek" | null>(null);
  const d = Math.max(0.01, duration);

  function timeAt(clientX: number): number {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    // Timelines run left→right even in RTL, like every video editor.
    return Math.min(d, Math.max(0, ((clientX - r.left) / r.width) * d));
  }

  function apply(kind: "start" | "end", t: number) {
    if (kind === "start") {
      let s = Math.min(t, end - MIN_LEN);
      if (maxLen && end - s > maxLen) s = end - maxLen;
      onChange(Math.max(0, s), end, "start");
    } else {
      let e = Math.max(t, start + MIN_LEN);
      if (maxLen && e - start > maxLen) e = start + maxLen;
      onChange(start, Math.min(d, e), "end");
    }
  }

  function down(kind: "start" | "end" | "seek", e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = kind;
    if (kind === "seek") onSeek(clampSeek(timeAt(e.clientX)));
  }

  function clampSeek(t: number) {
    return marker ? t : Math.min(end, Math.max(start, t));
  }

  function moveP(e: React.PointerEvent) {
    const k = drag.current;
    if (!k) return;
    const t = timeAt(e.clientX);
    if (k === "seek") onSeek(clampSeek(t));
    else apply(k, t);
  }

  function up() {
    drag.current = null;
  }

  function key(kind: "start" | "end", e: React.KeyboardEvent) {
    const step = e.shiftKey ? 1 : 0.1;
    const cur = kind === "start" ? start : end;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") apply(kind, cur - step);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") apply(kind, cur + step);
    else if (e.key === "Home") apply(kind, 0);
    else if (e.key === "End") apply(kind, d);
    else return;
    e.preventDefault();
  }

  const pct = (t: number) => `${(t / d) * 100}%`;

  return (
    <div dir="ltr" className="select-none px-4">
      <div
        ref={ref}
        className="relative h-12 touch-none"
        onPointerDown={(e) => down("seek", e)}
        onPointerMove={moveP}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <div className="absolute inset-0 flex overflow-hidden rounded-[8px] bg-white/10">
          {thumbs.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element -- local frame grabs
            <img key={i} src={src} alt="" draggable={false} className="h-full min-w-0 flex-1 object-cover" />
          ))}
        </div>
        {!marker ? (
          <>
            <div className="pointer-events-none absolute inset-y-0 left-0 rounded-s-[8px] bg-black/60" style={{ width: pct(start) }} />
            <div className="pointer-events-none absolute inset-y-0 right-0 rounded-e-[8px] bg-black/60" style={{ width: `calc(100% - ${pct(end)})` }} />
            <div className="pointer-events-none absolute inset-y-0 border-y-[3px] border-white" style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }} />
            {(["start", "end"] as const).map((k) => {
              const t = k === "start" ? start : end;
              return (
                <div
                  key={k}
                  role="slider"
                  tabIndex={0}
                  aria-label={k === "start" ? "Trim start" : "Trim end"}
                  aria-valuemin={0}
                  aria-valuemax={Math.round(d * 10) / 10}
                  aria-valuenow={Math.round(t * 10) / 10}
                  aria-valuetext={formatClock(t)}
                  onPointerDown={(e) => down(k, e)}
                  onPointerMove={moveP}
                  onPointerUp={up}
                  onPointerCancel={up}
                  onKeyDown={(e) => key(k, e)}
                  className={cn(
                    "absolute inset-y-0 z-[2] flex w-6 cursor-ew-resize items-center justify-center bg-white outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    k === "start" ? "-translate-x-full rounded-s-[8px]" : "rounded-e-[8px]",
                  )}
                  style={{ left: pct(t) }}
                >
                  <span aria-hidden className="h-5 w-[3px] rounded-full bg-black/45" />
                </div>
              );
            })}
          </>
        ) : null}
        <div
          aria-hidden
          className={cn("pointer-events-none absolute -inset-y-1 z-[1] -translate-x-1/2 rounded-full bg-white shadow", marker ? "w-1.5 ring-2 ring-accent" : "w-[3px]")}
          style={{ left: pct(current) }}
        />
      </div>
    </div>
  );
}
