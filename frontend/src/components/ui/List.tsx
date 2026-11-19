import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/** A titled group of rows — the building block of Settings-style screens. */
export function ListGroup({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {title ? <h2 className="px-1 text-[13.5px] font-semibold text-muted">{title}</h2> : null}
      <div className="overflow-hidden rounded-[var(--radius-md)] border border-line bg-panel [&>*+*]:border-t [&>*+*]:border-line">{children}</div>
      {description ? <p className="px-1 text-[13px] leading-relaxed text-muted">{description}</p> : null}
    </section>
  );
}

export interface ListItemProps {
  icon?: LucideIcon;
  /** Custom leading element (e.g. an Avatar) instead of an icon. */
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right side: a value, a Switch, a button… A chevron is added
   * automatically for navigational rows. */
  trailing?: React.ReactNode;
  href?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Let the subtitle wrap onto more lines instead of truncating. */
  wrapSubtitle?: boolean;
  /** Show a chevron on a button row (e.g. one that opens a dialog). Link
   * rows always get one. */
  chevron?: boolean;
  className?: string;
}

export function ListItem({ icon: Icon, leading, title, subtitle, trailing, href, onClick, danger, disabled, wrapSubtitle, chevron, className }: ListItemProps) {
  const interactive = !!(href || onClick) && !disabled;
  const body = (
    <>
      {leading ??
        (Icon ? (
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)]",
              danger ? "bg-danger-soft text-danger" : "bg-sunken text-fg-2",
            )}
          >
            <Icon className="size-[18px]" strokeWidth={1.8} aria-hidden />
          </span>
        ) : null)}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[15px] font-medium", danger ? "text-danger" : "text-fg")}>{title}</span>
        {subtitle ? <span className={cn("mt-0.5 block text-[13px] text-muted", wrapSubtitle ? "leading-snug" : "truncate")}>{subtitle}</span> : null}
      </span>
      {trailing ? <span className="flex shrink-0 items-center gap-2 text-[14px] text-muted">{trailing}</span> : null}
      {href || chevron ? <ChevronRight className="size-[18px] shrink-0 text-muted rtl:rotate-180" strokeWidth={1.8} aria-hidden /> : null}
    </>
  );
  const classes = cn(
    "flex min-h-[60px] w-full items-center gap-3 px-4 py-2.5 text-start",
    interactive && "focus-inset transition-colors duration-[var(--dur-fast)] hover:bg-sunken",
    disabled && "opacity-50",
    className,
  );

  if (href && !disabled) {
    return (
      <Link href={href} className={classes}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} disabled={disabled} className={classes}>
        {body}
      </button>
    );
  }
  return <div className={classes}>{body}</div>;
}
