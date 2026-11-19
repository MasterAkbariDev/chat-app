"use client";

/* eslint-disable @next/next/no-img-element -- remote, backend-hosted media; sizes come from attachmentMeta */
import { useEffect, useRef, useState } from "react";
import { decode } from "blurhash";
import { ImageOff, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { usePerformance } from "@/contexts/performance-context";
import { GifImage } from "./GifImage";
import { bubbleImageSources, displayAspect, resolveAttachmentUrl } from "@/lib/media-src";

export interface AttachmentMetaEntry {
  width: number | null;
  height: number | null;
  blurhash: string | null;
}

// Decoded placeholders, shared by every bubble (and the viewer) — the same blurhash is
// decoded once per session, not once per mount while scrolling a virtualised list.
const blurCache = new Map<string, string | null>();

/** A blurhash → tiny data URL (16×16 PNG, stretched and blurred by CSS). Synchronous and
 *  cached, so a remounted bubble paints its placeholder in the very first frame. */
export function blurhashToDataUrl(hash: string | null | undefined): string | null {
  if (!hash || typeof document === "undefined") return null;
  const hit = blurCache.get(hash);
  if (hit !== undefined) return hit;
  let url: string | null = null;
  try {
    const pixels = decode(hash, 16, 16);
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const data = ctx.createImageData(16, 16);
      data.data.set(pixels);
      ctx.putImageData(data, 0, 0);
      url = canvas.toDataURL();
    }
  } catch {
    url = null;
  }
  if (blurCache.size > 500) blurCache.clear();
  blurCache.set(hash, url);
  return url;
}

/** The placeholder layer under a loading photo/video: the blurhash if there is one, else a
 *  soft pulse (stilled by Reduce motion / Lite mode via the global motion rules). */
export function MediaPlaceholder({ blurhash, className }: { blurhash?: string | null; className?: string }) {
  const [url] = useState(() => blurhashToDataUrl(blurhash));
  return url ? (
    <span aria-hidden className={cn("absolute inset-0 bg-cover bg-center", className)} style={{ backgroundImage: `url(${url})` }} />
  ) : (
    <span aria-hidden className={cn("skeleton absolute inset-0 rounded-none", className)} />
  );
}

type LoadState = "loading" | "loaded" | "error";

/** Width of a lone photo or video in a bubble: its own shape, capped at 300px (or 64vw) and
 *  never taller than 380px — a portrait picture is narrower, so the bubble hugs it. */
export function bubbleMediaWidth(aspect: number): string {
  return `min(300px, 64vw, ${Math.round(380 * aspect)}px)`;
}

/** A photo in a message: its box is sized from `attachmentMeta` before anything loads (so
 *  the chat never jumps), a blurred placeholder shows until the small variant arrives and
 *  fades in, and a failed load offers "Try again". */
export function BubbleImage({
  url,
  meta,
  grid,
  label,
  onOpen,
  animated,
  fill,
}: {
  url: string;
  meta?: AttachmentMetaEntry | null;
  /** A cell of a multi-photo grid (square). */
  grid?: boolean;
  /** Fill the parent (an album mosaic cell) instead of sizing itself. */
  fill?: boolean;
  label: string;
  onOpen?: () => void;
  /** GIF: use the file as-is (variants would drop the animation). */
  animated?: boolean;
}) {
  const sources = animated ? { src: resolveAttachmentUrl(url) } : bubbleImageSources(url, { grid });
  const [attempt, setAttempt] = useState(0);
  const [usingFallback, setUsingFallback] = useState(false);
  const [state, setState] = useState<LoadState>("loading");
  const imgRef = useRef<HTMLImageElement>(null);

  // Cached images can finish before React attaches onLoad.
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) setState("loaded");
  }, [attempt, usingFallback]);

  const aspect = grid ? 1 : displayAspect(meta?.width, meta?.height);
  const src = usingFallback && sources.fallback ? sources.fallback : sources.src;

  const content = animated ? (
    // GIFs follow Motion & performance (play while on screen / on hover / still).
    <>
      <MediaPlaceholder blurhash={meta?.blurhash} />
      <GifImage src={src} alt="" className="absolute inset-0 size-full" mediaClassName="object-cover" />
      <span className="pointer-events-none absolute start-2 top-2 rounded-full bg-black/55 px-1.5 py-0.5 text-[11px] font-bold text-white">GIF</span>
    </>
  ) : (
    <>
      {state !== "loaded" ? <MediaPlaceholder blurhash={meta?.blurhash} /> : null}
      {state !== "error" ? (
        <img
          key={`${attempt}:${usingFallback}`}
          ref={imgRef}
          src={src}
          srcSet={usingFallback ? undefined : sources.srcSet}
          sizes={usingFallback ? undefined : sources.sizes}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setState("loaded")}
          onError={() => {
            if (!usingFallback && sources.fallback) setUsingFallback(true);
            else setState("error");
          }}
          className={cn(
            "absolute inset-0 size-full object-cover transition-opacity duration-200 ease-out",
            state === "loaded" ? "opacity-100" : "opacity-0",
          )}
        />
      ) : null}
    </>
  );

  return (
    <div
      className={cn("relative w-full overflow-hidden bg-sunken", fill && "h-full")}
      style={fill ? undefined : { aspectRatio: String(aspect), maxHeight: grid ? undefined : 380 }}
      data-media-box=""
    >
      {state === "error" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-sunken p-2 text-center text-fg-2">
          <ImageOff className="size-6" strokeWidth={1.8} aria-hidden />
          <span className="text-[13px] font-medium">Couldn&apos;t load {animated ? "GIF" : "photo"}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setUsingFallback(false);
              setState("loading");
              setAttempt((a) => a + 1);
            }}
            className="pressable inline-flex h-9 items-center gap-1.5 rounded-full bg-raised px-3 text-[13px] font-semibold text-fg shadow-sm hover:bg-panel"
          >
            <RotateCcw className="size-3.5" strokeWidth={2.2} aria-hidden />
            Try again
          </button>
        </div>
      ) : onOpen ? (
        <button type="button" onClick={onOpen} aria-label={label} className="absolute inset-0 block size-full cursor-zoom-in">
          {content}
        </button>
      ) : (
        <span role="img" aria-label={label} className="absolute inset-0 block">
          {content}
        </span>
      )}
    </div>
  );
}

/** A GIF sent as a short silent video (mp4/webm): loops while visible, honours the
 *  animated-media setting (off → first frame, "on hover" → plays while hovered). */
export function BubbleGifVideo({ url, meta, label, onOpen }: { url: string; meta?: AttachmentMetaEntry | null; label: string; onOpen?: () => void }) {
  const { animatedMedia } = usePerformance();
  const ref = useRef<HTMLVideoElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [hover, setHover] = useState(false);
  const [visible, setVisible] = useState(false);
  const shouldPlay = visible && (animatedMedia === "auto" || (animatedMedia === "interact" && hover));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (shouldPlay) void el.play().catch(() => undefined);
    else el.pause();
  }, [shouldPlay]);

  return (
    <div className="relative w-full overflow-hidden bg-sunken" style={{ aspectRatio: String(displayAspect(meta?.width, meta?.height, 1)), maxHeight: 380 }} data-media-box="">
      {!loaded ? <MediaPlaceholder blurhash={meta?.blurhash} /> : null}
      <button
        type="button"
        onClick={onOpen}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        aria-label={label}
        className="absolute inset-0 block size-full"
      >
        <video
          ref={ref}
          src={resolveAttachmentUrl(url)}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedData={() => setLoaded(true)}
          className={cn("size-full object-cover transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")}
        />
        <span className="pointer-events-none absolute start-2 top-2 rounded-full bg-black/55 px-1.5 py-0.5 text-[11px] font-bold text-white">GIF</span>
      </button>
    </div>
  );
}

/** A sticker: fixed 144px box with a soft placeholder until the file arrives. */
/** Sticker box limits: the long side lands between these (Telegram-like), the aspect ratio is
 *  the sticker's own — stickers aren't all square. */
export const STICKER_MAX_PX = 200;
export const STICKER_MIN_PX = 120;
/** Used until the size is known (older messages carry no width/height). */
const STICKER_FALLBACK_PX = 160;

/** Display size for a sticker of intrinsic `width`×`height`: long side clamped to
 *  [STICKER_MIN_PX, STICKER_MAX_PX], aspect kept (very thin ones get at least 48px across). */
export function stickerBox(width: number | null | undefined, height: number | null | undefined): { width: number; height: number } {
  if (!width || !height || width <= 0 || height <= 0) return { width: STICKER_FALLBACK_PX, height: STICKER_FALLBACK_PX };
  const long = Math.max(width, height);
  const target = Math.min(STICKER_MAX_PX, Math.max(STICKER_MIN_PX, long));
  const scale = target / long;
  return {
    width: Math.max(48, Math.round(width * scale)),
    height: Math.max(48, Math.round(height * scale)),
  };
}

export function BubbleSticker({ url, meta }: { url: string; meta?: Pick<AttachmentMetaEntry, "width" | "height"> | null }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  // Intrinsic size from the image itself — only needed when the message has no meta.
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = ref.current;
    if (img?.complete && img.naturalWidth > 0) {
      setLoaded(true);
      if (!meta?.width) setNatural({ width: img.naturalWidth, height: img.naturalHeight });
    }
  }, [meta?.width]);
  const box = stickerBox(meta?.width ?? natural?.width, meta?.height ?? natural?.height);
  return (
    <span className="relative block max-w-[62vw]" style={{ width: box.width, aspectRatio: `${box.width} / ${box.height}` }} data-sticker-box="">
      {!loaded && !failed ? <span aria-hidden className="skeleton absolute inset-[12%] rounded-[var(--radius-md)]" /> : null}
      {failed ? (
        <span className="absolute inset-0 flex items-center justify-center text-muted">
          <ImageOff className="size-7" strokeWidth={1.6} aria-label="Sticker didn't load" />
        </span>
      ) : (
        <img
          ref={ref}
          src={resolveAttachmentUrl(url)}
          alt="Sticker"
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={(e) => {
            setLoaded(true);
            if (!meta?.width) setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight });
          }}
          onError={() => setFailed(true)}
          className={cn("absolute inset-0 size-full object-contain transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")}
        />
      )}
    </span>
  );
}
