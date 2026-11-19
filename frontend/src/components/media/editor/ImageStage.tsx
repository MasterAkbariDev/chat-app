"use client";

import { useEffect, useMemo, useRef } from "react";
import { CropOverlay } from "./CropOverlay";
import { drawStrokes, drawTexts, isLight, orientedSize, paintStroke, renderImage, type ImageSource } from "./render";
import { ASPECTS, FULL_RECT, type ImageEdits, type Stroke, type TextLayer } from "./types";
import { cn } from "@/lib/cn";

export type ImageTool = "crop" | "draw" | "text" | "adjust";

export interface BrushSettings {
  color: string;
  /** Fraction of the output width. */
  size: number;
  eraser: boolean;
}

interface ImageStageProps {
  /** A downscaled copy of the photo for fast previews (same aspect as the original). */
  source: ImageSource;
  edits: ImageEdits;
  onEdits: (update: (prev: ImageEdits) => ImageEdits) => void;
  tool: ImageTool | null;
  /** Space available, CSS px. */
  stageW: number;
  stageH: number;
  brush: BrushSettings;
  selectedText: string | null;
  onSelectText: (id: string | null) => void;
  fontFamily: string;
  /** Aspect ratio locked by the caller (profile photo = square). */
  lockedRatio?: number | null;
}

const CROP_PAD = 28;

/** The photo as it will be sent, sized to fit, plus whatever the active tool needs on top:
 *  the crop box, a drawing surface, or draggable text. */
export function ImageStage({ source, edits, onEdits, tool, stageW, stageH, brush, selectedText, onSelectText, fontFamily, lockedRatio }: ImageStageProps) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<Stroke | null>(null);
  const textDrag = useRef<{ id: string; x: number; y: number; sx: number; sy: number } | null>(null);

  const frame = orientedSize(source, edits.rotate);
  const cropMode = tool === "crop";
  const view = cropMode ? FULL_RECT : edits.crop;
  const pad = cropMode ? CROP_PAD : 0;
  const vw = view.w * frame.w;
  const vh = view.h * frame.h;
  const scale = Math.max(0.01, Math.min((stageW - pad * 2) / vw, (stageH - pad * 2) / vh));
  const cssW = Math.max(1, Math.round(vw * scale));
  const cssH = Math.max(1, Math.round(vh * scale));
  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const maxEdge = Math.round(Math.max(cssW, cssH) * dpr);

  const geometryKey = useMemo(
    () => JSON.stringify([edits.rotate, edits.flipH, edits.straighten, cropMode ? null : edits.crop, edits.adjust, maxEdge]),
    [edits.rotate, edits.flipH, edits.straighten, edits.crop, edits.adjust, cropMode, maxEdge],
  );

  // Base picture (geometry + adjustments). Drawing into a canvas — an external system.
  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    const id = requestAnimationFrame(() => {
      renderImage(source, edits, { maxEdge, frameOnly: cropMode, skipOverlays: true, target: canvas });
    });
    return () => cancelAnimationFrame(id);
    // geometryKey covers the edits fields that matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, geometryKey]);

  // Drawings and (outside text mode) text, on their own canvas.
  useEffect(() => {
    const c = overlayRef.current;
    if (!c) return;
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (cropMode) return;
    drawStrokes(ctx, c.width, c.height, edits.strokes);
    if (tool !== "text") drawTexts(ctx, c.width, c.height, edits.texts, fontFamily);
  }, [edits.strokes, edits.texts, cssW, cssH, dpr, cropMode, tool, fontFamily]);

  function pointIn(e: React.PointerEvent): { x: number; y: number } {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  }

  function redrawLive() {
    const c = overlayRef.current;
    const st = live.current;
    if (!c || !st) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    // Committed strokes + the one in progress on one layer, so the eraser previews right.
    const layer = document.createElement("canvas");
    layer.width = c.width;
    layer.height = c.height;
    const l = layer.getContext("2d");
    if (!l) return;
    for (const s of edits.strokes) paintStroke(l, c.width, c.height, s);
    paintStroke(l, c.width, c.height, st);
    ctx.drawImage(layer, 0, 0);
    drawTexts(ctx, c.width, c.height, edits.texts, fontFamily);
  }

  const lockedAspect = lockedRatio ?? ASPECTS.find((a) => a.key === edits.aspect)?.ratio ?? (edits.aspect === "original" ? frame.w / frame.h : null);

  return (
    <div className="relative flex size-full items-center justify-center">
      <div className="relative" style={{ width: cssW, height: cssH }}>
        <canvas ref={baseRef} aria-hidden className="absolute inset-0 size-full" />
        <canvas
          ref={overlayRef}
          aria-hidden
          className={cn("absolute inset-0 size-full", tool === "draw" ? "cursor-crosshair touch-none" : "pointer-events-none")}
          onPointerDown={
            tool === "draw"
              ? (e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  // Size is relative to the output width, so a stroke looks the same at any zoom.
                  live.current = { points: [pointIn(e)], color: brush.color, size: brush.size, eraser: brush.eraser || undefined };
                  redrawLive();
                }
              : undefined
          }
          onPointerMove={
            tool === "draw"
              ? (e) => {
                  if (!live.current) return;
                  const events = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
                  const r = e.currentTarget.getBoundingClientRect();
                  const pts = (events.length ? events : [e.nativeEvent]).map((ev) => ({
                    x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
                    y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)),
                  }));
                  live.current.points.push(...pts);
                  redrawLive();
                }
              : undefined
          }
          onPointerUp={
            tool === "draw"
              ? () => {
                  const st = live.current;
                  live.current = null;
                  if (st) onEdits((p) => ({ ...p, strokes: [...p.strokes, st] }));
                }
              : undefined
          }
          onPointerCancel={() => {
            live.current = null;
          }}
        />
        {tool === "text"
          ? edits.texts.map((t) => (
              <TextBox
                key={t.id}
                t={t}
                cssW={cssW}
                cssH={cssH}
                fontFamily={fontFamily}
                selected={selectedText === t.id}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  onSelectText(t.id);
                  textDrag.current = { id: t.id, x: e.clientX, y: e.clientY, sx: t.x, sy: t.y };
                }}
                onPointerMove={(e) => {
                  const d = textDrag.current;
                  if (!d || d.id !== t.id) return;
                  const nx = Math.min(1, Math.max(0, d.sx + (e.clientX - d.x) / cssW));
                  const ny = Math.min(1, Math.max(0, d.sy + (e.clientY - d.y) / cssH));
                  onEdits((p) => ({ ...p, texts: p.texts.map((x) => (x.id === t.id ? { ...x, x: nx, y: ny } : x)) }));
                }}
                onPointerUp={() => {
                  textDrag.current = null;
                }}
              />
            ))
          : null}
        {cropMode ? (
          <CropOverlay
            width={cssW}
            height={cssH}
            rect={edits.crop}
            ratio={lockedAspect}
            onChange={(crop) => onEdits((p) => ({ ...p, crop }))}
          />
        ) : null}
      </div>
    </div>
  );
}

function TextBox({
  t,
  cssW,
  cssH,
  fontFamily,
  selected,
  ...handlers
}: {
  t: TextLayer;
  cssW: number;
  cssH: number;
  fontFamily: string;
  selected: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const size = t.size * cssW;
  const style: React.CSSProperties = {
    left: t.x * cssW,
    top: t.y * cssH,
    fontSize: size,
    lineHeight: 1.22,
    fontFamily,
    fontWeight: 700,
    color: t.style === "fill" ? (isLight(t.color) ? "#111" : "#fff") : t.color,
    background: t.style === "fill" ? t.color : undefined,
    padding: t.style === "fill" ? `${size * 0.18}px ${size * 0.4}px` : `${size * 0.1}px`,
    borderRadius: size * 0.3,
    textShadow: t.style === "plain" ? "0 1px 6px rgba(0,0,0,.55)" : undefined,
    WebkitTextStroke: t.style === "outline" ? `${Math.max(1, size * 0.08)}px ${isLight(t.color) ? "#111" : "#fff"}` : undefined,
    paintOrder: "stroke fill",
  };
  return (
    <div
      dir="auto"
      role="button"
      aria-label={`Text: ${t.text || "empty"}`}
      aria-pressed={selected}
      className={cn(
        "absolute max-w-[95%] -translate-x-1/2 -translate-y-1/2 cursor-move touch-none whitespace-pre text-center outline-none",
        selected && "ring-2 ring-white/90 ring-offset-2 ring-offset-black/30",
      )}
      style={style}
      {...handlers}
    >
      {t.text || " "}
    </div>
  );
}
