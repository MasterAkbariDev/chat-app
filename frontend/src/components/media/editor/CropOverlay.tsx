"use client";

import { useRef } from "react";
import type { NormRect } from "./types";

const MIN = 0.08;

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface CropOverlayProps {
  /** Displayed frame size in CSS px (the overlay fills it). */
  width: number;
  height: number;
  rect: NormRect;
  /** Locked output aspect (width / height in pixels), or null for free. */
  ratio: number | null;
  onChange: (rect: NormRect) => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Largest rect of pixel aspect `ratio` centred on `around` that fits the frame. */
export function fitAspect(ratio: number | null, frameW: number, frameH: number, around: NormRect): NormRect {
  if (!ratio) return around;
  // Normalized width/height ratio for that pixel ratio.
  const rn = (ratio * frameH) / frameW;
  let w = 1;
  let h = w / rn;
  if (h > 1) {
    h = 1;
    w = rn;
  }
  const cx = around.x + around.w / 2;
  const cy = around.y + around.h / 2;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

/** Telegram-style crop box: dimmed outside, thirds grid, corner/edge handles, drag to move.
 *  Keyboard: arrows move it, Shift+arrows resize. */
export function CropOverlay({ width, height, rect, ratio, onChange }: CropOverlayProps) {
  const drag = useRef<{ handle: Handle; x: number; y: number; start: NormRect } | null>(null);
  const rn = ratio ? (ratio * height) / width : null;

  function begin(handle: Handle, e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { handle, x: e.clientX, y: e.clientY, start: rect };
  }

  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) / width;
    const dy = (e.clientY - d.y) / height;
    onChange(resize(d.start, d.handle, dx, dy, rn));
  }

  function end() {
    drag.current = null;
  }

  function onKey(e: React.KeyboardEvent) {
    const step = e.altKey ? 0.002 : 0.02;
    const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = map[e.key];
    if (!v) return;
    e.preventDefault();
    onChange(e.shiftKey ? resize(rect, "se", v[0], v[1], rn) : resize(rect, "move", v[0], v[1], rn));
  }

  const px = { left: rect.x * width, top: rect.y * height, width: rect.w * width, height: rect.h * height };
  const handles: { h: Handle; pos: string; inner: string }[] = [
    { h: "nw", pos: "-left-4 -top-4 cursor-nwse-resize", inner: "left-[13px] top-[13px] border-l-[3px] border-t-[3px]" },
    { h: "ne", pos: "-right-4 -top-4 cursor-nesw-resize", inner: "right-[13px] top-[13px] border-r-[3px] border-t-[3px]" },
    { h: "sw", pos: "-bottom-4 -left-4 cursor-nesw-resize", inner: "bottom-[13px] left-[13px] border-b-[3px] border-l-[3px]" },
    { h: "se", pos: "-bottom-4 -right-4 cursor-nwse-resize", inner: "bottom-[13px] right-[13px] border-b-[3px] border-r-[3px]" },
  ];

  return (
    <div className="absolute inset-0 touch-none select-none" style={{ width, height }}>
      <div
        role="group"
        tabIndex={0}
        aria-label="Crop area. Arrow keys move it, Shift and arrow keys resize it."
        className="absolute cursor-move outline-none focus-visible:ring-2 focus-visible:ring-white"
        style={{ ...px, boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.6)" }}
        onPointerDown={(e) => begin("move", e)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onKey}
      >
        <div aria-hidden className="pointer-events-none absolute inset-0 border border-white/90" />
        {/* Rule-of-thirds grid */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute inset-y-0 left-1/3 w-px bg-white/35" />
          <div className="absolute inset-y-0 left-2/3 w-px bg-white/35" />
          <div className="absolute inset-x-0 top-1/3 h-px bg-white/35" />
          <div className="absolute inset-x-0 top-2/3 h-px bg-white/35" />
        </div>
        {/* Edges (wide invisible hit areas) */}
        {(["n", "s", "e", "w"] as const).map((h) => (
          <div
            key={h}
            aria-hidden
            onPointerDown={(e) => begin(h, e)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            className={
              h === "n"
                ? "absolute inset-x-5 -top-3 h-6 cursor-ns-resize"
                : h === "s"
                  ? "absolute inset-x-5 -bottom-3 h-6 cursor-ns-resize"
                  : h === "e"
                    ? "absolute inset-y-5 -right-3 w-6 cursor-ew-resize"
                    : "absolute inset-y-5 -left-3 w-6 cursor-ew-resize"
            }
          />
        ))}
        {handles.map(({ h, pos, inner }) => (
          <div key={h} aria-hidden onPointerDown={(e) => begin(h, e)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} className={`absolute size-8 ${pos}`}>
            <span className={`pointer-events-none absolute size-5 border-white ${inner}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Applies a drag of (dx, dy) — normalized — to `r` by `handle`, keeping it inside the frame,
 *  at least MIN in size, and (when `rn` is set) at that normalized aspect. */
export function resize(r: NormRect, handle: Handle, dx: number, dy: number, rn: number | null): NormRect {
  if (handle === "move") {
    return { ...r, x: clamp(r.x + dx, 0, 1 - r.w), y: clamp(r.y + dy, 0, 1 - r.h) };
  }
  let x0 = r.x;
  let y0 = r.y;
  let x1 = r.x + r.w;
  let y1 = r.y + r.h;
  if (handle.includes("w")) x0 = clamp(x0 + dx, 0, x1 - MIN);
  if (handle.includes("e")) x1 = clamp(x1 + dx, x0 + MIN, 1);
  if (handle.includes("n")) y0 = clamp(y0 + dy, 0, y1 - MIN);
  if (handle.includes("s")) y1 = clamp(y1 + dy, y0 + MIN, 1);
  if (!rn) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

  // Locked aspect: drive from the dragged dimension, anchor the opposite side/corner.
  let w = x1 - x0;
  let h = y1 - y0;
  const vertical = handle === "n" || handle === "s";
  if (vertical) w = h * rn;
  else h = w / rn;
  // Keep inside the frame.
  const anchorX = handle.includes("w") ? r.x + r.w : handle.includes("e") ? r.x : r.x + r.w / 2;
  const anchorY = handle.includes("n") ? r.y + r.h : handle.includes("s") ? r.y : r.y + r.h / 2;
  const maxW = handle.includes("w") ? anchorX : handle.includes("e") ? 1 - anchorX : 2 * Math.min(anchorX, 1 - anchorX);
  const maxH = handle.includes("n") ? anchorY : handle.includes("s") ? 1 - anchorY : 2 * Math.min(anchorY, 1 - anchorY);
  const k = Math.min(1, maxW / w, maxH / h);
  w *= k;
  h *= k;
  if (w < MIN) {
    w = MIN;
    h = w / rn;
  }
  const x = handle.includes("w") ? anchorX - w : handle.includes("e") ? anchorX : anchorX - w / 2;
  const y = handle.includes("n") ? anchorY - h : handle.includes("s") ? anchorY : anchorY - h / 2;
  return { x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h), w, h };
}

/** The crop rect after a quarter turn clockwise of its frame. */
export function rotateRect(r: NormRect): NormRect {
  return { x: 1 - (r.y + r.h), y: r.x, w: r.h, h: r.w };
}

/** The crop rect after mirroring its frame horizontally. */
export function flipRect(r: NormRect): NormRect {
  return { ...r, x: 1 - r.x - r.w };
}
