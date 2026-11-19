"use client";

import { History, Search } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { RowText, SearchGroup, SearchOption, optionDomId } from "@/components/search/SearchList";
import { useRecentSearch, useSearchActions } from "@/hooks/use-global-search";
import { clearRecentSearch } from "@/lib/recent-search";

/** Shown while the search box is focused but empty: the last few queries and
 * the results you opened from search (per device, in localStorage). */
export function RecentSearches({
  listboxId,
  activeId,
  onPickQuery,
}: {
  listboxId: string;
  activeId: string | null;
  onPickQuery: (query: string) => void;
}) {
  const recent = useRecentSearch();
  const actions = useSearchActions("");
  const opt = (key: string) => ({ id: optionDomId(listboxId, key), active: activeId === optionDomId(listboxId, key) });
  const empty = recent.queries.length === 0 && recent.results.length === 0;

  if (empty) {
    return (
      <div className="fade-in flex flex-col items-center px-6 py-10 text-center">
        <Search className="mb-2 size-6 text-muted" strokeWidth={1.8} aria-hidden />
        <p className="text-[15px] font-semibold text-fg">Search everything</p>
        <p className="mt-1 text-[13.5px] text-muted">Find your chats, people, public groups and channels, and messages.</p>
        {/* Keeps aria-controls on the input pointing at something real. */}
        <div id={listboxId} role="listbox" aria-label="Recent searches" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 ps-3 pe-1 pt-2">
        <h2 className="min-w-0 flex-1 text-[14px] font-semibold text-fg">Recent</h2>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={clearRecentSearch}
          className="pressable h-10 shrink-0 rounded-full px-3.5 text-[13.5px] font-semibold text-accent-text hover:bg-sunken"
        >
          Clear
        </button>
      </div>
      <div id={listboxId} role="listbox" aria-label="Recent searches" onMouseDown={(e) => e.preventDefault()}>
        {actions.error ? (
          <p role="alert" className="mx-3 mb-1 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
            {actions.error}
          </p>
        ) : null}
        {recent.queries.length > 0 ? (
          <SearchGroup id={`${listboxId}-h-queries`} title="Searches">
            {recent.queries.map((q) => (
              <SearchOption key={q} {...opt(`q-${q}`)} onSelect={() => onPickQuery(q)} className="min-h-11">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sunken text-muted">
                  <History className="size-4" strokeWidth={1.8} aria-hidden />
                </span>
                <span dir="auto" className="min-w-0 flex-1 truncate text-start text-[15px] text-fg">
                  {q}
                </span>
              </SearchOption>
            ))}
          </SearchGroup>
        ) : null}
        {recent.results.length > 0 ? (
          <SearchGroup id={`${listboxId}-h-opened`} title="Opened">
            {recent.results.map((r) => (
              <SearchOption key={r.key} {...opt(`r-${r.key}`)} disabled={actions.pendingId !== null && r.target.type === "person" && actions.pendingId === r.target.userId} onSelect={() => actions.openRecent(r)}>
                <Avatar colorId={r.colorId} name={r.title} src={r.image ?? null} size={44} shape={r.shape} />
                <RowText title={r.title} subtitle={r.subtitle} />
              </SearchOption>
            ))}
          </SearchGroup>
        ) : null}
      </div>
    </div>
  );
}
