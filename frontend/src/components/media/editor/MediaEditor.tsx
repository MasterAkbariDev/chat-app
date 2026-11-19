"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Crop, File as FileIcon, ImagePlus, Paintbrush, Plus, SendHorizontal, SlidersHorizontal, Trash2, Type, Volume2, VolumeX, X, Image as ImageIcon } from "lucide-react";
import { useBackToClose } from "@/hooks/use-back-to-close";
import { cn } from "@/lib/cn";
import { canvasToBlob, encodeBothTiers, encodeTier, formatBytes, hasAlpha, toFile, type EncodedImage, type QualityTier } from "@/lib/image-quality";
import { fitAspect, flipRect, rotateRect } from "./CropOverlay";
import { ImageStage, type BrushSettings, type ImageTool } from "./ImageStage";
import { QualityControl } from "./QualityControl";
import { loadImage, orientedSize, renderImage, revokeImage } from "./render";
import { AdjustPanel, CropPanel, DrawPanel, TextPanel } from "./ToolPanels";
import {
  ASPECTS,
  FULL_RECT,
  NO_IMAGE_EDITS,
  NO_VIDEO_EDITS,
  hasImageEdits,
  isRectFull,
  videoEditsPayload,
  type AspectKey,
  type EditorItem,
  type ImageEdits,
  type MediaEditorResult,
  type PreparedMedia,
  type TextLayer,
  type VideoEditState,
  type VideoQualityTier,
} from "./types";
import { VideoStage, type VideoMeta, type VideoTool } from "./VideoStage";

export const MAX_ITEMS = 10;
const QUALITY_KEY = "chat:photo-quality";
const PREVIEW_EDGE = 2048;

type Tool = ImageTool | VideoTool;

export interface MediaEditorProps {
  files: File[];
  onClose: () => void;
  /** Called with the prepared files. The editor stays open (showing progress) until it resolves;
   *  a rejection shows its message and keeps the edits. */
  onDone: (result: MediaEditorResult) => void | Promise<void>;
  /** `chat`: caption, several items, add more, quality, send as file. `single`: one photo or
   *  video for a profile, group or wallpaper. */
  variant?: "chat" | "single";
  /** Lock the crop to a square (profile and group photos). */
  lockSquare?: boolean;
  confirmLabel?: string;
  /** Force a photo tier (hides the Standard / HD control). */
  imageTier?: QualityTier;
  /** Longest video allowed (seconds) — the trimmer won't select more. */
  maxVideoSec?: number;
  /** Accept videos (added via "Add"). Defaults to true. */
  allowVideo?: boolean;
  initialCaption?: string;
}

export function kindOf(file: File): EditorItem["kind"] | null {
  if (file.type === "image/gif") return "gif";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  // Some pickers hand over no type: fall back to the extension.
  if (/\.gif$/i.test(file.name)) return "gif";
  if (/\.(jpe?g|png|webp|heic|avif|bmp)$/i.test(file.name)) return "image";
  if (/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)) return "video";
  return null;
}

let idSeq = 0;
function makeItem(file: File): EditorItem | null {
  const kind = kindOf(file);
  if (!kind) return null;
  idSeq += 1;
  return { id: `m${Date.now().toString(36)}${idSeq}`, file, kind, image: NO_IMAGE_EDITS, video: NO_VIDEO_EDITS };
}

interface Loaded {
  img: HTMLImageElement;
  preview: HTMLCanvasElement;
  alpha: boolean;
}

// Rough average bitrates of the server's libx264 CRF 26 "veryfast" pass per long-edge cap — an
// estimate shown before sending (CRF targets quality, not size).
const VIDEO_KBPS: Record<VideoQualityTier, number> = { "480": 700, "720": 1800, "1080": 3500 };
export function estimateVideoBytes(durationSec: number, tier: VideoQualityTier, muted: boolean): number {
  return ((VIDEO_KBPS[tier] + (muted ? 0 : 128)) * 1000 * durationSec) / 8;
}

const SWAP: Partial<Record<AspectKey, AspectKey>> = { "4:3": "3:4", "3:4": "4:3", "16:9": "9:16", "9:16": "16:9", "3:2": "2:3", "2:3": "3:2" };

function readTier(): QualityTier {
  try {
    return localStorage.getItem(QUALITY_KEY) === "hd" ? "hd" : "standard";
  } catch {
    return "standard";
  }
}

/** Telegram-style full-screen editor shown before media is sent or set: crop / rotate /
 *  straighten, draw, text and adjustments for photos; trim, mute, cover frame and crop /
 *  rotate for videos (applied by the server); several items in a carousel with a caption,
 *  Standard / HD, and "Send as file". */
export function MediaEditor({
  files,
  onClose,
  onDone,
  variant = "chat",
  lockSquare,
  confirmLabel,
  imageTier: forcedTier,
  maxVideoSec,
  allowVideo = true,
  initialCaption = "",
}: MediaEditorProps) {
  const chat = variant === "chat";
  const [items, setItems] = useState<EditorItem[]>(() => files.map(makeItem).filter((x): x is EditorItem => !!x).slice(0, chat ? MAX_ITEMS : 1));
  const [index, setIndex] = useState(0);
  const [tool, setTool] = useState<Tool | null>(null);
  const snapshot = useRef<EditorItem | null>(null);
  const [caption, setCaption] = useState(initialCaption);
  const [imageTier, setImageTier] = useState<QualityTier>(readTier);
  const [videoTier, setVideoTier] = useState<VideoQualityTier>("720");
  const [sendAsFile, setSendAsFile] = useState(false);
  const [brush, setBrush] = useState<BrushSettings>({ color: "#ff3b30", size: 0.012, eraser: false });
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [videoMeta, setVideoMeta] = useState<Record<string, VideoMeta | null>>({});
  const [sizes, setSizes] = useState<Record<string, { key: string; standard: number; hd: number }>>({});
  const encoded = useRef<Record<string, { key: string; standard: EncodedImage; hd: EncodedImage }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fontFamily] = useState(() => (typeof document === "undefined" ? "system-ui, sans-serif" : getComputedStyle(document.body).fontFamily));
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const captionId = useId();

  const item = items[Math.min(index, items.length - 1)] as EditorItem | undefined;
  const current = item ? loaded[item.id] : undefined;
  const meta = item ? videoMeta[item.id] : undefined;

  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  useBackToClose(() => {
    if (busy) return false;
    onClose();
  });

  // Nothing left (all removed, or nothing usable was picked).
  useEffect(() => {
    if (!items.length) onClose();
  }, [items.length, onClose]);

  // Focus in, and back to the opener on the way out.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ focusVisible: false } as FocusOptions);
    return () => prev?.focus?.();
  }, []);

  // Stage size → fitted previews.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStage({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const loadedRef = useRef<Record<string, Loaded>>({});
  // Decode photos when they're shown (once), with a ≤2048 px copy for fast previews.
  const ensureLoaded = useCallback(async (it: EditorItem): Promise<Loaded> => {
    const have = loadedRef.current[it.id];
    if (have) return have;
    const img = await loadImage(it.file);
    const preview = document.createElement("canvas");
    const k = Math.min(1, PREVIEW_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    preview.width = Math.max(1, Math.round(img.naturalWidth * k));
    preview.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = preview.getContext("2d");
    ctx?.drawImage(img, 0, 0, preview.width, preview.height);
    const alpha = /png|webp/.test(it.file.type) && hasAlpha(preview);
    const entry = { img, preview, alpha };
    loadedRef.current[it.id] = entry;
    setLoaded((m) => ({ ...m, [it.id]: entry }));
    return entry;
  }, []);

  useEffect(() => {
    if (!item || item.kind !== "image" || loadedRef.current[item.id]) return;
    let cancelled = false;
    ensureLoaded(item)
      .then((entry) => {
        if (cancelled || !lockSquare) return;
        const f = orientedSize(entry.preview, 0);
        setItems((list) => list.map((x) => (x.id === item.id && isRectFull(x.image.crop) ? { ...x, image: { ...x.image, aspect: "square", crop: fitAspect(1, f.w, f.h, FULL_RECT) } } : x)));
      })
      .catch(() => {
        if (!cancelled) setError("This photo can't be opened. Remove it or try another one.");
      });
    return () => {
      cancelled = true;
    };
  }, [item, ensureLoaded, lockSquare]);

  // Free decoded images when the editor closes.
  useEffect(() => {
    const ref = loadedRef;
    return () => {
      for (const e of Object.values(ref.current)) revokeImage(e.img);
    };
  }, []);

  const showImageQuality = chat && !forcedTier && !sendAsFile;
  const imageKey = item?.kind === "image" ? JSON.stringify(item.image) : "";

  // Real sizes for Standard / HD (encoded for real, then reused when sending).
  useEffect(() => {
    if (!item || item.kind !== "image" || !current || tool || !showImageQuality) return;
    const cached = encoded.current[item.id];
    if (cached?.key === imageKey) return;
    let cancelled = false;
    const t = setTimeout(() => {
      encodeBothTiers({
        file: item.file,
        width: current.img.naturalWidth,
        height: current.img.naturalHeight,
        edited: hasImageEdits(item.image),
        alpha: current.alpha,
        render: (maxEdge) => renderImage(current.img, item.image, { maxEdge, fontFamily }),
      })
        .then((both) => {
          if (cancelled) return;
          encoded.current[item.id] = { key: imageKey, ...both };
          setSizes((m) => ({ ...m, [item.id]: { key: imageKey, standard: both.standard.blob.size, hd: both.hd.blob.size } }));
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [item, current, imageKey, tool, showImageQuality, fontFamily]);

  const updateImage = useCallback(
    (update: (prev: ImageEdits) => ImageEdits) => {
      if (!item) return;
      setItems((list) => list.map((x) => (x.id === item.id ? { ...x, image: update(x.image) } : x)));
    },
    [item],
  );
  const updateVideo = useCallback(
    (update: (prev: VideoEditState) => VideoEditState) => {
      if (!item) return;
      setItems((list) => list.map((x) => (x.id === item.id ? { ...x, video: update(x.video) } : x)));
    },
    [item],
  );

  function openTool(t: Tool) {
    if (!item) return;
    snapshot.current = item;
    setTool(t);
    setSelectedText(null);
  }

  function cancelTool() {
    const snap = snapshot.current;
    if (snap) setItems((list) => list.map((x) => (x.id === snap.id ? snap : x)));
    snapshot.current = null;
    setTool(null);
    setSelectedText(null);
  }

  function doneTool() {
    // Drop empty text labels.
    if (item?.kind === "image") updateImage((p) => ({ ...p, texts: p.texts.filter((t) => t.text.trim()) }));
    snapshot.current = null;
    setTool(null);
    setSelectedText(null);
  }

  // Frame (rotated) size of the current item, for aspect maths.
  function frameSize(rotate: number): { w: number; h: number } | null {
    if (!item) return null;
    if (item.kind === "image" && current) return orientedSize(current.preview, rotate);
    if (item.kind === "video" && meta) return rotate % 2 ? { w: meta.height, h: meta.width } : { w: meta.width, h: meta.height };
    return null;
  }

  function ratioOf(aspect: AspectKey, rotate: number): number | null {
    if (lockSquare) return 1;
    if (aspect === "original") {
      const f = frameSize(rotate);
      return f ? f.w / f.h : null;
    }
    return ASPECTS.find((a) => a.key === aspect)?.ratio ?? null;
  }

  type Geo = { rotate: 0 | 1 | 2 | 3; flipH: boolean; crop: typeof FULL_RECT; aspect: AspectKey };
  function geoUpdate(fn: (g: Geo) => Geo) {
    if (item?.kind === "image") updateImage((p) => ({ ...p, ...fn(p) }));
    else if (item?.kind === "video") updateVideo((p) => ({ ...p, ...fn(p) }));
  }

  function setAspect(aspect: AspectKey) {
    geoUpdate((g) => {
      const f = frameSize(g.rotate);
      const r = ratioOf(aspect, g.rotate);
      return { ...g, aspect, crop: f && r ? fitAspect(r, f.w, f.h, g.crop) : g.crop };
    });
  }

  function rotate() {
    geoUpdate((g) => ({
      ...g,
      rotate: ((g.rotate + 1) % 4) as 0 | 1 | 2 | 3,
      crop: rotateRect(g.crop),
      aspect: SWAP[g.aspect] ?? g.aspect,
    }));
  }

  function flip() {
    geoUpdate((g) => ({ ...g, flipH: !g.flipH, crop: flipRect(g.crop) }));
  }

  function resetGeometry() {
    if (item?.kind === "image") updateImage((p) => ({ ...p, straighten: 0 }));
    geoUpdate(() => {
      const f = frameSize(0);
      return { rotate: 0, flipH: false, aspect: lockSquare ? "square" : "free", crop: lockSquare && f ? fitAspect(1, f.w, f.h, FULL_RECT) : FULL_RECT };
    });
  }

  function addText() {
    const id = `t${Date.now().toString(36)}`;
    const layer: TextLayer = { id, text: "", x: 0.5, y: 0.5, size: 0.08, color: "#ffffff", style: "fill" };
    updateImage((p) => ({ ...p, texts: [...p.texts.filter((t) => t.text.trim()), layer] }));
    setSelectedText(id);
    requestAnimationFrame(() => textInputRef.current?.focus());
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = Array.from(list)
      .map(makeItem)
      .filter((x): x is EditorItem => !!x && (allowVideo || x.kind !== "video"));
    if (!next.length) return;
    setItems((prev) => {
      const merged = [...prev, ...next].slice(0, MAX_ITEMS);
      setIndex(Math.min(prev.length, merged.length - 1));
      return merged;
    });
  }

  function removeCurrent() {
    if (!item) return;
    delete encoded.current[item.id];
    setItems((list) => list.filter((x) => x.id !== item.id));
    setIndex((i) => Math.max(0, Math.min(i, items.length - 2)));
  }

  async function prepare(it: EditorItem): Promise<PreparedMedia> {
    if (it.kind === "gif") return sendAsFile ? { kind: "file", file: it.file } : { kind: "gif", file: it.file };
    if (it.kind === "video") {
      if (sendAsFile) return { kind: "file", file: it.file };
      const m = videoMeta[it.id];
      const duration = m?.duration ?? null;
      const end = it.video.trimEnd ?? duration ?? 0;
      return {
        kind: "video",
        file: it.file,
        edits: videoEditsPayload(it.video, duration),
        resolution: videoTier,
        durationSec: Math.max(0, end - it.video.trimStart),
      };
    }
    const entry = await ensureLoaded(it);
    const edited = hasImageEdits(it.image);
    if (sendAsFile) {
      if (!edited) return { kind: "file", file: it.file };
      const canvas = renderImage(entry.img, it.image, { maxEdge: 4096, fontFamily });
      const blob = await canvasToBlob(canvas, entry.alpha ? "image/png" : "image/jpeg", 0.92);
      return { kind: "file", file: toFile(blob, it.file.name) };
    }
    const tier = forcedTier ?? imageTier;
    const key = JSON.stringify(it.image);
    const cached = encoded.current[it.id];
    const opts = {
      file: it.file,
      width: entry.img.naturalWidth,
      height: entry.img.naturalHeight,
      edited,
      alpha: entry.alpha,
      render: (maxEdge: number) => renderImage(entry.img, it.image, { maxEdge, fontFamily }),
    };
    const enc = cached?.key === key ? cached[tier] : tier === "standard" && !forcedTier ? (await encodeBothTiers(opts)).standard : await encodeTier({ ...opts, tier });
    return { kind: "image", file: toFile(enc.blob, it.file.name), width: enc.width, height: enc.height };
  }

  async function confirm() {
    if (busy || !items.length) return;
    if (tool) doneTool();
    setBusy(true);
    setError(null);
    try {
      const prepared: PreparedMedia[] = [];
      for (const it of items) prepared.push(await prepare(it));
      await onDone({ items: prepared, caption: chat ? caption.trim() : "" });
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function chooseTier(t: QualityTier) {
    setImageTier(t);
    try {
      localStorage.setItem(QUALITY_KEY, t);
    } catch {
      /* private mode */
    }
  }

  // Keyboard: Esc backs out of a tool, then closes; Tab stays inside. On `window` in the
  // capture phase, so a Dialog underneath (profile photos) — which traps keys on `document` —
  // never sees them while the editor is open.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      if (tool) cancelTool();
      else close();
      return;
    }
    if (e.key === "Tab") e.stopPropagation();
    if (e.key === "Tab") {
      const root = rootRef.current;
      if (!root) return;
      const nodes = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      );
      if (!nodes.length) return;
      if (!root.contains(document.activeElement)) {
        e.preventDefault();
        nodes[0].focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keyRef.current = onKeyDown;
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  if (!item) return null;

  const isImage = item.kind === "image";
  const isVideo = item.kind === "video";
  const count = items.length;
  const label = confirmLabel ?? (chat ? "Send" : "Done");
  const title = !chat ? (isVideo ? "Edit video" : "Edit photo") : count > 1 ? `${index + 1} of ${count}` : isVideo ? "Video" : item.kind === "gif" ? "GIF" : "Photo";
  const sz = sizes[item.id];
  const sizeFresh = sz?.key === imageKey;
  const trimmedSec = meta ? (item.video.trimEnd ?? meta.duration) - item.video.trimStart : null;
  const toolTitle: Record<Tool, string> = { crop: "Crop and rotate", draw: "Draw", text: "Text", adjust: "Adjust", cover: "Cover frame" };

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={chat ? "Edit and send media" : title}
      className="fade-in fixed inset-0 z-[95] flex flex-col bg-black text-white"
    >
      {/* Top bar */}
      <div className="safe-top shrink-0">
        <div className="flex h-14 items-center gap-1 px-2">
          <button
            ref={closeRef}
            type="button"
            onClick={tool ? cancelTool : close}
            aria-label={tool ? "Cancel" : "Close"}
            title={tool ? "Cancel" : "Close (Esc)"}
            className="pressable flex size-11 items-center justify-center rounded-full hover:bg-white/15"
          >
            <X className="size-6" strokeWidth={2} />
          </button>
          <div className="tabular min-w-0 flex-1 truncate px-1 text-[16px] font-semibold">{tool ? toolTitle[tool] : title}</div>
          {tool ? (
            <button type="button" onClick={doneTool} className="pressable flex h-11 items-center gap-1.5 rounded-full bg-white px-4 text-[14px] font-bold text-black">
              <Check className="size-[18px]" strokeWidth={2.4} aria-hidden />
              Done
            </button>
          ) : (
            <>
              {chat ? (
                <button
                  type="button"
                  aria-pressed={sendAsFile}
                  onClick={() => setSendAsFile((v) => !v)}
                  title="Send the original files, without compression"
                  className={cn(
                    "pressable flex h-11 items-center gap-1.5 rounded-full px-3 text-[13.5px] font-semibold transition-colors",
                    sendAsFile ? "bg-white text-black" : "text-white/85 hover:bg-white/15",
                  )}
                >
                  <FileIcon className="size-[18px]" strokeWidth={2} aria-hidden />
                  Send as file
                </button>
              ) : null}
              {count > 1 ? (
                <button type="button" onClick={removeCurrent} aria-label="Remove this item" title="Remove this item" className="pressable flex size-11 items-center justify-center rounded-full hover:bg-white/15">
                  <Trash2 className="size-[21px]" strokeWidth={1.9} />
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* Stage */}
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden" onPointerDown={() => tool === "text" && setSelectedText(null)}>
        {stage.w > 0 && stage.h > 0 ? (
          isImage ? (
            current ? (
              <ImageStage
                source={current.preview}
                edits={item.image}
                onEdits={updateImage}
                tool={(tool as ImageTool) ?? null}
                stageW={stage.w - 16}
                stageH={stage.h - 16}
                brush={brush}
                selectedText={selectedText}
                onSelectText={setSelectedText}
                fontFamily={fontFamily}
                lockedRatio={lockSquare ? 1 : null}
              />
            ) : (
              <div className="flex size-full items-center justify-center">
                <span className="size-8 animate-spin rounded-full border-2 border-white/70 border-t-transparent" aria-label="Loading photo" />
              </div>
            )
          ) : isVideo ? (
            <VideoStage
              key={item.id}
              file={item.file}
              edits={item.video}
              onEdits={updateVideo}
              tool={(tool as VideoTool) ?? null}
              stageW={stage.w - 16}
              stageH={stage.h}
              meta={meta ?? null}
              lockedRatio={lockSquare ? 1 : null}
              maxLen={maxVideoSec}
              onMeta={(m) => {
                setVideoMeta((all) => ({ ...all, [item.id]: m }));
                if (!m) return;
                setItems((list) =>
                  list.map((x) => {
                    if (x.id !== item.id) return x;
                    let v = x.video;
                    if (maxVideoSec && m.duration > maxVideoSec && v.trimEnd == null) v = { ...v, trimEnd: Math.min(m.duration, v.trimStart + maxVideoSec) };
                    if (lockSquare && isRectFull(v.crop)) v = { ...v, aspect: "square", crop: fitAspect(1, m.width, m.height, FULL_RECT) };
                    return v === x.video ? x : { ...x, video: v };
                  }),
                );
              }}
            />
          ) : (
            <GifPreview file={item.file} />
          )
        ) : null}
      </div>

      {/* Bottom */}
      <div className="safe-bottom shrink-0 border-t border-white/10 bg-black px-3 pb-3 pt-3">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3">
          {tool ? (
            tool === "crop" ? (
              <CropPanel
                aspect={isImage ? item.image.aspect : item.video.aspect}
                onAspect={setAspect}
                straighten={item.image.straighten}
                onStraighten={(deg) => updateImage((p) => ({ ...p, straighten: deg }))}
                onRotate={rotate}
                onFlip={flip}
                onReset={resetGeometry}
                lockAspect={lockSquare}
                showStraighten={isImage}
              />
            ) : tool === "draw" ? (
              <DrawPanel
                brush={brush}
                onBrush={setBrush}
                canUndo={item.image.strokes.length > 0}
                onUndo={() => updateImage((p) => ({ ...p, strokes: p.strokes.slice(0, -1) }))}
                onClear={() => updateImage((p) => ({ ...p, strokes: [] }))}
              />
            ) : tool === "text" ? (
              <TextPanel
                layer={item.image.texts.find((t) => t.id === selectedText) ?? null}
                inputRef={textInputRef}
                onAdd={addText}
                onDelete={() => {
                  updateImage((p) => ({ ...p, texts: p.texts.filter((t) => t.id !== selectedText) }));
                  setSelectedText(null);
                }}
                onChange={(patch) => updateImage((p) => ({ ...p, texts: p.texts.map((t) => (t.id === selectedText ? { ...t, ...patch } : t)) }))}
              />
            ) : tool === "adjust" ? (
              <AdjustPanel value={item.image.adjust} onChange={(adjust) => updateImage((p) => ({ ...p, adjust }))} />
            ) : (
              <p className="text-center text-[13.5px] text-white/70">Drag along the strip to choose the frame people see before they play it.</p>
            )
          ) : (
            <>
              {/* Tools */}
              {!sendAsFile && item.kind !== "gif" ? (
                <div className="flex items-center justify-center gap-2" role="toolbar" aria-label="Edit">
                  {isImage ? (
                    <>
                      <ToolButton label="Crop" icon={<Crop strokeWidth={1.9} />} onClick={() => openTool("crop")} active={!isRectFull(item.image.crop) || item.image.rotate !== 0 || item.image.flipH || item.image.straighten !== 0} />
                      <ToolButton label="Draw" icon={<Paintbrush strokeWidth={1.9} />} onClick={() => openTool("draw")} active={item.image.strokes.length > 0} />
                      <ToolButton label="Text" icon={<Type strokeWidth={1.9} />} onClick={() => openTool("text")} active={item.image.texts.length > 0} />
                      <ToolButton label="Adjust" icon={<SlidersHorizontal strokeWidth={1.9} />} onClick={() => openTool("adjust")} active={Object.values(item.image.adjust).some(Boolean)} />
                    </>
                  ) : (
                    <>
                      <ToolButton label="Crop" icon={<Crop strokeWidth={1.9} />} onClick={() => openTool("crop")} active={!isRectFull(item.video.crop) || item.video.rotate !== 0 || item.video.flipH} disabled={!meta} />
                      <ToolButton
                        label={item.video.muted ? "Muted" : "Sound on"}
                        icon={item.video.muted ? <VolumeX strokeWidth={1.9} /> : <Volume2 strokeWidth={1.9} />}
                        onClick={() => updateVideo((p) => ({ ...p, muted: !p.muted }))}
                        active={item.video.muted}
                        pressed={item.video.muted}
                      />
                      <ToolButton label="Cover" icon={<ImageIcon strokeWidth={1.9} />} onClick={() => openTool("cover")} active={item.video.coverSec != null} disabled={!meta} />
                    </>
                  )}
                </div>
              ) : null}

              {/* Quality */}
              {isImage && showImageQuality ? (
                <QualityControl
                  aria-label="Photo quality"
                  value={imageTier}
                  onChange={chooseTier}
                  options={[
                    { key: "standard", label: "Standard", detail: sizeFresh ? formatBytes(sz.standard) : "…" },
                    { key: "hd", label: "HD", detail: sizeFresh ? formatBytes(sz.hd) : "…" },
                  ]}
                />
              ) : null}
              {isVideo && chat && !sendAsFile ? (
                <QualityControl
                  aria-label="Video quality"
                  value={videoTier}
                  onChange={setVideoTier}
                  options={(["480", "720", "1080"] as const).map((t) => ({
                    key: t,
                    label: `${t}p`,
                    detail: trimmedSec ? `~${formatBytes(estimateVideoBytes(trimmedSec, t, item.video.muted))}` : "…",
                  }))}
                />
              ) : null}
              {sendAsFile ? <p className="text-center text-[13.5px] text-white/70">Sent as the original {count > 1 ? "files" : "file"}, without compression.</p> : null}

              {/* Carousel */}
              {chat ? (
                <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="listbox" aria-label="Selected media">
                  {items.map((it, i) => (
                    <Thumb key={it.id} item={it} selected={i === index} onSelect={() => setIndex(i)} position={`${i + 1} of ${count}`} />
                  ))}
                  {count < MAX_ITEMS ? (
                    <button
                      type="button"
                      onClick={() => addInputRef.current?.click()}
                      aria-label="Add photos or videos"
                      title="Add photos or videos"
                      className="pressable flex size-14 shrink-0 items-center justify-center rounded-[10px] border border-dashed border-white/35 text-white/80 hover:bg-white/10"
                    >
                      {count > 1 ? <Plus className="size-6" strokeWidth={1.9} /> : <ImagePlus className="size-6" strokeWidth={1.9} />}
                    </button>
                  ) : null}
                  <input
                    ref={addInputRef}
                    type="file"
                    multiple
                    accept={allowVideo ? "image/*,video/*" : "image/*"}
                    className="sr-only"
                    tabIndex={-1}
                    aria-hidden
                    onChange={(e) => {
                      addFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </div>
              ) : null}

              {error ? (
                <p role="alert" className="rounded-[10px] bg-danger/20 px-3 py-2 text-[13.5px] text-white">
                  {error}
                </p>
              ) : null}

              {/* Caption + send */}
              <div className="flex items-end gap-2">
                {chat ? (
                  <textarea
                    id={captionId}
                    dir="auto"
                    rows={1}
                    value={caption}
                    onChange={(e) => {
                      setCaption(e.target.value);
                      const t = e.currentTarget;
                      t.style.height = "auto";
                      t.style.height = `${Math.min(120, t.scrollHeight)}px`;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia?.("(pointer: coarse)").matches) {
                        e.preventDefault();
                        void confirm();
                      }
                    }}
                    placeholder="Add a caption"
                    aria-label="Caption"
                    maxLength={4000}
                    className="max-h-[120px] min-h-11 min-w-0 flex-1 resize-none rounded-[22px] border border-white/15 bg-white/10 px-4 py-[11px] text-[15px] leading-[1.35] text-white outline-none placeholder:text-white/45 focus:border-white/45"
                  />
                ) : (
                  <div className="flex-1" />
                )}
                <button
                  type="button"
                  onClick={() => void confirm()}
                  disabled={busy}
                  aria-label={chat ? `${label}${count > 1 ? ` ${count} items` : ""}` : label}
                  className={cn(
                    "pressable relative flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-accent font-bold text-accent-fg hover:bg-accent-hover disabled:opacity-70",
                    chat ? "w-11" : "px-6 text-[15px]",
                  )}
                >
                  {busy ? (
                    <span className="size-5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
                  ) : chat ? (
                    <SendHorizontal className="size-5 rtl:rotate-180" strokeWidth={2} />
                  ) : (
                    label
                  )}
                  {chat && count > 1 && !busy ? (
                    <span className="tabular absolute -end-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1 text-[11.5px] font-bold text-black">{count}</span>
                  ) : null}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ToolButton({
  label,
  icon,
  onClick,
  active,
  pressed,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className="pressable relative flex min-w-[64px] flex-col items-center gap-1 rounded-[12px] px-2 py-1.5 text-[12.5px] font-semibold text-white/85 hover:bg-white/10 hover:text-white disabled:opacity-40 [&_svg]:size-[22px]"
    >
      {icon}
      <span>{label}</span>
      {active ? <span aria-hidden className="absolute end-3 top-1 size-2 rounded-full bg-accent" /> : null}
    </button>
  );
}

function Thumb({ item, selected, onSelect, position }: { item: EditorItem; selected: boolean; onSelect: () => void; position: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(item.file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors a browser resource
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [item.file]);
  const kind = item.kind === "video" ? "Video" : item.kind === "gif" ? "GIF" : "Photo";
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-label={`${kind}, ${position}`}
      onClick={onSelect}
      className={cn("pressable relative size-14 shrink-0 overflow-hidden rounded-[10px] bg-white/10", selected ? "ring-2 ring-white" : "opacity-70 hover:opacity-100")}
    >
      {url ? (
        item.kind === "video" ? (
          <video src={`${url}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover" aria-hidden />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- local blob preview
          <img src={url} alt="" className="size-full object-cover" />
        )
      ) : null}
      {item.kind === "video" ? <span className="absolute bottom-0.5 end-1 text-[10px] font-bold drop-shadow">▶</span> : null}
    </button>
  );
}

function GifPreview({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors a browser resource
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <div className="flex size-full items-center justify-center p-2">
      {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
      {url ? <img src={url} alt="GIF preview" className="max-h-full max-w-full object-contain" /> : null}
    </div>
  );
}
