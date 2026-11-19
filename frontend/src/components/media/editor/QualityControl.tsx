"use client";

import { useRef } from "react";
import { cn } from "@/lib/cn";

export interface QualityOption<T extends string> {
  key: T;
  label: string;
  /** Second line, e.g. the size it will be sent at. */
  detail?: string;
}

interface QualityControlProps<T extends string> {
  options: QualityOption<T>[];
  value: T;
  onChange: (key: T) => void;
  "aria-label": string;
  disabled?: boolean;
}

/** Segmented control for the editor's dark chrome: each segment is its own filled box (no
 *  sliding pill to drift out of line), two lines — the label and the size — and it fits a
 *  375 px screen with three options. A radio group with arrow keys. */
export function QualityControl<T extends string>({ options, value, onChange, "aria-label": ariaLabel, disabled }: QualityControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = Math.max(0, options.findIndex((o) => o.key === value));

  function move(delta: number) {
    const next = (active + delta + options.length) % options.length;
    onChange(options[next].key);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className="grid gap-1 rounded-[12px] bg-white/10 p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o, i) => {
        const selected = i === active;
        return (
          <button
            key={o.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.key)}
            onKeyDown={(e) => {
              const rtl = getComputedStyle(e.currentTarget).direction === "rtl" ? -1 : 1;
              if (e.key === "ArrowRight") move(rtl);
              else if (e.key === "ArrowLeft") move(-rtl);
              else if (e.key === "ArrowDown") move(1);
              else if (e.key === "ArrowUp") move(-1);
              else return;
              e.preventDefault();
            }}
            className={cn(
              "flex min-h-11 min-w-0 flex-col items-center justify-center rounded-[9px] px-2 py-1 text-center transition-colors duration-[var(--dur-fast)] disabled:opacity-50",
              selected ? "bg-white text-black shadow-sm" : "text-white/80 hover:bg-white/10 hover:text-white",
            )}
          >
            <span className="max-w-full truncate text-[14px] font-bold leading-tight">{o.label}</span>
            {o.detail ? (
              <span className={cn("tabular max-w-full truncate text-[12px] leading-tight", selected ? "text-black/65" : "text-white/60")}>{o.detail}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
