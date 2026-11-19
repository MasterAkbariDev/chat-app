"use client";

import { cn } from "@/lib/cn";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  id?: string;
  className?: string;
}

export function Switch({ checked, onChange, disabled, className, ...aria }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors duration-[var(--dur-base)] disabled:opacity-50",
        checked ? "border-transparent bg-accent" : "border-line-strong bg-sunken",
        className,
      )}
      {...aria}
    >
      <span
        aria-hidden
        className={cn(
          "absolute start-[3px] size-5 rounded-full shadow-sm transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]",
          checked ? "translate-x-5 bg-accent-fg rtl:-translate-x-5" : "translate-x-0 bg-muted",
        )}
      />
    </button>
  );
}
