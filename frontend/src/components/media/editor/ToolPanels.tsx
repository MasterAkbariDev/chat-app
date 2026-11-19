"use client";

import { Eraser, FlipHorizontal2, RotateCcw, RotateCw, Trash2, Type, Undo2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { BrushSettings } from "./ImageStage";
import { ASPECTS, type Adjustments, type AspectKey, type TextLayer, type TextStyle } from "./types";

export const COLORS = ["#ffffff", "#111111", "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#af52de"];

const chip =
  "pressable inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 text-[13.5px] font-semibold transition-colors";

export function ToolIconButton({
  label,
  onClick,
  pressed,
  children,
  disabled,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "pressable flex size-11 shrink-0 items-center justify-center rounded-full text-white transition-colors disabled:opacity-35 [&_svg]:size-[22px]",
        pressed ? "bg-white text-black" : "hover:bg-white/15",
      )}
    >
      {children}
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  center,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  /** Show the fill from this value (e.g. 0 for −100…100 sliders). */
  center?: number;
}) {
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  const from = center != null ? Math.min(pct(center), pct(value)) : 0;
  const to = center != null ? Math.max(pct(center), pct(value)) : pct(value);
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[13.5px]">
        <span className="font-semibold text-white">{label}</span>
        <span className="tabular text-white/65">{format ? format(value) : Math.round(value)}</span>
      </span>
      <span className="relative block h-8">
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/20" />
        <span aria-hidden className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-white" style={{ left: `${from}%`, width: `${to - from}%` }} />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          onDoubleClick={() => center != null && onChange(center)}
          className="absolute inset-0 h-8 w-full cursor-pointer appearance-none bg-transparent [&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgba(0,0,0,.5)]"
        />
      </span>
    </label>
  );
}

export function Swatches({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center justify-between gap-1">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={COLOR_NAMES[c] ?? c}
          onClick={() => onChange(c)}
          className="pressable flex size-10 items-center justify-center rounded-full"
        >
          <span
            className={cn("block size-7 rounded-full border-2 transition-transform", value === c ? "scale-110 border-white" : "border-white/40")}
            style={{ background: c, boxShadow: value === c ? "0 0 0 2px rgba(0,0,0,.4)" : undefined }}
          />
        </button>
      ))}
    </div>
  );
}

const COLOR_NAMES: Record<string, string> = {
  "#ffffff": "White",
  "#111111": "Black",
  "#ff3b30": "Red",
  "#ff9500": "Orange",
  "#ffcc00": "Yellow",
  "#34c759": "Green",
  "#0a84ff": "Blue",
  "#af52de": "Purple",
};

export function CropPanel({
  aspect,
  onAspect,
  straighten,
  onStraighten,
  onRotate,
  onFlip,
  onReset,
  lockAspect,
  showStraighten = true,
}: {
  aspect: AspectKey;
  onAspect: (a: AspectKey) => void;
  straighten: number;
  onStraighten: (deg: number) => void;
  onRotate: () => void;
  onFlip: () => void;
  onReset: () => void;
  lockAspect?: boolean;
  showStraighten?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {showStraighten ? (
        <Slider label="Straighten" value={straighten} min={-45} max={45} step={0.5} center={0} onChange={onStraighten} format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}°`} />
      ) : null}
      <div className="flex items-center gap-1">
        <ToolIconButton label="Rotate" onClick={onRotate}>
          <RotateCw strokeWidth={1.9} />
        </ToolIconButton>
        <ToolIconButton label="Flip" onClick={onFlip}>
          <FlipHorizontal2 strokeWidth={1.9} />
        </ToolIconButton>
        {!lockAspect ? (
          <div role="radiogroup" aria-label="Aspect ratio" className="[scrollbar-width:none] [&::-webkit-scrollbar]:hidden -my-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-1">
            {ASPECTS.map((a) => (
              <button
                key={a.key}
                type="button"
                role="radio"
                aria-checked={aspect === a.key}
                onClick={() => onAspect(a.key)}
                className={cn(chip, aspect === a.key ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/20")}
              >
                {a.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex-1" />
        )}
        <ToolIconButton label="Reset" onClick={onReset}>
          <RotateCcw strokeWidth={1.9} />
        </ToolIconButton>
      </div>
    </div>
  );
}

export function DrawPanel({
  brush,
  onBrush,
  canUndo,
  onUndo,
  onClear,
}: {
  brush: BrushSettings;
  onBrush: (b: BrushSettings) => void;
  canUndo: boolean;
  onUndo: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Swatches label="Brush colour" value={brush.eraser ? "" : brush.color} onChange={(color) => onBrush({ ...brush, color, eraser: false })} />
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Slider
            label={brush.eraser ? "Eraser size" : "Brush size"}
            value={Math.round(brush.size * 1000)}
            min={4}
            max={60}
            onChange={(v) => onBrush({ ...brush, size: v / 1000 })}
          />
        </div>
        <ToolIconButton label="Eraser" pressed={brush.eraser} onClick={() => onBrush({ ...brush, eraser: !brush.eraser })}>
          <Eraser strokeWidth={1.9} />
        </ToolIconButton>
        <ToolIconButton label="Undo" disabled={!canUndo} onClick={onUndo}>
          <Undo2 strokeWidth={1.9} />
        </ToolIconButton>
        <ToolIconButton label="Clear drawing" disabled={!canUndo} onClick={onClear}>
          <Trash2 strokeWidth={1.9} />
        </ToolIconButton>
      </div>
    </div>
  );
}

const STYLES: { key: TextStyle; label: string }[] = [
  { key: "plain", label: "Plain" },
  { key: "fill", label: "Box" },
  { key: "outline", label: "Outline" },
];

export function TextPanel({
  layer,
  onChange,
  onAdd,
  onDelete,
  inputRef,
}: {
  layer: TextLayer | null;
  onChange: (patch: Partial<TextLayer>) => void;
  onAdd: () => void;
  onDelete: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  if (!layer) {
    return (
      <div className="flex flex-col items-center gap-2 py-2">
        <button type="button" onClick={onAdd} className={cn(chip, "h-11 bg-white px-5 text-black")}>
          <Type className="size-[18px]" strokeWidth={2} aria-hidden />
          Add text
        </button>
        <p className="text-[13px] text-white/60">Tap a text on the photo to change it, drag to move it.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <textarea
          ref={inputRef}
          dir="auto"
          rows={1}
          value={layer.text}
          onChange={(e) => onChange({ text: e.target.value })}
          placeholder="Type something"
          aria-label="Text"
          className="max-h-24 min-h-11 min-w-0 flex-1 resize-none rounded-[12px] border border-white/15 bg-white/10 px-3 py-2.5 text-[15px] text-white outline-none placeholder:text-white/45 focus:border-white/50"
        />
        <ToolIconButton label="Add another text" onClick={onAdd}>
          <Type strokeWidth={1.9} />
        </ToolIconButton>
        <ToolIconButton label="Delete text" onClick={onDelete}>
          <Trash2 strokeWidth={1.9} />
        </ToolIconButton>
      </div>
      <Swatches label="Text colour" value={layer.color} onChange={(color) => onChange({ color })} />
      <div className="flex items-center gap-3">
        <div role="radiogroup" aria-label="Text style" className="flex gap-1.5">
          {STYLES.map((s) => (
            <button
              key={s.key}
              type="button"
              role="radio"
              aria-checked={layer.style === s.key}
              onClick={() => onChange({ style: s.key })}
              className={cn(chip, layer.style === s.key ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/20")}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <Slider label="Size" value={Math.round(layer.size * 100)} min={3} max={25} onChange={(v) => onChange({ size: v / 100 })} />
        </div>
      </div>
    </div>
  );
}

const ADJUST_ROWS: { key: keyof Adjustments; label: string; min: number }[] = [
  { key: "brightness", label: "Brightness", min: -100 },
  { key: "contrast", label: "Contrast", min: -100 },
  { key: "saturation", label: "Saturation", min: -100 },
  { key: "warmth", label: "Warmth", min: -100 },
  { key: "fade", label: "Fade", min: 0 },
  { key: "vignette", label: "Vignette", min: 0 },
];

export function AdjustPanel({ value, onChange }: { value: Adjustments; onChange: (a: Adjustments) => void }) {
  return (
    <div className="grid max-h-[34vh] grid-cols-1 gap-x-6 gap-y-1 overflow-y-auto pe-1 sm:grid-cols-2">
      {ADJUST_ROWS.map((r) => (
        <Slider
          key={r.key}
          label={r.label}
          value={value[r.key]}
          min={r.min}
          max={100}
          center={0}
          onChange={(v) => onChange({ ...value, [r.key]: v })}
          format={(v) => (v > 0 && r.min < 0 ? `+${v}` : String(v))}
        />
      ))}
    </div>
  );
}
