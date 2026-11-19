"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { decode } from "blurhash";

export interface MediaProps {
  src: string;
  alt: string;
  width?: number | null;
  height?: number | null;
  blurhash?: string | null;
  className?: string;
}

/** A real photo/video-poster attachment — not a sticker/reaction glyph or
 * pack-item thumbnail (those stay plain `<img>`: small, pack-hosted, no
 * benefit from blur-up or layout reservation, and the app's own convention
 * per every existing `<img>`'s eslint-disable comment). Falls back to a
 * plain `<img>` when width/height aren't known (a legacy attachment sent
 * before this existed, or one with no resolvable `MediaAsset` row at all,
 * e.g. a GIF) — `next/image` needs real dimensions (or `fill`), and
 * guessing a wrong aspect ratio would be worse than not optimizing it. */
export function Media({ src, alt, width, height, blurhash, className }: MediaProps) {
  const blurDataURL = useBlurDataURL(blurhash);

  if (!width || !height) {
    // eslint-disable-next-line @next/next/no-img-element -- dimensions unknown, next/image can't size it
    return <img src={src} alt={alt} className={className} />;
  }

  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      placeholder={blurDataURL ? "blur" : "empty"}
      blurDataURL={blurDataURL ?? undefined}
    />
  );
}

/** Decodes a blurhash string into a tiny blurred placeholder image via an
 * offscreen canvas, for `next/image`'s `blurDataURL` prop — real DOM work,
 * so this only ever runs client-side, after mount (a one-render flash of no
 * placeholder while it decodes is expected and fine; the real image is
 * loading anyway). Degrades to no placeholder — never a crash — if canvas
 * 2D isn't available at all (some test environments, e.g. jsdom, don't
 * implement it) or the hash fails to decode. */
function useBlurDataURL(blurhash?: string | null): string | null {
  const [dataURL, setDataURL] = useState<string | null>(null);

  useEffect(() => {
    let next: string | null = null;
    if (blurhash) {
      try {
        const pixels = decode(blurhash, 32, 32);
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const imageData = ctx.createImageData(32, 32);
          imageData.data.set(pixels);
          ctx.putImageData(imageData, 0, 0);
          next = canvas.toDataURL();
        }
      } catch {
        next = null;
      }
    }
    // Canvas decode is real, unavoidable DOM work — can't be a `useMemo`
    // (canvas isn't safe to touch during render) — so this genuinely is
    // the "compute from a side effect, store in state" case, not the
    // "effect that just mirrors a prop into state" pattern this rule
    // means to catch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDataURL(next);
  }, [blurhash]);

  return dataURL;
}
