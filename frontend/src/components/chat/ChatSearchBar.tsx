"use client";

import { ArrowLeft, ChevronDown, ChevronUp, Search } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";

export interface ChatSearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  total: number;
  /** 0-based, into the newest-first result array — 0 is the newest match. */
  currentIndex: number;
  onOlder: () => void;
  onNewer: () => void;
  isPending: boolean;
}

// Replaces the ChatHeader in place while search is open (same height and
// hairline), so the layout under it never shifts.
export function ChatSearchBar({ query, onQueryChange, onClose, total, currentIndex, onOlder, onNewer, isPending }: ChatSearchBarProps) {
  const hasQuery = query.trim().length > 0;
  const hasResults = hasQuery && total > 0;

  return (
    <header className="safe-top relative z-20 shrink-0 border-b border-line bg-panel">
      <div className="flex h-[var(--header-h)] items-center gap-1.5 px-2 lg:px-4">
        <IconButton aria-label="Close search" onClick={onClose}>
          <ArrowLeft className="rtl:rotate-180" strokeWidth={2} />
        </IconButton>
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border border-line bg-sunken px-3.5 text-muted focus-within:border-accent focus-within:bg-raised">
          <Search className="size-[17px] shrink-0" strokeWidth={2} aria-hidden />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && hasResults) {
                e.preventDefault();
                if (e.shiftKey) onNewer();
                else onOlder();
              }
            }}
            placeholder="Search in this chat"
            aria-label="Search in this chat"
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none focus-visible:outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
          />
          {hasQuery ? (
            <span className="tabular shrink-0 text-[13px] text-muted" aria-live="polite">
              {isPending ? "Searching…" : hasResults ? `${currentIndex + 1} of ${total}` : "No matches"}
            </span>
          ) : null}
        </div>
        <IconButton aria-label="Older match" title="Older match (Enter)" onClick={onOlder} disabled={!hasResults}>
          <ChevronUp strokeWidth={2} />
        </IconButton>
        <IconButton aria-label="Newer match" title="Newer match (Shift+Enter)" onClick={onNewer} disabled={!hasResults}>
          <ChevronDown strokeWidth={2} />
        </IconButton>
      </div>
    </header>
  );
}
