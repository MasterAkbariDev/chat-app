"use client";

import { useRef } from "react";
import { cn } from "@/lib/cn";

export interface SegmentedTabsProps<T extends string> {
  options: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
  className?: string;
  pillClassName?: string;
  /** Accessible name for the group. */
  "aria-label"?: string;
}

/** A single-choice segmented control — exposed as a radio group (arrow
 * keys move the selection, only the selected segment is a tab stop). */
export function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
  className,
  pillClassName,
  "aria-label": ariaLabel,
}: SegmentedTabsProps<T>) {
  const activeIndex = Math.max(0, options.findIndex((o) => o.key === value));
  const count = options.length;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function move(delta: number) {
    const next = (activeIndex + delta + count) % count;
    onChange(options[next].key);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("relative flex rounded-[var(--radius-sm)] bg-sunken p-1", className)}>
      <div
        aria-hidden
        className={cn(
          // Logical inset + a direction-aware offset, so the pill sits under
          // the selected segment in RTL too (it was pinned to the left and
          // slid right, i.e. under the wrong segment, when dir="rtl").
          "absolute inset-y-1 start-1 translate-x-[calc(var(--seg-i)*100%)] rounded-[7px] bg-raised shadow-sm transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)] rtl:translate-x-[calc(var(--seg-i)*-100%)]",
          pillClassName,
        )}
        style={{ width: `calc((100% - 8px) / ${count})`, ["--seg-i" as string]: activeIndex }}
      />
      {options.map((o, i) => {
        const selected = o.key === value;
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
            onClick={() => onChange(o.key)}
            onKeyDown={(e) => {
              // Left/Right follow the visual order, which flips in RTL.
              const flip = getComputedStyle(e.currentTarget).direction === "rtl" ? -1 : 1;
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(e.key === "ArrowRight" ? flip : 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(e.key === "ArrowLeft" ? -flip : -1);
              }
            }}
            className={cn(
              "relative z-10 h-9 flex-1 rounded-[7px] px-3 text-[13.5px] font-semibold transition-colors duration-[var(--dur-fast)]",
              selected ? "text-fg" : "text-muted hover:text-fg-2",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
