"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

export interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  className?: string;
  /** Accessible name for the text field (or pass `id` and label it). */
  "aria-label"?: string;
  id?: string;
}

/** A free-text tag editor: existing tags render as removable pills, typing
 * and pressing Enter/comma (or blurring with text still in the field) adds
 * a new one. Dedupes by exact string match only — the backend matches a
 * folder's `includeTags` against a chat's tags case-sensitively with no
 * normalization, so "Work" and "work" really are different tags there, and
 * silently case-folding them here would let this UI promise a match the
 * server won't actually make. */
export function TagInput({ tags, onChange, placeholder, className, "aria-label": ariaLabel, id }: TagInputProps) {
  const [draft, setDraft] = useState("");

  // Takes the value to commit as a parameter rather than reading `draft`
  // from closure — a comma typed in one batch (e.g. a paste, or this
  // component's own onChange branch below) can call this in the same tick
  // as the `setDraft` that produced that value, before React has applied
  // it to state, so reading `draft` here would see the stale pre-keystroke
  // value instead.
  function commitText(raw: string) {
    const value = raw.trim();
    if (value && !tags.includes(value)) onChange([...tags, value]);
  }

  function remove(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  return (
    <div
      className={cn(
        "flex min-h-11 flex-wrap items-center gap-1.5 rounded-[var(--radius-sm)] border border-line bg-sunken p-1.5 transition-colors hover:border-line-strong focus-within:border-accent focus-within:bg-raised",
        className,
      )}
    >
      {tags.map((tag) => (
        <span key={tag} className="flex h-8 items-center gap-0.5 rounded-full bg-accent-soft pe-1 ps-3 text-[13.5px] font-semibold text-accent-text">
          {tag}
          <button
            type="button"
            onClick={() => remove(tag)}
            aria-label={`Remove tag ${tag}`}
            title={`Remove ${tag}`}
            className="pressable flex size-6 items-center justify-center rounded-full hover:bg-accent/15"
          >
            <X className="size-3.5" strokeWidth={2.2} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => {
          const raw = e.target.value;
          if (!raw.includes(",")) {
            setDraft(raw);
            return;
          }
          // Handles more than one comma-separated tag arriving at once
          // (typed fast enough to batch, or pasted) — commit every
          // complete segment and keep only the trailing partial word.
          const segments = raw.split(",");
          const remainder = segments.pop() ?? "";
          const seen = new Set(tags);
          const additions: string[] = [];
          for (const segment of segments) {
            const value = segment.trim();
            if (value && !seen.has(value)) {
              seen.add(value);
              additions.push(value);
            }
          }
          if (additions.length) onChange([...tags, ...additions]);
          setDraft(remainder);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commitText(draft);
            setDraft("");
          } else if (e.key === "Backspace" && !draft && tags.length) {
            remove(tags[tags.length - 1]);
          }
        }}
        onBlur={() => {
          commitText(draft);
          setDraft("");
        }}
        id={id}
        aria-label={ariaLabel}
        placeholder={tags.length ? "Add another" : placeholder}
        className="h-8 min-w-[100px] flex-1 bg-transparent px-2 text-[15px] text-fg outline-none placeholder:text-muted focus-visible:outline-none"
      />
    </div>
  );
}
