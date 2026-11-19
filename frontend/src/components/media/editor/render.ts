import type { Adjustments, ImageEdits, NormRect, Stroke, TextLayer } from "./types";
import { FULL_RECT, NO_ADJUST } from "./types";

/** Anything canvas can draw that has a size. */
export type ImageSource = HTMLImageElement | ImageBitmap | HTMLCanvasElement;

export function sourceSize(src: ImageSource): { w: number; h: number } {
  if ("naturalWidth" in src) return { w: src.naturalWidth, h: src.naturalHeight };
  return { w: src.width, h: src.height };
}

/** Size of the frame after quarter turns (straightening keeps the frame size). */
export function orientedSize(src: ImageSource, rotate: number): { w: number; h: number } {
  const { w, h } = sourceSize(src);
  return rotate % 2 ? { w: h, h: w } : { w, h };
}

/** How much a w×h image must be scaled, when rotated by `deg`, to still cover its w×h frame. */
export function straightenScale(w: number, h: number, deg: number): number {
  const t = (Math.abs(deg) * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return Math.max((w * c + h * s) / w, (w * s + h * c) / h);
}

/** Output pixel size for `crop` of the oriented frame, long edge capped at `maxEdge`. */
export function outputSize(frameW: number, frameH: number, crop: NormRect, maxEdge = Infinity): { w: number; h: number; scale: number } {
  const cw = Math.max(1, crop.w * frameW);
  const ch = Math.max(1, crop.h * frameH);
  const scale = Math.min(1, maxEdge / Math.max(cw, ch));
  return { w: Math.max(1, Math.round(cw * scale)), h: Math.max(1, Math.round(ch * scale)), scale };
}

export interface RenderOptions {
  /** Long-edge cap of the output, in pixels. */
  maxEdge?: number;
  /** Crop mode: render the whole rotated/straightened frame and skip drawings/text. */
  frameOnly?: boolean;
  /** Draw into this canvas instead of a new one (it is resized). */
  target?: HTMLCanvasElement;
  /** Leave drawings / text out (the editor draws them live on top). */
  skipOverlays?: boolean;
  /** Font family stack for text layers (the app's computed one). */
  fontFamily?: string;
}

/** Renders `src` with `edits` (geometry → adjustments → vignette → drawings → text). The same
 *  function draws the on-screen preview (small `maxEdge`) and the exported file, so what you
 *  see is what gets sent. */
export function renderImage(src: ImageSource, edits: ImageEdits, opts: RenderOptions = {}): HTMLCanvasElement {
  const { w: sw, h: sh } = sourceSize(src);
  const { w: fw, h: fh } = orientedSize(src, edits.rotate);
  const crop = opts.frameOnly ? FULL_RECT : edits.crop;
  const out = outputSize(fw, fh, crop, opts.maxEdge);
  const canvas = opts.target ?? document.createElement("canvas");
  canvas.width = out.w;
  canvas.height = out.h;
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  if (!ctx) return canvas;

  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, out.w, out.h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const s = out.w / (crop.w * fw);
  ctx.scale(s, s);
  ctx.translate(-crop.x * fw, -crop.y * fh);
  ctx.translate(fw / 2, fh / 2);
  if (edits.straighten) {
    ctx.rotate((edits.straighten * Math.PI) / 180);
    const k = straightenScale(fw, fh, edits.straighten);
    ctx.scale(k, k);
  }
  if (edits.flipH) ctx.scale(-1, 1);
  if (edits.rotate) ctx.rotate((edits.rotate * Math.PI) / 2);
  ctx.drawImage(src, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();

  applyAdjustments(ctx, out.w, out.h, edits.adjust ?? NO_ADJUST);

  if (!opts.frameOnly && !opts.skipOverlays) {
    drawStrokes(ctx, out.w, out.h, edits.strokes);
    drawTexts(ctx, out.w, out.h, edits.texts, opts.fontFamily);
  }
  return canvas;
}

function isNeutral(a: Adjustments): boolean {
  return !a.brightness && !a.contrast && !a.saturation && !a.warmth && !a.fade && !a.vignette;
}

/** Brightness/contrast/fade via one LUT, then saturation and warmth per pixel; vignette as a
 *  radial gradient on top. */
export function applyAdjustments(ctx: CanvasRenderingContext2D, w: number, h: number, a: Adjustments) {
  if (isNeutral(a)) return;
  if (a.brightness || a.contrast || a.saturation || a.warmth || a.fade) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const b = a.brightness / 100;
    const c = a.contrast / 100;
    const f = a.fade / 100;
    const sat = 1 + a.saturation / 100;
    const warm = (a.warmth / 100) * 28;
    const cf = c >= 0 ? 1 + c * 0.8 : 1 + c * 0.6;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      let v = i / 255;
      // Brightness as a gamma-ish curve: lifts/darkens mids more than the ends.
      v = b >= 0 ? 1 - Math.pow(1 - v, 1 + b * 1.2) : Math.pow(v, 1 - b * 1.2);
      v = (v - 0.5) * cf + 0.5;
      v = v * (1 - f * 0.22) + f * 0.12;
      lut[i] = Math.round(v * 255);
    }
    const doSat = sat !== 1;
    for (let i = 0; i < d.length; i += 4) {
      let r = lut[d[i]];
      let g = lut[d[i + 1]];
      let bl = lut[d[i + 2]];
      if (doSat) {
        const l = 0.299 * r + 0.587 * g + 0.114 * bl;
        r = l + (r - l) * sat;
        g = l + (g - l) * sat;
        bl = l + (bl - l) * sat;
      }
      if (warm) {
        r += warm;
        g += warm * 0.25;
        bl -= warm;
      }
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = bl;
    }
    ctx.putImageData(img, 0, 0);
  }
  if (a.vignette) {
    const v = a.vignette / 100;
    const r = Math.hypot(w, h) / 2;
    const g = ctx.createRadialGradient(w / 2, h / 2, r * (0.55 - v * 0.25), w / 2, h / 2, r);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${0.75 * v})`);
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}

/** Freehand strokes on their own layer (so the eraser only erases drawing, not the photo). */
export function drawStrokes(ctx: CanvasRenderingContext2D, w: number, h: number, strokes: Stroke[]) {
  if (!strokes.length) return;
  const layer = document.createElement("canvas");
  layer.width = w;
  layer.height = h;
  const l = layer.getContext("2d");
  if (!l) return;
  for (const st of strokes) paintStroke(l, w, h, st);
  ctx.drawImage(layer, 0, 0);
}

export function paintStroke(l: CanvasRenderingContext2D, w: number, h: number, st: Stroke) {
  if (!st.points.length) return;
  l.save();
  l.globalCompositeOperation = st.eraser ? "destination-out" : "source-over";
  l.strokeStyle = st.eraser ? "#000" : st.color;
  l.fillStyle = l.strokeStyle;
  l.lineCap = "round";
  l.lineJoin = "round";
  l.lineWidth = Math.max(1, st.size * w);
  const pts = st.points;
  if (pts.length === 1) {
    l.beginPath();
    l.arc(pts[0].x * w, pts[0].y * h, l.lineWidth / 2, 0, Math.PI * 2);
    l.fill();
  } else {
    l.beginPath();
    l.moveTo(pts[0].x * w, pts[0].y * h);
    // Quadratic smoothing through midpoints.
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = ((pts[i].x + pts[i + 1].x) / 2) * w;
      const my = ((pts[i].y + pts[i + 1].y) / 2) * h;
      l.quadraticCurveTo(pts[i].x * w, pts[i].y * h, mx, my);
    }
    const last = pts[pts.length - 1];
    l.lineTo(last.x * w, last.y * h);
    l.stroke();
  }
  l.restore();
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/** Relative luminance-ish check, for text drawn on a coloured box. */
export function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}

export function textFont(sizePx: number, family?: string): string {
  return `700 ${Math.max(6, Math.round(sizePx))}px ${family || "system-ui, sans-serif"}`;
}

/** Text labels: plain (with a soft shadow), filled box, or outlined. Multi-line, centred. */
export function drawTexts(ctx: CanvasRenderingContext2D, w: number, h: number, texts: TextLayer[], family?: string) {
  for (const t of texts) {
    const text = t.text.trim();
    if (!text) continue;
    const size = t.size * w;
    const lines = text.split("\n");
    const lineH = size * 1.22;
    ctx.save();
    ctx.font = textFont(size, family);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.direction = RTL.test(text) ? "rtl" : "ltr";
    const cx = t.x * w;
    const cy = t.y * h;
    const top = cy - ((lines.length - 1) * lineH) / 2;
    if (t.style === "fill") {
      const padX = size * 0.4;
      const padY = size * 0.18;
      const widest = Math.max(...lines.map((ln) => ctx.measureText(ln).width));
      const bw = widest + padX * 2;
      const bh = lines.length * lineH + padY * 2;
      ctx.fillStyle = t.color;
      roundRect(ctx, cx - bw / 2, cy - bh / 2, bw, bh, size * 0.3);
      ctx.fill();
      ctx.fillStyle = isLight(t.color) ? "#111" : "#fff";
      lines.forEach((ln, i) => ctx.fillText(ln, cx, top + i * lineH));
    } else if (t.style === "outline") {
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(2, size * 0.16);
      ctx.strokeStyle = isLight(t.color) ? "#111" : "#fff";
      lines.forEach((ln, i) => ctx.strokeText(ln, cx, top + i * lineH));
      ctx.fillStyle = t.color;
      lines.forEach((ln, i) => ctx.fillText(ln, cx, top + i * lineH));
    } else {
      ctx.shadowColor = "rgba(0,0,0,0.55)";
      ctx.shadowBlur = size * 0.18;
      ctx.shadowOffsetY = size * 0.04;
      ctx.fillStyle = t.color;
      lines.forEach((ln, i) => ctx.fillText(ln, cx, top + i * lineH));
    }
    ctx.restore();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Loads a picked image file, upright (EXIF orientation applied by the browser). */
export function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      resolve(img);
      // Keep the URL alive for the element's lifetime; revoked by the caller via revokeImage().
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This image can't be opened."));
    };
    img.src = url;
  });
}

export function revokeImage(img: HTMLImageElement | null | undefined) {
  if (img?.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
}
