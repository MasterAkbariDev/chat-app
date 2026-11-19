/** Normalized (0–1) rectangle, relative to the frame it lives in. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_RECT: NormRect = { x: 0, y: 0, w: 1, h: 1 };

/** Crop aspect presets (width / height). `free` = any, `original` = the frame's own. */
export type AspectKey = "free" | "original" | "square" | "4:3" | "3:4" | "16:9" | "9:16" | "3:2" | "2:3";

export const ASPECTS: { key: AspectKey; label: string; ratio: number | null }[] = [
  { key: "free", label: "Free", ratio: null },
  { key: "original", label: "Original", ratio: null },
  { key: "square", label: "Square", ratio: 1 },
  { key: "4:3", label: "4:3", ratio: 4 / 3 },
  { key: "3:4", label: "3:4", ratio: 3 / 4 },
  { key: "16:9", label: "16:9", ratio: 16 / 9 },
  { key: "9:16", label: "9:16", ratio: 9 / 16 },
  { key: "3:2", label: "3:2", ratio: 3 / 2 },
  { key: "2:3", label: "2:3", ratio: 2 / 3 },
];

/** A freehand stroke. Points and width are normalized to the *output* (cropped) frame:
 *  x/y by its width/height, `size` by its width. */
export interface Stroke {
  points: { x: number; y: number }[];
  color: string;
  size: number;
  eraser?: boolean;
}

export type TextStyle = "plain" | "fill" | "outline";

/** A text label, centred at (x, y) in the output frame; `size` is the font size as a
 *  fraction of the output width. */
export interface TextLayer {
  id: string;
  text: string;
  x: number;
  y: number;
  size: number;
  color: string;
  style: TextStyle;
}

export interface Adjustments {
  /** −100…100, 0 = unchanged. */
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  /** 0…100. */
  fade: number;
  vignette: number;
}

export const NO_ADJUST: Adjustments = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, fade: 0, vignette: 0 };

export interface ImageEdits {
  /** Quarter turns clockwise. */
  rotate: 0 | 1 | 2 | 3;
  flipH: boolean;
  /** Straighten, degrees (−45…45). */
  straighten: number;
  /** In the rotated + straightened frame. */
  crop: NormRect;
  aspect: AspectKey;
  strokes: Stroke[];
  texts: TextLayer[];
  adjust: Adjustments;
}

export const NO_IMAGE_EDITS: ImageEdits = {
  rotate: 0,
  flipH: false,
  straighten: 0,
  crop: FULL_RECT,
  aspect: "free",
  strokes: [],
  texts: [],
  adjust: NO_ADJUST,
};

export interface VideoEditState {
  trimStart: number;
  /** null = to the end. */
  trimEnd: number | null;
  muted: boolean;
  rotate: 0 | 1 | 2 | 3;
  flipH: boolean;
  crop: NormRect;
  aspect: AspectKey;
  /** Cover frame on the source timeline (seconds), null = first frame. */
  coverSec: number | null;
}

export const NO_VIDEO_EDITS: VideoEditState = {
  trimStart: 0,
  trimEnd: null,
  muted: false,
  rotate: 0,
  flipH: false,
  crop: FULL_RECT,
  aspect: "free",
  coverSec: null,
};

export type ImageQualityTier = "standard" | "hd";
export type VideoQualityTier = "480" | "720" | "1080";

export interface EditorItem {
  id: string;
  file: File;
  kind: "image" | "gif" | "video";
  image: ImageEdits;
  video: VideoEditState;
}

/** What the editor hands back per item. */
export type PreparedMedia =
  | { kind: "image"; file: File; width: number; height: number }
  | { kind: "gif"; file: File }
  | {
      kind: "video";
      file: File;
      /** Server-side edits (POST /upload/video `edits`), null when untouched. */
      edits: VideoEditsPayload | null;
      resolution: VideoQualityTier;
      durationSec: number;
    }
  | { kind: "file"; file: File };

/** Matches backend `VideoEdits` (src/media/video-processing.util.ts). */
export interface VideoEditsPayload {
  trimStartSec?: number;
  trimEndSec?: number;
  muted?: boolean;
  rotate?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  crop?: NormRect;
  coverSec?: number;
}

export interface MediaEditorResult {
  items: PreparedMedia[];
  caption: string;
}

export function isRectFull(r: NormRect): boolean {
  return r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.999 && r.h >= 0.999;
}

export function hasImageEdits(e: ImageEdits): boolean {
  const a = e.adjust;
  return (
    e.rotate !== 0 ||
    e.flipH ||
    Math.abs(e.straighten) > 0.05 ||
    !isRectFull(e.crop) ||
    e.strokes.length > 0 ||
    e.texts.some((t) => t.text.trim()) ||
    a.brightness !== 0 ||
    a.contrast !== 0 ||
    a.saturation !== 0 ||
    a.warmth !== 0 ||
    a.fade !== 0 ||
    a.vignette !== 0
  );
}

/** Video edit state → the upload's `edits` field (null when nothing changes). */
export function videoEditsPayload(v: VideoEditState, duration: number | null): VideoEditsPayload | null {
  const out: VideoEditsPayload = {};
  if (v.trimStart > 0.05) out.trimStartSec = round3(v.trimStart);
  if (v.trimEnd != null && (duration == null || v.trimEnd < duration - 0.05)) out.trimEndSec = round3(v.trimEnd);
  if (v.muted) out.muted = true;
  if (v.rotate) out.rotate = (v.rotate * 90) as 90 | 180 | 270;
  if (v.flipH) out.flipH = true;
  if (!isRectFull(v.crop)) out.crop = { x: round4(v.crop.x), y: round4(v.crop.y), w: round4(v.crop.w), h: round4(v.crop.h) };
  if (v.coverSec != null && v.coverSec > 0.01) out.coverSec = round3(v.coverSec);
  return Object.keys(out).length ? out : null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
