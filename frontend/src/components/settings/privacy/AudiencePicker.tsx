"use client";

import { useRef } from "react";
import { Check } from "lucide-react";
import { ListGroup } from "@/components/ui/List";
import { cn } from "@/lib/cn";
import type { PrivacyAudience } from "@/lib/api/types";
import { AUDIENCE_LABEL } from "./privacy-meta";

const AUDIENCES: PrivacyAudience[] = ["everybody", "contacts", "nobody"];

/** A Telegram-style radio list: label on the start side, a check on the end. */
export function AudiencePicker({
  title,
  value,
  description,
  onChange,
}: {
  title: string;
  value: PrivacyAudience;
  description: React.ReactNode;
  onChange: (value: PrivacyAudience) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  // Arrow keys move focus (roving tabindex); Enter/Space picks — picking
  // saves straight away, so focus alone shouldn't.
  function onKeyDown(e: React.KeyboardEvent, index: number) {
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    refs.current[(index + delta + AUDIENCES.length) % AUDIENCES.length]?.focus();
  }

  return (
    <ListGroup title={title} description={<span aria-live="polite">{description}</span>}>
      <div role="radiogroup" aria-label={title} className="[&>*+*]:border-t [&>*+*]:border-line">
        {AUDIENCES.map((opt, i) => {
          const selected = opt === value;
          return (
            <button
              key={opt}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(opt)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className="focus-inset flex min-h-[52px] w-full items-center gap-3 px-4 py-2.5 text-start transition-colors duration-[var(--dur-fast)] hover:bg-sunken"
            >
              <span className={cn("min-w-0 flex-1 text-[15px]", selected ? "font-semibold text-fg" : "font-medium text-fg")}>{AUDIENCE_LABEL[opt]}</span>
              <Check className={cn("size-5 shrink-0 text-accent-text", selected ? "opacity-100" : "opacity-0")} strokeWidth={2.4} aria-hidden />
            </button>
          );
        })}
      </div>
    </ListGroup>
  );
}
