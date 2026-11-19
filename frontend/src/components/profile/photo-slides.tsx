"use client";

/* eslint-disable @next/next/no-img-element -- remote, backend-hosted profile photos */
import { useCallback, useRef, useState } from "react";
import { LoopVideo } from "@/components/media/LoopVideo";
import { resolvePhotoSrc } from "@/components/ui/Avatar";
import type { ProfilePhoto } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { photoStill } from "./use-profile-photos";

/** One profile photo: the image, or for a video a silent loop (or just its
 *  poster when `still` — neighbours in a gallery never decode). */
export function PhotoMedia({
  photo,
  active = true,
  still,
  fit = "cover",
  label,
  className,
}: {
  photo: ProfilePhoto;
  active?: boolean;
  still?: boolean;
  fit?: "cover" | "contain";
  label?: string;
  className?: string;
}) {
  const fitClass = fit === "cover" ? "object-cover" : "object-contain";
  if (photo.kind === "video" && !still) {
    return <LoopVideo src={photo.url} poster={photo.posterUrl} active={active} fit={fit} label={label} className={className} />;
  }
  const src = resolvePhotoSrc(photoStill(photo), { large: true });
  if (!src) return <div aria-hidden className={cn("size-full bg-black/20", className)} />;
  return <img src={src} alt={label ?? ""} draggable={false} decoding="async" className={cn("size-full select-none", fitClass, className)} />;
}

/** Horizontal paging with the finger: `drag(dx)` while moving, `release(dx, vx)`
 *  to settle on a neighbour or snap back. Rubber-bands at the ends. */
export function useSlideTrack({
  count,
  index,
  onIndex,
  instant,
}: {
  count: number;
  index: number;
  onIndex: (next: number) => void;
  /** Reduced motion: switch without the slide. */
  instant?: boolean;
}) {
  const [dx, setDx] = useState(0);
  const [settling, setSettling] = useState(false);
  const widthRef = useRef(0);
  const pending = useRef<number | null>(null);

  const drag = useCallback(
    (d: number) => {
      const atEdge = (index === 0 && d > 0) || (index === count - 1 && d < 0);
      setSettling(false);
      setDx(atEdge ? d * 0.28 : d);
    },
    [index, count],
  );

  const release = useCallback(
    (d: number, vx: number) => {
      const w = widthRef.current || 1;
      let dir = 0;
      if ((d < -w * 0.18 || vx < -0.45) && index < count - 1) dir = 1;
      else if ((d > w * 0.18 || vx > 0.45) && index > 0) dir = -1;
      if (dir !== 0 && instant) {
        setDx(0);
        onIndex(index + dir);
        return;
      }
      setSettling(true);
      pending.current = dir === 0 ? null : index + dir;
      setDx(dir === 0 ? 0 : -dir * w);
    },
    [index, count, instant, onIndex],
  );

  const onTransitionEnd = useCallback(
    (e: React.TransitionEvent) => {
      if (e.target !== e.currentTarget) return;
      setSettling(false);
      const next = pending.current;
      pending.current = null;
      if (next !== null) {
        setDx(0);
        onIndex(next);
      }
    },
    [onIndex],
  );

  const setWidth = useCallback((w: number) => {
    widthRef.current = w;
  }, []);

  return { dx, settling, setWidth, drag, release, onTransitionEnd };
}

/** The current slide plus whichever neighbour is being revealed. The next one
 *  is always mounted (as a still) so it's already loaded when you get there. */
export function SlideTrack({
  photos,
  index,
  track,
  fit = "cover",
  preloadNext = true,
  label,
}: {
  photos: ProfilePhoto[];
  index: number;
  track: ReturnType<typeof useSlideTrack>;
  fit?: "cover" | "contain";
  preloadNext?: boolean;
  label?: (i: number) => string;
}) {
  const { dx, settling, onTransitionEnd } = track;
  const current = photos[index];
  const prev = index > 0 && dx > 0 ? photos[index - 1] : null;
  const next = index < photos.length - 1 && (preloadNext || dx < 0) ? photos[index + 1] : null;
  if (!current) return null;
  return (
    <div
      className="absolute inset-0"
      style={{
        transform: dx ? `translate3d(${dx}px,0,0)` : undefined,
        transition: settling ? "transform 300ms var(--ease-out)" : "none",
      }}
      onTransitionEnd={onTransitionEnd}
    >
      {prev ? (
        <div key={prev.id} aria-hidden className="absolute inset-y-0 w-full" style={{ insetInlineStart: "-100%" }}>
          <PhotoMedia photo={prev} still fit={fit} />
        </div>
      ) : null}
      <div key={current.id} className="absolute inset-0">
        <PhotoMedia photo={current} fit={fit} label={label?.(index)} />
      </div>
      {next ? (
        <div key={next.id} aria-hidden className="absolute inset-y-0 w-full" style={{ insetInlineStart: "100%" }}>
          <PhotoMedia photo={next} still fit={fit} />
        </div>
      ) : null}
    </div>
  );
}

/** Telegram-style progress segments, one per photo. */
export function SegmentBars({ count, index, className }: { count: number; index: number; className?: string }) {
  if (count < 2) return null;
  return (
    <div aria-hidden className={cn("flex gap-1", className)}>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={cn("h-[3px] min-w-0 flex-1 rounded-full transition-colors duration-200", i === index ? "bg-white" : "bg-white/35")}
          style={{ boxShadow: "0 0 2px rgb(0 0 0 / 0.25)" }}
        />
      ))}
    </div>
  );
}

/** "n / N" on a dark chip, readable over any photo. */
export function PhotoCounter({ index, count, className }: { index: number; count: number; className?: string }) {
  return (
    <span
      className={cn("tabular inline-flex h-7 items-center rounded-full bg-black/45 px-2.5 text-[12.5px] font-semibold text-white", className)}
      aria-live="polite"
      aria-atomic
    >
      <span className="sr-only">Photo </span>
      {index + 1}
      <span aria-hidden className="mx-1 text-white/60">
        /
      </span>
      <span className="sr-only"> of </span>
      {count}
    </span>
  );
}
