import { cn } from "@/lib/cn";

export interface ChipProps {
  label: string;
  active?: boolean;
  onClick?: () => void;
  /** Optional trailing count (e.g. unread chats in a folder). */
  count?: number;
  className?: string;
}

/** A filter toggle (chat folders, search scopes). Exposes its state via
 * `aria-pressed` so it reads as a toggle, not a plain button. */
export function Chip({ label, active, onClick, count, className }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!!active}
      className={cn(
        "pressable inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[13px] font-semibold",
        active ? "border-transparent bg-accent text-accent-fg" : "border-line bg-transparent text-fg-2 hover:border-line-strong hover:text-fg",
        className,
      )}
    >
      {label}
      {count ? <span className={cn("tabular text-[12px]", active ? "opacity-80" : "text-muted")}>{count}</span> : null}
    </button>
  );
}
