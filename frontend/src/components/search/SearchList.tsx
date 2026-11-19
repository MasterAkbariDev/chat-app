import { cn } from "@/lib/cn";

/** Building blocks for the search listbox. The search input keeps focus the
 * whole time (combobox + `aria-activedescendant`); rows are `role="option"`
 * and are clicked, not tabbed to. The parent moves the active option with
 * ↑/↓ by walking `[role="option"]` in DOM order and clicks it on Enter. */

/** Same geometry as a chat-list row, so search results sit in the list
 * without a visual seam. */
const ROW =
  "flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-start transition-colors duration-[var(--dur-fast)]";

export function optionDomId(listboxId: string, key: string) {
  return `${listboxId}-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function SearchOption({
  id,
  active,
  disabled,
  onSelect,
  label,
  className,
  children,
}: {
  id: string;
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /** Accessible name when the visible text isn't enough. */
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      aria-label={label}
      onClick={disabled ? undefined : onSelect}
      className={cn(ROW, active ? "bg-sunken ring-2 ring-inset ring-accent" : "hover:bg-sunken", disabled && "cursor-default opacity-70", className)}
    >
      {children}
    </div>
  );
}

/** A section heading inside the listbox (presentation only — the group is
 * labelled by it). */
export function SearchGroup({
  id,
  title,
  count,
  aside,
  children,
}: {
  id: string;
  title: string;
  count?: string | number;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div role="group" aria-labelledby={id} className="pb-1">
      <div role="presentation" className="flex items-center gap-2 px-3 pb-1 pt-3">
        <span id={id} className="flex min-w-0 flex-1 items-baseline gap-2 text-[13px] font-semibold text-muted">
          {title}
          {count !== undefined ? <span className="tabular font-medium">{count}</span> : null}
        </span>
        {aside}
      </div>
      {children}
    </div>
  );
}

export function RowText({ title, subtitle }: { title: React.ReactNode; subtitle?: React.ReactNode }) {
  return (
    <span className="min-w-0 flex-1">
      <span dir="auto" className="block truncate text-start text-[15px] font-semibold text-fg">
        {title}
      </span>
      {subtitle ? (
        <span dir="auto" className="block truncate text-start text-[13.5px] text-muted">
          {subtitle}
        </span>
      ) : null}
    </span>
  );
}
