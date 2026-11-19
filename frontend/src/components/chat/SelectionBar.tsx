"use client";

import { useEffect } from "react";
import { Copy, Trash2, X } from "lucide-react";
import { cn } from "@/lib/cn";

/** Replaces the composer while messages are selected: how many, copy them, delete them, or leave. */
export function SelectionBar({
  count,
  canCopy,
  canDelete,
  onCopy,
  onDelete,
  onCancel,
}: {
  count: number;
  /** Some selected message has text to copy. */
  canCopy: boolean;
  canDelete: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  // Escape leaves selection mode, like the other transient states of the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div role="toolbar" aria-label="Selected messages" className="fade-in mx-auto flex w-full max-w-[860px] items-center gap-2 rounded-[22px] border border-line bg-raised px-2 py-1.5 shadow-sm">
      <button type="button" onClick={onCancel} aria-label="Cancel selection" title="Cancel selection (Esc)" className="pressable flex size-10 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-sunken hover:text-fg">
        <X className="size-5" strokeWidth={2} aria-hidden />
      </button>
      <span className="tabular min-w-0 flex-1 truncate text-[15px] font-semibold text-fg" aria-live="polite">
        {count} selected
      </span>
      <button
        type="button"
        onClick={onCopy}
        disabled={!canCopy}
        aria-label="Copy selected messages"
        title="Copy"
        className={cn("pressable flex h-10 items-center gap-2 rounded-full px-3.5 text-[14px] font-semibold text-fg-2 hover:bg-sunken hover:text-fg disabled:opacity-40")}
      >
        <Copy className="size-[18px]" strokeWidth={1.9} aria-hidden />
        Copy
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={!canDelete}
        aria-label="Delete selected messages"
        title="Delete"
        className="pressable flex h-10 items-center gap-2 rounded-full px-3.5 text-[14px] font-semibold text-danger hover:bg-danger/10 disabled:opacity-40"
      >
        <Trash2 className="size-[18px]" strokeWidth={1.9} aria-hidden />
        Delete
      </button>
    </div>
  );
}
