"use client";

/* eslint-disable @next/next/no-img-element -- remote avatar photos, size known via props */
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { personColor } from "@/lib/avatar-color";
import { photoSources } from "@/lib/photo-src";

export { resolvePhotoSrc } from "@/lib/photo-src";

export interface AvatarProps {
  /** Stable id (user or chat) — picks the person colour. Preferred. */
  colorId?: string;
  /** @deprecated legacy: a background from `avatarGradientFor()`. Still
   * honoured (the matching ink colour is derived from it) so older call
   * sites keep working. */
  gradient?: string;
  initial?: string;
  /** Full name — used to build initials when `initial` isn't given. */
  name?: string;
  src?: string | null;
  size?: number;
  /** People are circles; groups/channels are rounded squares, so the shape
   * alone tells you what kind of conversation a row is. */
  shape?: "circle" | "square";
  presence?: "online" | "offline" | "none";
  /** Shown in place of the photo, clipped to the shape (e.g. a `LoopVideo` for a video avatar). */
  media?: ReactNode;
  className?: string;
}

const ARABIC_SCRIPT = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/;

function initialsOf(name?: string): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = Array.from(parts[0])[0] ?? "";
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? "") : "";
  // Two Arabic-script letters side by side join into one connected shape
  // ("مریم احمدی" → "ما", which reads as a word, not as initials) — a
  // zero-width non-joiner keeps them as two separate letters.
  const joiner = first && last && ARABIC_SCRIPT.test(first) && ARABIC_SCRIPT.test(last) ? "\u200c" : "";
  return (first + joiner + last).toUpperCase();
}

function colorsFrom(colorId?: string, gradient?: string) {
  if (colorId) return personColor(colorId);
  const match = gradient?.match(/--person-(\d+)-bg/);
  if (match) return { bg: gradient!, fg: `var(--person-${match[1]}-fg)` };
  return { bg: gradient ?? "var(--sunken)", fg: "var(--fg)" };
}

export function Avatar({ colorId, gradient, initial, name, src, size = 40, shape = "circle", presence = "none", media, className }: AvatarProps) {
  const { bg, fg } = colorsFrom(colorId, gradient);
  const label = initial ?? initialsOf(name);
  // A clear green dot with a panel-coloured ring, so it reads against any photo.
  const dot = Math.max(12, Math.round(size * 0.3));
  const sources = photoSources(src);
  // Try the small file, then the original; a photo that fails both falls back to
  // initials rather than a broken-image icon.
  const [failed, setFailed] = useState<{ src: string; step: number } | null>(null);
  const step = sources && failed?.src === sources.src ? failed.step : 0;
  const photo = !sources ? null : step === 0 ? sources.src : step === 1 ? (sources.fallback ?? null) : null;
  const showPhoto = !!photo;
  const onPhotoError = () => {
    if (!sources) return;
    setFailed({ src: sources.src, step: step === 0 && sources.fallback ? 1 : 2 });
  };

  return (
    <div className={cn("relative shrink-0 select-none", className)} style={{ width: size, height: size }} aria-hidden>
      <div
        className={cn("flex size-full items-center justify-center overflow-hidden font-bold", shape === "circle" ? "rounded-full" : "rounded-[30%]")}
        style={{ background: bg, color: fg, fontSize: Math.round(size * (label.length > 1 ? 0.36 : 0.42)), letterSpacing: "0.01em" }}
      >
        {media ? (
          media
        ) : showPhoto ? (
          <img src={photo} alt="" className="size-full object-cover" draggable={false} onError={onPhotoError} />
        ) : (
          label
        )}
      </div>
      {presence === "online" ? (
        <span
          className="absolute rounded-full bg-online"
          style={{ width: dot, height: dot, insetInlineEnd: shape === "circle" ? 0 : -2, bottom: shape === "circle" ? 0 : -2, boxShadow: "0 0 0 2.5px var(--panel)" }}
        />
      ) : null}
    </div>
  );
}
